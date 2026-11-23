// 社員の追加、設定、削除のルート (タスクとレビューの 3.4、API の staff)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, CreateStaffInput, log, StaffId, StaffOverview, UpdateStaffInput } from "@know-office/core";
import type { Context } from "hono";
import { createRouter } from "../app.ts";
import { requireStepUp, stepUpGate } from "../auth/passkey.ts";
import { staffOf } from "../guard/actions.ts";
import type { GateEnv } from "../env.ts";
import { recordError } from "../ledger/errors.ts";
import { audit } from "../ledger/record.ts";
import { createdResponse, okResponse, problems } from "../openapi.ts";
import { created, noContent, ok } from "../respond.ts";
import { notifyStaff } from "../work/loop.ts";
import { activeStaffRow } from "../work/roster.ts";
import { addStaff, MAX_STAFF, needsStepUp, retireStaff, updateStaff } from "../work/staff-manage.ts";
import { revokeStaffTickets } from "../work/ticket.ts";
import { staffOverview } from "./staff.ts";

const router = createRouter();

/**
 * JSON の本文の形
 * @param schema 本文の Zod スキーマ
 * @returns 要る本文
 */
const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });

const StaffParam = z.object({ staffId: StaffId.openapi({ param: { name: "staffId", in: "path" }, description: "社員 ID" }) }).strict();

const createStaffRoute = createRoute({
  method: "post",
  path: "/api/v1/staff",
  operationId: "createStaff",
  tags: ["staff"],
  summary: "社員を足す",
  description: "社員を 1 人足すと Claude の費用とワークスペースの稼働が増えるので、15 分以内のパスキーの確認が要る。社長は足せない。",
  "x-steps": [
    "パスキーの確認を求める",
    `\`<職種>-<小文字と数字の 6 字>\` の ID を作り、上司が在籍で在籍の社員が ${String(MAX_STAFF)} 人より少ない時だけ、\`staff\` と、同じ職種の最初の社員の最新の説明文の写しの \`staff_prompts\` を 1 回のバッチで追加する。ID が重なれば 1 度だけ作り直す`,
    "`StaffDO.wake` で出勤の予定を組ませる。届かなければエラーログに `staff_wake_failed` を残し、社員 DO が次に起きた時に組む",
    "監査ログに `staff.create` を記録する",
  ],
  "x-errors": ["401 `step_up_required`: パスキーの確認がない", `409 \`refused\`: 在籍の社員がもう ${String(MAX_STAFF)} 人いる`, "422 `validation_failed`: 上司が在籍の社員でない"],
  "x-step-up": true,
  middleware: [stepUpGate] as const,
  request: { body: jsonBody(CreateStaffInput) },
  responses: { 201: createdResponse(StaffOverview), ...problems(400, 401, 403, 409, 413, 415, 422, 429, 500) },
});

