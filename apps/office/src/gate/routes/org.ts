// 組織: 組織図、役目の説明文、オーナーの承認 (ルートの一覧の 1.8、タスクとレビューの 3.1)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, Approval, ApprovalStatus, DecisionInput, newId, OrgStaff, PromptVersion, StaffId, UpdatePromptInput } from "@know-office/core";
import { and, asc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { approvals, staff, staffPrompts } from "../db/main.ts";
import { createRouter } from "../app.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { list, ok } from "../respond.ts";
import { clockAt } from "../work/attendance.ts";
import { notifyStaff } from "../work/loop.ts";
import { appendNodeEvent, findNode, moveNode } from "../work/nodes.ts";

const router = createRouter();

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const StaffParam = z.object({ staffId: StaffId.openapi({ param: { name: "staffId", in: "path" }, description: "社員 ID。役割ごとに固定" }) }).strict();
const ApprovalParam = z.object({ approvalId: z.uuid().openapi({ param: { name: "approvalId", in: "path" }, description: "UUID v7" }) }).strict();

const listOrgRoute = createRoute({
  method: "get",
  path: "/api/v1/org",
  operationId: "listOrg",
  tags: ["org"],
  request: { query: listQuery(router) },
  responses: { 200: listResponse(OrgStaff), ...problems(400, 401, 403, 422, 429, 500) },
});

const updatePromptRoute = createRoute({
  method: "put",
  path: "/api/v1/staff/{staffId}/prompt",
  operationId: "updatePrompt",
  tags: ["org"],
  request: { params: StaffParam, body: jsonBody(UpdatePromptInput) },
  responses: { 200: okResponse(PromptVersion), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

const listApprovalsRoute = createRoute({
  method: "get",
  path: "/api/v1/approvals",
  operationId: "listApprovals",
  tags: ["org"],
  request: { query: listQuery(router).extend({ status: ApprovalStatus.optional().openapi({ param: { name: "status", in: "query" } }) }) },
  responses: { 200: listResponse(Approval), ...problems(400, 401, 403, 422, 429, 500) },
});

const decideApprovalRoute = createRoute({
  method: "post",
  path: "/api/v1/approvals/{approvalId}/decision",
  operationId: "decideApproval",
  tags: ["org"],
  request: { params: ApprovalParam, body: jsonBody(DecisionInput) },
  responses: { 200: okResponse(Approval), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

const iso = (at: number) => new Date(at).toISOString();
const Payload = z.record(z.string(), z.unknown());
const RoleChange = z.object({ target: StaffId, role: z.string().min(1), bossId: StaffId.nullable() }).loose();
const Waiting = z.object({ nodeId: z.uuid() }).loose();

/** approvals の行 */
type ApprovalRow = typeof approvals.$inferSelect;

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
    const { cursor, limit } = c.req.valid("query");
    const orm = drizzle(c.env.DB);
    const people = await orm.select().from(staff);
    const prompts = await orm.select().from(staffPrompts);
    // 上から下へ並べる。社員 ID は役ごとに決まっているので、その順をカーソルにする
    const ordered = people
      .flatMap((p) => {
        const id = StaffId.safeParse(p.id);
        return id.success ? [{ ...p, id: id.data }] : [];
      })
      .toSorted((a, b) => StaffId.options.indexOf(a.id) - StaffId.options.indexOf(b.id))
      .filter((p) => cursor === undefined || StaffId.options.indexOf(p.id) > StaffId.options.indexOf(StaffId.catch("reviewer").parse(cursor)));
    const page = ordered.slice(0, limit);
    const items = page.map((p) => ({
      id: p.id,
      role: p.role,
      bossId: p.bossId,
      model: p.model,
      prompt: prompts.find((v) => v.staffId === p.id && v.version === p.promptVersion)?.body ?? "",
      promptVersion: p.promptVersion,
    }));
    return list(c, items, ordered.length > limit ? (page.at(-1)?.id ?? null) : null);
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
    // 読んだ版のままの時だけ上げる。同時に直した 2 つの片方を断る
    const moved = await orm
      .update(staff)
      .set({ promptVersion: next })
      .where(and(eq(staff.id, staffId), eq(staff.promptVersion, version)))
      .returning({ id: staff.id });
    if (moved.length === 0) throw new AppError("conflict", "バージョンが違う");
    await orm.insert(staffPrompts).values({ id: newId(clockAt(now)), staffId, version: next, body, by: "owner", createdAt: now });
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
    if (row.status !== "pending") throw new AppError("conflict", "もう決めた");
    const status = decision === "approve" ? "approved" : "rejected";
    const decided = await orm
      .update(approvals)
      .set({ status, decidedAt: now, reason })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
      .returning({ id: approvals.id });
    if (decided.length === 0) throw new AppError("conflict", "もう決めた");
    if (decision === "approve" && row.kind === "role_change") {
      const change = RoleChange.safeParse(row.payload);
      if (change.success) await orm.update(staff).set({ role: change.data.role, bossId: change.data.bossId }).where(eq(staff.id, change.data.target));
    }
    // 答えを待っていたタスクは、承認でも差し戻しでも todo に戻し、社員が理由を読んで続ける
    const waiting = Waiting.safeParse(row.payload);
    if (waiting.success) {
      const node = await findNode(c.env.DB, waiting.data.nodeId).catch(() => null);
      if (node?.status === "waiting_owner") {
        await moveNode(c.env.DB, node, "todo", now);
        await appendNodeEvent(c.env, { nodeId: node.id, staffId: null, kind: "approval_decided", detail: { approvalId, decision, reason } }, { by: "owner", now, traceId: c.var.traceId });
        if (node.assignee !== null) await notifyStaff(c.env, node.assignee, now, false);
      }
    }
    await audit(c, "approval.decide", approvalId, { kind: row.kind, decision });
    return ok(c, toApproval({ ...row, status, decidedAt: now, reason }));
  });
