import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import path from "node:path";
const root = process.cwd();
const development = process.argv.includes("--dev");
const adbManifest = JSON.parse(readFileSync("vendor/adb/manifest.json", "utf8"));
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const output = path.join(root, "outputs", `windows-v${version}`);
mkdirSync(output, { recursive: true });
const bundle = await build({
  entryPoints: ["companion/main.ts"],
  outfile: path.join(output, "companion.cjs"),
  bundle: true,
  metafile: true,
  platform: "node",
  target: "node26",
  format: "cjs",
  logLevel: "info",
});
if (development) {
  const child = spawn(
    process.execPath,
    [path.join(output, "companion.cjs"), "--dev", "--no-open"],
    { stdio: "inherit", windowsHide: true },
  );
  process.on("SIGINT", () => child.kill());
  child.on("exit", (code) => (process.exitCode = code || 0));
} else {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    Number(process.versions.node.split(".")[0]) < 26
  )
    throw new Error("发布助手需要 Windows x64 与 Node.js 26.3 或更高版本");
  const exe = path.join(output, "AwesomeAdb 助手.exe"),
    config = path.join(output, "sea-config.json");
  writeFileSync(
    config,
    JSON.stringify({
      main: path.relative(root, path.join(output, "companion.cjs")),
      output: exe,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
      execArgvExtension: "none",
      assets: Object.fromEntries([
        ["adb/manifest.json", "vendor/adb/manifest.json"],
        ...adbManifest.files.map(file => [`adb/${file.name}`,`vendor/adb/files/${file.name}`]),
      ]),
    }),
  );
  const result = spawnSync(process.execPath, ["--build-sea", config], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status || 1);
  // GUI subsystem avoids an empty console window when launched from Explorer.
  const bytes = readFileSync(exe),
    pe = bytes.readUInt32LE(0x3c);
  if (bytes.toString("ascii", pe, pe + 4) !== "PE\0\0")
    throw new Error("Invalid Windows executable");
  bytes.writeUInt16LE(2, pe + 24 + 68);
  writeFileSync(exe, bytes);
  const packages = new Set(
    Object.keys(bundle.metafile.inputs)
      .filter((p) => p.startsWith("node_modules/"))
      .map((p) => {
        const parts = p.split("/");
        return parts[1].startsWith("@")
          ? parts.slice(0, 3).join("/")
          : parts.slice(0, 2).join("/");
      }),
  );
  let licenses =
    "AwesomeAdb 使用以下开源组件。\r\n\r\n=== Node.js " +
    process.version +
    " ===\r\n" +
    readFileSync("vendor/Node-LICENSE.txt", "utf8");
  for (const dir of [...packages].sort()) {
    const pkg = JSON.parse(
      readFileSync(path.join(dir, "package.json"), "utf8"),
    );
    const file = readdirSync(dir).find((f) => /^licen[sc]e(?:\.|$)/i.test(f));
    if (!file) throw new Error("缺少开源许可: " + pkg.name);
    licenses +=
      "\r\n\r\n=== " +
      pkg.name +
      " " +
      pkg.version +
      " ===\r\n" +
      readFileSync(path.join(dir, file), "utf8");
  }
  writeFileSync(path.join(output, "LICENSES.txt"), licenses);
  writeFileSync(path.join(output,"ADB-NOTICE.txt"),readFileSync("vendor/adb/files/NOTICE.txt"));
  writeFileSync(
    path.join(output, "使用说明.txt"),
    `AwesomeAdb ${version}\r\n\r\n1. 将压缩包解压，双击 AwesomeAdb 助手.exe。已内置 ADB，无需配置路径或安装 Node.js。\r\n2. 从工作台下载的安装包会自动打开网页。GitHub 通用包请先从自己的工作台下载 AwesomeAdb-site.json，放在助手旁边；也可以在启动时选择导入。\r\n3. 网页“连接与设置”中连接助手，允许本地网络访问，并在 Windows 授权窗口选择“是”。\r\n4. 连接设备并填写备注。USB 设备需要打开 USB 调试并授权电脑；无线配对按页面提示分别填写配对和连接端口。\r\n5. 完成设置后，从设备首页进入文件管理，使用“上传到设备”和“下载到电脑”。\r\n\r\nADB 更新完全手动。在设置中点击“检查更新”，需要时再点击“更新 ADB”；未更新仍可使用。\r\n升级助手前请完成任务并退出旧助手，再启动新版。升级会保留电脑标识、备注和连接记录，不会强制升级已经安装的 ADB。\r\nWindows 10/11 x64。文件内容在电脑与设备之间直接传输。\r\n开源组件许可见 LICENSES.txt 和 ADB-NOTICE.txt。\r\n`,
  );
  console.log(`Windows helper: ${exe}`);
}
