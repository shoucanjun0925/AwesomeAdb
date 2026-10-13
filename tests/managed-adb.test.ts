import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {mkdir,mkdtemp,writeFile,readFile,readdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {createServer} from "node:net";
import {EventEmitter} from "node:events";
import {ManagedAdb,newerVersion,validateAssetUrl,adbManifestSchema,type AdbManifest} from "../companion/managed-adb";
import {dataDirectory,loadConfig,type LocalConfig} from "../companion/config";
import {AdbService,serverRequest,statusVersion} from "../companion/adb";
import {validatedSiteUrl,downloadManifestSchema} from "../shared/downloads";

const digest=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
async function bundle(version:string,dir:string) {
  await mkdir(path.join(dir,"files"),{recursive:true});
  const files=[];
  for(const name of ["adb.exe","AdbWinApi.dll","NOTICE.txt"]) {
    const bytes=Buffer.from(version+" "+name);
    await writeFile(path.join(dir,"files",name),bytes);
    files.push({name,size:bytes.length,sha256:digest(bytes)});
  }
  const manifest={version,files};await writeFile(path.join(dir,"manifest.json"),JSON.stringify(manifest));return manifest;
}
async function fixture() {
  await mkdir(".sites-runtime/tests/managed",{recursive:true});
  const root=await mkdtemp(path.resolve(".sites-runtime/tests/managed/case-"));
  const bundled=path.join(root,"bundle"),installed=path.join(root,"installed");
  const config:LocalConfig={machineId:"test-machine",mode:"managed",customPath:null,adbVersion:null};
  const manifest=await bundle("1.0.0",bundled);
  return {root,bundled,installed,config,manifest};
}
test("首次自动提取内置 ADB，升级助手后继续使用已安装版本且不访问网络",async()=>{
  const f=await fixture();let requests=0;
  const request=(async()=>{requests++;throw new Error("不应联网");}) as typeof fetch;
  const runtime=new ManagedAdb(f.config,()=>{},f.installed,f.bundled,request);
  const exe=await runtime.initialize();assert.equal(await readFile(exe,"utf8"),"1.0.0 adb.exe");
  await bundle("2.0.0",f.bundled);
  const upgraded=new ManagedAdb(f.config,()=>{},f.installed,f.bundled,request);
  assert.equal(await upgraded.initialize(),exe);assert.equal(upgraded.state.installedVersion,"1.0.0");assert.equal(requests,0);
});
test("手动更新校验完整文件，提交前不改变当前版本，并保留上一版",async()=>{
  const f=await fixture();const runtime=new ManagedAdb(f.config,()=>{},f.installed,f.bundled);
  await runtime.initialize();const next=await bundle("2.0.0",path.join(f.root,"next"));
  const remote:AdbManifest={...next,files:next.files.map(file=>({...file,url:`https://github.com/shoucanjun0925/AwesomeAdb/releases/download/v0.3.0/${file.name}`}))};
  const request=(async(url:string|URL|Request)=>{
    if(String(url).endsWith("adb-manifest.json")) return Response.json(remote);
    const name=new URL(String(url)).pathname.split("/").at(-1)!;
    return new Response(await readFile(path.join(f.root,"next/files",name)));
  }) as typeof fetch;
  const updating=new ManagedAdb(f.config,()=>{},f.installed,f.bundled,request);
  await updating.checkUpdate();assert.equal(f.config.adbVersion,"1.0.0");
  const candidate=await updating.prepareUpdate();assert.equal(f.config.adbVersion,"1.0.0");
  candidate.commit();assert.equal(f.config.adbVersion,"2.0.0");assert.equal(f.config.previousAdbVersion,"1.0.0");
  assert.equal(await readFile(path.join(f.installed,"1.0.0/adb.exe"),"utf8"),"1.0.0 adb.exe");
});
test("更新文件损坏时保留旧版本并清理临时目录",async()=>{
  const f=await fixture();await new ManagedAdb(f.config,()=>{},f.installed,f.bundled).initialize();
  const next=await bundle("2.0.0",path.join(f.root,"next"));
  const remote={...next,files:next.files.map(file=>({...file,url:`https://github.com/shoucanjun0925/AwesomeAdb/releases/download/v0.3.0/${file.name}`}))};
  const request=(async(url:string|URL|Request)=>String(url).endsWith("adb-manifest.json")?Response.json(remote):new Response("damaged")) as typeof fetch;
  const runtime=new ManagedAdb(f.config,()=>{},f.installed,f.bundled,request);
  await assert.rejects(()=>runtime.prepareUpdate(),/校验失败/);assert.equal(f.config.adbVersion,"1.0.0");
  assert.equal((await readdir(f.installed)).some(name=>name.startsWith("staging-")),false);
});
test("ADB 更新来源、路径与清单拒绝越界和重复文件",()=>{
  assert.equal(newerVersion("37.0.1","37.0.0"),true);assert.equal(newerVersion("37.0.1","37.0.1"),false);
  for(const url of ["http://github.com/shoucanjun0925/AwesomeAdb/releases/download/x/y","https://example.com/adb.exe","https://github.com/other/repo/releases/download/x/y"])
    assert.throws(()=>validateAssetUrl(url));
  assert.equal(adbManifestSchema.safeParse({version:"../bad",files:[]}).success,false);
  assert.equal(adbManifestSchema.safeParse({version:"1.0.0",files:[{name:"../adb.exe",size:1,sha256:"a".repeat(64)}]}).success,false);
});
test("切换 ADB 拒绝活动访问，提交失败恢复原状态且不启动停止中的服务",async()=>{
  const adb=new AdbService();adb.state={...adb.state,path:"old.exe",valid:true,server:"stopped"};adb.activeAccesses=1;
  await assert.rejects(()=>adb.activateManaged("new.exe",()=>{}),/任务进行中/);adb.activeAccesses=0;
  (adb as unknown as {runFile:()=>Promise<string>}).runFile=async()=>"Android Debug Bridge\nVersion 2.0.0";
  let calls=0;adb.run=async()=>{calls++;return "";};
  await assert.rejects(()=>adb.activateManaged("new.exe",()=>{throw new Error("写入失败");}),/写入失败/);
  assert.equal(adb.state.path,"old.exe");assert.equal(adb.state.server,"stopped");assert.equal(calls,0);adb.pause();
});
test("旧配置迁移保留电脑标识和旧文件，未知模式不会重建标识",async()=>{
  const old={machineId:"legacy-stable-id",mode:"unknown-mode",customPath:"unused"};
  await writeFile(path.join(dataDirectory,"config.json"),JSON.stringify(old));
  await writeFile(path.join(dataDirectory,"config-v2.json"),"broken");
  const config=loadConfig();assert.equal(config.machineId,"legacy-stable-id");assert.equal(config.mode,"managed");
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDirectory,"config.json"),"utf8")),old);
});
test("程序版本与更新清单不一致时，在停止服务之前拒绝切换",async()=>{
  const adb=new AdbService();adb.state={...adb.state,path:"old.exe",valid:true,server:"stopped"};
  (adb as unknown as {runFile:()=>Promise<string>}).runFile=async()=>"Android Debug Bridge\nVersion 1.0.0-build";
  let committed=false;
  await assert.rejects(()=>adb.activateManaged("new.exe",()=>{committed=true;},"2.0.0"),/版本与更新清单不一致/);
  assert.equal(committed,false);assert.equal(adb.state.path,"old.exe");adb.pause();
});
test("候选服务启动后提交失败，只结束自己的候选进程并恢复旧版本",async()=>{
  class Child extends EventEmitter {exitCode:number|null=null;signalCode=null;kills=0;kill(){this.kills++;this.exitCode=0;this.emit("exit");return true;}}
  const old=new Child(),candidate=new Child(),adb=new AdbService();
  const internals=adb as unknown as {ownedServer:Child|undefined;ownedServerPath:string;runFile:()=>Promise<string>;ensureServer:()=>Promise<void>};
  adb.state={...adb.state,path:"old.exe",valid:true,server:"running"};
  internals.ownedServer=old;internals.ownedServerPath="old.exe";
  internals.runFile=async()=>"Android Debug Bridge\nVersion 2.0.0-build";
  adb.run=async()=>{old.exitCode=0;internals.ownedServer=undefined;return "";};
  const started:string[]=[];
  internals.ensureServer=async()=>{started.push(adb.state.path!);internals.ownedServer=adb.state.path==="new.exe"?candidate:old;internals.ownedServerPath=adb.state.path!;};
  await assert.rejects(()=>adb.activateManaged("new.exe",()=>{throw new Error("提交失败");},"2.0.0"),/提交失败/);
  assert.equal(candidate.kills,1);assert.equal(old.kills,0);assert.equal(adb.state.path,"old.exe");
  assert.equal(adb.state.server,"running");assert.deepEqual(started,["new.exe","old.exe"]);adb.pause();
});
test("下载期间主动停止服务，更新完成后仍保持停止",async()=>{
  const adb=new AdbService();adb.state={...adb.state,path:"old.exe",valid:true,server:"running"};
  (adb as unknown as {runFile:()=>Promise<string>}).runFile=async()=>"Android Debug Bridge\nVersion 2.0.0-build";
  const calls:string[]=[];adb.run=async args=>{calls.push(args[0]);return "";};
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  adb.runtime.prepareUpdate=async()=>{await gate;return {path:"new.exe",version:"2.0.0",commit:()=>{}};};
  const updating=adb.updateManaged();await adb.stop();release();await updating;
  assert.equal(adb.state.server,"stopped");assert.equal(adb.state.path,"new.exe");assert.deepEqual(calls,["kill-server"]);adb.pause();
});
test("站点配置和私有下载清单拒绝凭证、非HTTPS及非法对象路径",()=>{
  assert.equal(validatedSiteUrl("https://workspace.example/"),"https://workspace.example/");
  for(const url of ["http://workspace.example","https://user:pass@workspace.example/","https://workspace.example/?token=a","https://workspace.example/files"])
    assert.throws(()=>validatedSiteUrl(url));
  assert.equal(downloadManifestSchema.safeParse({version:"0.3.0",fileName:"x.zip",size:1,sha256:"a".repeat(64),key:"../other",notes:"",publishedAt:new Date().toISOString()}).success,false);
});
test("smart socket 正确处理拆分响应及错误，不需要调用 adb CLI",async()=>{
  const server=createServer(socket=>socket.once("data",()=>{socket.write("OK");setTimeout(()=>socket.end("AY00040029"),5);}));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {assert.equal(await serverRequest("host:version",1000,"utf8",(server.address() as {port:number}).port),"0029");}
  finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
  assert.equal(statusVersion(Buffer.from([8,4,42,6,...Buffer.from("37.0.1")])),"37.0.1");
});
