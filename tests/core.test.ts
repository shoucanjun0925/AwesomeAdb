import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import {
  remotePath,
  remoteJoin,
  shellQuote,
  windowsName,
  assertMutablePath,
} from "../shared/paths";
import {
  upsertAdbSql,
  upsertConnectionSql,
  trimHistorySql,
  pathKey,
  endpointKey,
} from "../db/history";
import { AdbService } from "../companion/adb";
import { FileService, type RemoteFiles } from "../companion/files";
import { JobService } from "../companion/jobs";
import { createCompanion } from "../companion/server";
import type { FileEntry, Job } from "../shared/contracts";
import {
  deviceWriteStatements,
  legacyDeviceStatements,
  type SqlStatement,
} from "../db/devices";
import {
  applyDeviceMutation,
  deviceLabelSchema,
  deviceMutationSchema,
  emptyDeviceData,
  endpointBindingKey,
  nameDevices,
  setupStep,
  transportBindingKey,
} from "../shared/devices";

function deviceDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("drizzle/0000_broken_bill_hollister.sql", "utf8"));
  db.exec(readFileSync("drizzle/0001_device_profiles.sql", "utf8"));
  return db;
}
function transaction(db: DatabaseSync, statements: SqlStatement[]) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const s of statements) db.prepare(s.sql).run(...s.values);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

