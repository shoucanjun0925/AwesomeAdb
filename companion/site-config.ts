import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDirectory } from "./config";
import { native } from "./native";
import { validatedSiteUrl } from "../shared/downloads";

const cachedFile = path.join(dataDirectory, "site.json");
function readSite(file: string): string {
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.schemaVersion !== 1) throw new Error("站点配置版本不支持，请从工作台重新下载");
  return validatedSiteUrl(value.siteUrl);
}
export async function resolveSiteUrl(): Promise<string> {
  let cached: string | null = null;
  try { cached = readSite(cachedFile); } catch { /* First run. */ }
  const adjacent = path.join(path.dirname(process.execPath), "AwesomeAdb-site.json");
  let selected = existsSync(adjacent) ? readSite(adjacent) : cached;
  if (!selected) {
    const files = await native<string[]>("site", {});
    if (!files.length) throw new Error("请从你的工作台下载完整安装包，或下载 AwesomeAdb-site.json 后放在助手旁边，再次启动。无需配置 ADB。");
    selected = readSite(files[0]);
  }
  if (cached && cached !== selected) {
    const allowed = await native<boolean>("confirm", { message: `此安装包将工作台改为：\n${selected}\n\n原工作台：${cached}\n\n是否使用新工作台？后续设备操作仍须在本机授权。` });
    if (!allowed) return cached;
  }
  const temp = cachedFile + ".tmp";
  writeFileSync(temp, JSON.stringify({ schemaVersion: 1, siteUrl: selected }, null, 2));
  renameSync(temp, cachedFile);
  return selected;
}
