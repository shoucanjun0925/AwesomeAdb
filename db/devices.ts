import type { DeviceMutation } from "../shared/devices";
export interface SqlStatement {
  sql: string;
  values: (string | number | null)[];
}
/** Bounded, idempotent data upgrade for the current user's at most ten legacy connections. */
export function legacyDeviceStatements(userId: string): SqlStatement[] {
  return [
    {
      sql: "INSERT INTO device_profiles (id,user_id,label,created_at,updated_at) SELECT 'legacy-'||c.id,c.user_id,trim(c.label),c.last_used_at,c.last_used_at FROM connections c WHERE c.user_id=? AND c.device_id IS NULL AND trim(c.label)<>'' AND NOT EXISTS (SELECT 1 FROM device_bindings b WHERE b.user_id=c.user_id AND b.binding_key='tcp|'||lower(c.host)||'|'||c.port) AND c.id=(SELECT c2.id FROM connections c2 WHERE c2.user_id=c.user_id AND lower(c2.host)=lower(c.host) AND c2.port=c.port AND trim(c2.label)<>'' ORDER BY c2.last_used_at DESC,c2.id DESC LIMIT 1) ON CONFLICT(id) DO NOTHING",
      values: [userId],
    },
    {
      sql: "INSERT INTO device_bindings (id,user_id,profile_id,binding_key) SELECT 'legacy-'||c.id,c.user_id,'legacy-'||c.id,'tcp|'||lower(c.host)||'|'||c.port FROM connections c JOIN device_profiles p ON p.id='legacy-'||c.id AND p.user_id=c.user_id WHERE c.user_id=? AND c.device_id IS NULL AND trim(c.label)<>'' ON CONFLICT(user_id,binding_key) DO NOTHING",
      values: [userId],
    },
    {
      sql: "UPDATE connections SET device_id=(SELECT b.profile_id FROM device_bindings b WHERE b.user_id=connections.user_id AND b.binding_key='tcp|'||lower(connections.host)||'|'||connections.port),label=(SELECT p.label FROM device_bindings b JOIN device_profiles p ON p.id=b.profile_id AND p.user_id=b.user_id WHERE b.user_id=connections.user_id AND b.binding_key='tcp|'||lower(connections.host)||'|'||connections.port) WHERE user_id=? AND device_id IS NULL AND trim(label)<>'' AND EXISTS (SELECT 1 FROM device_bindings b WHERE b.user_id=connections.user_id AND b.binding_key='tcp|'||lower(connections.host)||'|'||connections.port)",
      values: [userId],
    },
  ];
}
export function deviceWriteStatements(
  userId: string,
  input: DeviceMutation,
  now: number,
): SqlStatement[] {
  const statements: SqlStatement[] = [];
  if (input.kind === "save")
    statements.push({
      sql: "INSERT INTO device_profiles (id,user_id,label,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at WHERE device_profiles.user_id=excluded.user_id",
      values: [input.id, userId, input.label, now, now],
    });
  for (const key of new Set(input.bindingKeys))
    statements.push({
      // A competing binding makes the entire D1 batch roll back unless reassignment was explicit.
      sql: "INSERT INTO device_bindings (id,user_id,profile_id,binding_key) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM device_profiles WHERE id=? AND user_id=?) ON CONFLICT(user_id,binding_key) DO UPDATE SET profile_id=CASE WHEN device_bindings.profile_id=excluded.profile_id OR ?=1 THEN excluded.profile_id ELSE NULL END",
      values: [
        crypto.randomUUID(),
        userId,
        input.id,
        key,
        input.id,
        userId,
        input.reassign ? 1 : 0,
      ],
    });
  statements.push({
    sql: "UPDATE connections SET device_id=?,label=(SELECT label FROM device_profiles WHERE id=? AND user_id=?) WHERE user_id=? AND (device_id=? OR ('tcp|' || lower(host) || '|' || port) IN (SELECT binding_key FROM device_bindings WHERE user_id=? AND profile_id=?))",
    values: [input.id, input.id, userId, userId, input.id, userId, input.id],
  });
  return statements;
}
