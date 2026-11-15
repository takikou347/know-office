// 管理の拡張の差し込み口。設定で入れ切りし、切るとルートとツールが使えなくなり、入れ直すと前のデータが残っている (サービスと拡張の 3.8)
import { decide, DEFAULT_RULES, type StaffId, toOperation } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Caller, routeEgress } from "../../src/gate/egress.ts";
import { defineExtension, type ExtensionDefinition } from "../../src/gate/extensions/define.ts";
import { INSTALLED } from "../../src/gate/extensions/installed.ts";
import { issueTicket, workspaceIdOf } from "../../src/gate/work/ticket.ts";
import { runTool, staffTools } from "../../src/gate/work/tools.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";
import { api, at, MINUTE, rows, type WorkWorld, useWork } from "../helpers/work.ts";

const world = useWork();

const ExtensionRow = z.object({ id: z.string(), title: z.string(), enabled: z.boolean(), ownerData: z.boolean() }).strict();

/** 見本の拡張のメモを読むツールの、SDK が渡す名前。社員の MCP の受け手 staff が出す */
const SDK_NOTE_READ = "mcp__staff__ext__sample-notes__note_read";

/**
 * パスキーで確かめた事にする。確認の流れそのものは passkey.test.ts で確かめる
 * @param w テストの物
 */
async function stepUp(w: WorkWorld): Promise<void> {
  await w.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(w.clock.now() + 15 * MINUTE).run();
}

/**
 * 拡張を入れるか切る。入れる時はパスキーで確かめてから送る
 * @param w テストの物
 * @param id 拡張の ID
 * @param enabled 入れるか
 * @returns 返った拡張
 */
async function toggle(w: WorkWorld, id: string, enabled: boolean): Promise<z.infer<typeof ExtensionRow>> {
  if (enabled) await stepUp(w);
  return ExtensionRow.parse(await api(w, "PUT", `/api/v1/extensions/${id}`, { enabled }));
}

/**
 * 作る役に 9 時からのタスクを持たせ (持っていなければ)、作業トークンでルールの判断を聞く
 * @param gate ゲートウェイ
 * @param w テストの物
 * @param toolName SDK が渡すツールの名前
 * @param extensions 差し込んだ拡張。無ければ読み込んだ物
 * @returns 判断の data
 */
async function ask(gate: TestGate, w: WorkWorld, toolName: string, extensions?: readonly ExtensionDefinition[]): Promise<{ allow: boolean; reason: string }> {
  const staffId: StaffId = "builder";
  const { book } = gate.staff[staffId];
  if ((await book.status(w.clock.now())).nodeId === null) {
    const nodeId = crypto.randomUUID();
    await book.wake(at(8));
    await book.wake(at(9));
    await w.d1.DB.prepare(
      "INSERT INTO nodes (id, kind, parent_id, scope, title, status, priority, assignee, created_by, created_at, updated_at) VALUES (?, 'task', NULL, 'office', '直す', 'doing', 1, ?, 'president', 0, 0)",
    )
      .bind(nodeId, staffId)
      .run();
    w.clock.advance(at(9) - w.clock.now());
    // ログインの証明は短い間で切れるので、進めた後に作り直す
    w.headers = await gate.signIn();
    await book.take({ nodeId, title: "直す", scope: "office" }, null, at(9));
  }
  const { nodeId } = await book.status(w.clock.now());
  if (nodeId === null) throw new Error("タスクを持たせられない");
  const { token } = await issueTicket(gate.env, staffId, nodeId, w.clock.now());
  const caller: Caller = { staffId, workspaceId: workspaceIdOf(gate.env, staffId) };
  const request = new Request("http://gate.internal/ws/v1/decisions", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ toolName, toolInput: {} }),
  });
  const res = await routeEgress(request, gate.env, caller, { clock: w.clock, guard: gate.deps, ...(extensions ? { extensions } : {}) });
  expect(res.status).toBe(200);
  return z.object({ data: z.object({ allow: z.boolean(), reason: z.string() }).strict() }).loose().parse(await res.json()).data;
}