test("设备备注拒绝空值与超长内容，允许中文并去除首尾空格", () => {
  for (const value of ["", "  ", "\n\t", "字".repeat(101)])
    assert.equal(deviceLabelSchema.safeParse(value).success, false);
  assert.equal(deviceLabelSchema.parse("  家用手机 📱  "), "家用手机 📱");
  assert.equal(
    deviceMutationSchema.safeParse({
      kind: "save",
      id: "A",
      label: " ",
      bindingKeys: [],
    }).success,
    false,
  );
  assert.equal(
    endpointBindingKey("[2001:DB8::1]", 5555),
    "tcp|2001:db8::1|5555",
  );
  assert.equal(
    transportBindingKey({ serial: "[2001:db8::1]:5555", transport: "tcp" }),
    "tcp|2001:db8::1|5555",
  );
});
test("旧备注按连接迁移，空备注待补充，同名不同设备不合并，重复升级幂等", () => {
  const db = deviceDatabase();
  const insert = db.prepare(upsertConnectionSql);
  insert.run(
    "A",
    "user-A",
    "tcp|host1|5555",
    "host1",
    5555,
    "tcp",
    " 家用手机 ",
    1,
  );
  insert.run(
    "B",
    "user-A",
    "tcp|host2|5555",
    "host2",
    5555,
    "tcp",
    "家用手机",
    2,
  );
  insert.run("C", "user-A", "tcp|host3|5555", "host3", 5555, "tcp", "", 3);
  insert.run(
    "D",
    "user-B",
    "tcp|host1|5555",
    "host1",
    5555,
    "tcp",
    "别人的设备",
    4,
  );
  transaction(db, legacyDeviceStatements("user-A"));
  transaction(db, legacyDeviceStatements("user-A"));
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM device_profiles WHERE user_id='user-A'",
      )
      .get()!.n,
    2,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM device_profiles WHERE user_id='user-B'",
      )
      .get()!.n,
    0,
  );
  assert.equal(
    db.prepare("SELECT device_id FROM connections WHERE id='C'").get()!
      .device_id,
    null,
  );
  assert.equal(
    db.prepare("SELECT label FROM connections WHERE id='A'").get()!.label,
    "家用手机",
  );
  assert.notEqual(
    db.prepare("SELECT device_id FROM connections WHERE id='A'").get()!
      .device_id,
    db.prepare("SELECT device_id FROM connections WHERE id='B'").get()!
      .device_id,
  );
  db.close();
});
test("设备关联事务防止并发抢占，显式重新关联才覆盖，用户备注相互隔离", () => {
  const db = deviceDatabase();
  const key = endpointBindingKey("host", 5555);
  transaction(
    db,
    deviceWriteStatements(
      "A",
      {
        kind: "save",
        id: "device-A",
        label: "手机 A",
        bindingKeys: [key],
        reassign: false,
      },
      1,
    ),
  );
  transaction(
    db,
    deviceWriteStatements(
      "B",
      {
        kind: "save",
        id: "device-B",
        label: "手机 B",
        bindingKeys: [key],
        reassign: false,
      },
      2,
    ),
  );
  assert.throws(
    () =>
      transaction(
        db,
        deviceWriteStatements(
          "A",
          {
            kind: "save",
            id: "competing",
            label: "不能抢占",
            bindingKeys: [key],
            reassign: false,
          },
          3,
        ),
      ),
    /NOT NULL/,
  );
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM device_profiles WHERE id='competing'")
      .get()!.n,
    0,
  );
  transaction(
    db,
    deviceWriteStatements(
      "A",
      {
        kind: "save",
        id: "new-A",
        label: "新关联",
        bindingKeys: [key],
        reassign: true,
      },
      4,
    ),
  );
  assert.equal(
    db
      .prepare("SELECT profile_id FROM device_bindings WHERE user_id='A'")
      .get()!.profile_id,
    "new-A",
  );
  assert.equal(
    db
      .prepare("SELECT profile_id FROM device_bindings WHERE user_id='B'")
      .get()!.profile_id,
    "device-B",
  );
  db.close();
});
test("连接历史淘汰不删除设备备注，重命名同步关联连接，USB 和无线共用名称", () => {
  const db = deviceDatabase();
  const keys = [
    endpointBindingKey("phone", 5555),
    "usb|USB-A",
    "hardware|stable-device",
  ];
  transaction(
    db,
    deviceWriteStatements(
      "A",
      {
        kind: "save",
        id: "phone",
        label: "家用手机",
        bindingKeys: keys,
        reassign: false,
      },
      1,
    ),
  );
  db.prepare(upsertConnectionSql).run(
    "first",
    "A",
    "tcp|phone|5555",
    "phone",
    5555,
    "tcp",
    "家用手机",
    1,
  );
  transaction(
    db,
    deviceWriteStatements(
      "A",
      {
        kind: "save",
        id: "phone",
        label: "新的备注",
        bindingKeys: [],
        reassign: false,
      },
      2,
    ),
  );
  // Existing history is linked as soon as its endpoint is known.
  transaction(
    db,
    deviceWriteStatements(
      "A",
      { kind: "link", id: "phone", bindingKeys: keys, reassign: false },
      2,
    ),
  );
  assert.equal(
    db.prepare("SELECT label FROM connections WHERE id='first'").get()!.label,
    "新的备注",
  );
  for (let i = 0; i < 11; i++) {
    db.prepare(upsertConnectionSql).run(
      `row-${i}`,
      "A",
      `tcp|other-${i}|5555`,
      `other-${i}`,
      5555,
      "tcp",
      "其他设备",
      i + 10,
    );
    db.prepare(trimHistorySql("connection")).run("A", "A");
  }
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM connections WHERE user_id='A'").get()!
      .n,
    10,
  );
  assert.equal(
    db.prepare("SELECT label FROM device_profiles WHERE id='phone'").get()!
      .label,
    "新的备注",
  );
  const data = {
    profiles: [{ id: "phone", label: "新的备注", createdAt: 1, updatedAt: 2 }],
    bindings: keys.map((bindingKey) => ({ bindingKey, profileId: "phone" })),
  };
  const named = nameDevices(
    [
      { serial: "USB-A", state: "device", model: "M", transport: "usb" },
      {
        serial: "new-address:4444",
        state: "device",
        model: "M",
        transport: "tcp",
      },
    ],
    data,
    { "new-address:4444": "hardware|stable-device" },
  );
  assert.deepEqual(
    named.map((d) => d.label),
    ["新的备注", "新的备注"],
  );
  assert.deepEqual(
    named.map((d) => d.profileId),
    ["phone", "phone"],
  );
  db.close();
});
test("缺少身份能力时可手动共用备注，关联冲突阻止误操作，未命名设备不阻塞已命名设备", () => {
  let data = applyDeviceMutation(emptyDeviceData, {
    kind: "save",
    id: "A",
    label: "测试手机",
    bindingKeys: ["usb|A"],
    reassign: false,
  });
  data = applyDeviceMutation(data, {
    kind: "link",
    id: "A",
    bindingKeys: [endpointBindingKey("host", 5555)],
    reassign: false,
  });
  const devices = [
    { serial: "A", state: "device", model: "M", transport: "usb" as const },
    {
      serial: "host:5555",
      state: "device",
      model: "M",
      transport: "tcp" as const,
    },
    {
      serial: "unnamed",
      state: "device",
      model: "U",
      transport: "usb" as const,
    },
  ];
  const named = nameDevices(devices, data, {}, new Set(["A"]));
  assert.deepEqual(
    named.map((d) => d.label),
    ["测试手机", "测试手机", ""],
  );
  assert.equal(named[0].pending, true);
  assert.equal(setupStep(true, true, named), 0);
  assert.equal(setupStep(false, true, named), 1);
  assert.equal(setupStep(true, false, named), 2);
  assert.equal(setupStep(true, true, [named[2]]), 3);
  data = applyDeviceMutation(data, {
    kind: "save",
    id: "B",
    label: "其他手机",
    bindingKeys: ["hardware|other"],
    reassign: false,
  });
  const conflict = nameDevices([devices[0]], data, { A: "hardware|other" })[0];
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.profileId, null);
  assert.equal(conflict.label, "");
});
test("设备身份跨 USB 和无线一致并缓存，读取失败可以手动关联", async () => {
  const f = await fixture();
  f.adb.devices.push({
    serial: "host:5555",
    state: "device",
    model: "M",
    transport: "tcp",
  });
  let calls = 0;
  f.adb.run = async (args) => {
    calls++;
    return args.at(-1) === "ro.serialno" ? "unknown" : "stable-phone-serial";
  };
  const usb = await f.adb.identity("device-A");
  assert.match(usb!, /^hardware\|[a-f0-9]{64}$/);
  assert.equal(await f.adb.identity("device-A"), usb);
  assert.equal(calls, 2);
  assert.equal(await f.adb.identity("host:5555"), usb);
  f.adb.devices.push({
    serial: "restricted",
    state: "device",
    model: "M",
    transport: "usb",
  });
  f.adb.run = async () => {
    throw new Error("权限拒绝");
  };
  assert.equal(await f.adb.identity("restricted"), null);
});
test("停止服务等待身份读取完成，停止后身份查询不启动 ADB", async () => {
  const f = await fixture();
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  f.adb.run = async (args) => {
    calls.push(args[0]);
    if (args[0] === "-s") {
      await gate;
      return "serial-A";
    }
    return "";
  };
  const reading = f.adb.identity("device-A");
  const stopping = f.adb.stop();
  await delay(10);
  assert.deepEqual(calls, ["-s"]);
  release();
  await Promise.all([reading, stopping]);
  assert.deepEqual(calls, ["-s", "kill-server"]);
  await assert.rejects(() => f.adb.identity("device-A"), /已停止/);
  assert.equal(calls.length, 2);
});