const updateStaffRoute = createRoute({
  method: "patch",
  path: "/api/v1/staff/{staffId}",
  operationId: "updateStaff",
  tags: ["staff"],
  summary: "社員の設定を直す",
  description: "名前、上司、モデル、勤務の時刻を直す。モデルの変更は次の作業から効き、作業中の作業は始めた時のモデルのまま続く。",
  "x-steps": [
    "在籍の社員を読む",
    "単価の高いモデルに替える時と、週の勤務の時間が増える時 (全体の勤務の時刻に戻す時を含む) だけパスキーの確認を求める",
    "`version` が今のままで在籍の時だけ 1 文で更新し、`version` を 1 上げる。上司は在籍で、新しい上司から上へたどった中に自分が居ない時だけ書く",
    "勤務の時刻を変えた時は `StaffDO.wake` で予定を組み直させる。届かなければエラーログに `staff_wake_failed` を残す",
    "監査ログに `staff.update` を記録する",
  ],
  "x-errors": [
    "401 `step_up_required`: 単価の高いモデルか、長い勤務に変えるのにパスキーの確認がない",
    "404 `not_found`: 在籍の社員でない",
    "409 `conflict`: 読んだ後に設定が変わったか、削除された",
    "422 `validation_failed`: 社長に上司を付けた、または上司が在籍でないか、自分か自分の下",
  ],
  "x-step-up": "conditional",
  request: { params: StaffParam, body: jsonBody(UpdateStaffInput) },
  responses: { 200: okResponse(StaffOverview), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

const deleteStaffRoute = createRoute({
  method: "delete",
  path: "/api/v1/staff/{staffId}",
  operationId: "deleteStaff",
  tags: ["staff"],
  summary: "社員を削除する",
  description: "費用が減る側なのでパスキーの確認は要らない。削除した社員の勤怠、会話、使用量の記録は残り、ID は使い回さない。",
  "x-steps": [
    "在籍の社員でなければ 404、社長なら 409 `refused`",
    "在籍で同じ職種の在籍がほかに居る時だけ、`retired_at` を 1 文で書く",
    "`StaffDO.wake` で予定を消させてから `StaffDO.status` を読み、作業中か作業中のタスクを持っていれば、書いた `retired_at` の時だけ戻し、予定を組み直させて 409 にする。印の後はタスクを取る文が担当の在籍を見て断る",
    "終わりでないタスクを 1 つずつ、同じ職種の在籍で終わりでないタスクの少ない社員 (居なければ社長) に移し (doing は todo に戻す)、部下の上司を社長にする。途中で落ちた分は、印から 10 分たった後に日次の定期ジョブが移し直す",
    "作業トークンをすべて失効させ、監査ログに `ticket.revoke` を残す。`StaffDO.wake` で予定を消させる",
    "監査ログに `staff.retire` を記録し、移した先の社員に知らせる",
  ],
  "x-errors": ["404 `not_found`: 在籍の社員でない", "409 `refused`: 社長か、職種の最後の 1 人", "409 `conflict`: 作業中、または同時に削除した"],
  request: { params: StaffParam },
  responses: { 204: { description: "削除した" }, ...problems(400, 401, 403, 404, 409, 429, 500) },
});

/**
 * 社員 DO に予定を組み直させる。届かなくても行は残り、社員 DO が次に起きた時に D1 から読み直す
 * @param c 要求の文脈
 * @param staffId 社員 ID
 */
async function rewake(c: Context<GateEnv>, staffId: StaffId): Promise<void> {
  try {
    await staffOf(c.env, staffId).wake(c.var.clock.now());
  } catch (error) {
    log("error", "staff_wake_failed", { staffId, traceId: c.var.traceId });
    await recordError(c.env, { source: "gate", level: "warn", code: "staff_wake_failed", error, route: c.req.routePath, traceId: c.var.traceId }, c.var.clock);
  }
}

/** 社員の追加、設定、削除のルート */
export const staffManageRoutes = router
  .openapi(createStaffRoute, async (c) => {
    const input = c.req.valid("json");
    const now = c.var.clock.now();
    const row = await addStaff(c.env.DB, input, now);
    await rewake(c, row.id);
    await audit(c, "staff.create", row.id, { job: row.job, model: row.model, bossId: row.bossId });
    return created(c, await staffOverview(c.env, row, now), `/api/v1/staff/${row.id}`);
  })
  .openapi(updateStaffRoute, async (c) => {
    const { staffId } = c.req.valid("param");
    const input = c.req.valid("json");
    const row = await activeStaffRow(c.env.DB, staffId);
    if (!row) throw new AppError("not_found", "在籍の社員でない");
    if (await needsStepUp(c.env.DB, row, input)) requireStepUp(c);
    const next = await updateStaff(c.env.DB, row, input);
    if (input.schedule !== undefined) await rewake(c, staffId);
    await audit(c, "staff.update", staffId, Object.fromEntries(Object.entries(input).filter(([k]) => k !== "version")));
    return ok(c, await staffOverview(c.env, next, c.var.clock.now()));
  })
  .openapi(deleteStaffRoute, async (c) => {
    const { staffId } = c.req.valid("param");
    const now = c.var.clock.now();
    const moved = await retireStaff(c.env, staffId, now);
    await revokeStaffTickets(c.env, staffId, now, c.var.traceId);
    await rewake(c, staffId);
    await audit(c, "staff.retire", staffId, { moved: moved.length });
    for (const heir of new Set(moved.map((m) => m.assignee))) await notifyStaff(c.env, heir, now, false);
    return noContent(c);
  });
