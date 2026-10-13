"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  CloudOff,
  Download,
  FileImage,
  FileText,
  HardDrive,
  Image,
  Monitor,
  Settings2,
  ShieldCheck,
  Smartphone,
  Terminal,
  XCircle,
} from "lucide-react";
import { useWorkspace } from "./use-workspace";
import { appModules } from "./modules/registry";
import { ConnectionSettings } from "./connection-settings";
import { DeviceHome } from "./device-home";
import { TaskPanel } from "./task-panel";
import { Busy } from "./ui";
import { APP_VERSION, type NamedDevice } from "../shared/contracts";
import { remotePath } from "../shared/paths";
import { setupStep } from "../shared/devices";

const quickPaths = [
  { label: "内部存储", path: "/sdcard", icon: HardDrive },
  { label: "下载", path: "/sdcard/Download", icon: Download },
  { label: "相机", path: "/sdcard/DCIM", icon: Image },
  { label: "图片", path: "/sdcard/Pictures", icon: FileImage },
  { label: "文档", path: "/sdcard/Documents", icon: FileText },
];
export default function Workspace({
  displayName,
  initialSection = "home",
}: {
  displayName: string;
  initialSection?: string;
}) {
  const w = useWorkspace();
  const [section, updateSection] = useState(initialSection),
    [serial, setSerial] = useState("");
  const [currentPath, setCurrentPath] = useState("/sdcard"),
    [taskOpen, setTaskOpen] = useState(false);
  const [focusSerial, setFocusSerial] = useState<string | undefined>();
  const firstCheck = useRef(false),
    firstSelection = useRef(false),
    previousJobCount = useRef(0);
  const currentDevice = w.namedDevices.find((d) => d.serial === serial);
  const available =
    w.connected &&
    currentDevice?.state === "device" &&
    !!currentDevice.label &&
    !currentDevice.conflict;
  const activeModule = appModules.find((m) => m.id === section),
    ModuleView = activeModule?.Component;
  const step = setupStep(w.connected, !!w.helper?.adb.valid, w.namedDevices);
  const loading = !w.initialized || !w.devicesLoaded;
  const setSection = useCallback((id: string, replace = false) => {
    updateSection(id);
    const path = id === "home" ? "/" : `/${id}`;
    if (window.location.pathname !== path)
      window.history[replace ? "replaceState" : "pushState"](null, "", path);
  }, []);
  const goSettings = (focus?: string) => {
    setFocusSerial(focus);
    setSection("settings");
  };
  useEffect(() => {
    const pop = () =>
      updateSection(window.location.pathname.split("/")[1] || "home");
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (loading || firstCheck.current) return;
    firstCheck.current = true;
    if (step !== 0 && initialSection !== "settings")
      setSection("settings", true);
  }, [loading, step, initialSection, setSection]);
  useEffect(() => {
    if (serial && !w.namedDevices.some((d) => d.serial === serial))
      setSerial("");
    if (!firstSelection.current && w.connected) {
      const ready = w.namedDevices.filter(
        (d) => d.state === "device" && d.label && !d.conflict,
      );
      if (ready.length === 1) {
        firstSelection.current = true;
        setSerial(ready[0].serial);
      }
    }
  }, [w.namedDevices, w.connected, serial]);
  useEffect(() => {
    const count = w.helper?.jobs.length || 0;
    if (
      count > previousJobCount.current &&
      w.helper?.jobs.some((j) =>
        ["queued", "running", "conflict"].includes(j.state),
      )
    )
      setTaskOpen(true);
    previousJobCount.current = count;
  }, [w.helper?.jobs]);
  const navigate = (path: string) => {
    try {
      setCurrentPath(remotePath(path));
    } catch (e) {
      w.notify((e as Error).message, true);
    }
  };
  const files = (device: NamedDevice) => {
    firstSelection.current = true;
    setSerial(device.serial);
    navigate("/sdcard");
    setSection("files");
  };
  return (
    <div className="app-shell simple-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            setSection("home");
          }}
        >
          <span className="brand-icon">
            <Terminal size={23} />
            <i />
          </span>
          <span>
            Awesome<span className="brand-light">Adb</span>
            <small>ANDROID 设备工具</small>
          </span>
        </a>
        <nav aria-label="主导航">
          <button
            className={`nav-item ${section === "home" ? "active" : ""}`}
            onClick={() => setSection("home")}
          >
            <Smartphone size={19} />
            <span>我的设备</span>
          </button>
          {appModules.map((m) => (
            <button
              key={m.id}
              className={`nav-item ${section === m.id ? "active" : ""}`}
              onClick={() => {
                if (!available) goSettings(serial || undefined);
                else setSection(m.id);
              }}
            >
              <m.Icon size={19} />
              <span>{m.name}</span>
            </button>
          ))}
          <button
            className={`nav-item ${section === "settings" ? "active" : ""}`}
            onClick={() => goSettings()}
          >
            <Settings2 size={19} />
            <span>连接与设置</span>
          </button>
        </nav>
        {section === "files" && (
          <div className="directory-shortcuts">
            <p>常用目录</p>
            {quickPaths.map((path) => (
              <button
                key={path.path}
                className={`quick-item ${currentPath === path.path ? "active" : ""}`}
                disabled={!available}
                onClick={() => navigate(path.path)}
              >
                <path.icon size={17} />
                <span>{path.label}</span>
              </button>
            ))}
          </div>
        )}
        <div className="sidebar-bottom">
          <button className="helper-summary" onClick={() => goSettings()}>
            <Monitor size={17} />
            <span>{w.connected ? "本地助手已连接" : "本地助手未连接"}</span>
            <i className={w.connected ? "connected" : ""} />
          </button>
          <small className="app-version">AwesomeAdb {APP_VERSION}</small>
        </div>
      </aside>
      <div className="main-stage">
        <header className="topbar">
          <div className="topbar-label">
            {section === "home"
              ? "我的设备"
              : section === "settings"
                ? "连接与设置"
                : activeModule?.name || "我的设备"}
          </div>
          <div className="topbar-right">
            <div className="device-select">
              <Smartphone size={17} />
              <select
                aria-label="当前设备"
                value={serial}
                onChange={(e) => {
                  firstSelection.current = true;
                  setSerial(e.target.value);
                  navigate("/sdcard");
                }}
              >
                <option value="">选择要操作的设备</option>
                {w.namedDevices.map((d) => (
                  <option
                    key={d.serial}
                    value={d.serial}
                    disabled={!d.label || d.conflict}
                  >
                    {d.label || "待补充备注"} ·{" "}
                    {d.transport === "usb" ? "USB" : "无线"}
                    {d.state === "device" && w.connected ? "" : " · 未就绪"}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </div>
            <span className="user-avatar" title={displayName}>
              {displayName.slice(0, 1).toUpperCase()}
            </span>
          </div>
        </header>
        {(w.deviceError || w.historyError) && (
          <div className="sync-warning" role="status">
            <CloudOff size={17} />
            <span>{w.deviceError || w.historyError}</span>
            <button
              onClick={async () => {
                try {
                  if (await w.retryDeviceSync()) await w.retrySync();
                } catch (e) {
                  w.notify((e as Error).message, true);
                }
              }}
            >
              重试同步
            </button>
          </div>
        )}
        <main
          className={`content ${section === "files" ? "files-content" : ""}`}
        >
          {loading ? (
            <div className="workspace-loading">
              <Busy size={25} />
              <h2>正在检查连接与已保存设备</h2>
              <p>准备好后，将自动显示对应页面。</p>
            </div>
          ) : (
            <>
              {section === "home" && (
                <DeviceHome
                  services={w}
                  serial={serial}
                  onFiles={files}
                  onSettings={goSettings}
                />
              )}
              {section === "settings" && (
                <ConnectionSettings
                  services={w}
                  serial={serial}
                  focusSerial={focusSerial}
                  onDone={() => setSection("home")}
                />
              )}
              {ModuleView &&
                (activeModule!.requiredCapabilities.every((c) =>
                  w.helper?.capabilities.includes(c),
                ) || !w.connected ? (
                  <ModuleView
                    services={w}
                    serial={serial}
                    currentPath={currentPath}
                    setCurrentPath={setCurrentPath}
                    setTaskOpen={setTaskOpen}
                    onConfigure={() => goSettings(serial || undefined)}
                    onConnect={() => goSettings(serial || undefined)}
                  />
                ) : (
                  <section className="welcome-empty">
                    <ShieldCheck size={35} />
                    <h2>请更新 Windows 助手</h2>
                    <p>
                      当前助手尚不支持此功能。请在连接与设置中查看更新说明。
                    </p>
                    <button className="button" onClick={() => goSettings()}>
                      去连接与设置
                    </button>
                  </section>
                ))}
            </>
          )}
        </main>
        <TaskPanel services={w} open={taskOpen} setOpen={setTaskOpen} />
      </div>
      {w.toast && (
        <div
          role="status"
          aria-live="polite"
          className={`toast ${w.toast.error ? "error" : ""}`}
        >
          {w.toast.error ? <XCircle size={18} /> : <Check size={18} />}
          <span>{w.toast.message}</span>
        </div>
      )}
    </div>
  );
}