class MemoryFiles implements RemoteFiles {
  entries = new Map<string, Buffer | null>();
  links = new Set<string>();
  writes: string[] = [];
  failOn = "";
  onChunk?: () => void;
  async list(p: string) {
    return [...this.entries.keys()]
      .filter((key) => path.posix.dirname(key) === p)
      .map((key) => this.info(key));
  }
  info(p: string): FileEntry {
    const b = this.entries.get(p);
    return {
      path: p,
      name: path.posix.basename(p),
      type: this.links.has(p) ? "symlink" : b === null ? "directory" : "file",
      size: b?.length || 0,
      modifiedAt: 1,
      mode: 0,
    };
  }
  async stat(p: string) {
    return this.entries.has(p) ? this.info(p) : null;
  }
  async *read(p: string) {
    const b = this.entries.get(p);
    if (!b) throw new Error("读取失败");
    for (let i = 0; i < b.length; i += 65536) yield b.subarray(i, i + 65536);
  }
  async write(p: string, stream: AsyncIterable<Uint8Array>) {
    this.writes.push(p);
    if (this.failOn && p.includes(this.failOn)) throw new Error("模拟设备断线");
    const parts: Buffer[] = [];
    for await (const b of stream) {
      parts.push(Buffer.from(b));
      this.entries.set(p, Buffer.concat(parts));
      this.onChunk?.();
      await delay(1);
    }
    this.entries.set(p, Buffer.concat(parts));
  }
  async mkdir(p: string) {
    this.entries.set(p, null);
  }
  async remove(p: string) {
    for (const key of this.entries.keys())
      if (key === p || key.startsWith(p + "/")) this.entries.delete(key);
  }
  async rename(from: string, to: string) {
    const b = this.entries.get(from);
    if (b === undefined) throw new Error("临时文件不存在");
    this.entries.set(to, b);
    this.entries.delete(from);
  }
  async dispose() {}
}
async function fixture() {
  await mkdir(".sites-runtime/tests/files", { recursive: true });
  const directory = await mkdtemp(
    path.resolve(".sites-runtime/tests/files/case-"),
  );
  const adb = new AdbService();
  adb.state = {
    ...adb.state,
    path: "test-adb.exe",
    valid: true,
    server: "running",
  };
  adb.devices = [
    {
      serial: "device-A",
      state: "device",
      model: "测试设备",
      transport: "usb",
    },
  ];
  const remote = new MemoryFiles();
  remote.entries.set("/sdcard", null);
  const files = new FileService(adb);
  files.open = async () => remote;
  return { directory, adb, remote, files, jobs: new JobService(adb, files) };
}
async function until(condition: () => boolean) {
  const end = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > end) throw new Error("等待任务状态超时");
    await delay(5);
  }
}
async function done(job: Job) {
  await until(() => ["succeeded", "failed", "cancelled"].includes(job.state));
  return job;
}

