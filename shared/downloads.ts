import { z } from "zod";

export const PUBLIC_REPOSITORY = "https://github.com/shoucanjun0925/AwesomeAdb";
export const downloadManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  fileName: z.string().regex(/^AwesomeAdb-Windows-x64-v[\w.-]+\.zip$/),
  size: z.number().int().positive().max(128 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  key: z.string().regex(/^downloads\/[\w.-]+\/[a-f0-9]{64}\.zip$/),
  notes: z.string().max(2000),
  publishedAt: z.string().datetime(),
});
export type DownloadManifest = z.infer<typeof downloadManifestSchema>;

export function validatedSiteUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("站点配置缺少网址");
  let u: URL;
  try { u = new URL(value); } catch { throw new Error("站点网址格式不正确"); }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash)
    throw new Error("站点网址必须是没有凭证、端口或查询参数的 HTTPS 地址");
  if (u.pathname !== "/") throw new Error("请使用工作台首页网址");
  return u.origin + "/";
}
