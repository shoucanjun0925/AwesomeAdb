import path from "node:path";
import { createHash } from "node:crypto";
import { getAsset, isSea } from "node:sea";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile, open } from "node:fs/promises";
import { z } from "zod";
import { dataDirectory, saveConfig, type LocalConfig } from "./config";
import type { AdbRuntimeState } from "../shared/contracts";

export const UPDATE_MANIFEST_URL = "https://github.com/shoucanjun0925/AwesomeAdb/releases/latest/download/adb-manifest.json";
export const adbManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  files: z.array(z.object({
    name: z.string().regex(/^(?:adb\.exe|[a-zA-Z0-9_-]+\.dll|NOTICE\.txt|source\.properties)$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().min(1).max(32 * 1024 * 1024),
    url: z.string().optional(),
  })).min(2).max(20),
}).superRefine((v,c) => {
  if (!v.files.some(f=>f.name === "adb.exe") || !v.files.some(f=>f.name === "NOTICE.txt")) c.addIssue({code:"custom",message:"ADB 包缺少程序或许可文件"});
  if (new Set(v.files.map(f=>f.name.toLowerCase())).size !== v.files.length) c.addIssue({code:"custom",message:"ADB 包包含重复文件"});
  if (v.files.reduce((n,f)=>n+f.size,0)>64*1024*1024) c.addIssue({code:"custom",message:"ADB 包过大"});
});
export type AdbManifest = z.infer<typeof adbManifestSchema>;
export function newerVersion(candidate:string,current:string) {
  const a=candidate.split(".").map(Number),b=current.split(".").map(Number);
  for(let i=0;i<3;i++) if(a[i]!==b[i]) return a[i]>b[i];
  return false;
}
export function validateAssetUrl(value?:string) {
  if(!value) throw new Error("更新包缺少下载地址");
  const u=new URL(value);
  if(u.protocol!=="https:" || u.host!=="github.com" || u.username || u.password || u.search || u.hash ||
    !u.pathname.startsWith("/shoucanjun0925/AwesomeAdb/releases/download/")) throw new Error("更新包来源不受信任");
  return u.toString();
}
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
export class ManagedAdb {
  state:AdbRuntimeState;
  private latest:AdbManifest|null=null;
  private busy=false;
  constructor(private config:LocalConfig,private changed:()=>void,
    private root=path.join(dataDirectory,"adb"),
    private bundledDirectory=path.join(process.cwd(),"vendor","adb"),
    private request:typeof fetch=fetch) {
    this.state={installedVersion:config.adbVersion||null,previousVersion:config.previousAdbVersion||null,
      latestVersion:null,status:"ready",completedBytes:0,totalBytes:0,error:null,checkedAt:null};
  }
  private set(v:Partial<AdbRuntimeState>) {Object.assign(this.state,v);this.changed();}
  fail(e:unknown) {this.set({status:"error",error:(e as Error).message||"ADB 更新失败，原版本仍然保留"});}
  private async bundle(name:string) {
    return isSea()?Buffer.from(getAsset(`adb/${name}`)):readFile(path.join(this.bundledDirectory,name==="manifest.json"?name:"files/"+name));
  }
  private async verify(directory:string,manifest:AdbManifest) {
    for(const f of manifest.files) {
      const bytes=await readFile(path.join(directory,f.name));
      if(bytes.length!==f.size || hash(bytes)!==f.sha256) throw new Error(`ADB 文件校验失败：${f.name}`);
    }
  }
  async initialize():Promise<string> {
    await mkdir(this.root,{recursive:true});
    if(this.config.adbVersion && /^\d+\.\d+\.\d+$/.test(this.config.adbVersion)) {
      const dir=path.join(this.root,this.config.adbVersion);
      try {
        const saved=adbManifestSchema.parse(JSON.parse(await readFile(path.join(dir,"manifest.json"),"utf8")));
        if(saved.version!==this.config.adbVersion) throw new Error("版本不一致");
        await this.verify(dir,saved);this.set({installedVersion:saved.version,status:"ready",error:null});
        return path.join(dir,"adb.exe");
      } catch {/* Repair missing or damaged runtime from the embedded payload. */}
    }
    const manifest=adbManifestSchema.parse(JSON.parse((await this.bundle("manifest.json")).toString("utf8")));
    const stage=await mkdtemp(path.join(this.root,"staging-"));
    try {
      for(const f of manifest.files) await writeFile(path.join(stage,f.name),await this.bundle(f.name));
      await this.verify(stage,manifest);
      const dir=await this.finishInstall(stage,manifest);
      this.config.adbVersion=manifest.version;this.config.mode="managed";this.config.customPath=null;saveConfig(this.config);
      this.set({installedVersion:manifest.version,status:"ready",error:null});return path.join(dir,"adb.exe");
    } finally {await this.cleanStage(stage);}
  }
  private async cleanStage(stage:string) {
    if(path.dirname(path.resolve(stage))!==path.resolve(this.root)||!path.basename(stage).startsWith("staging-")) throw new Error("临时目录不正确");
    await rm(stage,{recursive:true,force:true}).catch(()=>{});
  }
  private async finishInstall(stage:string,manifest:AdbManifest) {
    const dir=path.join(this.root,manifest.version);
    await writeFile(path.join(stage,"manifest.json"),JSON.stringify(manifest,null,2));
    try {await rename(stage,dir);} catch(e) {await this.verify(dir,manifest).catch(()=>{throw e;});}
    return dir;
  }
  async checkUpdate() {
    if(this.busy) throw new Error("ADB 更新操作正在进行，请稍后重试");
    this.busy=true;this.set({status:"checking",error:null});
    try {
      const r=await this.request(UPDATE_MANIFEST_URL,{signal:AbortSignal.timeout(20000),cache:"no-store"});
      if(!r.ok) throw new Error(r.status===404?"暂时没有可用的更新清单，当前 ADB 仍可使用":"无法检查更新，请稍后重试");
      const text=await r.text();if(text.length>65536) throw new Error("更新清单过大");
      const manifest=adbManifestSchema.parse(JSON.parse(text));
      for(const f of manifest.files) validateAssetUrl(f.url);
      this.latest=manifest;this.set({latestVersion:manifest.version,status:"ready",error:null,checkedAt:Date.now()});return this.state;
    } catch(e) {this.fail(e);throw e;} finally {this.busy=false;}
  }
  async prepareUpdate() {
    if(!this.latest) await this.checkUpdate();
    if(this.busy) throw new Error("ADB 更新正在进行");
    const manifest=this.latest!;
    if(this.state.installedVersion&&!newerVersion(manifest.version,this.state.installedVersion)) throw new Error("当前已经是已发布的最新 ADB，无需更新");
    this.busy=true;this.set({status:"downloading",error:null,completedBytes:0,totalBytes:manifest.files.reduce((n,f)=>n+f.size,0)});
    let stage:string|undefined;
    try {
      await mkdir(this.root,{recursive:true});
      stage=await mkdtemp(path.join(this.root,"staging-"));
      for(const f of manifest.files) {
        const r=await this.request(validateAssetUrl(f.url),{signal:AbortSignal.timeout(120000)});
        if(!r.ok||!r.body) throw new Error(`无法下载 ${f.name}，原版本仍然保留`);
        const handle=await open(path.join(stage,f.name),"wx"),digest=createHash("sha256"),reader=r.body.getReader();let size=0;
        try {
          for(;;) {const {done,value}=await reader.read();if(done) break;
            size+=value.length;if(size>f.size) throw new Error(`更新文件大小异常：${f.name}`);
            digest.update(value);await handle.writeFile(value);this.set({completedBytes:this.state.completedBytes+value.length});}
        } finally {await reader.cancel().catch(()=>{});reader.releaseLock();await handle.close();}
        if(size!==f.size||digest.digest("hex")!==f.sha256) throw new Error(`更新文件校验失败：${f.name}`);
      }
      this.set({status:"installing"});const dir=await this.finishInstall(stage,manifest);
      return {path:path.join(dir,"adb.exe"),version:manifest.version,commit:()=>{
        const previous={...this.config};this.config.previousAdbVersion=this.config.adbVersion||null;
        this.config.adbVersion=manifest.version;this.config.mode="managed";
        try {saveConfig(this.config);} catch(e) {Object.assign(this.config,previous);throw e;}
        this.set({installedVersion:manifest.version,previousVersion:this.config.previousAdbVersion,status:"ready",error:null});
      }};
    } catch(e) {this.fail(e);throw e;} finally {this.busy=false;if(stage) await this.cleanStage(stage);}
  }
}
