import path from "node:path";
import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { once } from "node:events";
import { FileService, localFs, type RemoteFiles } from "./files";
import { AdbService } from "./adb";
import { assertMutablePath, remoteJoin, windowsName } from "../shared/paths";
import type { Job, JobConflict, ConflictAction } from "../shared/contracts";

interface Item {
  source: string;
  destination: string;
  directory: boolean;
  size: number;
}
interface RecordJob {
  job: Job;
  controller: AbortController;
  adbPath: string;
  generation: number;
  inputs: string[];
  destination: string;
  items?: Item[];
  failures: Item[];
  pendingConflict?: {
    resolve: (v: ConflictAction) => void;
    reject: (e: Error) => void;
  };
  allAction?: ConflictAction;
  session?: RemoteFiles;
  scanFailures: string[];
}
const active = (j: Job) => ["queued", "running", "conflict"].includes(j.state);
export class JobService {
  records = new Map<string, RecordJob>();
  private queues = new Map<string, Promise<void>>();
  changed: () => void = () => {};
  constructor(
    private adb: AdbService,
    private files: FileService,
  ) {
    adb.isBusy = () => this.busy;
  }
  get jobs() {
    return [...this.records.values()]
      .map((r) => r.job)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  get busy() {
    return this.jobs.some(active);
  }
  busyDevice(serial: string) {
    return this.jobs.some((j) => j.serial === serial && active(j));
  }
  create(
    kind: Job["kind"],
    serial: string,
    inputs: string[],
    destination = "",
  ) {
    this.adb.requireDevice(serial);
    if (!inputs.length) throw new Error("请选择文件或文件夹");
    const job: Job = {
      id: randomUUID(),
      kind,
      label: `${kind === "upload" ? "上传" : kind === "download" ? "下载" : "删除"} ${inputs.length} 个项目`,
      serial,
      state: "queued",
      phase: "等待执行",
      createdAt: Date.now(),
      completedBytes: 0,
      totalBytes: 0,
      completedFiles: 0,
      totalFiles: 0,
      speed: 0,
      errors: [],
      skipped: 0,
      retryable: false,
    };
    const r: RecordJob = {
      job,
      inputs,
      destination,
      adbPath: this.adb.state.path!,
      generation: this.adb.generation,
      controller: new AbortController(),
      failures: [],
      scanFailures: [],
    };
    this.records.set(job.id, r);
    this.enqueue(r);
    return job;
  }
  private enqueue(r: RecordJob) {
    const previous = this.queues.get(r.job.serial) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.execute(r));
    this.queues.set(r.job.serial, next);
    void next
      .finally(() => {
        if (this.queues.get(r.job.serial) === next)
          this.queues.delete(r.job.serial);
        this.changed();
      })
      .catch(() => {});
    if (this.records.size > 100)
      for (const [id, record] of this.records) {
        if (this.records.size <= 100) break;
        if (!active(record.job)) this.records.delete(id);
      }
    this.changed();
  }
  cancel(id: string) {
    const r = this.get(id);
    if (!active(r.job)) return;
    r.controller.abort();
    r.pendingConflict?.reject(new Error("任务已取消"));
    if (r.session) void r.session.dispose().catch(() => {});
    if (r.job.state === "queued") {
      r.job.state = "cancelled";
      r.job.finishedAt = Date.now();
      r.job.phase = "已取消";
    }
    this.changed();
  }
  async cancelAll() {
    for (const r of this.records.values())
      if (active(r.job)) this.cancel(r.job.id);
    await Promise.allSettled([...this.queues.values()]);
  }
  retry(id: string) {
    const old = this.get(id);
    if (active(old.job) || !old.job.retryable)
      throw new Error("该任务没有可重试项目");
    if (this.adb.state.path !== old.adbPath || this.adb.generation !== old.generation)
      throw new Error("设备服务或 ADB 已变更，请重新选择失败项目创建任务");
    this.adb.requireDevice(old.job.serial);
    const job: Job = {
      ...old.job,
      id: randomUUID(),
      state: "queued",
      createdAt: Date.now(),
      finishedAt: undefined,
      completedBytes: 0,
      completedFiles: 0,
      totalBytes: 0,
      totalFiles: 0,
      errors: [],
      skipped: 0,
      speed: 0,
      conflict: undefined,
      retryable: false,
      phase: "重试失败项目",
    };
    const r: RecordJob = {
      ...old,
      job,
      controller: new AbortController(),
      inputs: [...new Set(old.scanFailures)],
      items: [...old.failures],
      failures: [],
      scanFailures: [],
      allAction: undefined,
      session: undefined,
      pendingConflict: undefined,
    };
    this.records.set(job.id, r);
    this.enqueue(r);
    return job;
  }
  resolve(id: string, action: ConflictAction, all: boolean) {
    const r = this.get(id);
    if (!r.pendingConflict) throw new Error("任务当前没有名称冲突");
    if (all) r.allAction = action;
    r.pendingConflict.resolve(action);
    r.pendingConflict = undefined;
  }
  private get(id: string) {
    const r = this.records.get(id);
    if (!r) throw new Error("找不到此任务");
    return r;
  }
  private check(r: RecordJob) {
    if (r.controller.signal.aborted) throw new Error("任务已取消");
  }
  private async conflict(
    r: RecordJob,
    conflict: JobConflict,
  ): Promise<ConflictAction> {
    if (r.allAction) return r.allAction;
    r.job.state = "conflict";
    r.job.phase = "等待处理重名";
    r.job.conflict = conflict;
    this.changed();
    const action = await new Promise<ConflictAction>(
      (resolve, reject) => (r.pendingConflict = { resolve, reject }),
    );
    this.check(r);
    r.job.state = "running";
    r.job.conflict = undefined;
    this.changed();
    return action;
  }
  private async scan(r: RecordJob, fs: RemoteFiles): Promise<Item[]> {
    const items: Item[] = [];
    const visitLocal = async (source: string, destination: string) => {
      this.check(r);
      const s = await localFs.lstat(source);
      if (s.isSymbolicLink()) {
        r.job.skipped++;
        return;
      }
      if (!s.isFile() && !s.isDirectory()) {
        r.job.skipped++;
        return;
      }
      items.push({
        source,
        destination,
        directory: s.isDirectory(),
        size: s.isFile() ? s.size : 0,
      });
      if (s.isDirectory())
        for (const child of await localFs.readdir(source))
          await visitLocal(
            path.join(source, child),
            remoteJoin(destination, child),
          );
    };
    const visitRemote = async (source: string, destination: string) => {
      this.check(r);
      const s = await fs.stat(source);
      if (!s) throw new Error("设备文件已不存在");
      if (s.type === "symlink" || s.type === "other") {
        r.job.skipped++;
        return;
      }
      items.push({
        source,
        destination,
        directory: s.type === "directory",
        size: s.type === "file" ? s.size : 0,
      });
      if (s.type === "directory")
        for (const child of await fs.list(source))
          await visitRemote(
            child.path,
            path.join(destination, windowsName(child.name)),
          );
    };
    for (const source of r.inputs) {
      try {
        if (r.job.kind === "upload")
          await visitLocal(
            source,
            remoteJoin(r.destination, path.basename(source)),
          );
        else if (r.job.kind === "download")
          await visitRemote(
            source,
            r.inputs.length === 1 && !r.destination.endsWith(path.sep)
              ? r.destination
              : path.join(
                  r.destination,
                  windowsName(path.posix.basename(source)),
                ),
          );
        else
          items.push({
            source: assertMutablePath(source),
            destination: "",
            directory: false,
            size: 0,
          });
      } catch (e) {
        if (r.controller.signal.aborted) throw e;
        r.job.errors.push({ path: source, message: (e as Error).message });
        r.scanFailures.push(source);
      }
    }
    return items;
  }
  private async execute(r: RecordJob) {
    if (r.controller.signal.aborted) return;
    const j = r.job;
    let fs: RemoteFiles | undefined;
    let items: Item[] = [];
    let index = 0;
    const started = Date.now();
    const remaps: { from: string; to: string }[] = [];
    const skippedPrefixes: string[] = [];
    let lastEmit = 0;
    const progress = (n: number) => {
      j.completedBytes += n;
      j.speed = j.completedBytes / Math.max(1, (Date.now() - started) / 1000);
      if (Date.now() - lastEmit > 180) {
        lastEmit = Date.now();
        this.changed();
      }
    };
    try {
      this.check(r);
      this.adb.requireDevice(j.serial);
      j.state = "running";
      j.phase = "扫描文件";
      this.changed();
      fs = await this.files.open(j.serial);
      r.session = fs;
      items = r.items
        ? [...r.items, ...(r.inputs.length ? await this.scan(r, fs) : [])]
        : await this.scan(r, fs);
      j.totalFiles = items.length;
      j.totalBytes = items.reduce((n, i) => n + i.size, 0);
      for (index = 0; index < items.length; index++) {
        const original = items[index];
        this.check(r);
        const item = { ...original };
        const sep = j.kind === "upload" ? "/" : path.sep;
        if (skippedPrefixes.some((p) => item.destination.startsWith(p + sep))) {
          j.skipped++;
          continue;
        }
        const remap = remaps
          .filter(
            (map) =>
              item.destination === map.from ||
              item.destination.startsWith(map.from + sep),
          )
          .sort((a, b) => b.from.length - a.from.length)[0];
        if (remap)
          item.destination =
            remap.to + item.destination.slice(remap.from.length);
        j.currentPath = item.source;
        j.phase = item.directory
          ? "创建文件夹"
          : j.kind === "delete"
            ? "删除项目"
            : "正在传输";
        this.changed();
        try {
          if (j.kind === "delete") {
            await fs.remove(item.source);
            j.completedFiles++;
            continue;
          }
          const existing =
            j.kind === "upload"
              ? await fs.stat(item.destination)
              : await localFs.localStat(item.destination);
          const existingDirectory = Boolean(
            existing &&
            ("type" in existing
              ? existing.type === "directory"
              : existing.isDirectory()),
          );
          const existingLink =
            existing &&
            ("type" in existing
              ? existing.type === "symlink"
              : existing.isSymbolicLink());
          if (existing) {
            const action = await this.conflict(r, {
              source: item.source,
              destination: item.destination,
              directory: item.directory,
            });
            if (action === "skip") {
              j.skipped++;
              if (item.directory) skippedPrefixes.push(original.destination);
              continue;
            }
            if (action === "keep-both") {
              const previous = item.destination;
              let n = 1;
              do {
                const ext = item.directory
                  ? ""
                  : j.kind === "upload"
                    ? path.posix.extname(previous)
                    : path.extname(previous);
                item.destination =
                  previous.slice(0, previous.length - ext.length) +
                  ` (${n++})` +
                  ext;
              } while (
                j.kind === "upload"
                  ? await fs.stat(item.destination)
                  : await localFs.localStat(item.destination)
              );
              if (item.directory)
                remaps.push({
                  from: original.destination,
                  to: item.destination,
                });
            } else if (existingLink)
              throw new Error("不会覆盖软链接，请选择跳过或保留两份");
            else if (existingDirectory !== item.directory)
              throw new Error("文件与文件夹类型不同，请选择跳过或保留两份");
          }
          if (j.kind === "download") {
            for (
              let parent = path.dirname(item.destination);
              ;
              parent = path.dirname(parent)
            ) {
              if ((await localFs.localStat(parent))?.isSymbolicLink())
                throw new Error("下载路径包含软链接或目录联接，请选择其他位置");
              if (path.dirname(parent) === parent) break;
            }
          }
          if (item.directory) {
            if (j.kind === "upload") await fs.mkdir(item.destination);
            else await localFs.mkdir(item.destination, { recursive: true });
          } else if (j.kind === "upload") {
            const temp = item.destination + `.awesomeadb-${j.id}.part`;
            const input = localFs.createReadStream(item.source);
            const self = this;
            const stream = async function* () {
              for await (const chunk of input) {
                self.check(r);
                const b = chunk as Buffer;
                progress(b.length);
                yield b;
              }
            };
            try {
              await fs.write(temp, stream());
              this.check(r);
              await fs.rename(temp, item.destination);
            } catch (e) {
              input.destroy();
              await fs.remove(temp).catch(() => {
                j.errors.push({
                  path: temp,
                  message:
                    "设备无法连接，临时文件未能清理。恢复连接后可在文件列表中删除此 .part 文件。",
                });
              });
              throw e;
            }
          } else {
            await localFs.mkdir(path.dirname(item.destination), {
              recursive: true,
            });
            const temp = item.destination + `.awesomeadb-${j.id}.part`;
            const out = localFs.createWriteStream(temp, { flags: "wx" });
            // Capture stream errors immediately, including disk-full before backpressure.
            const done = finished(out);
            void done.catch(() => {});
            try {
              for await (const chunk of fs.read(item.source)) {
                this.check(r);
                if (!out.write(chunk)) await once(out, "drain");
                progress(chunk.length);
              }
              out.end();
              await done;
              this.check(r);
              await localFs.rename(temp, item.destination);
            } catch (e) {
              out.destroy();
              await done.catch(() => {});
              await localFs
                .unlink(temp)
                .catch((cleanup: NodeJS.ErrnoException) => {
                  if (cleanup.code !== "ENOENT")
                    j.errors.push({
                      path: temp,
                      message:
                        "临时文件未能清理，请检查磁盘权限并手动删除此 .part 文件。",
                    });
                });
              throw e;
            }
          }
          j.completedFiles++;
        } catch (e) {
          if (r.controller.signal.aborted) throw e;
          j.errors.push({ path: item.source, message: (e as Error).message });
          r.failures.push(item);
        }
      }
      j.state = j.errors.length ? "failed" : "succeeded";
      j.phase = j.errors.length ? "部分项目未完成" : "已完成";
    } catch (e) {
      j.state = r.controller.signal.aborted ? "cancelled" : "failed";
      j.phase = r.controller.signal.aborted
        ? "已取消，已完成文件已保留"
        : "任务失败";
      if (!r.controller.signal.aborted)
        j.errors.push({
          path: j.currentPath || "",
          message: (e as Error).message,
        });
      r.failures.push(...items.slice(index));
      if (!items.length) r.scanFailures.push(...r.inputs);
    } finally {
      j.conflict = undefined;
      j.finishedAt = Date.now();
      j.speed = 0;
      j.retryable = r.failures.length > 0 || r.scanFailures.length > 0;
      await fs?.dispose().catch(() => {});
      r.session = undefined;
      this.changed();
    }
  }
}
