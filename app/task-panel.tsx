"use client";
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  Download,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import type { useWorkspace } from "./use-workspace";
import { formatBytes } from "../shared/paths";
import { Badge, Busy, Modal } from "./ui";
import { transportBindingKey } from "../shared/devices";

export function TaskPanel({
  services: w,
  open,
  setOpen,
}: {
  services: ReturnType<typeof useWorkspace>;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const [all, setAll] = useState(false);
  const targets = useRef(new Map<string, string>());
  const jobs = w.helper?.jobs || [],
    active = jobs.filter((j) =>
      ["queued", "running", "conflict"].includes(j.state),
    );
  const conflict = jobs.find((j) => j.state === "conflict" && j.conflict);
  const action = async (route: string, input: unknown = {}) => {
    try {
      await w.bridge(route, input);
    } catch (e) {
      w.notify((e as Error).message, true);
    }
  };
  const label = (serial: string, jobId: string) => {
    const captured = targets.current.get(jobId);
    if (captured)
      return (
        w.deviceData.profiles.find((p) => p.id === captured)?.label || serial
      );
    const current = w.namedDevices.find((d) => d.serial === serial);
    if (current?.profileId) {
      targets.current.set(jobId, current.profileId);
      return current.label;
    }
    const key = transportBindingKey({
      serial,
      transport:
        serial.includes(":") || serial.includes("._tcp") ? "tcp" : "usb",
    });
    const profileId = w.deviceData.bindings.find(
      (b) => b.bindingKey === key,
    )?.profileId;
    if (profileId) targets.current.set(jobId, profileId);
    return (
      w.deviceData.profiles.find((p) => p.id === profileId)?.label || serial
    );
  };
  if (!jobs.length) return null;
  return (
    <>
      <div className={`task-dock ${open ? "expanded" : ""}`}>
        <button
          className="task-dock-heading"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span>
            <ArrowDownToLine size={17} />
            <strong>传输与操作任务</strong>
            <small>
              {active.length
                ? `${active.length} 个进行中`
                : `${jobs.length} 条记录`}
            </small>
          </span>
          <span>
            {!!active.length && <Busy size={14} />}
            <ChevronDown size={16} className={open ? "rotate" : ""} />
          </span>
        </button>
        {open && (
          <div className="task-list">
            {[...jobs].reverse().map((job) => (
              <div className="job-row" key={job.id}>
                <span className={`job-icon ${job.state}`}>
                  {job.state === "succeeded" ? (
                    <Check size={19} />
                  ) : job.kind === "upload" ? (
                    <Upload size={19} />
                  ) : job.kind === "download" ? (
                    <Download size={19} />
                  ) : (
                    <Trash2 size={19} />
                  )}
                </span>
                <div className="job-main">
                  <div>
                    <strong>{job.label}</strong>
                    <span className={`job-state ${job.state}`}>
                      {job.phase}
                    </span>
                  </div>
                  <small className="job-device">
                    {label(job.serial, job.id)} · {job.serial}
                  </small>
                  <small title={job.currentPath}>{job.currentPath}</small>
                  <div className="job-progress">
                    <i
                      style={{
                        width: `${job.state === "succeeded" ? 100 : job.totalBytes ? Math.min(100, (job.completedBytes / job.totalBytes) * 100) : job.totalFiles ? (job.completedFiles / job.totalFiles) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <small>
                    {job.completedFiles}/{job.totalFiles} 项 ·{" "}
                    {formatBytes(job.completedBytes)} /{" "}
                    {formatBytes(job.totalBytes)}
                    {job.speed > 0 && ` · ${formatBytes(job.speed)}/s`}
                    {job.skipped > 0 && ` · 跳过 ${job.skipped} 项`}
                  </small>
                  {!!job.errors.length && (
                    <details className="job-errors">
                      <summary>{job.errors.length} 个项目未完成</summary>
                      {job.errors.map((e, i) => (
                        <p key={i}>
                          {e.path}：{e.message}
                        </p>
                      ))}
                    </details>
                  )}
                </div>
                <div className="job-controls">
                  {["queued", "running", "conflict"].includes(job.state) && (
                    <button
                      className="icon-button"
                      title="取消任务"
                      onClick={() => void action(`/jobs/${job.id}/cancel`)}
                    >
                      <X size={16} />
                    </button>
                  )}
                  {job.retryable && (
                    <button
                      className="button small"
                      onClick={() => void action(`/jobs/${job.id}/retry`)}
                    >
                      <RefreshCw size={14} />
                      重试失败项
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {conflict?.conflict && (
        <Modal
          dismissible={false}
          title="遇到同名文件"
          subtitle={`目标设备：${label(conflict.serial, conflict.id)}`}
          onClose={() => {}}
        >
          <div className="modal-body">
            <p className="conflict-path">{conflict.conflict.destination}</p>
            <p className="panel-description">
              目标位置已有同名{conflict.conflict.directory ? "文件夹" : "文件"}
              ，请选择处理方式。
            </p>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={all}
                onChange={(e) => setAll(e.target.checked)}
              />
              应用于此任务的全部重名项目
            </label>
            <div className="modal-footer conflict-actions">
              <button
                className="button"
                onClick={() => {
                  void action(`/jobs/${conflict.id}/cancel`);
                  setAll(false);
                }}
              >
                取消任务
              </button>
              {(
                [
                  ["skip", "跳过"],
                  ["keep-both", "保留两份"],
                  ["overwrite", "覆盖"],
                ] as const
              ).map(([value, text]) => (
                <button
                  key={value}
                  className={`button ${value === "keep-both" ? "primary" : ""}`}
                  onClick={() => {
                    void action(`/jobs/${conflict.id}/resolve`, {
                      action: value,
                      all,
                    });
                    setAll(false);
                  }}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