test("路径处理保留中文、空格和引号，并阻止根目录删除与 Windows 非法文件名", () => {
  assert.equal(remotePath("/sdcard//照片/../下载"), "/sdcard/下载");
  assert.equal(remoteJoin("/sdcard", "a '中文.txt"), "/sdcard/a '中文.txt");
  assert.equal(shellQuote("a'$(id)"), "'a'\\''$(id)'");
  for (const p of ["/", "/sdcard/", "/storage/emulated/0", "/data"])
    assert.throws(() => assertMutablePath(p));
  for (const p of [
    "../a",
    "a/b",
    "bad:name",
    "CON",
    "NUL.txt",
    "file.",
    "tail ",
    "a\\b",
  ])
    assert.throws(() => windowsName(p));
  assert.throws(() => remoteJoin("/sdcard", ".."));
  assert.equal(windowsName("我的 '文件.txt"), "我的 '文件.txt");
});

test("数据库事务：第 11 条淘汰、重复更新，以及用户和电脑隔离", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("drizzle/0000_broken_bill_hollister.sql", "utf8"));
  const save = (user: string, machine: string, p: string, time: number) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(upsertAdbSql).run(
        randomUUID(),
        user,
        machine,
        p,
        pathKey(p),
        time,
      );
      db.prepare(trimHistorySql("adb")).run(user, machine, user, machine);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  for (let i = 0; i < 11; i++) save("u1", "pc1", `C:\\sdk${i}\\adb.exe`, i);
  assert.equal(db.prepare("SELECT count(*) AS n FROM adb_paths").get()!.n, 10);
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM adb_paths WHERE path_key=?")
      .get(pathKey("C:\\sdk0\\adb.exe"))!.n,
    0,
  );
  save("u1", "pc1", "c:/SDK1/adb.exe", 50);
  assert.equal(db.prepare("SELECT count(*) AS n FROM adb_paths").get()!.n, 10);
  assert.equal(
    db
      .prepare("SELECT path FROM adb_paths ORDER BY last_used_at DESC LIMIT 1")
      .get()!.path,
    "c:/SDK1/adb.exe",
  );
  save("u1", "pc2", "C:\\sdk1\\adb.exe", 2);
  save("u2", "pc1", "C:\\sdk1\\adb.exe", 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM adb_paths").get()!.n, 12);
  const connect = (user: string, host: string, time: number, label = "") => {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(upsertConnectionSql).run(
      randomUUID(),
      user,
      endpointKey("tcp", host, 5555),
      host,
      5555,
      "tcp",
      label,
      time,
    );
    db.prepare(trimHistorySql("connection")).run(user, user);
    db.exec("COMMIT");
  };
  for (let i = 0; i < 11; i++) connect("u1", `192.168.1.${i + 1}`, i);
  connect("u1", "192.168.1.2", 99, "客厅设备");
  connect("u1", "192.168.1.2", 100);
  connect("u2", "192.168.1.2", 3);
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM connections WHERE user_id='u1'")
      .get()!.n,
    10,
  );
  assert.equal(
    db
      .prepare(
        "SELECT label FROM connections WHERE user_id='u1' ORDER BY last_used_at DESC LIMIT 1",
      )
      .get()!.label,
    "客厅设备",
  );
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM connections WHERE user_id='u2'")
      .get()!.n,
    1,
  );
  db.close();
});

