export function trimHistorySql(kind: "adb" | "connection") {
  return kind === "adb"
    ? "DELETE FROM adb_paths WHERE user_id = ? AND machine_id = ? AND id NOT IN (SELECT id FROM adb_paths WHERE user_id = ? AND machine_id = ? ORDER BY last_used_at DESC, id DESC LIMIT 10)"
    : "DELETE FROM connections WHERE user_id = ? AND id NOT IN (SELECT id FROM connections WHERE user_id = ? ORDER BY last_used_at DESC, id DESC LIMIT 10)";
}
export function pathKey(value: string) {
  return value.replace(/\//g, "\\").toLowerCase();
}
export function endpointKey(mode: string, host: string, port: number) {
  return `${mode}|${host.toLowerCase()}|${port}`;
}
export const upsertAdbSql =
  "INSERT INTO adb_paths (id,user_id,machine_id,path,path_key,last_used_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,machine_id,path_key) DO UPDATE SET path=excluded.path,last_used_at=excluded.last_used_at";
export const upsertConnectionSql =
  "INSERT INTO connections (id,user_id,endpoint_key,host,port,mode,label,last_used_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,endpoint_key) DO UPDATE SET last_used_at=excluded.last_used_at,label=CASE WHEN excluded.label='' THEN connections.label ELSE excluded.label END";
