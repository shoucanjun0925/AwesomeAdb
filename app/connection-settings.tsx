"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ZodError } from "zod";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  Link2,
  Monitor,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Smartphone,
  Trash2,
  Usb,
  Wifi,
} from "lucide-react";
import type {
  ConnectionHistory,
  HelperState,
  NamedDevice,
} from "../shared/contracts";
import { APP_VERSION } from "../shared/contracts";
import {
  deviceLabelSchema,
  endpointBindingKey,
  setupStep,
  transportBindingKey,
} from "../shared/devices";
import type { useWorkspace } from "./use-workspace";
import { Badge, Busy, Field, Modal } from "./ui";
import { AdbRuntimeSettings } from "./adb-runtime-settings";
import {
  HelperDownloadCard,
  HelperPackagePublisher,
  useHelperDownloads,
} from "./helper-downloads";

type Editor = {
  device?: NamedDevice;
  profileId?: string;
  connection?: ConnectionHistory;
};
type Confirmation = {
  kind: "stop" | "exit" | "device" | "history";
  id?: string;
  historyKind?: "adb" | "connection";
  label?: string;
} | null;
export function ConnectionSettings({
  services: w,
  serial,
  focusSerial,
  onDone,
}: {
  services: ReturnType<typeof useWorkspace>;
  serial: string;
  focusSerial?: string;
  onDone: () => void;
}) {
  const readiness = setupStep(w.connected, !!w.helper?.adb.valid, w.namedDevices);
  const step = readiness === 3 ? 2 : readiness === 2 ? 1 : readiness;
  const downloads = useHelperDownloads();
  const [openStep, setOpenStep] = useState(step),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const [tab, setTab] = useState<"usb" | "pair" | "tcp">("usb");
  const [host, setHost] = useState(""),
    [port, setPort] = useState("5555"),
    [pairPort, setPairPort] = useState(""),
    [code, setCode] = useState(""),
    [paired, setPaired] = useState(false);
  const [connectionProfile, setConnectionProfile] = useState(""),
    [connectionNote, setConnectionNote] = useState("");
  const [editing, setEditing] = useState<Editor | null>(null),
    [note, setNote] = useState(""),
    [existingId, setExistingId] = useState(""),
    [reassign, setReassign] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const previousStep = useRef(step),
    focusHandled = useRef("");
  const activeJobs = w.helper?.jobs.some((j) =>
    ["queued", "running", "conflict"].includes(j.state),
  );
  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError("");
    try {
      return await fn();
    } catch (e) {
      const message =
        e instanceof ZodError
          ? e.issues[0]?.message || "请检查填写的信息"
          : (e as Error).message;
      setError(message);
      return undefined;
    } finally {
      setBusy("");
    }
  };
  useEffect(() => {
    if (step === 0 && previousStep.current !== 0) setOpenStep(0);
    if (step !== previousStep.current && step && step > previousStep.current)
      setOpenStep(step);
    if (previousStep.current === 1 && step !== 1) setOpenStep(step);
    previousStep.current = step;
  }, [step]);
  const edit = (value: Editor) => {
    setEditing(value);
    setError("");
    setOpenStep(2);
    setReassign(false);
    const profile = w.deviceData.profiles.find((p) => p.id === value.profileId);
    setExistingId("");
    setNote(profile?.label || value.connection?.label || "");
  };
  useEffect(() => {
    if (!focusSerial || focusHandled.current === focusSerial) return;
    const device = w.namedDevices.find((d) => d.serial === focusSerial);
    if (device) {
      focusHandled.current = focusSerial;
      edit({ device, profileId: device.profileId || undefined });
    }
  }, [focusSerial, w.namedDevices]);
  const refresh = () =>
    run("检测设备", async () => {
      w.applyState(await w.bridge<HelperState>("/devices/refresh", {}));
      w.notify("检测完成。未显示设备时，请查看下方连接提示。");
    });
  const selectHistory = (c: ConnectionHistory) => {
    setTab(c.mode === "paired" ? "pair" : "tcp");
    setPaired(c.mode === "paired");
    setHost(c.host);
    setPort(String(c.port));
    setConnectionProfile(c.deviceId || "");
    setConnectionNote(
      w.deviceData.profiles.find((p) => p.id === c.deviceId)?.label || c.label,
    );
    setOpenStep(2);
    setError("");
  };
  const connect = () =>
    run(tab === "pair" && !paired ? "配对设备" : "连接设备", async () => {
      const label = deviceLabelSchema.parse(connectionNote);
      if (tab === "pair" && !paired) {
        if (!/^\d{6}$/.test(code) || !Number(pairPort))
          throw new Error("请填写配对弹窗中的端口和 6 位配对码");
        try {
          await w.bridge("/devices/pair", {
            host: host.trim(),
            port: Number(pairPort),
            code,
          });
          setPaired(true);
          setPort("");
          w.notify("配对成功。请返回无线调试主界面，填写连接端口。");
        } finally {
          setCode("");
        }
        return;
      }
      const endpoint = endpointBindingKey(host, Number(port));
      const previous = new Set(w.helper?.devices.map((d) => d.serial) || []);
      const result = await w.bridge<{ state: HelperState }>(
        "/devices/connect",
        { host: host.trim(), port: Number(port) },
      );
      w.applyState(result.state);
      const newDevices = result.state.devices.filter(
        (d) => d.state === "device" && !previous.has(d.serial),
      );
      const device =
        result.state.devices.find((d) => transportBindingKey(d) === endpoint) ||
        (newDevices.length === 1 ? newDevices[0] : undefined);
      const keys = [endpoint];
      if (device) {
        keys.push(transportBindingKey(device));
        if (result.state.capabilities.includes("device-identity")) {
          try {
            const identity = await w.bridge<{ identityKey: string | null }>(
              `/devices/identity?serial=${encodeURIComponent(device.serial)}`,
            );
            if (identity.identityKey) keys.push(identity.identityKey);
          } catch {
            /* Naming by connection remains supported. */
          }
        }
      }
      const foundIds = [
        ...new Set(
          w.deviceData.bindings
            .filter((b) => keys.includes(b.bindingKey))
            .map((b) => b.profileId),
        ),
      ];
      if (
        foundIds.length > 1 ||
        (connectionProfile && foundIds.some((id) => id !== connectionProfile))
      ) {
        if (device)
          edit({
            device: {
              ...device,
              profileId: null,
              label: "",
              identityKey: keys.find((k) => k.startsWith("hardware|")) || null,
              bindingKeys: [...new Set(keys)],
              conflict: true,
              pending: false,
            },
          });
        throw new Error(
          "设备已连接，但连接关联不一致。请在下方确认正确的设备备注。",
        );
      }
      const id = connectionProfile || foundIds[0] || crypto.randomUUID();
      const stored = w.deviceData.profiles.find((p) => p.id === id);
      const savedLabel = stored?.label || label;
      const saved = await w.saveDevice({
        kind: "save",
        id,
        label: savedLabel,
        bindingKeys: [...new Set(keys)],
        reassign: false,
      });
      await w.saveHistory(
        {
          kind: "connection",
          host: host.trim(),
          port: Number(port),
          mode: tab === "pair" ? "paired" : "tcp",
          label: savedLabel,
          deviceId: id,
        },
        !saved.synced,
      );
      w.notify(
        saved.synced
          ? `${savedLabel} 已连接${stored && label !== savedLabel ? "，已沿用保存的备注" : ""}`
          : "设备已连接，备注等待云端同步",
      );
      setCode("");
    });
  const editingDevice = editing?.device
    ? w.namedDevices.find((d) => d.serial === editing.device!.serial) ||
      editing.device
    : undefined;
  const editingKeys =
    editingDevice?.bindingKeys ||
    (editing?.connection
      ? [endpointBindingKey(editing.connection.host, editing.connection.port)]
      : []);
  const editorId = editing?.profileId || existingId;
  const editorConflict = w.deviceData.bindings.some(
    (b) => editingKeys.includes(b.bindingKey) && b.profileId !== editorId,
  );
  const saveNote = () =>
    run("保存备注", async () => {
      const label = deviceLabelSchema.parse(note);
      if (editorConflict && !reassign)
        throw new Error("请先确认将此连接关联到所选设备");
      const id = editorId || crypto.randomUUID();
      const result = await w.saveDevice({
        kind: "save",
        id,
        label,
        bindingKeys: editingKeys,
        reassign,
      });
      setEditing(null);
      w.notify(
        result.synced ? "设备备注已保存" : "备注已在当前页面保存，等待同步",
      );
    });
  const stepPanel = (
    number: number,
    title: string,
    complete: boolean,
    summary: string,
    children: ReactNode,
  ) => (
    <section className={`setup-step ${openStep === number ? "open" : ""}`}>
      <button
        className="setup-step-heading"
        aria-expanded={openStep === number}
        onClick={() => {
          setOpenStep(openStep === number ? 0 : number);
          setError("");
        }}
      >
        <span className={`step-circle ${complete ? "complete" : ""}`}>
          {complete ? <Check size={18} /> : number}
        </span>
        <span className="step-title">
          <strong>{title}</strong>
          <small>{summary}</small>
        </span>
        <Badge tone={complete ? "green" : "neutral"}>
          {complete ? "已完成" : "待完成"}
        </Badge>
        <ChevronDown size={18} />
      </button>
      {openStep === number && <div className="setup-step-body">{children}</div>}
    </section>
  );
  const confirm = () =>
    run("确认操作", async () => {
      if (!confirmation) return;
      if (confirmation.kind === "stop")
        w.applyState(await w.bridge<HelperState>("/adb/stop", {}));
      if (confirmation.kind === "exit") await w.bridge("/shutdown", {});
      if (confirmation.kind === "device") {
        await w.removeSavedDevice(confirmation.id!);
      }
      if (confirmation.kind === "history")
        await w.deleteHistory(confirmation.historyKind!, confirmation.id);
      setConfirmation(null);
    });
  const usbDevices = w.namedDevices.filter(
    (d) => d.transport === "usb" && d.state === "device",
  );
  const selectedUsb =
    usbDevices.find((d) => d.serial === serial) ||
    (usbDevices.length === 1 ? usbDevices[0] : undefined);
  return (
    <>
      <div className="page-heading compact-heading">
        <div>
          <h1>连接与设置</h1>
          <p>只需两步：启动助手，再连接并命名设备。</p>
        </div>
        <Badge>网页 {APP_VERSION}</Badge>
      </div>
      <div className="setup-layout">
        <div className="setup-main">
          <div className="setup-intro">
            <ShieldCheck size={22} />
            <p>
              助手已自带 ADB，无需选择程序或配置路径。设备备注和连接地址会保存，文件直接在电脑与设备之间传输。
            </p>
          </div>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {stepPanel(
            1,
            "下载并启动 Windows 助手",
            w.connected && !!w.helper?.adb.valid,
            w.connected
              ? `${w.helper?.machineName} · 助手 ${w.helper?.version}`
              : "自带 ADB，下载后解压运行即可",
            <>
              <HelperDownloadCard download={downloads} />
              <ol className="guide-list">
                <li>
                  将下载的压缩包解压，再双击 <strong>AwesomeAdb 助手.exe</strong>。
                </li>
                <li>点击下方按钮，在 Windows 授权窗口选择“是”。</li>
                <li>如果浏览器询问本地网络访问，请选择允许。</li>
              </ol>
              {!w.connected && w.helperError && (
                <div className="field-help warning-text">{w.helperError}</div>
              )}
              <button
                className="button primary"
                disabled={w.connecting}
                onClick={() => void run("连接助手", () => w.connect())}
              >
                {w.connecting ? <Busy /> : <Plug size={17} />}{" "}
                {w.connected ? "重新连接助手" : "连接本地助手"}
              </button>
              <AdbRuntimeSettings services={w} />
              <details className="help-details">
                <summary>
                  <CircleHelp size={15} />
                  没有连接成功？
                </summary>
                <p>
                  先确认助手正在运行，再使用 Chrome 或 Edge
                  打开本站。如曾拒绝本地网络权限，可在地址栏的站点设置中重新允许访问本地网络，然后重试连接。
                </p>
              </details>
            </>,
          )}
          {stepPanel(
            2,
            "连接设备并填写备注",
            step === 0,
            step === 0
              ? "设备已经可以操作，也可以在这里添加其他设备"
              : "备注会显示在设备首页和文件管理中",
            <>
              {!w.connected || !w.helper?.adb.valid ? (
                <p className="field-help">
                  先启动并连接 Windows 助手。ADB 会自动准备，无需配置。
                </p>
              ) : (
                <>
                  <div
                    className="connection-methods"
                    role="tablist"
                    aria-label="设备连接方式"
                  >
                    {(
                      [
                        {
                          id: "usb",
                          label: "USB 数据线",
                          hint: "推荐新手",
                          icon: Usb,
                        },
                        {
                          id: "pair",
                          label: "无线配对",
                          hint: "Android 无线调试",
                          icon: Link2,
                        },
                        {
                          id: "tcp",
                          label: "IP 地址连接",
                          hint: "已开启无线连接",
                          icon: Wifi,
                        },
                      ] as const
                    ).map((t) => (
                      <button
                        key={t.id}
                        role="tab"
                        aria-selected={tab === t.id}
                        className={tab === t.id ? "selected" : ""}
                        onClick={() => {
                          setTab(t.id);
                          setPaired(false);
                          setCode("");
                          setPort(t.id === "tcp" ? "5555" : "");
                          setError("");
                        }}
                      >
                        <t.icon size={20} />
                        <strong>{t.label}</strong>
                        <small>{t.hint}</small>
                      </button>
                    ))}
                  </div>
                  {tab === "usb" ? (
                    <div className="method-body">
                      <ol className="guide-list">
                        <li>使用支持传输数据的 USB 数据线连接电脑和设备。</li>
                        <li>在设备的“开发者选项”中打开 USB 调试。</li>
                        <li>解锁设备，在“允许 USB 调试”窗口中允许这台电脑。</li>
                      </ol>
                      <button
                        className="button"
                        disabled={!!busy}
                        onClick={() => void refresh()}
                      >
                        {busy === "检测设备" ? (
                          <Busy />
                        ) : (
                          <RefreshCw size={16} />
                        )}
                        检测 USB 设备
                      </button>
                      <details className="help-details">
                        <summary>没有找到设备？</summary>
                        <p>
                          确认数据线支持数据传输，并保持设备解锁。尝试更换 USB
                          接口或数据线；如果设备显示“待授权”，请先在设备屏幕上完成授权，再重新检测。
                        </p>
                      </details>
                    </div>
                  ) : (
                    <form
                      className="method-body wireless-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void connect();
                      }}
                    >
                      <Field
                        label="设备备注（必填）"
                        hint="例如：家用手机、办公室测试机。USB 与无线连接可以共用同一备注。"
                      >
                        <>
                          {!!w.deviceData.profiles.length && (
                            <select
                              aria-label="选择已有设备备注"
                              value={connectionProfile}
                              onChange={(e) => {
                                setConnectionProfile(e.target.value);
                                setConnectionNote(
                                  w.deviceData.profiles.find(
                                    (p) => p.id === e.target.value,
                                  )?.label || "",
                                );
                              }}
                            >
                              <option value="">添加一台新设备</option>
                              {w.deviceData.profiles.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.label}
                                </option>
                              ))}
                            </select>
                          )}
                          <input
                            required
                            maxLength={100}
                            value={connectionNote}
                            readOnly={!!connectionProfile}
                            onChange={(e) => setConnectionNote(e.target.value)}
                            placeholder="给这台设备一个容易辨认的名字"
                            aria-label="无线设备备注"
                          />
                        </>
                      </Field>
                      <Field
                        label="设备 IP 地址"
                        hint={
                          tab === "pair"
                            ? "在设备的“设置 → 开发者选项 → 无线调试”中查看。"
                            : "电脑与设备需网络互通，设备已开启 ADB TCP/IP。"
                        }
                      >
                        <input
                          required
                          value={host}
                          onChange={(e) => {
                            setHost(e.target.value);
                            setPaired(false);
                          }}
                          placeholder="例如 192.168.1.100"
                        />
                      </Field>
                      {tab === "pair" && !paired ? (
                        <>
                          <div className="instruction-box">
                            <Link2 size={19} />
                            <div>
                              <strong>第一步：用配对码配对</strong>
                              <p>
                                在设备上打开“无线调试 →
                                使用配对码配对设备”，填写弹窗中的配对端口和配对码。
                              </p>
                            </div>
                          </div>
                          <div className="form-grid">
                            <Field label="配对端口">
                              <input
                                required
                                type="number"
                                min={1}
                                max={65535}
                                value={pairPort}
                                onChange={(e) => setPairPort(e.target.value)}
                                placeholder="配对弹窗中的端口"
                              />
                            </Field>
                            <Field label="6 位配对码">
                              <input
                                required
                                type="password"
                                autoComplete="off"
                                inputMode="numeric"
                                minLength={6}
                                maxLength={6}
                                value={code}
                                onChange={(e) =>
                                  setCode(e.target.value.replace(/\D/g, ""))
                                }
                                placeholder="仅本次使用"
                              />
                            </Field>
                          </div>
                        </>
                      ) : (
                        <>
                          <Field
                            label={tab === "pair" ? "连接端口" : "端口"}
                            hint={
                              tab === "pair"
                                ? "配对已完成。返回无线调试主界面查看连接端口，它可能与配对端口不同。"
                                : "传统无线连接默认端口为 5555。"
                            }
                          >
                            <input
                              required
                              type="number"
                              min={1}
                              max={65535}
                              value={port}
                              onChange={(e) => setPort(e.target.value)}
                              placeholder={
                                tab === "pair" ? "无线调试主界面的端口" : "5555"
                              }
                            />
                          </Field>
                          {tab === "pair" && (
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => {
                                setPaired(false);
                                setCode("");
                              }}
                            >
                              需要重新配对
                            </button>
                          )}
                        </>
                      )}
                      <div className="method-footer">
                        <button
                          type="submit"
                          className="button primary"
                          disabled={!!busy || !connectionNote.trim()}
                        >
                          {busy ? <Busy /> : <Plug size={16} />}{" "}
                          {tab === "pair" && !paired
                            ? "配对并继续"
                            : "连接设备"}
                        </button>
                      </div>
                    </form>
                  )}
                  {!!w.namedDevices.length && (
                    <div className="detected-devices">
                      <h3>检测到的设备</h3>
                      {w.namedDevices.map((device) => (
                        <div className="detected-row" key={device.serial}>
                          <Smartphone size={22} />
                          <div>
                            <strong>
                              {device.label ||
                                (device.conflict
                                  ? "需要确认关联"
                                  : "待补充备注")}
                            </strong>
                            <small>
                              {device.model} ·{" "}
                              {device.transport === "usb" ? "USB" : "无线"} ·{" "}
                              {device.serial}
                            </small>
                            {device.state !== "device" && (
                              <small className="warning-text">
                                {device.state === "unauthorized"
                                  ? "请在设备屏幕上允许 USB 调试，然后重新检测"
                                  : "设备离线，请检查数据线或无线网络"}
                              </small>
                            )}
                          </div>
                          <button
                            className="button small"
                            onClick={() =>
                              edit({
                                device,
                                profileId: device.profileId || undefined,
                              })
                            }
                          >
                            {device.label ? "修改备注" : "填写备注"}
                          </button>
                          {device.transport === "tcp" && (
                            <button
                              className="button small"
                              disabled={!!busy || !!activeJobs}
                              onClick={() =>
                                void run("断开设备", async () => {
                                  w.applyState(
                                    await w.bridge<HelperState>(
                                      "/devices/disconnect",
                                      { serial: device.serial },
                                    ),
                                  );
                                  w.notify(
                                    `${device.label || "无线设备"}已断开，可从我的设备重新连接`,
                                  );
                                })
                              }
                            >
                              断开
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {!w.helper.capabilities.includes("device-identity") && (
                    <p className="field-help">
                      当前助手可手动关联同一设备。更新到 {APP_VERSION}{" "}
                      后可自动识别 USB 和无线连接。
                    </p>
                  )}
                  {editing && (
                    <form
                      className="note-editor"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveNote();
                      }}
                    >
                      <div className="note-editor-title">
                        <Pencil size={18} />
                        <h3>
                          {editing.profileId
                            ? "修改设备备注"
                            : "填写备注或关联已有设备"}
                        </h3>
                      </div>
                      <p className="field-help">
                        {editingDevice
                          ? `${editingDevice.model} · ${editingDevice.serial}`
                          : editing.connection
                            ? `${editing.connection.host}:${editing.connection.port}`
                            : "修改后，所有连接方式都会显示新备注。"}
                      </p>
                      {!editing.profileId && !!w.deviceData.profiles.length && (
                        <Field label="这是一台已有设备吗？">
                          <select
                            value={existingId}
                            onChange={(e) => {
                              setExistingId(e.target.value);
                              setNote(
                                w.deviceData.profiles.find(
                                  (p) => p.id === e.target.value,
                                )?.label || "",
                              );
                              setReassign(false);
                            }}
                          >
                            <option value="">这是新设备，填写新备注</option>
                            {w.deviceData.profiles.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                        </Field>
                      )}
                      <Field label="设备备注（必填）">
                        <input
                          autoFocus
                          required
                          maxLength={100}
                          value={note}
                          readOnly={!!existingId}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="例如：家用手机"
                        />
                      </Field>
                      {editorConflict && (
                        <label className="checkbox-label warning-text">
                          <input
                            type="checkbox"
                            required
                            checked={reassign}
                            onChange={(e) => setReassign(e.target.checked)}
                          />
                          我确认这台设备应使用所选备注，并替换当前连接关联
                        </label>
                      )}
                      <div className="button-row">
                        <button
                          className="button primary"
                          disabled={
                            !!busy ||
                            !note.trim() ||
                            (editorConflict && !reassign)
                          }
                        >
                          {busy === "保存备注" ? <Busy /> : <Check size={16} />}
                          保存备注
                        </button>
                        <button
                          type="button"
                          className="button"
                          onClick={() => setEditing(null)}
                        >
                          取消
                        </button>
                      </div>
                    </form>
                  )}
                  {!!w.deviceData.profiles.length && (
                    <details className="help-details">
                      <summary>
                        管理已保存设备（{w.deviceData.profiles.length}）
                      </summary>
                      {w.deviceData.profiles.map((profile) => (
                        <div className="simple-history-row" key={profile.id}>
                          <Smartphone size={17} />
                          <strong>{profile.label}</strong>
                          <button
                            className="text-button"
                            onClick={() => edit({ profileId: profile.id })}
                          >
                            修改备注
                          </button>
                          <button
                            className="icon-button"
                            aria-label={`移除设备 ${profile.label}`}
                            onClick={() =>
                              setConfirmation({
                                kind: "device",
                                id: profile.id,
                                label: profile.label,
                              })
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      ))}
                    </details>
                  )}
                  {!!w.history.connections.length && (
                    <details className="help-details">
                      <summary>
                        最近连接地址（{w.history.connections.length}/10）
                      </summary>
                      {w.history.connections.map((c) => (
                        <div
                          className="simple-history-row connection-history"
                          key={c.id}
                        >
                          <Wifi size={17} />
                          <div>
                            <strong>
                              {w.deviceData.profiles.find(
                                (p) => p.id === c.deviceId,
                              )?.label ||
                                c.label ||
                                "待补充备注"}
                            </strong>
                            <small>
                              {c.host}:{c.port} ·{" "}
                              {c.mode === "paired" ? "无线调试" : "IP 连接"}
                            </small>
                          </div>
                          {c.label ? (
                            <button
                              className="text-button"
                              onClick={() => selectHistory(c)}
                            >
                              填入连接信息
                            </button>
                          ) : (
                            <button
                              className="text-button"
                              onClick={() => edit({ connection: c })}
                            >
                              补充备注
                            </button>
                          )}
                          <button
                            className="icon-button"
                            aria-label={`移除连接 ${c.host}:${c.port}`}
                            onClick={() =>
                              setConfirmation({
                                kind: "history",
                                historyKind: "connection",
                                id: c.id,
                              })
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      ))}
                      <button
                        className="text-button danger-text"
                        onClick={() =>
                          setConfirmation({
                            kind: "history",
                            historyKind: "connection",
                          })
                        }
                      >
                        清空连接历史
                      </button>
                    </details>
                  )}
                </>
              )}
            </>,
          )}
          <div className="setup-completion">
            <div>
              <strong>
                {step === 0
                  ? "设备已准备好，可以开始操作"
                  : `请先完成第 ${step} 步`}
              </strong>
              <p>
                {step === 0
                  ? "以后从设备首页直接进入文件管理。需要修改时，再来这里设置。"
                  : "至少连接并命名一台设备，其他未命名设备可以稍后设置。"}
              </p>
            </div>
            <button
              className="button primary"
              disabled={step !== 0}
              onClick={onDone}
            >
              完成设置，进入工作台
              <ArrowRight size={17} />
            </button>
          </div>
          <details className="advanced-settings">
            <summary>
              <Settings2 size={18} />
              高级设置<span>服务启停与 USB 无线模式</span>
            </summary>
            <div>
              <div className="settings-row">
                <div>
                  <strong>ADB 服务</strong>
                  <p>
                    当前
                    {w.helper?.adb.server === "running" ? "正在运行" : "已停止"}
                    。停止会断开设备，并取消本工具的未完成任务；停止后保持停止。
                  </p>
                </div>
                <div className="button-row">
                  <button
                    className="button"
                    disabled={
                      !w.connected ||
                      !w.helper?.adb.valid ||
                      !!busy ||
                      !!activeJobs
                    }
                    onClick={() => void refresh()}
                  >
                    启动／刷新
                  </button>
                  <button
                    className="button danger-outline"
                    disabled={!w.connected || !w.helper?.adb.valid || !!busy}
                    onClick={() => setConfirmation({ kind: "stop" })}
                  >
                    停止服务（kill-server）
                  </button>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <strong>通过 USB 开启传统无线连接</strong>
                  <p>
                    {selectedUsb
                      ? `目标：${selectedUsb.label || selectedUsb.model}`
                      : "先连接并选择一台 USB 设备，再开启无线模式。"}
                  </p>
                </div>
                <div className="button-row">
                  <input
                    className="small-port"
                    type="number"
                    aria-label="传统无线端口"
                    min={1}
                    max={65535}
                    value={port || "5555"}
                    onChange={(e) => setPort(e.target.value)}
                  />
                  <button
                    className="button"
                    disabled={!selectedUsb?.label || !!busy || !!activeJobs}
                    onClick={() =>
                      void run("开启无线模式", async () => {
                        w.applyState(
                          await w.bridge<HelperState>("/devices/tcpip", {
                            serial: selectedUsb!.serial,
                            port: Number(port || 5555),
                          }),
                        );
                        setTab("tcp");
                        setOpenStep(2);
                        w.notify("已开启无线模式，请输入设备 IP 连接。");
                      })
                    }
                  >
                    开启无线模式
                  </button>
                </div>
              </div>
              <HelperPackagePublisher download={downloads} />
              <div className="settings-row">
                <div>
                  <strong>退出 Windows 助手</strong>
                  <p>网页将失去本机连接，未完成任务会取消。</p>
                </div>
                <button
                  className="button"
                  disabled={!w.connected || !!busy}
                  onClick={() => setConfirmation({ kind: "exit" })}
                >
                  退出助手
                </button>
              </div>
            </div>
          </details>
        </div>
        <aside className="setup-aside">
          <Monitor size={28} />
          <h2>只需准备一次</h2>
          <p>
            助手自动管理 ADB。连接地址和设备备注都会保存，下次打开后，从设备首页继续操作。
          </p>
          <div className="aside-divider" />
          <h3>同一设备，一个名字</h3>
          <p>
            USB 和无线连接共用备注。识别不到时，在“填写备注”中选择已有设备即可。
          </p>
          <h3>设备没有授权？</h3>
          <p>保持设备解锁，在设备屏幕上允许 USB 调试，再点击检测。</p>
        </aside>
      </div>
      {confirmation && (
        <Modal
          title={
            confirmation.kind === "stop"
              ? "停止 ADB 服务？"
              : confirmation.kind === "exit"
                ? "退出 Windows 助手？"
                : confirmation.kind === "device"
                  ? `移除“${confirmation.label}”？`
                  : "移除保存的记录？"
          }
          onClose={() => setConfirmation(null)}
        >
          <div className="modal-body">
            <p>
              {confirmation.kind === "stop"
                ? "这会断开所有 ADB 设备，并取消本工具的未完成任务。停止后不会自动重启。"
                : confirmation.kind === "exit"
                  ? "助手退出后需要重新启动并授权。未完成任务会取消，已完成的文件会保留。"
                  : confirmation.kind === "device"
                    ? "将移除设备备注和已关联的连接记录。设备上的文件不会被删除；再次使用需要重新填写备注。"
                    : "只移除保存的连接记录，设备上的文件会保留。"}
            </p>
            {error && <p className="field-help warning-text">{error}</p>}
            <div className="modal-footer">
              <button className="button" onClick={() => setConfirmation(null)}>
                取消
              </button>
              <button
                className="button danger"
                disabled={!!busy}
                onClick={() => void confirm()}
              >
                {busy ? <Busy /> : null}确认
                {confirmation.kind === "stop"
                  ? "停止"
                  : confirmation.kind === "exit"
                    ? "退出"
                    : "移除"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