test("上传文件夹保留中文名称、空目录和内容；递归跳过设备软链接", async () => {
  const f = await fixture();
  const source = path.join(f.directory, "中文 '文件夹");
  await mkdir(path.join(source, "空文件夹"), { recursive: true });
  await writeFile(path.join(source, "a ' b.txt"), "测试内容");
  const job = await done(
    f.jobs.create("upload", "device-A", [source], "/sdcard"),
  );
  assert.equal(job.state, "succeeded");
  assert.equal(job.completedFiles, 3);
  assert.equal(
    f.remote.entries.get("/sdcard/中文 '文件夹/a ' b.txt")!.toString(),
    "测试内容",
  );
  assert.equal(f.remote.entries.get("/sdcard/中文 '文件夹/空文件夹"), null);
  f.remote.entries.set("/sdcard/中文 '文件夹/link", Buffer.from("target"));
  f.remote.links.add("/sdcard/中文 '文件夹/link");
  const output = path.join(f.directory, "output");
  await mkdir(output);
  const download = await done(
    f.jobs.create(
      "download",
      "device-A",
      ["/sdcard/中文 '文件夹"],
      output + path.sep,
    ),
  );
  assert.equal(download.state, "succeeded");
  assert.equal(download.skipped, 1);
});

test("同名目录保留两份会重定向所有子项；下载保留空目录", async () => {
  const f = await fixture();
  f.remote.entries.set("/sdcard/相册", null);
  f.remote.entries.set("/sdcard/相册/空", null);
  f.remote.entries.set("/sdcard/相册/中文.txt", Buffer.from("hello"));
  await mkdir(path.join(f.directory, "相册"));
  await writeFile(path.join(f.directory, "相册", "original.txt"), "keep");
  const job = f.jobs.create(
    "download",
    "device-A",
    ["/sdcard/相册"],
    f.directory + path.sep,
  );
  await until(() => job.state === "conflict");
  f.jobs.resolve(job.id, "keep-both", false);
  await done(job);
  assert.equal(job.state, "succeeded");
  assert.equal(
    await readFile(path.join(f.directory, "相册 (1)", "中文.txt"), "utf8"),
    "hello",
  );
  assert.deepEqual(await readdir(path.join(f.directory, "相册 (1)", "空")), []);
  assert.equal(
    await readFile(path.join(f.directory, "相册", "original.txt"), "utf8"),
    "keep",
  );
});

test("失败项目可单独重试，传输失败清理临时文件", async () => {
  const f = await fixture();
  const a = path.join(f.directory, "good.txt"),
    b = path.join(f.directory, "broken.txt");
  await writeFile(a, "good");
  await writeFile(b, "later");
  f.remote.failOn = "broken.txt";
  const job = await done(
    f.jobs.create("upload", "device-A", [a, b], "/sdcard"),
  );
  assert.equal(job.state, "failed");
  assert.equal(job.completedFiles, 1);
  assert.equal(job.retryable, true);
  assert.equal(
    [...f.remote.entries.keys()].some((p) => p.endsWith(".part")),
    false,
  );
  f.remote.failOn = "";
  const retried = await done(f.jobs.retry(job.id));
  assert.equal(retried.state, "succeeded");
  assert.equal(retried.completedFiles, 1);
  assert.equal(f.remote.writes.filter((p) => p.includes("good.txt")).length, 1);
});

