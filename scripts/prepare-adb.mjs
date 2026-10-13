import {mkdir,readFile,writeFile,copyFile,access} from "node:fs/promises";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import path from "node:path";
const root=process.cwd(),dir=path.join(root,"vendor/adb");
const lock=JSON.parse(await readFile(path.join(dir,"release.json"),"utf8"));
const names=["adb.exe","AdbWinApi.dll","AdbWinUsbApi.dll","libwinpthread-1.dll","NOTICE.txt","source.properties"];
let present=true;
for(const name of names) try {await access(path.join(dir,"files",name));} catch {present=false;}
if(!present) {
  if(process.platform!=="win32") throw new Error("准备 Windows ADB 载荷需要在 Windows 构建机运行");
  const download=path.join(root,"work","adb-"+lock.sha256.slice(0,12));
  await mkdir(download,{recursive:true});
  const response=await fetch(lock.sourceUrl,{signal:AbortSignal.timeout(120000)});
  if(!response.ok) throw new Error("无法下载官方 ADB："+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(createHash("sha256").update(bytes).digest("hex")!==lock.sha256) throw new Error("官方 ADB 包校验失败，请核对发布版本，不能直接使用变化后的包");
  const zip=path.join(download,"platform-tools.zip");await writeFile(zip,bytes);
  const script="$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd()|ConvertFrom-Json; Expand-Archive -LiteralPath $p.zip -DestinationPath $p.destination -Force";
  const result=spawnSync("powershell.exe",["-NoProfile","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{input:JSON.stringify({zip,destination:download}),windowsHide:true});
  if(result.status!==0) throw new Error("官方 ADB 解压失败");
  await mkdir(path.join(dir,"files"),{recursive:true});
  for(const name of names) await copyFile(path.join(download,"platform-tools",name),path.join(dir,"files",name));
}
const source=await readFile(path.join(dir,"files/source.properties"),"utf8");
if(!source.includes("Pkg.Revision="+lock.version)) throw new Error("ADB 版本与发布锁定文件不一致");
const files=[];
for(const name of names) {const b=await readFile(path.join(dir,"files",name));files.push({name,size:b.length,sha256:createHash("sha256").update(b).digest("hex")});}
const manifest={version:lock.version,files};
let previous;
try {previous=JSON.parse(await readFile(path.join(dir,"manifest.json"),"utf8"));} catch {}
if(previous?.version===manifest.version&&JSON.stringify(previous)!==JSON.stringify(manifest)) throw new Error("同版本 ADB 载荷与已锁定校验清单不一致");
await writeFile(path.join(dir,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
console.log("已验证 Windows ADB "+manifest.version+"，包含程序、DLL 和官方许可");
