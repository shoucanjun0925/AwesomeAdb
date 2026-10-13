import {mkdir,readFile,writeFile,copyFile,readdir,rm} from "node:fs/promises";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import path from "node:path";
const root=process.cwd(),outputs=path.join(root,"outputs");
const version=JSON.parse(await readFile("package.json","utf8")).version;
const adb=JSON.parse(await readFile("vendor/adb/manifest.json","utf8"));
const sha=b=>createHash("sha256").update(b).digest("hex");
const forbidden=[/https:\/\/[^\s"'<>]*\.chatgpt\.site/i,/appgprj_[a-z0-9]+/i,/C:[\\/]Users[\\/]shoucanjun/i,/D:[\\/]Dev[\\/]Web[\\/]WebWorkSpace/i,/shoucanjun[^\s"']*@/i,/(?:ghp_|github_pat_)[a-zA-Z0-9_]{20,}/,/\bsk-[a-zA-Z0-9_-]{24,}/];
function inspect(bytes,name) {
  for(const encoding of ["utf8","utf16le"]) {
    const text=bytes.toString(encoding);
    if(forbidden.some(rule=>rule.test(text))) throw new Error("公开文件隐私检查失败："+name);
  }
}
async function cleanGenerated(dir) {
  if(path.dirname(path.resolve(dir))!==path.resolve(outputs)) throw new Error("生成目录超出 outputs");
  await rm(dir,{recursive:true,force:true});await mkdir(dir,{recursive:true});
}
async function zip(directory,destination) {
  const code="$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd()|ConvertFrom-Json; Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $p.directory -Force | Select-Object -ExpandProperty FullName) -DestinationPath $p.destination -Force";
  const result=spawnSync("powershell.exe",["-NoProfile","-EncodedCommand",Buffer.from(code,"utf16le").toString("base64")],{windowsHide:true,input:JSON.stringify({directory,destination})});
  if(result.status!==0) throw new Error("压缩包生成失败："+String(result.stderr));
}
await mkdir(outputs,{recursive:true});
const generic=path.join(outputs,"generic-package");await cleanGenerated(generic);
for(const name of ["AwesomeAdb 助手.exe","LICENSES.txt","ADB-NOTICE.txt","使用说明.txt"]) {
  const bytes=await readFile(path.join(outputs,`windows-v${version}`,name));inspect(bytes,name);await writeFile(path.join(generic,name),bytes);
}
const genericZip=path.join(outputs,`AwesomeAdb-Windows-x64-v${version}.zip`);await zip(generic,genericZip);
const source=path.join(outputs,"public-source");await cleanGenerated(source);
const listed=spawnSync("git",["ls-files","--cached","--others","--exclude-standard","-z"],{encoding:"utf8"});
if(listed.status!==0) throw new Error("无法获取源码文件");
for(const name of [...new Set(listed.stdout.split("\0").filter(Boolean))]) {
  if(name==="tsconfig.tsbuildinfo"||name===".openai/hosting.json"||/^(?:outputs|work|node_modules|\.git|\.sites-runtime|\.wrangler|dist)\//.test(name)) continue;
  const bytes=await readFile(path.join(root,name));inspect(bytes,name);
  await mkdir(path.dirname(path.join(source,name)),{recursive:true});await writeFile(path.join(source,name),bytes);
}
await mkdir(path.join(source,".openai"),{recursive:true});
await writeFile(path.join(source,".openai/hosting.json"),JSON.stringify({d1:"DB",r2:"BUCKET"},null,2)+"\n");
const sourceZip=path.join(outputs,`AwesomeAdb-Source-v${version}.zip`);await zip(source,sourceZip);
const release=path.join(outputs,"github-release");await cleanGenerated(release);
await copyFile(genericZip,path.join(release,path.basename(genericZip)));
await copyFile(sourceZip,path.join(release,path.basename(sourceZip)));
const tag=`v${version}`;
const remote={...adb,files:[]};
for(const file of adb.files) {
  const asset=`adb-${adb.version}-${file.name}`;
  await copyFile(path.join(root,"vendor/adb/files",file.name),path.join(release,asset));
  remote.files.push({...file,url:`https://github.com/shoucanjun0925/AwesomeAdb/releases/download/${tag}/${asset}`});
}
await writeFile(path.join(release,"adb-manifest.json"),JSON.stringify(remote,null,2)+"\n");
const assets=[];
for(const name of await readdir(release)) {const bytes=await readFile(path.join(release,name));inspect(bytes,name);assets.push({name,size:bytes.length,sha256:sha(bytes)});}
await writeFile(path.join(release,"SHA256SUMS.txt"),assets.map(f=>`${f.sha256}  ${f.name}`).join("\n")+"\n");
const siteIndex=process.argv.indexOf("--site-url");let privatePackage=null;
if(siteIndex>=0) {
  const u=new URL(process.argv[siteIndex+1]);
  if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash||u.pathname!=="/") throw new Error("私有站点配置必须为 HTTPS 首页");
  const dir=path.join(outputs,"private-package");await cleanGenerated(dir);
  for(const name of await readdir(generic)) await copyFile(path.join(generic,name),path.join(dir,name));
  await writeFile(path.join(dir,"AwesomeAdb-site.json"),JSON.stringify({schemaVersion:1,siteUrl:u.origin+"/"},null,2)+"\n");
  await mkdir(path.join(outputs,"private"),{recursive:true});
  const file=path.join(outputs,"private",path.basename(genericZip));await zip(dir,file);
  const bytes=await readFile(file);privatePackage={file,size:bytes.length,sha256:sha(bytes)};
}
await writeFile(path.join(outputs,"release.json"),JSON.stringify({version,adbVersion:adb.version,publicAssets:assets,privatePackage},null,2)+"\n");
console.log(JSON.stringify({version,adbVersion:adb.version,publicSource:source,publicAssets:assets.map(f=>f.name),privatePackage}));