test("取消大文件传输保留已完成项目并清理临时文件；同设备任务串行", async () => {
  const f = await fixture();
  const a = path.join(f.directory, "large.bin"),
    b = path.join(f.directory, "next.txt");
  await writeFile(a, Buffer.alloc(2 * 1024 * 1024, 7));
  await writeFile(b, "next");
  const first = f.jobs.create("upload", "device-A", [a], "/sdcard");
  const second = f.jobs.create("upload", "device-A", [b], "/sdcard");
  assert.equal(second.state, "queued");
  assert.throws(() => f.adb.requireDevice("different-device"));
  f.remote.onChunk = () => {
    f.remote.onChunk = undefined;
    f.jobs.cancel(first.id);
  };
  await done(first);
  await done(second);
  assert.equal(first.state, "cancelled");
  assert.equal(second.state, "succeeded");
  assert.equal(
    [...f.remote.entries.keys()].some((p) => p.endsWith(".part")),
    false,
  );
  assert.equal(f.remote.entries.has("/sdcard/large.bin"), false);
  assert.equal(f.remote.entries.get("/sdcard/next.txt")!.toString(), "next");
});

test("下载无法表示的 Windows 文件名会清楚失败，不误报成功", async () => {
  const f = await fixture();
  f.remote.entries.set("/sdcard/test", null);
  f.remote.entries.set("/sdcard/test/bad:name", Buffer.from("x"));
  const job = await done(
    f.jobs.create(
      "download",
      "device-A",
      ["/sdcard/test"],
      f.directory + path.sep,
    ),
  );
  assert.equal(job.state, "failed");
  assert.ok(job.errors.length);
  assert.equal(job.retryable, true);
});

test("预览文本只读前 1 MiB，图片超过 20 MiB 拒绝预览", async () => {
  const f = await fixture();
  f.remote.entries.set("/sdcard/big.txt", Buffer.alloc(1024 * 1024 + 8, 65));
  f.remote.entries.set("/sdcard/big.png", Buffer.alloc(20 * 1024 * 1024 + 1));
  const result = await f.files.preview(
    "device-A",
    "/sdcard/big.txt",
    "text",
    "utf-8",
  );
  assert.equal(result.truncated, true);
  assert.equal(result.text!.length, 1024 * 1024);
  await assert.rejects(
    () => f.files.preview("device-A", "/sdcard/big.png", "image", "utf-8"),
    /20 MB/,
  );
});

test("kill-server 等待正在进行的设备查询结束，停止后不再启动监听", async () => {
  const adb = new AdbService();
  adb.state = {
    ...adb.state,
    path: "test-adb.exe",
    valid: true,
    server: "running",
  };
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  adb.run = async (args) => {
    calls.push(args[0]);
    if (args[0] === "devices") {
      await gate;
      return "List of devices attached\nA device usb:1 model:Test";
    }
    return "";
  };
  const refresh = adb.refresh();
  const stopping = adb.stop();
  await delay(10);
  assert.deepEqual(calls, ["devices"]);
  assert.throws(() => adb.requireDevice("A"), /ADB 操作/);
  release();
  await Promise.all([refresh, stopping]);
  assert.deepEqual(calls, ["devices", "kill-server"]);
  assert.equal(adb.state.server, "stopped");
  assert.deepEqual(adb.devices, []);
  assert.equal((adb as unknown as { monitoring: boolean }).monitoring, false);
  adb.pause();
});

