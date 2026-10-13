import { PUBLIC_REPOSITORY } from "../../../shared/downloads";
import { currentDownload, downloadContext, downloadError } from "./service";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const { bucket, adminAllowed } = await downloadContext();
    const manifest = await currentDownload(bucket);
    return Response.json({
      available: !!manifest,
      version: manifest?.version || null,
      fileName: manifest?.fileName || null,
      size: manifest?.size || 0,
      sha256: manifest?.sha256 || null,
      notes: manifest?.notes || "内置 ADB，无需配置路径。解压后双击助手即可开始。",
      publishedAt: manifest?.publishedAt || null,
      githubUrl: PUBLIC_REPOSITORY + "/releases/latest",
      sourceUrl: PUBLIC_REPOSITORY,
      adminAllowed,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return downloadError(e); }
}
