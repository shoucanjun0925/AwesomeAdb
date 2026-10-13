"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Download, ExternalLink, PackageCheck, RefreshCw } from "lucide-react";
import { APP_VERSION, type ApiFailure } from "../shared/contracts";
import { Busy, Field } from "./ui";

type DownloadMetadata = {
  version: string;
  fileName: string;
  size: number;
  sha256: string;
  available: boolean;
  githubUrl: string;
  sourceUrl: string;
  notes: string;
  adminAllowed?: boolean;
};
const repository = "https://github.com/shoucanjun0925/AwesomeAdb";

export function useHelperDownloads() {
  const [metadata, setMetadata] = useState<DownloadMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/downloads", {
        cache: "no-store",
        signal: AbortSignal.timeout(20000),
      });
      const value = (await response.json()) as DownloadMetadata & ApiFailure;
      if (!response.ok)
        throw new Error(value.error?.message || "暂时无法获取安装包信息");
      setMetadata(value);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { metadata, loading, error, refresh };
}
type Downloads = ReturnType<typeof useHelperDownloads>;

export function HelperDownloadCard({ download }: { download: Downloads }) {
  const { metadata, loading, error, refresh } = download;
  return (
    <div className="helper-download-card">
      <span className="helper-download-icon"><Download size={25} /></span>
      <div className="helper-download-content">
        <h3>Windows 助手</h3>
        <p>已包含 ADB，下载后即可使用。无需安装 Node.js 或配置路径。</p>
        <div className="helper-download-actions">
          {metadata?.available ? (
            <a className="button primary" href="/api/downloads/windows" download>
              <Download size={17} />下载 Windows 助手
            </a>
          ) : (
            <button className="button primary" disabled>
              {loading ? <Busy /> : <PackageCheck size={17} />}
              {loading ? "正在获取下载信息" : "安装包准备中"}
            </button>
          )}
          {metadata?.version && (
            <span className="download-version">
              v{metadata.version} · Windows 10/11 x64
              {metadata.size > 0 && ` · ${(metadata.size / 1024 / 1024).toFixed(1)} MB`}
            </span>
          )}
        </div>
        {error && (
          <div className="download-error" role="alert">
            <span>{error}。可以重试，或使用下方 GitHub 下载。</span>
            <button className="text-button" disabled={loading} onClick={() => void refresh()}>
              <RefreshCw size={14} />重试
            </button>
          </div>
        )}
        <details className="download-alternatives">
          <summary>更新说明与备用下载</summary>
          {metadata?.notes && <p className="release-notes">{metadata.notes}</p>}
          <p>从本站下载的压缩包已经带好本站配置。更新助手前，请先完成任务并退出旧助手，再解压新版运行。</p>
          <div className="download-links">
            <a href={metadata?.githubUrl || `${repository}/releases/latest`} target="_blank" rel="noreferrer">
              GitHub 通用版 <ExternalLink size={13} />
            </a>
            <a href="/api/downloads/site-config" download>下载本站配置</a>
            <a href={metadata?.sourceUrl || repository} target="_blank" rel="noreferrer">
              查看公开源码 <ExternalLink size={13} />
            </a>
          </div>
          <p>使用 GitHub 通用版时，将本站配置文件放到助手同一文件夹，或在助手首次启动时导入。</p>
          {metadata?.sha256 && (
            <details className="download-checksum">
              <summary>查看安装包校验值</summary>
              <code>SHA-256: {metadata.sha256}</code>
            </details>
          )}
        </details>
      </div>
    </div>
  );
}

export function HelperPackagePublisher({ download }: { download: Downloads }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  if (!download.metadata?.adminAllowed) return null;
  const publish = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError("");
    setResult("");
    try {
      const data = new FormData(form);
      const file = data.get("file");
      if (!(file instanceof File) || !file.size)
        throw new Error("请选择要发布的 ZIP 安装包");
      const query = new URLSearchParams({
        version: String(data.get("version") || ""),
        sha256: String(data.get("sha256") || "").trim().toLowerCase(),
        fileName: file.name,
        notes: String(data.get("notes") || ""),
      });
      const response = await fetch(`/api/downloads/admin?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: file,
      });
      const value = (await response.json()) as ApiFailure;
      if (!response.ok)
        throw new Error(value.error?.message || "安装包发布失败，请重试");
      setResult("安装包已发布，页面下载入口已更新。");
      await download.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="package-publisher help-details">
      <summary><PackageCheck size={16} />安装包发布（仅站点所有者）</summary>
      <p>上传包含本站配置的 Windows 压缩包。校验成功后才会替换当前下载版本。</p>
      <form className="publisher-form" onSubmit={(e) => void publish(e)}>
        <Field label="Windows 安装包（ZIP）">
          <input type="file" name="file" accept=".zip,application/zip" required disabled={busy} />
        </Field>
        <Field label="助手版本">
          <input name="version" defaultValue={APP_VERSION} required maxLength={30} disabled={busy} />
        </Field>
        <Field label="安装包 SHA-256">
          <input name="sha256" required pattern="[a-fA-F0-9]{64}" placeholder="填写打包时生成的 64 位校验值" disabled={busy} />
        </Field>
        <Field label="更新说明">
          <textarea name="notes" rows={3} maxLength={2000} placeholder="本次新增功能与使用提示" disabled={busy} />
        </Field>
        {error && <div className="notice error" role="alert">{error}</div>}
        {result && <p className="publisher-success" role="status">{result}</p>}
        <button className="button" disabled={busy}>
          {busy ? <Busy /> : <PackageCheck size={16} />}
          {busy ? "正在上传并校验，请保持页面打开" : "上传并发布下载包"}
        </button>
      </form>
    </details>
  );
}
