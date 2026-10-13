"use client";
import { useState } from "react";
import { RefreshCw, Download, Check } from "lucide-react";
import type { HelperState } from "../shared/contracts";
import type { useWorkspace } from "./use-workspace";
import { Busy, Modal } from "./ui";

export function AdbRuntimeSettings({services:w}:{services:ReturnType<typeof useWorkspace>}) {
  const [error,setError]=useState(""),[busy,setBusy]=useState(""),[restart,setRestart]=useState(false);
  if(!w.connected||!w.helper) return null;
  if(!w.helper.capabilities.includes("managed-adb")) return <div className="notice warning">
    当前是旧版助手，可以继续使用已有功能。下载并启动新版后，ADB 会自动准备，无需选择路径。
  </div>;
  const runtime=w.helper.adbRuntime,adb=w.helper.adb;
  const running=w.helper.jobs.some(j=>["queued","running","conflict"].includes(j.state));
  const updating=!!runtime&&["checking","downloading","installing"].includes(runtime.status);
  const available=!!runtime?.latestVersion&&(()=>{
    const a=runtime.latestVersion!.split(".").map(Number),b=(runtime.installedVersion||"0.0.0").split(".").map(Number);
    for(let i=0;i<3;i++) if(a[i]!==b[i]) return a[i]>b[i];return false;
  })();
  const run=async(route:string,label:string)=>{
    setBusy(label);setError("");
    try {w.applyState(await w.bridge<HelperState>(route,{}));}
    catch(e) {setError((e as Error).message);}
    finally {setBusy("");}
  };
  return <div className="adb-runtime-settings">
    <div className="settings-row"><div><strong><Check size={15}/> {adb.valid?"ADB 已自动准备":"内置 ADB 需要修复"}</strong>
      <p>内置版本 {runtime?.installedVersion||"准备中"} · 版本更新由你决定。</p>
      {adb.server==="running"&&<p>{adb.serverSource==="shared"?"正在共用电脑已有的设备服务":"内置设备服务正在运行"}{adb.serverVersion?` · ${adb.serverVersion}`:""}</p>}
      {runtime?.latestVersion&&<p>{available?`可更新至 ${runtime.latestVersion}`:"当前已是已发布的最新版本"}</p>}
    </div><div className="button-row">
      <button className="button" disabled={!!busy||updating} onClick={()=>void run("/adb/check-update","检查更新")}>
        {busy==="检查更新"?<Busy/>:<RefreshCw size={15}/>}检查更新
      </button>
      {available&&<button className="button" disabled={!!busy||updating||running} onClick={()=>void run("/adb/update","更新 ADB")}>
        {busy==="更新 ADB"?<Busy/>:<Download size={15}/>}更新 ADB
      </button>}
    </div></div>
    {running&&available&&<p className="field-help">请先完成或取消传输任务，再更新 ADB。</p>}
    {runtime&&["downloading","installing"].includes(runtime.status)&&<div role="status">
      <p>{runtime.status==="installing"?"正在安全切换版本，请稍候":"正在下载 ADB，原版本仍然保留"}</p>
      <progress max={runtime.totalBytes||1} value={runtime.completedBytes} style={{width:"100%"}}/>
    </div>}
    {(error||runtime?.error||adb.serviceError)&&<div className="notice error" role="alert">{error||runtime?.error||adb.serviceError}</div>}
    {(adb.updatePendingRestart||adb.serviceError)&&<div className="notice warning">
      <p>{adb.updatePendingRestart?"ADB 文件已更新。当前服务仍在使用原版本，重新启动服务后生效。":"可以重新启动设备服务，使用助手内置的 ADB。"}</p>
      <button className="button" disabled={!!busy||updating||running} onClick={()=>setRestart(true)}>重启设备服务</button>
    </div>}
    {restart&&<Modal title="重启设备服务？" onClose={()=>setRestart(false)}>
      <p>这会断开设备，并中断 Android Studio 等程序正在使用的 ADB 连接。重新启动后使用助手内置的版本。</p>
      <div className="button-row"><button className="button" onClick={()=>setRestart(false)}>取消</button><button className="button primary" onClick={()=>{setRestart(false);void run("/adb/restart","重启服务");}}>确认重启</button></div>
    </Modal>}
  </div>;
}