describe("差し込み口", () => {
  it("拡張を切る", async () => {
    // 見本の拡張は extensions/ に置いただけで読み込まれ、最初は入っていない
    expect(INSTALLED.map((e) => e.id)).toContain("sample-notes");
    expect(z.array(ExtensionRow).parse(await api(world, "GET", "/api/v1/extensions"))).toContainEqual({ id: "sample-notes", title: "メモ", enabled: false, ownerData: false });
    await api(world, "GET", "/api/v1/ext/sample-notes/note", undefined, 404);
    expect(await staffTools(world.gate.env, "builder")).not.toContain("ext__sample-notes__note_read");

    // 入れると、拡張のルートとツールが使える
    expect(await toggle(world, "sample-notes", true)).toEqual({ id: "sample-notes", title: "メモ", enabled: true, ownerData: false });
    await api(world, "PUT", "/api/v1/ext/sample-notes/note", { body: "金曜は早く上がる" });
    expect(await api(world, "GET", "/api/v1/ext/sample-notes/note")).toEqual({ body: "金曜は早く上がる" });
    expect(await staffTools(world.gate.env, "builder")).toContain("ext__sample-notes__note_read");
    expect(await ask(world.gate, world, SDK_NOTE_READ)).toEqual({ allow: true, reason: "入れた拡張のツール" });
    const read = await runTool(world.gate.env, world.forge, { staffId: "builder", tool: "ext__sample-notes__note_read", input: {}, now: world.clock.now() });
    expect(JSON.parse(read.content)).toEqual({ body: "金曜は早く上がる" });

    // 切ると、ルートは 404、ツールは一覧から外れ、判断でも動かす所でも断られる
    expect(await toggle(world, "sample-notes", false)).toMatchObject({ enabled: false });
    expect(z.array(ExtensionRow).parse(await api(world, "GET", "/api/v1/extensions"))).toContainEqual({ id: "sample-notes", title: "メモ", enabled: false, ownerData: false });
    await api(world, "GET", "/api/v1/ext/sample-notes/note", undefined, 404);
    await api(world, "PUT", "/api/v1/ext/sample-notes/note", { body: "上書き" }, 404);
    expect(await staffTools(world.gate.env, "builder")).not.toContain("ext__sample-notes__note_read");
    expect(await ask(world.gate, world, SDK_NOTE_READ)).toEqual({ allow: false, reason: "入れていない拡張のツールは断る" });
    await expect(runTool(world.gate.env, world.forge, { staffId: "builder", tool: "ext__sample-notes__note_read", input: {}, now: world.clock.now() })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(world.gate.audits.filter((a) => a.action === "extension.toggle").map((a) => [a.target, a.detail])).toEqual([
      ["sample-notes", { enabled: true, version: 1 }],
      ["sample-notes", { enabled: false, version: 2 }],
    ]);

    // 切ってもデータは消さず、入れ直すと前のメモが出る
    await toggle(world, "sample-notes", true);
    expect(await api(world, "GET", "/api/v1/ext/sample-notes/note")).toEqual({ body: "金曜は早く上がる" });
  });

  it("土台を直さない", async () => {
    // 土台のコードを直さずに、定義を 1 つ足すだけの拡張。ルートとツールは土台が拡張の置き場の下に付ける
    const Count = z.object({ count: z.number().int() }).strict();
    const counter = defineExtension({
      id: "test-counter",
      title: "数える",
      ownerData: false,
      routes: [{ method: "get", path: "/count", operationId: "getTestCount", summary: "数を読む", response: Count, run: async (ctx) => Count.parse((await ctx.store.get("count")) ?? { count: 0 }) }],
      tools: {
        count_up: {
          schema: z.object({}).strict(),
          run: async (ctx) => {
            const next = { count: Count.parse((await ctx.store.get("count")) ?? { count: 0 }).count + 1 };
            await ctx.store.put("count", next);
            return next;
          },
        },
      },
    });
    const extensions = [...INSTALLED, counter];
    const gate = await createTestGate({ clock: world.clock, d1: world.d1, extensions });
    const w: WorkWorld = { ...world, gate, headers: await gate.signIn() };

    expect(z.array(ExtensionRow).parse(await api(w, "GET", "/api/v1/extensions")).map((e) => e.id)).toEqual(["sample-notes", "test-counter"]);
    await toggle(w, "test-counter", true);
    expect(await staffTools(gate.env, "reviewer", extensions)).toContain("ext__test-counter__count_up");
    expect(await ask(gate, w, "mcp__staff__ext__test-counter__count_up", extensions)).toEqual({ allow: true, reason: "入れた拡張のツール" });
    await runTool(gate.env, w.forge, { staffId: "reviewer", tool: "ext__test-counter__count_up", input: {}, now: w.clock.now() }, extensions);
    expect(await api(w, "GET", "/api/v1/ext/test-counter/count")).toEqual({ count: 1 });
    // 拡張のデータは拡張ごとの置き場 (R2 の ext/<id>/) にだけ書く
    expect((await gate.env.FILES.list({ prefix: "ext/test-counter/" })).objects.map((o) => o.key)).toEqual(["ext/test-counter/count.json"]);
  });

  it("確認なしで入れると断られ、記録が残る", async () => {
    // 入れると社員のツールが増えるので、守りを弱める変更としてパスキーの確認を求める
    expect(await api(world, "PUT", "/api/v1/extensions/sample-notes", { enabled: true }, 401)).toMatchObject({ code: "step_up_required" });
    expect(z.array(ExtensionRow).parse(await api(world, "GET", "/api/v1/extensions"))).toContainEqual({ id: "sample-notes", title: "メモ", enabled: false, ownerData: false });
    expect(await rows(world.d1.DB, "SELECT key FROM settings WHERE key LIKE 'extension.%'")).toEqual([]);
    expect(world.gate.audits.filter((a) => a.action.startsWith("extension.")).map((a) => [a.action, a.target, a.detail])).toEqual([
      ["extension.toggle_refused", "sample-notes", { enabled: true, reason: "step_up_required" }],
    ]);
    // 切る側は守りを強めるだけなので、確認なしで通す
    expect(await api(world, "PUT", "/api/v1/extensions/sample-notes", { enabled: false })).toMatchObject({ enabled: false });
  });

  it("拡張のツールもルールの判断を通り、鍵や自動停止や社員に触れる名前は入れても断る", () => {
    const enabled = { ...DEFAULT_RULES, extensionTools: ["sample-notes.note_read", "bad.vault_read", "bad.stop_all", "bad.staff_add"] };
    expect(toOperation(SDK_NOTE_READ, {})).toEqual({ kind: "ext.tool", tool: SDK_NOTE_READ, target: "sample-notes.note_read", paths: [] });
    expect(decide(toOperation(SDK_NOTE_READ, {}), enabled)).toMatchObject({ allow: true });
    // 初期のルールでは、どの拡張のツールも入っていない
    expect(decide(toOperation(SDK_NOTE_READ, {}), DEFAULT_RULES)).toMatchObject({ allow: false });
    for (const [name, kind] of [
      ["mcp__staff__ext__bad__vault_read", "secret.read"],
      ["mcp__staff__ext__bad__stop_all", "guard.access"],
      ["mcp__staff__ext__bad__staff_add", "staff.manage"],
      // 形の違う名前は知らないツールとして断る
      ["mcp__staff__ext__Bad__x", "unknown"],
    ] as const) {
      const op = toOperation(name, {});
      expect(op.kind).toBe(kind);
      expect(decide(op, enabled).allow).toBe(false);
    }
  });
});