test("本机 API 拒绝错误来源与无令牌请求；授权拒绝后可以重新连接", async () => {
  let approve = false;
  const app = createCompanion({
    origins: ["https://example.test"],
    port: 27189,
    approve: async () => approve,
  });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(27189, "127.0.0.1", resolve);
  });
  const request = (
    p: string,
    method = "GET",
    token?: string,
    origin = "https://example.test",
    body?: unknown,
  ) =>
    fetch("http://127.0.0.1:27189/v1" + p, {
      method,
      headers: {
        Origin: origin,
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal(
      (await request("/health", "GET", undefined, "https://evil.test")).status,
      403,
    );
    assert.equal((await request("/state")).status, 401);
    assert.equal((await request("/devices/identity?serial=A")).status, 401);
    assert.equal((await request("/session", "POST")).status, 403);
    approve = true;
    const session = (await (await request("/session", "POST")).json()) as {
      token: string;
    };
    assert.equal(session.token.length, 64);
    const state = await request("/state", "GET", session.token);
    assert.equal(state.status, 200);
    const payload = (await state.json()) as { capabilities: string[] };
    assert.ok(payload.capabilities.includes("device-identity"));
    const originalIdentity = app.adb.identity;
    app.adb.identity = async () => "hardware|" + "a".repeat(64);
    try {
      const identity = await request(
        "/devices/identity?serial=A",
        "GET",
        session.token,
      );
      assert.equal(identity.status, 200);
      assert.deepEqual(await identity.json(), {
        identityKey: "hardware|" + "a".repeat(64),
      });
    } finally {
      app.adb.identity = originalIdentity;
    }
    assert.equal(
      state.headers.get("access-control-allow-origin"),
      "https://example.test",
    );
    assert.equal(
      (
        await request("/devices/connect", "POST", session.token, undefined, {
          host: "x;echo",
          port: 5555,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/jobs", "POST", session.token, undefined, {
          kind: "upload",
          serial: "A",
          selectionId: "guessed",
          destination: "/sdcard",
        })
      ).status,
      400,
    );
  } finally {
    app.adb.pause();
    app.server.closeAllConnections();
    await new Promise<void>((r) => app.server.close(() => r()));
  }
});

test("文本预览提前结束时先关闭同步连接，避免取消流继续读取整个文件", async () => {
  const adb = new AdbService();
  let disposed = false,
    drained = false;
  const sync = {
    lstat: async () => ({
      mode: 0x8000,
      size: BigInt(64 * 1024 * 1024),
      mtime: BigInt(1),
    }),
    read: () => ({
      getReader: () => ({
        read: async () => ({
          done: false,
          value: new Uint8Array(1024 * 1024).fill(65),
        }),
        cancel: async () => {
          if (!disposed) drained = true;
        },
        releaseLock() {},
      }),
    }),
    dispose: async () => {
      disposed = true;
    },
  };
  adb.open = async () =>
    ({ sync: async () => sync, close: async () => {} }) as never;
  const preview = await new FileService(adb).preview(
    "A",
    "/sdcard/large.txt",
    "text",
    "utf-8",
  );
  assert.equal(preview.text!.length, 1024 * 1024);
  assert.equal(preview.truncated, true);
  assert.equal(drained, false);
  assert.equal(disposed, true);
});

test(
  "Windows 大小写目录重名：嵌套保留两份后，子项使用最深层的新路径",
  { skip: process.platform !== "win32" },
  async () => {
    const f = await fixture();
    f.remote.entries.set("/sdcard/root", null);
    f.remote.entries.set("/sdcard/root/A", null);
    f.remote.entries.set("/sdcard/root/A/one.txt", Buffer.from("one"));
    f.remote.entries.set("/sdcard/root/a", null);
    f.remote.entries.set("/sdcard/root/a/two.txt", Buffer.from("two"));
    await mkdir(path.join(f.directory, "root"));
    const job = f.jobs.create(
      "download",
      "device-A",
      ["/sdcard/root"],
      f.directory + path.sep,
    );
    await until(() => job.state === "conflict");
    f.jobs.resolve(job.id, "keep-both", true);
    await done(job);
    assert.equal(job.state, "succeeded");
    assert.equal(
      await readFile(
        path.join(f.directory, "root (1)", "A", "one.txt"),
        "utf8",
      ),
      "one",
    );
    assert.equal(
      await readFile(
        path.join(f.directory, "root (1)", "a (1)", "two.txt"),
        "utf8",
      ),
      "two",
    );
  },
);
