import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { AdbSync } from "@yume-chan/adb";
import { AdbService } from "./adb";
import {
  remoteJoin,
  remoteName,
  remotePath,
  assertMutablePath,
} from "../shared/paths";
import type { FileEntry } from "../shared/contracts";

export interface RemoteFiles {
  list(p: string): Promise<FileEntry[]>;
  stat(p: string): Promise<FileEntry | null>;
  read(p: string): AsyncIterable<Uint8Array>;
  write(p: string, stream: AsyncIterable<Uint8Array>): Promise<void>;
  mkdir(p: string): Promise<void>;
  remove(p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  dispose(): Promise<void>;
}
function entry(
  p: string,
  s: { mode: number; size: bigint; mtime: bigint },
  name = remoteName(p),
): FileEntry {
  const type = s.mode & 0xf000;
  return {
    name,
    path: p,
    type:
      type === 0x4000
        ? "directory"
        : type === 0x8000
          ? "file"
          : type === 0xa000
            ? "symlink"
            : "other",
    size: Number(s.size),
    modifiedAt: Number(s.mtime) * 1000,
    mode: s.mode,
  };
}
export class FileService {
  constructor(private adb: AdbService) {}
  async open(serial: string): Promise<RemoteFiles> {
    const adb = await this.adb.open(serial);
    let sync: AdbSync;
    try { sync = await adb.sync(); }
    catch(e) { await adb.close().catch(() => {}); throw e; }
    return {
      list: async (p) => {
        const list = await sync.readdir(remotePath(p));
        return list
          .filter((e) => e.name !== "." && e.name !== "..")
          .map((e) => entry(remoteJoin(p, e.name), e, e.name));
      },
      stat: async (p) => {
        try {
          const s = await sync.lstat(remotePath(p));
          return s.mode === 0 ? null : entry(p, s);
        } catch (e) {
          if ((e as Error).message.includes("ENOENT")) return null;
          throw e;
        }
      },
      read: async function* (p) {
        const reader = sync.read(remotePath(p)).getReader();
        let completed = false;
        try {
          while (true) {
            const r = await reader.read();
            if (r.done) {
              completed = true;
              break;
            }
            yield r.value;
          }
        } finally {
          // Tango drains an unfinished pull on cancel. Close this dedicated sync
          // connection first so a bounded preview does not read the entire file.
          if (!completed) await sync.dispose().catch(() => {});
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      },
      write: async (p, stream) => {
        const iterator = stream[Symbol.asyncIterator]();
        const readable = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const r = await iterator.next();
              if (r.done) controller.close();
              else controller.enqueue(r.value);
            } catch (e) {
              controller.error(e);
            }
          },
          async cancel() {
            await iterator.return?.();
          },
        });
        await sync.write({
          filename: assertMutablePath(p),
          file: readable as never,
        });
      },
      mkdir: (p) => this.adb.shell(serial, "mkdir", [remotePath(p)]),
      remove: (p) => this.adb.shell(serial, "rm", [assertMutablePath(p)]),
      rename: (from, to) =>
        this.adb.shell(serial, "mv", [
          assertMutablePath(from),
          assertMutablePath(to),
        ]),
      dispose: async () => {
        await sync.dispose().catch(() => {});
        await adb.close().catch(() => {});
      },
    };
  }
  async list(serial: string, p: string) {
    const fs = await this.open(serial);
    try {
      return await fs.list(p);
    } finally {
      await fs.dispose();
    }
  }
  async mkdir(serial: string, parent: string, name: string) {
    const p = remoteJoin(parent, name),
      fs = await this.open(serial);
    try {
      if (await fs.stat(p)) throw new Error("同名文件或文件夹已经存在");
      await fs.mkdir(p);
    } finally {
      await fs.dispose();
    }
  }
  async rename(serial: string, from: string, name: string) {
    const p = assertMutablePath(from),
      target = remoteJoin(p.slice(0, p.lastIndexOf("/")) || "/", name),
      fs = await this.open(serial);
    try {
      if (await fs.stat(target)) throw new Error("同名文件或文件夹已经存在");
      await fs.rename(p, target);
    } finally {
      await fs.dispose();
    }
  }
  async preview(
    serial: string,
    p: string,
    kind: "text" | "image",
    encoding: string,
  ) {
    const fs = await this.open(serial);
    try {
      const info = await fs.stat(p);
      if (!info || info.type !== "file") throw new Error("无法预览该文件");
      const limit = kind === "image" ? 20 * 1024 * 1024 : 1024 * 1024;
      if (kind === "image" && info.size > limit)
        throw new Error("图片超过 20 MB，请下载后查看");
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of fs.read(p)) {
        const part = chunk.subarray(0, limit - length);
        chunks.push(part);
        length += part.length;
        if (length >= limit) break;
      }
      const buffer = Buffer.concat(chunks);
      if (kind === "text")
        return {
          text: new TextDecoder(encoding).decode(buffer),
          truncated: info.size > limit,
        };
      const ext = path.posix.extname(p).toLowerCase();
      const types: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
      };
      if (!types[ext]) throw new Error("此图片格式暂不支持，请下载查看");
      return { data: buffer.toString("base64"), mime: types[ext] };
    } finally {
      await fs.dispose();
    }
  }
}
export async function localStat(p: string) {
  try {
    return await lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export const localFs = {
  localStat,
  lstat,
  mkdir,
  readdir,
  rename,
  unlink,
  createReadStream,
  createWriteStream,
};
