import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { Adb, AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import type { AdbConfiguration, AdbMode, Device } from "../shared/contracts";
import { environmentAdb, loadConfig, saveConfig } from "./config";
import { shellQuote } from "../shared/paths";
import { ManagedAdb } from "./managed-adb";

// Talk to the server directly: adb CLI may silently kill a server of another version.
export function serverRequest(request: string, timeout = 15000, encoding: BufferEncoding = "utf8", port = 5037): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({host: "127.0.0.1", port});
    let data = Buffer.alloc(0), done = false;
    const finish = (error?: Error, value = "") => {
      if (done) return; done = true; socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(timeout, () => finish(new Error("设备服务响应超时，请检查设备连接")));
    socket.once("error", e => finish(e));
    socket.once("connect", () => {
      const b = Buffer.from(request);
      socket.write(Buffer.concat([Buffer.from(b.length.toString(16).padStart(4, "0")), b]));
    });
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 4 * 1024 * 1024) return finish(new Error("设备服务响应过大"));
      if (data.length < 4) return;
      const status = data.toString("ascii", 0, 4);
      if (status !== "OKAY" && status !== "FAIL") return finish(new Error("5037 端口被其他程序占用，无法确认是 ADB 服务"));
      if (status === "OKAY" && request === "host:kill") return finish();
      if (data.length < 8) return;
      const header = data.toString("ascii", 4, 8);
      if (!/^[0-9a-f]{4}$/i.test(header)) return finish(new Error("ADB 服务返回了不兼容的数据"));
      const length = parseInt(header, 16);
      if (data.length < 8 + length) return;
      const value = data.toString(status === "FAIL" ? "utf8" : encoding, 8, 8 + length);
      finish(status === "FAIL" ? new Error(value) : undefined, value);
    });
    socket.on("end", () => { if (!done) finish(new Error("ADB 服务连接提前结束")); });
  });
}
export function statusVersion(bytes: Uint8Array): string | null {
  let i = 0;
  const number = () => {
    let value = 0, shift = 0;
    while (i < bytes.length && shift < 49) {
      const byte = bytes[i++]; value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value; shift += 7;
    }
    throw new Error("ADB 服务状态格式错误");
  };
  while (i < bytes.length) {
    const tag = number(), wire = tag & 7;
    if (wire === 0) number();
    else if (wire === 2) {
      const length = number(); if (i + length > bytes.length) return null;
      if (tag >>> 3 === 5) return Buffer.from(bytes.subarray(i, i + length)).toString("utf8");
      i += length;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else return null;
  }
  return null;
}

export class AdbService {
  config = loadConfig();
  state: AdbConfiguration = {
    mode: this.config.mode,
    path: null,
    version: null,
    environmentPath: null,
    valid: false,
    server: "stopped",
  };
  devices: Device[] = [];
  changed: () => void = () => {};
  isBusy: () => boolean = () => false;
  activeAccesses = 0;
  generation = 0;
  runtime = new ManagedAdb(this.config, () => this.changed());
  private ownedServer?: ChildProcess;
  private ownedServerPath?: string;
  private connections = new Set<Adb>();
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  private changing = false;
  private monitoring = false;
  private identityCache = new Map<string, string | null>();
  private identityReads = new Map<string, Promise<string | null>>();
  async initialize() {
    try {
      const exe = await this.runtime.initialize();
      await this.activateManaged(exe, () => {}, this.runtime.state.installedVersion || undefined);
      await this.start();
    } catch (e) {
      this.state.serviceError = (e as Error).message;
      this.changed();
    }
  }
  async run(args: string[], timeout = 15000, stdin?: string): Promise<string> {
    if (!this.state.valid || !this.state.path)
      throw new Error("内置 ADB 尚未准备好，请重新启动或更新助手");
    if (args[0] === "start-server") { await this.ensureServer(); return ""; }
    if (args[0] === "kill-server") {
      try { const version=await serverRequest("host:version", 3000); if(!/^[a-f0-9]{4}$/i.test(version)) throw new Error("无法确认当前服务是 ADB，未停止任何程序"); await serverRequest("host:kill", 3000); }
      catch(e) { if ((e as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw e; }
      this.generation++; return "";
    }
    if (args[0] === "devices") return "List of devices attached\n" + await serverRequest("host:devices-l", timeout);
    if (args[0] === "connect") return serverRequest(`host:connect:${args[1]}`, timeout);
    if (args[0] === "disconnect") return serverRequest(`host:disconnect:${args[1]}`, timeout);
    if (args[0] === "pair") return serverRequest(`host:pair:${stdin?.trim()}:${args[1]}`, timeout);
    if (args[0] === "-s") {
      const device = await this.openInternal(args[1]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const work = args[2] === "tcpip" ? device.tcpip.setPort(Number(args[3])) : (async () => {
          const command = args.length === 4 ? args[3] : args.slice(3).map(shellQuote).join(" ");
          if (device.subprocess.shellProtocol) {
            const result = await device.subprocess.shellProtocol.spawnWaitText(command);
            if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `设备操作失败 (${result.exitCode})`);
            return result.stdout.trim();
          }
          const marker = "__AWESOME_ADB_STATUS__";
          const result = await device.subprocess.noneProtocol.spawnWaitText(`${command}; printf '\\n${marker}%s' "$?"`);
          const position = result.lastIndexOf(marker);
          if (position < 0 || Number(result.slice(position + marker.length).trim()) !== 0) throw new Error(result.slice(0, position).trim() || "设备操作失败");
          return result.slice(0, position).trim();
        })();
        return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => { void device.close(); reject(new Error("设备操作超时")); }, timeout); })]);
      } finally { clearTimeout(timer); await device.close().catch(() => {}); }
    }
    throw new Error("不支持此 ADB 操作");
  }
  private async ensureServer() {
    let protocol: number | null = null;
    try { protocol = parseInt(await serverRequest("host:version", 3000), 16); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw e; }
    if (protocol !== null) {
      if (!Number.isFinite(protocol) || protocol < 41) throw new Error("当前设备服务与助手不兼容。请在设置中重启设备服务，使用内置 ADB。");
      AdbServerClient.parseDeviceList(await serverRequest("host:devices-l", 3000),["device","unauthorized","offline"]);
      this.state.serverSource = this.ownedServer && this.ownedServer.exitCode === null ? "managed" : "shared";
      this.state.serverVersion = this.state.serverSource === "managed" ? this.runtime.state.installedVersion : `协议 ${protocol}（共享服务）`;
      try { this.state.serverVersion = statusVersion(Buffer.from(await serverRequest("host:server-status", 1500, "latin1"), "latin1")) || this.state.serverVersion; } catch { /* Older servers lack this optional query. */ }
      this.state.serviceError = null;
      return;
    }
    const child = spawn(this.state.path!, ["-L", "tcp:localhost:5037", "server", "nodaemon"], {
      windowsHide: true, stdio: "ignore", env: {...process.env, ADB_SERVER_SOCKET:"tcp:localhost:5037", ADB_SERVER_PORT:"5037"},
    });
    let launchError: Error | undefined;
    child.once("error", e => { launchError = e; });
    this.ownedServer = child;
    this.ownedServerPath = this.state.path!;
    child.once("exit", () => { if (this.ownedServer === child) this.ownedServer = undefined; });
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (launchError) throw launchError;
      try {
        const value = parseInt(await serverRequest("host:version", 1000), 16);
        if (value < 41) throw new Error("ADB 服务版本不兼容");
        this.state.serverSource = this.ownedServer === child ? "managed" : "shared";
        this.state.serverVersion = this.ownedServer === child ? this.runtime.state.installedVersion : `协议 ${value}（共享服务）`;
        this.state.serviceError = null; this.generation++; return;
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw e; }
      if (child.exitCode !== null) throw new Error("内置 ADB 未能启动，请检查服务冲突后重试");
    }
    throw new Error("内置 ADB 启动超时，请重试");
  }
  async activateManaged(exe: string, commit: () => void | Promise<void>, expectedVersion?: string) {
    return this.control(async () => {
      const version = await this.runFile(exe, ["version"], 8000);
      if (!version.includes("Android Debug Bridge")) throw new Error("内置 ADB 校验失败");
      const actualVersion=version.match(/^Version\s+(\d+\.\d+\.\d+)(?:-|\s|$)/m)?.[1];
      if (expectedVersion && actualVersion !== expectedVersion)
        throw new Error("ADB 程序版本与更新清单不一致，原版本仍然保留");
      const oldState = {...this.state};
      const ownRunning = this.state.server === "running" && !!this.ownedServer && this.ownedServerPath === this.state.path;
      try {
        if (ownRunning) {
          const child = this.ownedServer!;
          await this.run(["kill-server"]);
          await new Promise<void>((resolve, reject) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const timer = setTimeout(() => reject(new Error("旧 ADB 服务尚未退出，请稍后重试")), 5000);
            child.once("exit", () => {clearTimeout(timer); resolve();});
          });
        }
        this.state = {...this.state, mode:"managed", path:exe, valid:true,
          environmentPath:null, version:version.split(/\r?\n/).slice(0,2).join(" · ")};
        if (ownRunning) await this.ensureServer();
        await commit();
        this.state.updatePendingRestart = oldState.server === "running" && !ownRunning && exe !== oldState.path;
        if (this.state.serverSource === "managed") this.state.serverVersion = this.runtime.state.installedVersion;
        this.generation++;
      } catch (e) {
        if (ownRunning && this.ownedServer && this.ownedServerPath === exe) {
          const failedChild = this.ownedServer;
          // Terminate only the child created by this activation, never an external PID.
          failedChild.kill();
          await new Promise<void>(resolve => {
            if (failedChild.exitCode !== null || failedChild.signalCode !== null) return resolve();
            const timer=setTimeout(resolve,2000);
            failedChild.once("exit",()=>{clearTimeout(timer);resolve();});
          });
        }
        this.state = oldState;
        if (ownRunning) await this.ensureServer().catch(() => { this.state.server = "stopped"; });
        throw e;
      }
    });
  }
  async updateManaged() {
    if (this.isBusy() || this.activeAccesses || this.changing) throw new Error("请等待当前任务和文件访问结束后再更新 ADB");
    const candidate = await this.runtime.prepareUpdate();
    try { await this.activateManaged(candidate.path, () => candidate.commit(), candidate.version); }
    catch (e) { this.runtime.fail(e); throw e; }
  }
  async restart() {
    return this.control(async () => {
      await this.run(["kill-server"]);
      for (let i=0; i<30; i++) {
        try { await serverRequest("host:version", 1000); await new Promise(r=>setTimeout(r,100)); }
        catch(e) { if ((e as NodeJS.ErrnoException).code === "ECONNREFUSED") break; throw e; }
        if (i === 29) throw new Error("服务尚未退出，请稍后重试");
      }
      this.state.server = "stopped";
      await this.ensureServer(); this.state.server = "running";
      this.state.updatePendingRestart = false;
      await this.readDevices();
    });
  }
  private runFile(
    file: string,
    args: string[],
    timeout: number,
    stdin?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        file,
        args,
        {
          windowsHide: true,
          timeout,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            // ADB only treats the literal localhost socket as locally startable.
            ADB_SERVER_SOCKET: "tcp:localhost:5037",
            ADB_SERVER_PORT: "5037",
          },
        },
        (error, out, err) => {
          if (error)
            reject(
              new Error((err || out || error.message).trim().slice(0, 1500)),
            );
          else resolve(out.trim());
        },
      );
      if (stdin) child.stdin?.end(stdin);
    });
  }
  async configure(mode: AdbMode, customPath?: string) {
    return this.control(async () => {
      if (this.isBusy())
        throw new Error("任务进行中，请完成或取消任务后再切换 ADB");
      const envPath = environmentAdb();
      const exe = mode === "environment" ? envPath : customPath;
      if (!exe)
        throw new Error(
          mode === "environment"
            ? "环境变量中未找到 adb.exe"
            : "请选择 adb.exe",
        );
      if (!(await stat(exe)).isFile() || !/\.exe$/i.test(exe))
        throw new Error("请选择有效的 adb.exe 文件");
      const version = await this.runFile(exe, ["version"], 8000);
      if (!version.includes("Android Debug Bridge"))
        throw new Error("所选程序不是有效的 Android ADB");
      this.pause();
      this.state = {
        mode,
        path: exe,
        environmentPath: envPath,
        version: version.split(/\r?\n/).slice(0, 2).join(" · "),
        valid: true,
        server: "stopped",
      };
      this.config.mode = mode;
      if (mode === "custom") this.config.customPath = exe;
      saveConfig(this.config);
      this.devices = [];
      this.identityCache.clear();
      this.changed();
      return this.state;
    });
  }
  private async control<T>(
    action: () => Promise<T>,
    allowBusy = false,
  ): Promise<T> {
    if (this.changing) throw new Error("ADB 操作进行中，请稍后重试");
    if (!allowBusy && (this.isBusy() || this.activeAccesses))
      throw new Error("任务进行中，请完成或取消任务后再操作 ADB 服务");
    this.changing = true;
    this.pause();
    try {
      await this.refreshing?.catch(() => {});
      await Promise.allSettled([...this.identityReads.values()]);
      if (allowBusy) await Promise.allSettled([...this.connections].map(c => c.close()));
      return await action();
    } finally {
      this.changing = false;
      if (this.state.server === "running") {
        this.monitoring = true;
        this.schedule();
      }
      this.changed();
    }
  }
  async start() {
    return this.control(async () => {
      await this.run(["start-server"]);
      this.state.server = "running";
      await this.readDevices();
    });
  }
  pause() {
    this.monitoring = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  async stop() {
    return this.control(async () => {
      this.state.server = "stopped";
      this.devices = [];
      this.identityCache.clear();
      this.changed();
      await this.run(["kill-server"]);
    }, true);
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.monitoring && !this.changing && this.state.server === "running")
      this.timer = setTimeout(() => {
        void this.refresh().catch(() => {
          this.devices = [];
          this.state.serviceError = "设备服务连接中断，请检查连接后重新检测设备";
          this.changed();
        });
      }, 2500);
  }
  private async readDevices() {
    const output = await this.run(["devices", "-l"]);
    this.devices = output
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("List ") && !l.startsWith("* "))
      .map((line) => {
        const [serial, state] = line.trim().split(/\s+/);
        return {
          serial,
          state,
          model: (line.match(/model:(\S+)/)?.[1] || serial).replace(/_/g, " "),
          transport: serial.startsWith("emulator-")
            ? "emulator"
            : line.includes("usb:") ||
                (!serial.includes(":") && !serial.includes("._tcp"))
              ? "usb"
              : "tcp",
        } as Device;
      });
    for (const key of this.identityCache.keys())
      if (!this.devices.some((d) => d.serial === key && d.state === "device"))
        this.identityCache.delete(key);
    this.changed();
  }
  refresh(): Promise<void> {
    if (this.changing)
      return Promise.reject(new Error("ADB 操作进行中，请稍后重试"));
    if (this.refreshing) return this.refreshing;
    this.monitoring = true;
    this.refreshing = (async () => {
      if (this.state.server === "stopped") {
        await this.run(["start-server"]);
        this.state.server = "running";
      }
      await this.readDevices();
    })().finally(() => {
      this.refreshing = undefined;
      this.schedule();
    });
    return this.refreshing;
  }
  async connect(host: string, port: number) {
    return this.control(async () => {
      const endpoint = this.endpoint(host, port);
      await this.run(["start-server"]);
      const output = await this.run(["connect", endpoint], 20000);
      if (!/connected to|already connected/i.test(output))
        throw new Error(output || "连接失败，请检查地址、端口和无线调试设置");
      this.state.server = "running";
      await this.readDevices();
      return output;
    });
  }
  async pair(host: string, port: number, code: string) {
    return this.control(async () => {
      await this.run(["start-server"]);
      const output = await this.run(
        ["pair", this.endpoint(host, port)],
        30000,
        code + "\n",
      ).catch(e => {
        if (/unknown.*service|not supported/i.test((e as Error).message)) {
          this.state.serviceError = "当前设备服务不支持无线配对，请重新启动设备服务后重试";
          throw new Error(this.state.serviceError);
        }
        throw e;
      });
      if (!/successfully paired/i.test(output))
        throw new Error(output || "配对失败，请检查配对码与配对端口");
      this.state.server = "running";
      return output;
    });
  }
  endpoint(host: string, port: number) {
    return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  }
  async disconnect(serial: string) {
    return this.control(async () => {
      await this.run(["disconnect", serial]);
      await this.readDevices();
    });
  }
  async tcpip(serial: string, port: number) {
    this.requireDevice(serial);
    return this.control(async () => {
      await this.run(["-s", serial, "tcpip", String(port)]);
      await this.readDevices();
    });
  }
  requireDevice(serial: string) {
    if (this.changing) throw new Error("ADB 操作进行中，请稍后再创建任务");
    if (["downloading", "installing"].includes(this.runtime.state.status)) throw new Error("正在更新 ADB，请稍后再创建任务");
    if (this.state.server === "stopped")
      throw new Error("ADB 服务已停止，请先启动服务");
    if (!this.devices.some((d) => d.serial === serial && d.state === "device"))
      throw new Error("设备未连接或尚未授权，请在设备上允许 USB 调试");
  }
  async identity(serial: string): Promise<string | null> {
    this.requireDevice(serial);
    if (this.devices.find((d) => d.serial === serial)?.transport === "emulator")
      return null;
    if (this.identityCache.has(serial)) return this.identityCache.get(serial)!;
    const running = this.identityReads.get(serial);
    if (running) return running;
    const read = (async () => {
      try {
        for (const property of ["ro.serialno", "ro.boot.serialno"]) {
          const value = (
            await this.run(["-s", serial, "shell", "getprop", property], 4000)
          ).trim();
          if (
            value &&
            value.length <= 512 &&
            !/^(unknown|null|none|0+|0123456789abcdef)$/i.test(value)
          ) {
            const key =
              "hardware|" + createHash("sha256").update(value).digest("hex");
            this.identityCache.set(serial, key);
            return key;
          }
        }
      } catch {
        /* Device identity is optional; a manual association remains available. */
      }
      this.identityCache.set(serial, null);
      return null;
    })();
    this.identityReads.set(serial, read);
    try {
      return await read;
    } finally {
      this.identityReads.delete(serial);
    }
  }
  async open(serial: string): Promise<Adb> {
    this.requireDevice(serial);
    return this.openInternal(serial);
  }
  private async openInternal(serial: string): Promise<Adb> {
    this.activeAccesses++;
    const client = new AdbServerClient(
      new AdbServerNodeTcpConnector({ host: "127.0.0.1", port: 5037 }),
    );
    try {
      const transport = await client.createTransport({ serial });
      const device = new Adb(transport), close = device.close.bind(device);
      this.connections.add(device);
      let released = false;
      device.close = async () => { try { await close(); } finally { if (!released) { released = true; this.activeAccesses--; this.connections.delete(device); } } };
      return device;
    } catch (e) { this.activeAccesses--; throw e; }
  }
  async shell(serial: string, command: "mkdir" | "rm" | "mv", args: string[]) {
    this.requireDevice(serial);
    const flags =
      command === "mkdir" ? "-p --" : command === "rm" ? "-rf --" : "--";
    await this.run(
      [
        "-s",
        serial,
        "shell",
        `${command} ${flags} ${args.map(shellQuote).join(" ")}`,
      ],
      30000,
    );
  }
}
