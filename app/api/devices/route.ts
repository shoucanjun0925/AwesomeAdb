import { env } from "cloudflare:workers";
import { z } from "zod";
import { getChatGPTUser } from "../../chatgpt-auth";
import { deviceMutationSchema } from "../../../shared/devices";
import {
  deviceWriteStatements,
  legacyDeviceStatements,
} from "../../../db/devices";
export const dynamic = "force-dynamic";
async function context(request: Request, write = false) {
  if (
    write &&
    request.headers.get("origin") &&
    request.headers.get("origin") !== new URL(request.url).origin
  )
    throw Object.assign(new Error("请求来源不正确"), { status: 403 });
  const user = await getChatGPTUser();
  if (!user) throw Object.assign(new Error("请先登录"), { status: 401 });
  if (!env.DB)
    throw Object.assign(new Error("设备备注暂未同步，请稍后重试"), {
      status: 503,
    });
  return { db: env.DB, userId: user.userId };
}
function failure(e: unknown) {
  const error = e as Error & { status?: number };
  const conflict = /NOT NULL.*device_bindings|device_bindings.*NOT NULL/i.test(
    error.message,
  );
  return Response.json(
    {
      error: {
        code: conflict ? "DEVICE_CONFLICT" : "DEVICE_ERROR",
        message:
          e instanceof z.ZodError
            ? e.issues[0]?.message || "设备资料格式不正确"
            : conflict
              ? "此连接已关联其他设备，请确认后重新关联"
              : error.message || "设备资料保存失败",
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
export async function GET(request: Request) {
  try {
    const { db, userId } = await context(request);
    await db.batch(
      legacyDeviceStatements(userId).map((s) =>
        db.prepare(s.sql).bind(...s.values),
      ),
    );
    const [profiles, bindings] = await db.batch([
      db
        .prepare(
          "SELECT id,label,created_at AS createdAt,updated_at AS updatedAt FROM device_profiles WHERE user_id=? ORDER BY updated_at DESC,id",
        )
        .bind(userId),
      db
        .prepare(
          "SELECT profile_id AS profileId,binding_key AS bindingKey FROM device_bindings WHERE user_id=?",
        )
        .bind(userId),
    ]);
    return Response.json(
      { profiles: profiles.results, bindings: bindings.results },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    const { db, userId } = await context(request, true);
    const input = deviceMutationSchema.parse(await request.json());
    const existing = await db
      .prepare("SELECT user_id AS userId FROM device_profiles WHERE id=?")
      .bind(input.id)
      .first<{ userId: string }>();
    if (
      (existing && existing.userId !== userId) ||
      (input.kind === "link" && !existing)
    )
      throw Object.assign(new Error("找不到此设备记录"), { status: 404 });
    await db.batch(
      deviceWriteStatements(userId, input, Date.now()).map((s) =>
        db.prepare(s.sql).bind(...s.values),
      ),
    );
    return Response.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
export async function DELETE(request: Request) {
  try {
    const { db, userId } = await context(request, true);
    const { id } = z
      .object({ id: z.string().min(1).max(100) })
      .parse(await request.json());
    await db.batch([
      db
        .prepare("DELETE FROM connections WHERE user_id=? AND device_id=?")
        .bind(userId, id),
      db
        .prepare("DELETE FROM device_bindings WHERE user_id=? AND profile_id=?")
        .bind(userId, id),
      db
        .prepare("DELETE FROM device_profiles WHERE user_id=? AND id=?")
        .bind(userId, id),
    ]);
    return Response.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
