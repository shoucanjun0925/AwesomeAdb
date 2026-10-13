import { currentDownload, downloadContext, downloadError } from "../service";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const { bucket } = await downloadContext();
    const manifest = await currentDownload(bucket);
    if (!manifest || !bucket) throw Object.assign(new Error("安装包准备中，请稍后再来"), { status: 404 });
    const object = await bucket.get(manifest.key);
    if (!object || object.size !== manifest.size) throw Object.assign(new Error("安装包暂不可用，请稍后重试"), { status: 503 });
    return new Response(object.body, { headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${manifest.fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Checksum-SHA256": manifest.sha256,
    } });
  } catch (e) { return downloadError(e); }
}
