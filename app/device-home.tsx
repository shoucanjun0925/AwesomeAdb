"use client";
import { useState } from "react";
import {
  ArrowRight,
  FolderOpen,
  Plug,
  Plus,
  Settings2,
  Smartphone,
  Usb,
  Wifi,
} from "lucide-react";
import type { NamedDevice } from "../shared/contracts";
import type { useWorkspace } from "./use-workspace";
import { Badge, Busy } from "./ui";

export function DeviceHome({
  services: w,
  serial,
  onFiles,
  onSettings,
}: {
  services: ReturnType<typeof useWorkspace>;
  serial: string;
  onFiles: (device: NamedDevice) => void;
  onSettings: (serial?: string) => void;
}) {
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const cards = w.deviceData.profiles
    .map((profile) => {
      const online = w.namedDevices.filter((d) => d.profileId === profile.id);
      const device =
        online.find((d) => d.serial === serial) ||
        online.find((d) => d.state === "device" && d.transport === "usb") ||
        online.find((d) => d.state === "device") ||
        online[0];
      const connection = w.history.connections.find(
        (c) => c.deviceId === profile.id,
      );
      return { profile, device, connection };
    })
    .sort(
      (a, b) =>
        Number(b.device?.state === "device" && w.connected) -
        Number(a.device?.state === "device" && w.connected),
    );
  const unnamed = w.namedDevices.filter((d) => !d.profileId);
  return (
    <>
      <div className="page-heading compact-heading">
        <div>
          <h1>我的设备</h1>
          <p>选择设备，开始管理文件。</p>
        </div>
        <button className="button" onClick={() => onSettings()}>
          <Plus size={17} />
          连接与设置
        </button>
      </div>
      {!w.connected && (
        <div className="notice warning" role="status">
          <Plug size={20} />
          <div>
            <strong>本地助手连接已中断</strong>
            <p>{w.helperError || "启动 Windows 助手后，重新连接即可继续。"}</p>
          </div>
          <button className="button small" onClick={() => onSettings()}>
            去连接与设置
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
          <button className="text-button" onClick={() => onSettings()}>
            检查连接设置
          </button>
        </div>
      )}
      {cards.length || unnamed.length ? (
        <div className="device-card-grid">
          {cards.map(({ profile, device, connection }) => {
            const ready = w.connected && device?.state === "device";
            const status = !w.connected
              ? "助手未连接"
              : device?.state === "unauthorized"
                ? "请在设备上授权"
                : device?.state === "offline"
                  ? "设备离线"
                  : ready
                    ? "已连接"
                    : "未连接";
            return (
              <article
                key={profile.id}
                className={`device-card ${ready ? "ready" : ""}`}
              >
                <div className="device-card-top">
                  <span className="device-card-icon">
                    <Smartphone size={28} />
                  </span>
                  <Badge tone={ready ? "green" : "neutral"}>{status}</Badge>
                </div>
                <h2 title={profile.label}>{profile.label}</h2>
                <p className="device-model">
                  {device?.model || "已保存的 Android 设备"}
                </p>
                <div className="device-connection">
                  {device?.transport === "usb" ? (
                    <Usb size={15} />
                  ) : (
                    <Wifi size={15} />
                  )}
                  <span>
                    {device
                      ? `${device.transport === "usb" ? "USB" : "无线"} · ${device.serial}`
                      : connection
                        ? `${connection.host}:${connection.port}`
                        : "插入 USB 数据线后检测设备"}
                  </span>
                </div>
                {w.pendingDeviceIds.has(profile.id) && (
                  <small className="pending-note">备注未同步</small>
                )}
                <div className="device-card-actions">
                  {ready && device ? (
                    <button
                      className="button primary"
                      onClick={() => onFiles(device)}
                    >
                      <FolderOpen size={17} />
                      管理文件
                      <ArrowRight size={15} />
                    </button>
                  ) : connection ? (
                    <button
                      className="button primary"
                      disabled={!w.connected || !w.helper?.adb.valid || !!busy}
                      onClick={async () => {
                        setBusy(profile.id);
                        setError("");
                        try {
                          await w.connectSaved(connection);
                          w.notify(`${profile.label} 已连接`);
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy("");
                        }
                      }}
                    >
                      {busy === profile.id ? <Busy /> : <Plug size={17} />}
                      重新连接
                    </button>
                  ) : (
                    <button
                      className="button"
                      onClick={() => onSettings(device?.serial)}
                    >
                      检查连接
                      <ArrowRight size={15} />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label={`设置 ${profile.label}`}
                    title="修改备注与连接"
                    onClick={() => onSettings(device?.serial)}
                  >
                    <Settings2 size={17} />
                  </button>
                </div>
              </article>
            );
          })}
          {unnamed.map((device) => (
            <article key={device.serial} className="device-card needs-note">
              <div className="device-card-top">
                <span className="device-card-icon">
                  <Smartphone size={28} />
                </span>
                <Badge tone="amber">
                  {device.conflict ? "需要确认关联" : "待补充备注"}
                </Badge>
              </div>
              <h2>{device.conflict ? "确认这台设备" : "给设备起个名字"}</h2>
              <p className="device-model">{device.model}</p>
              <div className="device-connection">
                <span>{device.serial}</span>
              </div>
              <p className="card-hint">填写备注后，更容易找到要操作的设备。</p>
              <button
                className="button"
                onClick={() => onSettings(device.serial)}
              >
                去完成设备设置
                <ArrowRight size={15} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <section className="welcome-empty">
          <span className="welcome-icon">
            <Smartphone size={46} />
          </span>
          <h2>先连接你的第一台设备</h2>
          <p>下载并启动助手，再连接设备、填写备注，即可开始使用。</p>
          <button className="button primary" onClick={() => onSettings()}>
            开始设置
            <ArrowRight size={16} />
          </button>
        </section>
      )}
      {!!cards.length && (
        <p className="page-footnote">
          文件直接在这台电脑和 Android
          设备之间传输。需要添加设备或修改备注，请进入连接与设置。
        </p>
      )}
    </>
  );
}
