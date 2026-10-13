import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { downloadManifestSchema } from "../../../shared/downloads";

export const currentDownloadKey = "downloads/current.json";
export async function downloadContext() {
  const user = await getChatGPTUser();
  if (!user) throw Object.assign(new Error("请先登录，再下载助手"), { status: 401 });
  const ownerEmail = env.DOWNLOADS_OWNER_EMAIL?.trim().toLowerCase();
  return { user, bucket: env.BUCKET, adminAllowed: !!ownerEmail && user.email.toLowerCase() === ownerEmail };
}
export async function currentDownload(bucket?: R2Bucket) {
  if (!bucket) return null;
  const object = await bucket.get(currentDownloadKey);
  if (!object) return null;
  const parsed = downloadManifestSchema.safeParse(await object.json());
  if (!parsed.success) throw new Error("安装包信息暂时不可用，请稍后重试");
  return parsed.data;
}
export function downloadError(error: unknown) {
  const e = error as Error & { status?: number };
  return Response.json({ error: { code: "DOWNLOAD_ERROR", message: e.message || "下载服务暂不可用" } },
    { status: e.status || 500, headers: { "Cache-Control": "private, no-store" } });
}
