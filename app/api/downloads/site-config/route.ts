import { downloadContext, downloadError } from "../service";
import { validatedSiteUrl } from "../../../../shared/downloads";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await downloadContext();
    const siteUrl = validatedSiteUrl(new URL(request.url).origin);
    return new Response(JSON.stringify({ schemaVersion: 1, siteUrl }, null, 2) + "\n", { headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="AwesomeAdb-site.json"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (e) { return downloadError(e); }
}
