import {
  createServer,
  type ServerResponse,
  type IncomingMessage,
} from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  APP_VERSION,
  API_VERSION,
  HELPER_PORT,
  type HelperState,
} from "../shared/contracts";
import { remotePath, windowsName } from "../shared/paths";
import { AdbService } from "./adb";
import { FileService } from "./files";
import { JobService } from "./jobs";
import { native } from "./native";

const serial = z.string().min(1).max(512);
const endpoint = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.:%_-]+$/),
  port: z.number().int().min(1).max(65535),
});
export interface ServerOptions {
  origins: string[];
  port?: number;
  approve?: (origin: string) => Promise<boolean>;
  onExit?: () => void;
}
export function createCompanion(options: ServerOptions) {
  const adb = new AdbService(),
    files = new FileService(adb),
    jobs = new JobService(adb, files);
  const events = new EventEmitter();
  events.setMaxListeners(30);
  const sessions = new Map<string, { origin: string; expires: number }>();
  const selections = new Map<
    string,
    { paths: string[]; kind: string; expires: number; sessionToken: string }
  >();
  const mutationLocks = new Set<string>();
  adb.isBusy = () => jobs.busy || mutationLocks.size > 0;
  let pairing = false;
  let serviceStopping = false;
  const port = options.port ?? HELPER_PORT;
  const state = (): HelperState => ({
    app: "AwesomeAdb",
    apiVersion: API_VERSION,
    version: APP_VERSION,
    machineId: adb.config.machineId,
    machineName: os.hostname(),
    adb: adb.state,
    devices: adb.devices,
    jobs: jobs.jobs,
    capabilities: [
      "managed-adb",
      "files",
      "pairing",
      "native-dialogs",
      "jobs",
      "device-identity",
    ],
    adbRuntime: adb.runtime.state,
  });
  const changed = () => events.emit("state");
  adb.changed = changed;
  jobs.changed = changed;
  const json = (res: ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(data));
  };
  async function body(req: IncomingMessage) {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 128 * 1024) throw new Error("请求内容过大");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }
  async function mutation<T>(id: string, fn: () => Promise<T>) {
    if (mutationLocks.has(id) || jobs.busyDevice(id))
      throw new Error("该设备有任务进行中，请稍后重试");
    mutationLocks.add(id);
    try {
      return await fn();
    } finally {
      mutationLocks.delete(id);
    }
  }
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin || "";
    const requestAbort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) requestAbort.abort();
    });
    try {
      if (
        req.headers.host !== `127.0.0.1:${port}` &&
        req.headers.host !== `localhost:${port}`
      )
        return json(
          res,
          { error: { code: "INVALID_HOST", message: "请求主机不正确" } },
          403,
        );
      if (!options.origins.includes(origin))
        return json(
          res,
          { error: { code: "ORIGIN_DENIED", message: "该网页尚未被助手授权" } },
          403,
        );
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      res.setHeader("Access-Control-Allow-Private-Network", "true");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`),
        route = url.pathname;
      if (route === "/v1/health" && req.method === "GET")
        return json(res, {
          app: "AwesomeAdb",
          apiVersion: API_VERSION,
          version: APP_VERSION,
        });
      if (route === "/v1/session" && req.method === "POST") {
        if (pairing) throw new Error("请先在 Windows 授权窗口中确认");
        pairing = true;
        try {
          const approved = await (
            options.approve ||
            ((site: string) =>
              native<boolean>(
                "confirm",
                {
                  message: `允许此 AwesomeAdb 网页连接本机助手吗？\n\n${site}\n\n它将能够通过你选择的 ADB 管理设备文件。本次授权在助手退出后失效。`,
                },
                requestAbort.signal,
              ))
          )(origin);
          if (!approved)
            return json(
              res,
              {
                error: {
                  code: "PAIR_DENIED",
                  message: "本机授权已取消，可再次连接助手",
                },
              },
              403,
            );
          for (const [key, s] of sessions)
            if (s.expires < Date.now()) sessions.delete(key);
          if (sessions.size >= 10)
            sessions.delete(sessions.keys().next().value!);
          const token = randomBytes(32).toString("hex");
          sessions.set(token, {
            origin,
            expires: Date.now() + 24 * 60 * 60 * 1000,
          });
          return json(res, { token, state: state() });
        } finally {
          pairing = false;
        }
      }
      const token = req.headers.authorization?.replace(/^Bearer /, ""),
        session = token ? sessions.get(token) : null;
      if (!session || session.origin !== origin || session.expires < Date.now())
        return json(
          res,
          { error: { code: "SESSION_EXPIRED", message: "请重新连接本地助手" } },
          401,
        );
      if (route === "/v1/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        const send = () => {
          if (!res.destroyed && res.writableLength < 1024 * 1024)
            res.write(`data: ${JSON.stringify(state())}\n\n`);
        };
        send();
        events.on("state", send);
        const timer = setInterval(() => res.write(": heartbeat\n\n"), 15000);
        res.on("close", () => {
          events.off("state", send);
          clearInterval(timer);
        });
        return;
      }
      if (route === "/v1/state" && req.method === "GET")
        return json(res, state());
      if (route === "/v1/adb/runtime" && req.method === "GET") return json(res,adb.runtime.state);
      if (route === "/v1/devices/identity" && req.method === "GET")
        return json(res, {
          identityKey: await adb.identity(
            serial.parse(url.searchParams.get("serial")),
          ),
        });
      if (route === "/v1/files" && req.method === "GET")
        return json(
          res,
          await files.list(
            serial.parse(url.searchParams.get("serial")),
            remotePath(url.searchParams.get("path") || "/sdcard"),
          ),
        );
      if (req.method !== "POST")
        return json(
          res,
          { error: { code: "NOT_FOUND", message: "接口不存在" } },
          404,
        );
      const input = await body(req);
      if (serviceStopping) throw new Error("正在停止服务，请等待任务清理完成");
      if (route === "/v1/adb/check-update") {await adb.runtime.checkUpdate();return json(res,state());}
      if (route === "/v1/adb/update") {await adb.updateManaged();return json(res,state());}
      if (route === "/v1/adb/restart") {await adb.restart();return json(res,state());}
      if (route === "/v1/adb/configure") {
        const p = z
          .object({
            mode: z.enum(["environment", "custom"]),
            path: z.string().optional(),
          })
          .parse(input);
        await adb.configure(p.mode, p.path);
        return json(res, state());
      }
      if (route === "/v1/adb/start" || route === "/v1/devices/refresh") {
        await adb.start();
        return json(res, state());
      }
      if (route === "/v1/adb/stop") {
        serviceStopping = true;
        try {
          await jobs.cancelAll();
          await adb.stop();
        } finally {
          serviceStopping = false;
        }
        return json(res, state());
      }
      if (route === "/v1/devices/connect") {
        const p = endpoint.parse(input);
        const message = await adb.connect(p.host, p.port);
        return json(res, { message, state: state() });
      }
      if (route === "/v1/devices/pair") {
        const p = endpoint
          .extend({ code: z.string().regex(/^\d{6}$/) })
          .parse(input);
        const message = await adb.pair(p.host, p.port, p.code);
        return json(res, { message });
      }
      if (route === "/v1/devices/disconnect") {
        const p = z.object({ serial }).parse(input);
        if (jobs.busyDevice(p.serial))
          throw new Error("请先完成或取消该设备的任务");
        await adb.disconnect(p.serial);
        return json(res, state());
      }
      if (route === "/v1/devices/tcpip") {
        const p = z
          .object({ serial, port: z.number().int().min(1).max(65535) })
          .parse(input);
        if (jobs.busyDevice(p.serial))
          throw new Error("请先完成或取消该设备的任务");
        await adb.tcpip(p.serial, p.port);
        return json(res, state());
      }
      if (route === "/v1/dialog") {
        const p = z
          .object({
            kind: z.enum(["adb", "files", "folder", "save"]),
            name: z.string().max(255).optional(),
          })
          .parse(input);
        const paths = await native(
          p.kind,
          {
            name:
              p.kind === "save" ? windowsName(p.name || "download") : undefined,
          },
          requestAbort.signal,
        );
        if (!paths.length) return json(res, { cancelled: true });
        for (const [key, s] of selections)
          if (s.expires < Date.now()) selections.delete(key);
        const selectionId = randomUUID();
        selections.set(selectionId, {
          paths,
          kind: p.kind,
          expires: Date.now() + 10 * 60 * 1000,
          sessionToken: token!,
        });
        return json(res, { selectionId, paths });
      }
      if (route === "/v1/files/preview") {
        const p = z
          .object({
            serial,
            path: z.string(),
            kind: z.enum(["text", "image"]),
            encoding: z.enum(["utf-8", "gb18030"]).default("utf-8"),
          })
          .parse(input);
        return json(
          res,
          await files.preview(p.serial, remotePath(p.path), p.kind, p.encoding),
        );
      }
      if (route === "/v1/files/mkdir" || route === "/v1/files/rename") {
        const p = z
          .object({
            serial,
            path: z.string(),
            name: z.string().min(1).max(255),
          })
          .parse(input);
        await mutation(p.serial, () =>
          route.endsWith("mkdir")
            ? files.mkdir(p.serial, remotePath(p.path), p.name)
            : files.rename(p.serial, remotePath(p.path), p.name),
        );
        return json(res, { ok: true });
      }
      if (route === "/v1/jobs") {
        const p = z
          .object({
            kind: z.enum(["upload", "download", "delete"]),
            serial,
            paths: z.array(z.string()).max(10000).optional(),
            selectionId: z.string().optional(),
            destination: z.string().optional(),
          })
          .parse(input);
        if (mutationLocks.has(p.serial))
          throw new Error("设备文件操作进行中，请稍后重试");
        let inputs = p.paths || [],
          destination = p.destination || "";
        if (p.kind !== "delete") {
          const s = p.selectionId ? selections.get(p.selectionId) : null;
          if (!s || s.expires < Date.now() || s.sessionToken !== token)
            throw new Error("文件选择已失效，请重新选择");
          selections.delete(p.selectionId!);
          if (p.kind === "upload") {
            if (!["files", "folder"].includes(s.kind))
              throw new Error("请选择要上传的文件");
            inputs = s.paths;
            destination = remotePath(destination);
          } else {
            if (!["folder", "save"].includes(s.kind))
              throw new Error("请选择下载位置");
            inputs = inputs.map(remotePath);
            if (s.kind === "save" && inputs.length !== 1)
              throw new Error("多个项目请使用文件夹作为保存位置");
            destination = s.paths[0] + (s.kind === "folder" ? path.sep : "");
          }
        } else inputs = inputs.map(remotePath);
        return json(
          res,
          jobs.create(p.kind, p.serial, inputs, destination),
          202,
        );
      }
      const match = route.match(
        /^\/v1\/jobs\/([a-f0-9-]+)\/(cancel|retry|resolve)$/,
      );
      if (match) {
        if (match[2] === "cancel") jobs.cancel(match[1]);
        if (match[2] === "retry") return json(res, jobs.retry(match[1]), 202);
        if (match[2] === "resolve") {
          const p = z
            .object({
              action: z.enum(["overwrite", "skip", "keep-both"]),
              all: z.boolean(),
            })
            .parse(input);
          jobs.resolve(match[1], p.action, p.all);
        }
        return json(res, { ok: true });
      }
      if (route === "/v1/shutdown") {
        serviceStopping = true;
        await jobs.cancelAll();
        adb.pause();
        json(res, { ok: true });
        setTimeout(() => {
          server.closeAllConnections();
          server.close();
          options.onExit?.();
        }, 150);
        return;
      }
      return json(
        res,
        { error: { code: "NOT_FOUND", message: "接口不存在" } },
        404,
      );
    } catch (e) {
      if (res.destroyed) return;
      let message =
        e instanceof z.ZodError
          ? "输入格式不正确，请检查地址、端口或文件名称"
          : (e as Error).message;
      const friendly: Record<string, string> = {
        EACCES: "没有访问权限，请选择设备允许 ADB 访问的目录",
        EPERM: "操作被拒绝，请检查设备或电脑上的文件权限",
        EROFS: "目标目录是只读的，无法写入",
        ENOSPC: "目标位置剩余空间不足",
        ENOENT: "文件或目录已不存在，请刷新后重试",
        ENOTDIR: "路径中的项目不是文件夹",
      };
      message = friendly[message] || message;
      if (!res.headersSent)
        json(res, { error: { code: "OPERATION_FAILED", message } }, 400);
      else res.end();
    }
  });
  server.requestTimeout = 0;
  return {
    server,
    adb,
    files,
    jobs,
    state,
    initialize: () => adb.initialize(),
    port,
  };
}
