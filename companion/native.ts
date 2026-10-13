import { spawn } from "node:child_process";

// Only fixed scripts are executed. User input travels as JSON on stdin.
const prelude = `[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $p = [Console]::In.ReadToEnd() | ConvertFrom-Json; `;
const scripts = {
  site: `$d=New-Object Windows.Forms.OpenFileDialog; $d.Title='导入工作台配置（从网页下载 AwesomeAdb-site.json）'; $d.Filter='工作台配置 (AwesomeAdb-site.json)|*.json'; if($d.ShowDialog() -eq 'OK'){ConvertTo-Json -Compress -InputObject @($d.FileName)}`,
  adb: `$d=New-Object Windows.Forms.OpenFileDialog; $d.Title='选择 adb.exe'; $d.Filter='ADB 程序 (adb.exe)|adb.exe'; if($d.ShowDialog() -eq 'OK'){ConvertTo-Json -Compress -InputObject @($d.FileName)}`,
  files: `$d=New-Object Windows.Forms.OpenFileDialog; $d.Title='选择要上传的文件'; $d.Multiselect=$true; if($d.ShowDialog() -eq 'OK'){ConvertTo-Json -Compress -InputObject @($d.FileNames)}`,
  folder: `$d=New-Object Windows.Forms.FolderBrowserDialog; $d.Description='选择文件夹'; $d.ShowNewFolderButton=$true; if($d.ShowDialog() -eq 'OK'){ConvertTo-Json -Compress -InputObject @($d.SelectedPath)}`,
  save: `$d=New-Object Windows.Forms.SaveFileDialog; $d.Title='选择下载保存位置'; $d.FileName=$p.name; $d.OverwritePrompt=$false; if($d.ShowDialog() -eq 'OK'){ConvertTo-Json -Compress -InputObject @($d.FileName)}`,
  confirm: `$r=[Windows.Forms.MessageBox]::Show($p.message,'AwesomeAdb 本机授权','YesNo','Question'); ConvertTo-Json -Compress -InputObject ($r -eq 'Yes')`,
  error: `[void][Windows.Forms.MessageBox]::Show($p.message,'AwesomeAdb','OK','Error'); 'true'`,
  open: `Start-Process -FilePath $p.url -WindowStyle Hidden; 'true'`,
};
let dialogBusy = false;
export async function native<T = string[]>(
  kind: keyof typeof scripts,
  input: object = {},
  signal?: AbortSignal,
): Promise<T> {
  if (dialogBusy && kind !== "open")
    throw new Error("请先完成当前 Windows 窗口中的操作");
  if (kind !== "open") dialogBusy = true;
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-STA",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(prelude + scripts[kind], "utf16le").toString("base64"),
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal },
      );
      let out = "",
        err = "";
      child.stdout.setEncoding("utf8").on("data", (c) => (out += c));
      child.stderr.setEncoding("utf8").on("data", (c) => (err += c));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve(out.trim())
          : reject(new Error(err || "无法打开 Windows 窗口")),
      );
      child.stdin.end(JSON.stringify(input));
    });
    return result ? JSON.parse(result) : ([] as T);
  } finally {
    if (kind !== "open") dialogBusy = false;
  }
}
