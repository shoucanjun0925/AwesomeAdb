import { z } from "zod";
import { currentDownloadKey, downloadContext, downloadError } from "../service";
import { downloadManifestSchema } from "../../../../shared/downloads";
export const dynamic = "force-dynamic";
const limit = 128 * 1024 * 1024;
export async function POST(request: Request) {
  try {
    const { bucket, adminAllowed } = await downloadContext();
    if (!adminAllowed) throw Object.assign(new Error("只有站点所有者可以发布安装包"), { status: 403 });
    if (!bucket) throw Object.assign(new Error("安装包存储尚未启用"), { status: 503 });
    if (request.headers.get("origin") !== new URL(request.url).origin)
      throw Object.assign(new Error("请求来源不正确"), { status: 403 });
    const query = new URL(request.url).searchParams;
    const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/).parse(query.get("version"));
    const sha256 = z.string().regex(/^[a-f0-9]{64}$/).parse(query.get("sha256"));
    const fileName = `AwesomeAdb-Windows-x64-v${version}.zip`;
    if (query.get("fileName") !== fileName) throw Object.assign(new Error("安装包文件名与版本不一致"), { status: 400 });
    const notes = z.string().max(2000).parse(query.get("notes") || "");
    if (!request.body || request.headers.get("content-type") !== "application/zip")
      throw Object.assign(new Error("请选择 ZIP 安装包"), { status: 400 });
    const declaredSize = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > limit)
      throw Object.assign(new Error("请选择不超过 128 MiB 的完整安装包"), { status: 413 });
    const size = declaredSize;
    const key = `downloads/${version}/${sha256}.zip`;
    const checksum = Uint8Array.from(sha256.match(/../g)!, x => Number.parseInt(x, 16));
    await bucket.put(key, request.body, {
      sha256: checksum,
      httpMetadata: { contentType: "application/zip" },
      customMetadata: { version, fileName, sha256 },
    });
    const manifest = downloadManifestSchema.parse({ version, fileName, size, sha256, key, notes, publishedAt: new Date().toISOString() });
    await bucket.put(currentDownloadKey, JSON.stringify(manifest), { httpMetadata: { contentType: "application/json" } });
    return Response.json({ ok: true, version, size, sha256 }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    if (e instanceof z.ZodError) return downloadError(Object.assign(new Error("安装包信息格式不正确"), { status: 400 }));
    return downloadError(e);
  }
}
