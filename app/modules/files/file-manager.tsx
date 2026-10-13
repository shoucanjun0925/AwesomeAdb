"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUp,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  CloudOff,
  Code2,
  Copy,
  Download,
  File,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  Image,
  Info,
  LayoutGrid,
  Link2,
  List,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Smartphone,
  Terminal,
  Trash2,
  Unplug,
  Upload,
  Usb,
  Wifi,
  X,
  XCircle,
} from "lucide-react";
import { useWorkspace } from "../../use-workspace";
import { Badge, Busy, Field, Modal } from "../../ui";
import {
  APP_VERSION,
  modules,
  type ConnectionHistory,
  type Device,
  type FileEntry,
  type HelperState,
  type Job,
} from "../../../shared/contracts";
import { formatBytes, remoteJoin, remotePath } from "../../../shared/paths";

import type { ModuleContext } from "../types";
function fileIcon(entry: FileEntry, size = 22) {
  return entry.type === "directory" ? (
    <Folder size={size} className="folder-icon" fill="currentColor" />
  ) : /\.(png|jpe?g|gif|webp|bmp)$/i.test(entry.name) ? (
    <FileImage size={size} className="image-icon" />
  ) : /\.(txt|log|json|xml|md|csv|ya?ml|ini|conf|js|ts|py|sh)$/i.test(
      entry.name,
    ) ? (
    <FileText size={size} className="text-icon" />
  ) : (
    <File size={size} className="generic-icon" />
  );
}
export default function FileManager({
  services: w,
  serial,
  currentPath,
  setCurrentPath,
  setTaskOpen,
  onConfigure,
  onConnect,
}: ModuleContext) {
  const { helper, connected, bridge, notify } = w;
  const currentDevice = w.namedDevices.find((d) => d.serial === serial),
    available =
      connected &&
      currentDevice?.state === "device" &&
      !!currentDevice.label &&
      !currentDevice.conflict;
  const [uploadOpen, setUploadOpen] = useState(false),
    [pathOpen, setPathOpen] = useState(false),
    [actionError, setActionError] = useState("");
  const jobs = helper?.jobs || [];
  const [busy, setBusy] = useState(""),
    [fileDialog, setFileDialog] = useState<
      "mkdir" | "rename" | "delete" | null
    >(null),
    [pathDraft, setPathDraft] = useState(currentPath),
    [showPreview, setShowPreview] = useState(true),
    [editName, setEditName] = useState("");
  const dialog = fileDialog;
  const setDialog = (
    value: "mkdir" | "rename" | "delete" | "connect" | null,
  ) => (value === "connect" ? onConnect() : setFileDialog(value));
  const setSection = (value: string) => {
    if (value === "home") onConfigure();
  };
  const loadId = useRef(0),
    lastFinished = useRef(""),
    selectionAnchor = useRef("");
  const [entries, setEntries] = useState<FileEntry[]>([]),
    [loading, setLoading] = useState(false),
    [fileError, setFileError] = useState("");
  const [selected, setSelected] = useState<string[]>([]),
    [focusEntry, setFocusEntry] = useState<FileEntry | null>(null),
    [filter, setFilter] = useState("");
  const [sort, setSort] = useState<"name" | "size" | "modifiedAt">("name"),
    [ascending, setAscending] = useState(true),
    [view, setView] = useState<"list" | "grid">("list");
  const [preview, setPreview] = useState<{
      text?: string;
      data?: string;
      mime?: string;
      truncated?: boolean;
    } | null>(null),
    [previewError, setPreviewError] = useState(""),
    [previewBusy, setPreviewBusy] = useState(false),
    [encoding, setEncoding] = useState("utf-8");
  const selectedEntries = entries.filter((e) => selected.includes(e.path));
  const execute = useCallback(
    async (name: string, fn: () => Promise<unknown>) => {
      setBusy(name);
      setActionError("");
      try {
        return await fn();
      } catch (e) {
        setActionError((e as Error).message);
        notify((e as Error).message, true);
        return undefined;
      } finally {
        setBusy("");
      }
    },
    [notify],
  );
  useEffect(() => {
    setPathDraft(currentPath);
    setFilter("");
  }, [currentPath]);
  const navigate = (p: string) => {
    try {
      const next = remotePath(p);
      setCurrentPath(next);
      setPathDraft(next);
      setFilter("");
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const loadFiles = useCallback(async () => {
    const id = ++loadId.current;
    setSelected([]);
    setFocusEntry(null);
    setFileError("");
    if (!available || !serial) {
      setEntries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await bridge<FileEntry[]>(
        `/files?serial=${encodeURIComponent(serial)}&path=${encodeURIComponent(currentPath)}`,
      );
      if (id === loadId.current) setEntries(list);
    } catch (e) {
      if (id === loadId.current) {
        setFileError((e as Error).message);
        setEntries([]);
      }
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  }, [available, serial, currentPath, bridge]);
  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);
  useEffect(() => {
    const key = jobs
      .filter((j) => j.finishedAt && j.serial === serial)
      .map((j) => `${j.id}:${j.finishedAt}`)
      .join("|");
    if (key !== lastFinished.current) {
      lastFinished.current = key;
      void loadFiles();
    }
  }, [jobs, serial, loadFiles]);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewError("");
    setPreviewBusy(false);
    if (!focusEntry || focusEntry.type !== "file" || !available || !showPreview)
      return;
    const image = /\.(png|jpe?g|gif|webp|bmp)$/i.test(focusEntry.name),
      text =
        /\.(txt|log|json|xml|md|csv|ya?ml|ini|conf|js|ts|tsx|jsx|py|sh|java|kt|css|html|properties)$/i.test(
          focusEntry.name,
        );
    if (!image && !text) return;
    setPreviewBusy(true);
    bridge<{
      text?: string;
      data?: string;
      mime?: string;
      truncated?: boolean;
    }>("/files/preview", {
      serial,
      path: focusEntry.path,
      kind: image ? "image" : "text",
      encoding,
    })
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((e) => {
        if (!cancelled) setPreviewError(e.message);
      })
      .finally(() => {
        if (!cancelled) setPreviewBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [focusEntry, encoding, available, serial, bridge, showPreview]);
  const visible = useMemo(
    () =>
      entries
        .filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()))
        .sort((a, b) => {
          if (a.type === "directory" && b.type !== "directory") return -1;
          if (b.type === "directory" && a.type !== "directory") return 1;
          const value =
            sort === "name"
              ? a.name.localeCompare(b.name, "zh-CN", { numeric: true })
              : a[sort] - b[sort];
          return ascending ? value : -value;
        }),
    [entries, filter, sort, ascending],
  );
  const selectEntry = (entry: FileEntry, add = false, range = false) => {
    setFocusEntry(entry);
    const anchor = visible.findIndex((e) => e.path === selectionAnchor.current),
      end = visible.findIndex((e) => e.path === entry.path);
    if (range && anchor >= 0 && end >= 0) {
      setSelected(
        visible
          .slice(Math.min(anchor, end), Math.max(anchor, end) + 1)
          .map((e) => e.path),
      );
      return;
    }
    selectionAnchor.current = entry.path;
    setSelected((prev) =>
      add
        ? prev.includes(entry.path)
          ? prev.filter((p) => p !== entry.path)
          : [...prev, entry.path]
        : [entry.path],
    );
  };
  const transfer = async (kind: "upload" | "download", folder = false) => {
    if (!available) return;
    await execute(
      kind === "upload" ? "选择上传文件" : "选择下载位置",
      async () => {
        if (kind === "download" && !selectedEntries.length)
          throw new Error("请先选择要下载的项目");
        const single =
          kind === "download" &&
          selectedEntries.length === 1 &&
          selectedEntries[0].type === "file";
        const choice = await bridge<{
          cancelled?: boolean;
          selectionId: string;
        }>("/dialog", {
          kind:
            kind === "upload"
              ? folder
                ? "folder"
                : "files"
              : single
                ? "save"
                : "folder",
          name: single ? selectedEntries[0].name : undefined,
        });
        if (choice.cancelled) return;
        await bridge("/jobs", {
          kind,
          serial,
          selectionId: choice.selectionId,
          destination: kind === "upload" ? currentPath : undefined,
          paths: kind === "download" ? selected : undefined,
        });
        setTaskOpen(true);
        notify("任务已加入队列");
      },
    );
  };
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify("已复制");
    } catch {
      notify("无法访问剪贴板，请手动复制", true);
    }
  };
  return (
    <>
      <>
        <div className="page-heading files-heading">
          <div>
            <h1>文件管理</h1>
            <p>
              {available
                ? `${currentDevice!.label} · ${currentDevice!.model} · ${currentDevice!.transport === "usb" ? "USB" : "无线"}`
                : "完成连接与设备备注设置后，即可管理文件。"}
            </p>
          </div>
          <div className="heading-actions upload-control">
            <button
              className="button primary"
              disabled={!available || !!busy}
              aria-expanded={uploadOpen}
              onClick={() => setUploadOpen(!uploadOpen)}
            >
              <ArrowUpFromLine size={16} />
              上传到设备
              <ChevronDown size={15} />
            </button>
            {uploadOpen && (
              <div className="upload-options">
                <button
                  onClick={() => {
                    setUploadOpen(false);
                    void transfer("upload");
                  }}
                >
                  <File size={17} />
                  上传文件
                </button>
                <button
                  onClick={() => {
                    setUploadOpen(false);
                    void transfer("upload", true);
                  }}
                >
                  <Folder size={17} />
                  上传文件夹
                </button>
              </div>
            )}
          </div>
        </div>
        {actionError && (
          <div className="notice error" role="alert">
            {actionError}
          </div>
        )}
        <section className="file-workspace">
          <div className="file-toolbar">
            <div className="path-navigation">
              <button
                className="icon-button"
                aria-label="上一级"
                disabled={!available || currentPath === "/"}
                onClick={() =>
                  navigate(
                    currentPath.slice(0, currentPath.lastIndexOf("/")) || "/",
                  )
                }
              >
                <ArrowUp size={17} />
              </button>
              <button
                className="icon-button"
                title="刷新目录"
                disabled={!available || loading}
                onClick={() => void loadFiles()}
              >
                <RefreshCw size={16} className={loading ? "spin" : ""} />
              </button>
              <button
                className="text-button path-toggle"
                aria-expanded={pathOpen}
                onClick={() => setPathOpen(!pathOpen)}
                disabled={!available}
              >
                <HardDrive size={16} />
                {pathOpen ? "收起路径输入" : "输入目录路径"}
              </button>
              {pathOpen && (
                <form
                  className="address-bar"
                  onSubmit={(e) => {
                    e.preventDefault();
                    navigate(pathDraft);
                    setPathOpen(false);
                  }}
                >
                  <HardDrive size={16} />
                  <input
                    aria-label="设备目录路径"
                    value={pathDraft}
                    onChange={(e) => setPathDraft(e.target.value)}
                    disabled={!available}
                  />
                  <button title="前往目录" disabled={!available}>
                    <ArrowRight size={15} />
                  </button>
                </form>
              )}
            </div>
            <div className="file-search">
              <Search size={15} />
              <input
                placeholder="搜索当前文件夹"
                aria-label="搜索当前文件夹"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              {filter && (
                <button aria-label="清除搜索" onClick={() => setFilter("")}>
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
          <div className="file-actions">
            <div className="action-group">
              <button
                disabled={!available || !!busy}
                onClick={() => {
                  setEditName("");
                  setDialog("mkdir");
                }}
              >
                <FolderPlus size={16} />
                新建文件夹
              </button>
              {selected.length > 0 ? (
                <>
                  <span className="action-divider" />
                  <span className="selection-count">
                    已选 {selected.length} 项
                  </span>
                  <button
                    disabled={!selected.length || !available || !!busy}
                    onClick={() => void transfer("download")}
                  >
                    <ArrowDownToLine size={16} />
                    下载到电脑
                  </button>
                  <button
                    disabled={selected.length !== 1 || !available || !!busy}
                    onClick={() => {
                      setEditName(selectedEntries[0].name);
                      setDialog("rename");
                    }}
                  >
                    <Pencil size={15} />
                    重命名
                  </button>
                  <button
                    className="danger-action"
                    disabled={!selected.length || !available || !!busy}
                    onClick={() => setDialog("delete")}
                  >
                    <Trash2 size={15} />
                    删除
                  </button>
                </>
              ) : (
                <span className="selection-hint">
                  选择文件后，可以下载到电脑、重命名或删除
                </span>
              )}
            </div>
            <div className="view-actions">
              <button
                className={view === "list" ? "active" : ""}
                title="列表视图"
                onClick={() => setView("list")}
              >
                <List size={17} />
              </button>
              <button
                className={view === "grid" ? "active" : ""}
                title="网格视图"
                onClick={() => setView("grid")}
              >
                <LayoutGrid size={16} />
              </button>
              <span className="action-divider" />
              <button
                className={showPreview ? "active" : ""}
                title="显示或隐藏详情"
                onClick={() => setShowPreview(!showPreview)}
              >
                <Info size={17} />
              </button>
            </div>
          </div>
          <div className="breadcrumbs">
            <button
              onClick={() =>
                navigate(currentPath.startsWith("/sdcard") ? "/sdcard" : "/")
              }
            >
              {currentPath.startsWith("/sdcard") ? "内部存储" : "设备根目录"}
            </button>
            {currentPath !== "/sdcard" &&
              currentPath
                .split("/")
                .filter(Boolean)
                .map((part, i, parts) => (
                  <span key={i} hidden={i === 0 && part === "sdcard"}>
                    <ChevronRight size={12} />
                    <button
                      onClick={() =>
                        navigate("/" + parts.slice(0, i + 1).join("/"))
                      }
                    >
                      {part}
                    </button>
                  </span>
                ))}
          </div>
          <div
            className={`file-body ${showPreview && focusEntry && selected.length === 1 ? "with-preview" : ""}`}
          >
            <div
              className="file-list-region"
              tabIndex={0}
              onKeyDown={(e) => {
                if ((e.target as HTMLElement).matches("input,select,textarea"))
                  return;
                if (e.key === "Delete" && selected.length) {
                  setDialog("delete");
                  e.preventDefault();
                }
                if ((e.ctrlKey || e.metaKey) && e.key === "a") {
                  e.preventDefault();
                  setSelected(visible.map((x) => x.path));
                }
                if (e.key === "F2" && selectedEntries.length === 1) {
                  setEditName(selectedEntries[0].name);
                  setDialog("rename");
                  e.preventDefault();
                }
                if (e.key === "Enter" && focusEntry?.type === "directory")
                  navigate(focusEntry.path);
                if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault();
                  const index = visible.findIndex(
                    (entry) => entry.path === focusEntry?.path,
                  );
                  const next =
                    visible[
                      Math.max(
                        0,
                        Math.min(
                          visible.length - 1,
                          index + (e.key === "ArrowUp" ? -1 : 1),
                        ),
                      )
                    ];
                  if (next) selectEntry(next, false, e.shiftKey);
                }
                if (e.key === "Backspace" && available) {
                  e.preventDefault();
                  navigate(
                    currentPath.slice(0, currentPath.lastIndexOf("/")) || "/",
                  );
                }
              }}
            >
              {!available ? (
                <div className="files-empty">
                  <div className="files-empty-icon">
                    <FolderOpen size={44} />
                    <span>
                      <Plug size={18} />
                    </span>
                  </div>
                  <h3>
                    {currentDevice && !currentDevice.label
                      ? "请先填写设备备注"
                      : currentDevice?.state === "unauthorized"
                        ? "请在设备上允许 USB 调试"
                        : currentDevice?.state === "offline"
                          ? "设备当前离线"
                          : "连接设备，开始管理文件"}
                  </h3>
                  <p>
                    {currentDevice && !currentDevice.label
                      ? "在连接与设置中填写备注，或将此连接关联到已有设备。"
                      : currentDevice?.state === "unauthorized"
                        ? "解锁 Android 设备，在授权弹窗中允许这台电脑，再刷新设备列表。"
                        : currentDevice?.state === "offline"
                          ? "检查数据线或无线网络，重新连接设备后刷新。"
                          : "你的设备文件将在这里显示。先连接 Windows 助手，再通过 USB 或无线连接设备。"}
                  </p>
                  <button className="button primary" onClick={onConfigure}>
                    <Plug size={16} />
                    去连接与设置
                  </button>
                </div>
              ) : loading ? (
                <div className="files-empty">
                  <Busy size={28} />
                  <p>正在读取设备目录…</p>
                </div>
              ) : fileError ? (
                <div className="files-empty">
                  <XCircle size={32} className="amber-text" />
                  <h3>无法打开此目录</h3>
                  <p>{fileError}</p>
                  <button className="button" onClick={() => void loadFiles()}>
                    <RefreshCw size={15} />
                    重试
                  </button>
                </div>
              ) : !visible.length ? (
                <div className="files-empty">
                  <FolderOpen size={38} className="muted" />
                  <h3>{filter ? "没有匹配的文件" : "这个文件夹是空的"}</h3>
                  <p>
                    {filter
                      ? "尝试其他文件名称。"
                      : "上传文件或新建文件夹，开始整理。"}
                  </p>
                </div>
              ) : view === "list" ? (
                <table className="file-table">
                  <thead>
                    <tr>
                      <th className="checkbox-cell">
                        <input
                          type="checkbox"
                          aria-label="选择全部文件"
                          checked={
                            visible.length > 0 &&
                            visible.every((e) => selected.includes(e.path))
                          }
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? visible.map((x) => x.path)
                                : [],
                            )
                          }
                        />
                      </th>
                      {(["name", "size", "modifiedAt"] as const).map(
                        (field, i) => (
                          <th key={field}>
                            <button
                              onClick={() => {
                                if (sort === field) setAscending(!ascending);
                                else {
                                  setSort(field);
                                  setAscending(true);
                                }
                              }}
                            >
                              {["名称", "大小", "修改时间"][i]}
                              {sort === field && (
                                <ChevronDown
                                  size={12}
                                  className={ascending ? "" : "rotate"}
                                />
                              )}
                            </button>
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((entry) => (
                      <tr
                        key={entry.path}
                        className={
                          selected.includes(entry.path) ? "selected" : ""
                        }
                        onClick={(e) =>
                          selectEntry(entry, e.ctrlKey || e.metaKey, e.shiftKey)
                        }
                        onDoubleClick={() =>
                          entry.type === "directory"
                            ? navigate(entry.path)
                            : setFocusEntry(entry)
                        }
                      >
                        <td
                          className="checkbox-cell"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label={`选择 ${entry.name}`}
                            checked={selected.includes(entry.path)}
                            onChange={() => selectEntry(entry, true)}
                          />
                        </td>
                        <td>
                          <span className="file-name">
                            {fileIcon(entry)}
                            <span>
                              {entry.name}
                              {entry.type === "symlink" && (
                                <small>符号链接</small>
                              )}
                            </span>
                          </span>
                        </td>
                        <td className="numeric">
                          {entry.type === "directory"
                            ? "—"
                            : formatBytes(entry.size)}
                        </td>
                        <td className="date-cell">
                          {new Date(entry.modifiedAt).toLocaleString("zh-CN", {
                            year: "numeric",
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="file-grid">
                  {visible.map((entry) => (
                    <button
                      key={entry.path}
                      className={`file-tile ${selected.includes(entry.path) ? "selected" : ""}`}
                      onClick={(e) =>
                        selectEntry(entry, e.ctrlKey || e.metaKey, e.shiftKey)
                      }
                      onDoubleClick={() =>
                        entry.type === "directory" && navigate(entry.path)
                      }
                    >
                      {fileIcon(entry, 42)}
                      <span>{entry.name}</span>
                      <small>
                        {entry.type === "directory"
                          ? "文件夹"
                          : formatBytes(entry.size)}
                      </small>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {showPreview && focusEntry && selected.length === 1 && (
              <aside className="preview-panel">
                <div className="preview-title">
                  <strong>文件详情</strong>
                  <button
                    className="icon-button"
                    aria-label="关闭文件详情"
                    onClick={() => setShowPreview(false)}
                  >
                    <X size={15} />
                  </button>
                </div>
                {focusEntry ? (
                  <>
                    <div className="file-visual">
                      {preview?.data ? (
                        <img
                          src={`data:${preview.mime};base64,${preview.data}`}
                          alt={focusEntry.name}
                        />
                      ) : (
                        fileIcon(focusEntry, 56)
                      )}
                    </div>
                    <h3>{focusEntry.name}</h3>
                    <Badge>
                      {focusEntry.type === "directory"
                        ? "文件夹"
                        : focusEntry.type === "symlink"
                          ? "符号链接"
                          : "文件"}
                    </Badge>
                    <dl>
                      <dt>大小</dt>
                      <dd>{formatBytes(focusEntry.size)}</dd>
                      <dt>修改时间</dt>
                      <dd>
                        {new Date(focusEntry.modifiedAt).toLocaleString(
                          "zh-CN",
                        )}
                      </dd>
                      <dt>位置</dt>
                      <dd>
                        <code>{focusEntry.path}</code>
                        <button
                          className="icon-button"
                          title="复制位置"
                          onClick={() => void copy(focusEntry.path)}
                        >
                          <Copy size={12} />
                        </button>
                      </dd>
                    </dl>
                    {previewBusy && (
                      <p className="preview-note">
                        <Busy />
                        正在读取预览…
                      </p>
                    )}
                    {previewError && (
                      <p className="inline-error">{previewError}</p>
                    )}
                    {preview?.text !== undefined && (
                      <>
                        <div className="text-preview-heading">
                          <strong>文本预览</strong>
                          <select
                            aria-label="文本编码"
                            value={encoding}
                            onChange={(e) => setEncoding(e.target.value)}
                          >
                            <option value="utf-8">UTF-8</option>
                            <option value="gb18030">GB18030</option>
                          </select>
                        </div>
                        <pre className="text-preview">{preview.text}</pre>
                        {preview.truncated && (
                          <p className="preview-note">
                            仅展示前 1 MiB，下载可查看完整内容。
                          </p>
                        )}
                      </>
                    )}
                    <button
                      className="button preview-download"
                      disabled={!!busy}
                      onClick={() => {
                        setSelected([focusEntry.path]);
                        void execute("选择下载位置", async () => {
                          const choice = await bridge<{
                            cancelled?: boolean;
                            selectionId: string;
                          }>("/dialog", {
                            kind:
                              focusEntry.type === "file" ? "save" : "folder",
                            name: focusEntry.name,
                          });
                          if (choice.cancelled) return;
                          await bridge("/jobs", {
                            kind: "download",
                            serial,
                            paths: [focusEntry.path],
                            selectionId: choice.selectionId,
                          });
                          setTaskOpen(true);
                        });
                      }}
                    >
                      <ArrowDownToLine size={15} />
                      下载到电脑
                    </button>
                  </>
                ) : (
                  <div className="preview-placeholder">
                    <div>
                      <FileText size={30} />
                    </div>
                    <strong>每个文件，一目了然</strong>
                    <p>
                      选择文件查看属性，
                      <br />
                      图片与文本可直接预览。
                    </p>
                  </div>
                )}
              </aside>
            )}
          </div>
          <div className="file-status">
            <span>
              {visible.length} 个项目
              {selected.length > 0 && ` · 已选择 ${selected.length} 项`}
            </span>
            <span>
              <ShieldCheck size={12} />
              本机直连传输
            </span>
          </div>
        </section>
      </>
      {(dialog === "mkdir" || dialog === "rename") && (
        <Modal
          title={dialog === "mkdir" ? "新建文件夹" : "重命名"}
          subtitle={
            dialog === "mkdir"
              ? `创建于 ${currentPath}`
              : selectedEntries[0]?.name
          }
          onClose={() => setDialog(null)}
        >
          <form
            className="modal-body"
            onSubmit={(e) => {
              e.preventDefault();
              void execute("保存名称", async () => {
                await bridge(
                  dialog === "mkdir" ? "/files/mkdir" : "/files/rename",
                  {
                    serial,
                    path: dialog === "mkdir" ? currentPath : selected[0],
                    name: editName,
                  },
                );
                setDialog(null);
                await loadFiles();
                notify("操作已完成");
              });
            }}
          >
            <Field label="名称">
              <input
                autoFocus
                value={editName}
                maxLength={255}
                required
                onFocus={(e) => e.target.select()}
                onChange={(e) => setEditName(e.target.value)}
              />
            </Field>
            <div className="modal-footer">
              <button
                type="button"
                className="button"
                onClick={() => setDialog(null)}
              >
                取消
              </button>
              <button className="button primary" disabled={!!busy || !editName}>
                {busy ? <Busy /> : <Check size={15} />}保存
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === "delete" && (
        <Modal
          title={`删除 ${selected.length} 个项目？`}
          onClose={() => setDialog(null)}
        >
          <div className="modal-body">
            <p className="confirm-description">
              所选项目将从 Android 设备中删除，删除后无法在本工具中撤销。
            </p>
            <div className="delete-items">
              {selectedEntries.map((e) => (
                <div key={e.path}>
                  {fileIcon(e, 17)}
                  <span>{e.name}</span>
                </div>
              ))}
            </div>
            <div className="modal-footer">
              <button className="button" onClick={() => setDialog(null)}>
                取消
              </button>
              <button
                className="button danger"
                disabled={!!busy}
                onClick={() =>
                  void execute("删除项目", async () => {
                    await bridge("/jobs", {
                      kind: "delete",
                      serial,
                      paths: selected,
                    });
                    setTaskOpen(true);
                    setDialog(null);
                  })
                }
              >
                {busy ? <Busy /> : <Trash2 size={15} />}确认删除
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
