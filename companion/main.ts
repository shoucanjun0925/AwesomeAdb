import { appendFileSync } from "node:fs";
import path from "node:path";
import { createCompanion } from "./server";
import { native } from "./native";
import { dataDirectory, loadConfig } from "./config";
import { ManagedAdb } from "./managed-adb";
import { APP_VERSION, HELPER_PORT } from "../shared/contracts";
import { resolveSiteUrl } from "./site-config";
const dev = process.argv.includes("--dev");
async function main() {
  if (process.argv.includes("--self-test")) {
    const runtime = new ManagedAdb(loadConfig(), () => {});
    await runtime.initialize();
    console.log(
      JSON.stringify({
        app: "AwesomeAdb",
        version: APP_VERSION,
        platform: process.platform,
        arch: process.arch,
        runtime: process.version,
        adbVersion: runtime.state.installedVersion,
        embeddedFilesVerified: true,
        ok: true,
      }),
    );
    return;
  }
  const siteUrl = dev ? "http://127.0.0.1:5173/" : await resolveSiteUrl();
  const origins = [new URL(siteUrl).origin,
    ...(dev ? ["http://localhost:5173", "http://127.0.0.1:5173"] : [])];
  const current = (await fetch(`http://127.0.0.1:${HELPER_PORT}/v1/health`, {
    headers: { Origin: origins[0] },
    signal: AbortSignal.timeout(1000),
  })
    .then((r) => r.json())
    .catch(() => null)) as { app?: string; version?: string } | null;
  if (current?.app === "AwesomeAdb") {
    if (current.version !== APP_VERSION) await native("error", {
      message: `旧版助手 ${current.version || ""} 仍在运行。请先完成任务，在网页“连接与设置 → 高级设置”退出旧助手，然后重新启动新版。不会自动结束旧程序。`,
    });
    if (!process.argv.includes("--no-open"))
      await native("open", { url: dev ? origins[1] : siteUrl });
    return;
  }
  const app = createCompanion({ origins, onExit: () => process.exit(0) });
  await app.initialize();
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(HELPER_PORT, "127.0.0.1", () => resolve());
  });
  if (!process.argv.includes("--no-open"))
    await native("open", { url: dev ? origins[1] : siteUrl });
  const stop = () => {
    app.adb.pause();
    void app.jobs.cancelAll().finally(() => {
      app.server.closeAllConnections();
      app.server.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
void main().catch(async (error) => {
  appendFileSync(
    path.join(dataDirectory, "error.log"),
    `${new Date().toISOString()} ${error.code || ""} ${error.message}\n`,
  );
  await native("error", {
    message:
      error.code === "EADDRINUSE"
        ? `本机端口 ${HELPER_PORT} 被其他程序占用，请关闭占用程序后重试。`
        : error.message,
  }).catch(() => {});
  process.exitCode = 1;
});
