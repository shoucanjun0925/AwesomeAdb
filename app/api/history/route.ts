import { env } from "cloudflare:workers";
import { z } from "zod";
import { getChatGPTUser } from "../../chatgpt-auth";
import { deviceLabelSchema, endpointBindingKey } from "../../../shared/devices";
import {
  deviceWriteStatements,
  legacyDeviceStatements,
} from "../../../db/devices";
import {
  trimHistorySql,
  pathKey,
  endpointKey,
  upsertAdbSql,
  upsertConnectionSql,
} from "../../../db/history";
export const dynamic = "force-dynamic";
const machine = z.string().min(1).max(100);
const mutations = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("connection-note"),
    id: z.string().min(1).max(100),
    label: deviceLabelSchema,
  }),
  z.object({
    kind: z.literal("adb"),
    machineId: machine,
    path: z.string().min(1).max(32767),
  }),
  z.object({
    kind: z.literal("connection"),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9.:%_-]+$/),
    port: z.number().int().min(1).max(65535),
    mode: z.enum(["tcp", "paired"]),
    label: deviceLabelSchema,
    deviceId: z.string().min(1).max(100).optional(),
  }),
  z.object({
    kind: z.literal("preferences"),
    machineId: machine,
    mode: z.enum(["managed", "environment", "custom"]),
    lastPath: z.string().max(32767).nullable(),
  }),
]);
async function context() {
  const user = await getChatGPTUser();
  if (!user) throw Object.assign(new Error("请先登录"), { status: 401 });
  if (!env.DB)
    throw Object.assign(new Error("历史数据库暂不可用，本机操作仍可使用"), {
      status: 503,
    });
  return { userId: user.userId, db: env.DB };
}
function failure(e: unknown) {
  const error = e as Error & { status?: number };
  const conflict = /NOT NULL.*device_bindings|device_bindings.*NOT NULL/i.test(
    error.message,
  );
  return Response.json(
    {
      error: {
        code: conflict ? "DEVICE_CONFLICT" : "HISTORY_ERROR",
        message:
          error instanceof z.ZodError
            ? error.issues[0]?.message || "记录格式不正确"
            : conflict
              ? "此地址已关联其他设备，请在连接与设置中确认关联"
              : error.message || "历史同步失败",
      },
    },
    {
      status:
        error.status ||
        (e instanceof z.ZodError || e instanceof SyntaxError
          ? 400
          : conflict
            ? 409
            : 500),
      headers: { "Cache-Control": "no-store" },
    },
  );
}
function assertOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw Object.assign(new Error("请求来源不正确"), { status: 403 });
}
export async function GET(request: Request) {
  try {
    const { userId, db } = await context();
    await db.batch(
      legacyDeviceStatements(userId).map((s) =>
        db.prepare(s.sql).bind(...s.values),
      ),
    );
    const machineId = machine.parse(
      new URL(request.url).searchParams.get("machineId"),
    );
    const [paths, connections, settings] = await db.batch([
      db
        .prepare(
          "SELECT id, path, last_used_at AS lastUsedAt FROM adb_paths WHERE user_id = ? AND machine_id = ? ORDER BY last_used_at DESC, id DESC LIMIT 10",
        )
        .bind(userId, machineId),
      db
        .prepare(
          "SELECT c.id,c.host,c.port,c.mode,COALESCE(p.label,c.label) AS label,c.device_id AS deviceId,c.last_used_at AS lastUsedAt FROM connections c LEFT JOIN device_profiles p ON p.id=c.device_id AND p.user_id=c.user_id WHERE c.user_id=? ORDER BY c.last_used_at DESC,c.id DESC LIMIT 10",
        )
        .bind(userId),
      db
        .prepare(
          "SELECT mode, last_path AS lastPath FROM preferences WHERE user_id = ? AND machine_id = ?",
        )
        .bind(userId, machineId),
    ]);
    return Response.json(
      {
        adbPaths: paths.results,
        connections: connections.results,
        preferences: settings.results[0] || null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const { userId, db } = await context();
    const input = mutations.parse(await request.json());
    const id = crypto.randomUUID(),
      now = Date.now();
    if (input.kind === "connection-note") {
      const item = await db
        .prepare(
          "SELECT host,port,device_id AS deviceId FROM connections WHERE user_id=? AND id=?",
        )
        .bind(userId, input.id)
        .first<{ host: string; port: number; deviceId: string | null }>();
      if (!item)
        throw Object.assign(new Error("找不到此连接记录"), { status: 404 });
      const key = endpointBindingKey(item.host, item.port);
      const binding = await db
        .prepare(
          "SELECT profile_id AS id FROM device_bindings WHERE user_id=? AND binding_key=?",
        )
        .bind(userId, key)
        .first<{ id: string }>();
      await db.batch(
        deviceWriteStatements(
          userId,
          {
            kind: "save",
            id: item.deviceId || binding?.id || crypto.randomUUID(),
            label: input.label,
            bindingKeys: [key],
            reassign: false,
          },
          now,
        ).map((s) => db.prepare(s.sql).bind(...s.values)),
      );
    }
    if (input.kind === "adb")
      await db.batch([
        db
          .prepare(upsertAdbSql)
          .bind(
            id,
            userId,
            input.machineId,
            input.path,
            pathKey(input.path),
            now,
          ),
        db
          .prepare(trimHistorySql("adb"))
          .bind(userId, input.machineId, userId, input.machineId),
      ]);
    if (input.kind === "connection") {
      const binding = await db
        .prepare(
          "SELECT p.id,p.label FROM device_bindings b JOIN device_profiles p ON p.id=b.profile_id AND p.user_id=b.user_id WHERE b.user_id=? AND b.binding_key=?",
        )
        .bind(userId, endpointBindingKey(input.host, input.port))
        .first<{ id: string; label: string }>();
      const profile = input.deviceId
        ? await db
            .prepare(
              "SELECT id,label FROM device_profiles WHERE user_id=? AND id=?",
            )
            .bind(userId, input.deviceId)
            .first<{ id: string; label: string }>()
        : binding;
      if (input.deviceId && !profile)
        throw Object.assign(new Error("找不到此设备记录"), { status: 404 });
      const profileId = profile?.id || crypto.randomUUID();
      const label = profile?.label || input.label;
      const profileWrites = deviceWriteStatements(
        userId,
        {
          kind: profile ? "link" : "save",
          id: profileId,
          label,
          bindingKeys: [endpointBindingKey(input.host, input.port)],
          reassign: false,
        },
        now,
      );
      await db.batch([
        ...profileWrites.map((s) => db.prepare(s.sql).bind(...s.values)),
        db
          .prepare(upsertConnectionSql)
          .bind(
            id,
            userId,
            endpointKey(input.mode, input.host, input.port),
            input.host,
            input.port,
            input.mode,
            label,
            now,
          ),
        db
          .prepare(
            "UPDATE connections SET device_id=?,label=? WHERE user_id=? AND endpoint_key=?",
          )
          .bind(
            profileId,
            label,
            userId,
            endpointKey(input.mode, input.host, input.port),
          ),
        db.prepare(trimHistorySql("connection")).bind(userId, userId),
      ]);
    }
    if (input.kind === "preferences")
      await db
        .prepare(
          "INSERT INTO preferences (id,user_id,machine_id,mode,last_path) VALUES (?,?,?,?,?) ON CONFLICT(user_id,machine_id) DO UPDATE SET mode=excluded.mode,last_path=excluded.last_path",
        )
        .bind(id, userId, input.machineId, input.mode, input.lastPath)
        .run();
    return Response.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
export async function DELETE(request: Request) {
  try {
    assertOrigin(request);
    const { userId, db } = await context();
    const input = z
      .object({
        kind: z.enum(["adb", "connection"]),
        machineId: machine.optional(),
        id: z.string().max(100).optional(),
      })
      .parse(await request.json());
    if (input.kind === "adb") {
      const machineId = machine.parse(input.machineId);
      await db
        .prepare(
          `DELETE FROM adb_paths WHERE user_id=? AND machine_id=?${input.id ? " AND id=?" : ""}`,
        )
        .bind(
          ...(input.id ? [userId, machineId, input.id] : [userId, machineId]),
        )
        .run();
    } else
      await db
        .prepare(
          `DELETE FROM connections WHERE user_id=?${input.id ? " AND id=?" : ""}`,
        )
        .bind(...(input.id ? [userId, input.id] : [userId]))
        .run();
    return Response.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
