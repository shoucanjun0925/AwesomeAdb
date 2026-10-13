export function remotePath(value: string): string {
  if (!value.startsWith("/") || value.includes("\0"))
    throw new Error("设备路径必须是绝对路径");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}
export function remoteJoin(parent: string, name: string): string {
  if (!name || name === "." || name === ".." || /[\/\0]/.test(name))
    throw new Error("文件名称不合法");
  return remotePath(parent + "/" + name);
}
export function remoteName(value: string): string {
  return value.split("/").filter(Boolean).at(-1) ?? "";
}
export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("路径不能包含空字符");
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
export function assertMutablePath(value: string): string {
  const p = remotePath(value);
  if (
    [
      "/",
      "/sdcard",
      "/storage",
      "/storage/emulated",
      "/storage/emulated/0",
      "/data",
      "/system",
    ].includes(p)
  )
    throw new Error("不能修改设备根目录或存储根目录");
  return p;
}
export function windowsName(name: string): string {
  if (
    !name ||
    /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)
  )
    throw new Error(`“${name}”无法作为 Windows 文件名，请先重命名`);
  return name;
}
export function retainedIds<T extends { id: string; lastUsedAt: number }>(
  items: T[],
  limit = 10,
): string[] {
  return [...items]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.id.localeCompare(a.id))
    .slice(0, limit)
    .map((i) => i.id);
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024,
    i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
