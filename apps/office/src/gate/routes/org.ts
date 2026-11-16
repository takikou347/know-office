// 組織: 組織図、役目の説明文、オーナーの承認 (ルートの一覧の 1.8、タスクとレビューの 3.1)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, Approval, ApprovalStatus, DecisionInput, newId, OrgStaff, PromptVersion, StaffId, UpdatePromptInput } from "@know-office/core";
import type { D1Database } from "@cloudflare/workers-types";
import { and, asc, eq, gt, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { approvals, nodes, staff, staffPrompts } from "../db/main.ts";
import { createRouter } from "../app.ts";
import { requireStepUp } from "../auth/passkey.ts";
import { recordError } from "../ledger/errors.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { list, ok } from "../respond.ts";
import { closableService, closeStatements, stillAt } from "../services/flow.ts";
import { clockAt } from "../work/attendance.ts";
import { notifyStaff } from "../work/loop.ts";
import { appendNodeEvent } from "../work/nodes.ts";
import { loadOrg } from "../work/org.ts";

const router = createRouter();

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const StaffParam = z.object({ staffId: StaffId.openapi({ param: { name: "staffId", in: "path" }, description: "社員 ID。役割ごとに固定" }) }).strict();
const ApprovalParam = z.object({ approvalId: z.uuid().openapi({ param: { name: "approvalId", in: "path" }, description: "UUID v7" }) }).strict();

const listOrgRoute = createRoute({
  method: "get",
  path: "/api/v1/org",
  operationId: "listOrg",
  tags: ["org"],
  summary: "組織図",
  "x-steps": ["`cursor` を社員 ID として読む", "`staff` と最新の `staff_prompts` を取得し、上の役から下の役の順に並べ、`cursor` の後から `limit` 件を返す"],
  "x-errors": ["400 `malformed_request`: `cursor` が社員 ID でない"],
  request: { query: listQuery(router) },
  responses: { 200: listResponse(OrgStaff), ...problems(400, 401, 403, 422, 429, 500) },
});

const updatePromptRoute = createRoute({
  method: "put",
  path: "/api/v1/staff/{staffId}/prompt",
  operationId: "updatePrompt",
  tags: ["org"],
  summary: "役割の指示文を更新する",
  description: "次のタスクから反映される。",
  "x-steps": [
    "`version` が現在と一致することを確認する",
    "`staff_prompts` への追加と `staff.prompt_version` の更新を 1 回のバッチで行う。どちらも `version` が現在のままの時だけ書く",
    "監査ログに `staff.prompt` を記録する。次のタスクから反映される",
  ],
  "x-errors": ["409 `conflict`: バージョンが異なる"],
  request: { params: StaffParam, body: jsonBody(UpdatePromptInput) },
  responses: { 200: okResponse(PromptVersion), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

const listApprovalsRoute = createRoute({
  method: "get",
  path: "/api/v1/approvals",
  operationId: "listApprovals",
  tags: ["org"],
  summary: "オーナーの承認待ちの一覧",
  "x-steps": ["`approvals` の未決定の項目を古い順に取得する"],
  request: { query: listQuery(router).extend({ status: ApprovalStatus.optional().openapi({ param: { name: "status", in: "query" } }) }) },
  responses: { 200: listResponse(Approval), ...problems(400, 401, 403, 422, 429, 500) },
});

const decideApprovalRoute = createRoute({
  method: "post",
  path: "/api/v1/approvals/{approvalId}/decision",
  operationId: "decideApproval",
  tags: ["org"],
  summary: "承認または差し戻しを行う",
  description: "外部連携と費用の増える事を承認する場合のみ、15 分以内のパスキーの確認が必要。",
  "x-steps": [
    "承認の項目を取得し、未決定であることを確認する",
    "承認の時、読んだ行の種類が `external_integration` か `cost_increase` ならパスキーの確認を求める。差し戻しは求めない",
    "承認の時は種類を確かめる。役割の変更は `payload` を `target`、`role`、`bossId` の形で確かめ、閉じる案は対象のサービスがサービスか運用の段階にある事を確かめる。社員の追加、外部連携、費用の増える事は承認を残すだけで、社員は増えず、外へは送らない。`merge`、`deploy`、`prompt_rule`、`guard_change` はほかの画面で決めるので承認を断る",
    "`approvals` を未決定の時だけ更新し、同じバッチで、役割の変更なら `staff` を、閉じる案なら `services.stage` と `service_events` を書き、`payload.nodeId` のタスクが `waiting_owner` のままなら `todo` に戻す",
    "タスクに `approval_decided` の出来事を残し、担当の社員に知らせる。ここが失敗しても決定は残り、エラーログに残す",
    "監査ログに `approval.decide` を記録する",
  ],
  "x-errors": [
    "401 `step_up_required`: 外部連携か費用の増える事の承認で、パスキーの確認がない。承認は未決定のまま",
    "404 `not_found`: 承認の項目が存在しない",
    "409 `conflict`: すでに決定済み、ほかの画面で決める種類を承認しようとした (差し戻しは受ける)、閉じる案のサービスが閉じられる段階にない、または承認を読んだ後に閉じる案のサービスの段階が変わった。どれも承認は未決定のまま",
    "422 `validation_failed`: 役割の変更の `payload` の形が違う。承認は未決定のまま",
  ],
  // 外部連携と費用の増える事の承認だけ、読んだ行の種類で確かめる
  "x-step-up": "conditional",
  request: { params: ApprovalParam, body: jsonBody(DecisionInput) },
  responses: { 200: okResponse(Approval), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

const iso = (at: number) => new Date(at).toISOString();
const Payload = z.record(z.string(), z.unknown());
const RoleChange = z.object({ target: StaffId, role: z.string().min(1), bossId: StaffId.nullable() }).loose();
const Waiting = z.object({ nodeId: z.uuid() }).loose();

/** 承認する前にパスキーで確かめる種類。お金が増える事と外とのつながりが増える事 */
const STEP_UP_KINDS: ReadonlySet<string> = new Set(["external_integration", "cost_increase"]);
/** 承認を残すだけで、ほかを書かない種類。社員は 3 人に決まっていて、外へは送らない */
const RECORD_ONLY_KINDS: ReadonlySet<string> = new Set(["staff_add", "external_integration", "cost_increase"]);
/** ここで承認できる種類。merge、deploy、prompt_rule、guard_change はレビューか守りの画面で決める */
const DECIDABLE_KINDS: ReadonlySet<string> = new Set(["role_change", "service_close", ...RECORD_ONLY_KINDS]);

/** approvals の行 */
type ApprovalRow = typeof approvals.$inferSelect;

const CloseRequest = z.object({ reason: z.string().min(1) }).loose();
const Decided = z.array(z.object({ id: z.string() }));
const Moved = z.array(z.object({ id: z.string(), assignee: z.string().nullable() }));

/** 承認と同じ batch に入れる中身。before は承認を書く前、after は書いた後に置き、guard は承認を書く条件に足す */
type Effects = { before: BatchItem<"sqlite">[]; after: BatchItem<"sqlite">[]; guard: SQL | undefined };

/**
 * 承認で動く中身を、承認と同じ batch に入れる文にする。役の変更は社員を、閉じる案はサービスを変える
 * @param db 今の状態の D1
 * @param row approvals の行
 * @param now 今の時刻
 * @returns batch に入れる文と、承認を書く条件
 * @throws validation_failed 役の変更か閉じる案の中身の形が違う時
 * @throws conflict 閉じる案のサービスが閉じられる段階にない時
 */
async function approvedEffects(db: D1Database, row: ApprovalRow, now: number): Promise<Effects> {
  if (RECORD_ONLY_KINDS.has(row.kind)) return { before: [], after: [], guard: undefined };
  if (row.kind === "service_close") {
    const close = CloseRequest.safeParse(row.payload);
    if (!close.success) throw new AppError("validation_failed", "閉じる案の中身の形が違う");
    const service = await closableService(db, row.target);
    // サービスが読んだ段階のままの時だけ承認を書き、書けた承認の時だけサービスを閉じる。段階が変わっていれば承認は pending のまま 409 にする
    const approved = sql`EXISTS (SELECT 1 FROM ${approvals} WHERE ${approvals.id} = ${row.id} AND ${approvals.status} = 'approved' AND ${approvals.decidedAt} = ${now})`;
    return {
      before: [],
      after: closeStatements(db, { serviceId: service.id, from: service.stage, approvalId: row.id, reason: close.data.reason }, now, approved),
      guard: stillAt(service.id, service.stage),
    };
  }
  // 形の違う役の変更は、承認の更新も社員の更新も書かずに断る
  const change = RoleChange.safeParse(row.payload);
  if (!change.success) throw new AppError("validation_failed", "役の変更の中身の形が違う");
  const pending = sql`EXISTS (SELECT 1 FROM ${approvals} WHERE ${approvals.id} = ${row.id} AND ${approvals.status} = 'pending')`;
  return {
    before: [
      drizzle(db)
        .update(staff)
        .set({ role: change.data.role, bossId: change.data.bossId })
        .where(and(eq(staff.id, change.data.target), pending)),
    ],
    after: [],
    guard: undefined,
  };
}

/**
 * 承認の行を返す形にする
 * @param row approvals の行
 * @returns 承認 1 件
 */
function toApproval(row: ApprovalRow): Approval {
  // D1 の JSON は形を確かめてから返す
  const payload = Payload.safeParse(row.payload);
  return {
    id: row.id,
    kind: row.kind,
    target: row.target,
    payload: payload.success ? payload.data : {},
    status: ApprovalStatus.parse(row.status),
    requestedBy: row.requestedBy,
    requestedAt: iso(row.requestedAt),
    decidedAt: row.decidedAt === null ? null : iso(row.decidedAt),
    reason: row.reason,
  };
}

/** 組織のルート: 組織図、役目の説明文、オーナーの承認 */
export const orgRoutes = router
  .openapi(listOrgRoute, async (c) => {
    const { items, next } = await loadOrg(c.env.DB, c.req.valid("query"));
    return list(c, items, next);
  })
  .openapi(updatePromptRoute, async (c) => {
    const { staffId } = c.req.valid("param");
    const { version, body } = c.req.valid("json");
    const now = c.var.clock.now();
    const orm = drizzle(c.env.DB);
    const [who] = await orm.select({ promptVersion: staff.promptVersion }).from(staff).where(eq(staff.id, staffId)).limit(1);
    if (!who) throw new AppError("not_found", "社員がいない");
    if (who.promptVersion !== version) throw new AppError("conflict", "バージョンが違う");
    const next = version + 1;
    // 説明文の追加と版の更新は 1 回で書く。どちらも読んだ版のままの時だけ書き、同時に直した 2 つの片方を断る
    const [, moved] = await orm.batch([
      orm
        .insert(staffPrompts)
        .select(
          sql`SELECT ${newId(clockAt(now))}, ${staffId}, ${next}, ${body}, 'owner', ${now} WHERE EXISTS (SELECT 1 FROM ${staff} WHERE ${staff.id} = ${staffId} AND ${staff.promptVersion} = ${version})`,
        ),
      orm
        .update(staff)
        .set({ promptVersion: next })
        .where(and(eq(staff.id, staffId), eq(staff.promptVersion, version)))
        .returning({ id: staff.id }),
    ]);
    if (moved.length === 0) throw new AppError("conflict", "バージョンが違う");
    await audit(c, "staff.prompt", staffId, { version: next });
    return ok(c, { version: next });
  })
  .openapi(listApprovalsRoute, async (c) => {
    const { status, cursor, limit } = c.req.valid("query");
    const rows = await drizzle(c.env.DB)
      .select()
      .from(approvals)
      .where(and(eq(approvals.status, status ?? "pending"), cursor ? gt(approvals.id, cursor) : undefined))
      .orderBy(asc(approvals.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return list(c, page.map(toApproval), rows.length > limit ? (page.at(-1)?.id ?? null) : null);
  })
  .openapi(decideApprovalRoute, async (c) => {
    const { approvalId } = c.req.valid("param");
    const { decision, reason } = c.req.valid("json");
    const now = c.var.clock.now();
    const orm = drizzle(c.env.DB);
    const [row] = await orm.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
    if (!row) throw new AppError("not_found", "承認の項目が無い");
    // 確かめるかは送られた物でなく、D1 から読んだ種類で決める。差し戻しは守りを弱めないので確かめない
    if (decision === "approve" && STEP_UP_KINDS.has(row.kind)) requireStepUp(c);
    if (row.status !== "pending") throw new AppError("conflict", "もう決めた");
    if (decision === "approve" && !DECIDABLE_KINDS.has(row.kind)) throw new AppError("conflict", "この種類はレビューか守りの画面で決める");
    const status = decision === "approve" ? "approved" : "rejected";
    const effects: Effects = decision === "approve" ? await approvedEffects(c.env.DB, row, now) : { before: [], after: [], guard: undefined };
    const decide = orm
      .update(approvals)
      .set({ status, decidedAt: now, reason })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending"), effects.guard))
      .returning({ id: approvals.id });
    // 答えを待っていたタスクは、承認でも差し戻しでも todo に戻し、社員が答えを読んで続ける。書けた決定の時だけ戻す
    const waiting = Waiting.safeParse(row.payload);
    const decided = sql`EXISTS (SELECT 1 FROM ${approvals} WHERE ${approvals.id} = ${approvalId} AND ${approvals.status} = ${status} AND ${approvals.decidedAt} = ${now})`;
    const back = waiting.success
      ? [
          orm
            .update(nodes)
            .set({ status: "todo", version: sql`${nodes.version} + 1`, updatedAt: now })
            .where(and(eq(nodes.id, waiting.data.nodeId), eq(nodes.status, "waiting_owner"), decided))
            .returning({ id: nodes.id, assignee: nodes.assignee }),
        ]
      : [];
    // 承認の中身とタスクの戻しは承認と同じ 1 回で書く。まだ決めていない時だけ書き、同時に決めた 2 つの片方を断る
    const batch: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [decide, ...effects.after, ...back];
    batch.unshift(...effects.before);
    const results: readonly unknown[] = await orm.batch(batch);
    const written = Decided.parse(results.at(effects.before.length));
    if (written.length === 0) throw new AppError("conflict", "もう決めたか、承認の対象が変わった");
    const [moved] = back.length > 0 ? Moved.parse(results.at(-1)) : [];
    if (moved) {
      // 出来事は記録の D1 にあって同じバッチに入らない。落ちても決定とタスクの戻しは残り、社員は承認の行から答えを読む
      try {
        await appendNodeEvent(c.env, { nodeId: moved.id, staffId: null, kind: "approval_decided", detail: { approvalId, decision, reason } }, { by: "owner", now, traceId: c.var.traceId });
        if (moved.assignee !== null) await notifyStaff(c.env, moved.assignee, now, false);
      } catch (error) {
        await recordError(c.env, { source: "gate", level: "warn", code: "approval_follow_failed", error, route: c.req.routePath, traceId: c.var.traceId }, c.var.clock);
      }
    }
    await audit(c, "approval.decide", approvalId, { kind: row.kind, decision });
    return ok(c, toApproval({ ...row, status, decidedAt: now, reason }));
  });
