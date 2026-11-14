// 作業トークンの署名、期限、発行した先、失効と、チェックポイントでの差し替えを確かめる (社員が考えるの 2 章、3.2、3.3、4 章)
import { AppError } from "@know-office/core";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { rotateVaultKeys, vaultKey } from "../../src/gate/auth/vault.ts";
import { routeEgress, type Caller } from "../../src/gate/egress.ts";
import { authenticateTicket, issueTicket, TICKET_TYP, workspaceIdOf } from "../../src/gate/work/ticket.ts";
import { jst, MINUTE, NODE, NODE2, rows, startWork, useGuardWorld } from "../helpers/guard.ts";

const w = useGuardWorld();

/**
 * 開発担当のワークスペースを返す。発行した先として作業トークンに入る
 * @returns 社員 ID とワークスペース ID
 */
function builder(): Caller {
  return { staffId: "builder", workspaceId: workspaceIdOf(w.gate.env, "builder") };
}

/**
 * ワークスペースからゲートウェイへの要求を、外向きの通信の受け手に渡す
 * @param path ゲートウェイの道
 * @param init 要求の中身
 * @param caller 送ったワークスペース
 * @returns 受け手の返事
 */
function fromWorkspace(path: string, init: RequestInit, caller: Caller = builder()): Promise<Response> {
  return routeEgress(new Request(`http://gate.internal${path}`, init), w.gate.env, caller, { clock: w.clock, guard: w.gate.deps });
}

/**
 * 作業トークンを付けてルールの判断を聞く
 * @param token 作業トークン
 * @param caller 送ったワークスペース
 * @returns 受け手の返事
 */
function decide(token: string, caller?: Caller): Promise<Response> {
  return fromWorkspace(
    "/ws/v1/decisions",
    { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ toolName: "Read", toolInput: { file_path: "/work/a.ts" } }) },
    caller,
  );
}

/**
 * 止めた記録を読む
 * @returns stops の行
 */
function stops() {
  return rows(w, "SELECT scope, signal FROM stops ORDER BY id");
}

describe("鍵はゲートウェイだけが持つ", () => {
  it("作業トークンの期限", async () => {
    await startWork(w, "builder");
    const { token, expiresAt } = await issueTicket(w.gate.env, "builder", NODE, jst(9));
    expect(expiresAt).toBe(jst(10));
    expect(await authenticateTicket(w.gate.env, token, builder(), jst(9, 59), w.gate.deps)).toMatchObject({ staffId: "builder", nodeId: NODE });
    await expect(authenticateTicket(w.gate.env, token, builder(), jst(10), w.gate.deps)).rejects.toMatchObject({ code: "unauthenticated" });
    w.clock.advance(jst(10, 1) - w.clock.now());
    const res = await decide(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthenticated" });
    // 期限切れは全体を止めない
    expect(await stops()).toEqual([]);
  });
});

describe("全体を止めるシグナル", () => {
  it("作業トークンの横取り", async () => {
    await startWork(w, "builder");
    const { token } = await issueTicket(w.gate.env, "builder", NODE, jst(9));
    w.clock.advance(jst(9, 10) - w.clock.now());
    const res = await decide(token, { staffId: "reviewer", workspaceId: workspaceIdOf(w.gate.env, "reviewer") });
    expect(res.status).toBe(401);
    expect(await stops()).toMatchObject([{ scope: "office", signal: "certain_fraud" }]);
  });
});

describe("作業トークンの署名", () => {
  it("署名の合わない、形の違う、決めていないアルゴリズムの作業トークンを断る", async () => {
    await startWork(w, "builder");
    const { token } = await issueTicket(w.gate.env, "builder", NODE, jst(9));
    const [head = "", body = "", sig = ""] = token.split(".");
    const flipped = `${head}.${body}.${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`;
    const unsigned = `${btoa(JSON.stringify({ alg: "none", typ: TICKET_TYP })).replaceAll("=", "")}.${body}.`;
    // ほかの用途の鍵 (セッションの署名) で作った物
    const other = await new SignJWT({ node: NODE, ws: builder().workspaceId })
      .setProtectedHeader({ alg: "HS256", typ: TICKET_TYP })
      .setSubject("builder")
      .setJti("x")
      .setExpirationTime(Math.floor(jst(10) / 1000))
      .sign(await vaultKey(w.gate.env.DB, "session_signing", w.gate.env.MASTER_KEY, w.clock));
    for (const bad of [flipped, unsigned, other, "", "a.b", `${token}x`]) {
      await expect(authenticateTicket(w.gate.env, bad, builder(), jst(9, 1), w.gate.deps)).rejects.toThrow(AppError);
    }
    expect(await stops()).toEqual([]);
  });

  it("全体を止めて鍵を取り替えた後は、前の鍵で署名した作業トークンを断る", async () => {
    await startWork(w, "builder");
    const { token } = await issueTicket(w.gate.env, "builder", NODE, jst(9));
    await rotateVaultKeys(w.gate.env.DB, w.gate.env.MASTER_KEY, jst(9, 1));
    await expect(authenticateTicket(w.gate.env, token, builder(), jst(9, 2), w.gate.deps)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("タスクを止めて失効させた作業トークンを断る", async () => {
    await startWork(w, "builder");
    const { token } = await issueTicket(w.gate.env, "builder", NODE, jst(9));
    await w.gate.staff.builder.guard.dropTask(NODE, jst(9, 1));
    await expect(authenticateTicket(w.gate.env, token, builder(), jst(9, 2), w.gate.deps)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("作業トークンの無い要求を断り、ハートビートとチェックポイントだけは通す", async () => {
    await startWork(w, "builder");
    expect((await fromWorkspace("/ws/v1/decisions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await fromWorkspace("/ws/v1/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at: new Date(jst(9)).toISOString() }) })).status).toBe(204);
  });

});

/**
 * ハートビートを送る
 * @param caller 送ったワークスペース
 * @returns 受け手の返事
 */
function beat(caller?: Caller): Promise<Response> {
  return fromWorkspace("/ws/v1/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at: new Date(jst(9, 1)).toISOString() }) }, caller);
}

/**
 * チェックポイントを送る
 * @returns 受け手の返事
 */
function checkpoint(): Promise<Response> {
  return fromWorkspace("/ws/v1/checkpoints", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "commit", nodeId: NODE }) });
}

describe("1 時間を超えるタスク", () => {
  it("残りが 10 分を切ったチェックポイントで新しい作業トークンを渡し、前の作業トークンを失効させる", async () => {
    await startWork(w, "builder");
    const { token } = await issueTicket(w.gate.env, "builder", NODE, jst(9));
    w.clock.advance(jst(9, 30) - w.clock.now());
    expect((await checkpoint()).status).toBe(204);
    expect(w.gate.workspaces.builder.tickets).toEqual([]);
    w.clock.advance(jst(9, 51) - w.clock.now());
    expect((await checkpoint()).status).toBe(204);
    const [renewed] = w.gate.workspaces.builder.tickets;
    if (renewed === undefined) throw new Error("新しい作業トークンが届かない");
    expect(await authenticateTicket(w.gate.env, renewed, builder(), jst(10, 30), w.gate.deps)).toMatchObject({ nodeId: NODE, expiresAt: jst(9, 51) + 60 * MINUTE });
    await expect(authenticateTicket(w.gate.env, token, builder(), jst(9, 52), w.gate.deps)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("新しい作業トークンを渡せない時は、前の作業トークンを残す", async () => {
    await startWork(w, "builder");
    const { token } = await issueTicket(w.gate.env, "builder", NODE, jst(9));
    w.gate.workspaces.builder.down = true;
    w.clock.advance(jst(9, 51) - w.clock.now());
    expect((await checkpoint()).status).toBe(204);
    expect(await authenticateTicket(w.gate.env, token, builder(), jst(9, 52), w.gate.deps)).toMatchObject({ nodeId: NODE });
  });
});

describe("チェックポイントの受け方", () => {
  it("今のタスクと違うチェックポイントは 409 を返し、作業トークンを渡さない", async () => {
    await startWork(w, "builder");
    await issueTicket(w.gate.env, "builder", NODE, jst(9));
    w.clock.advance(jst(9, 51) - w.clock.now());
    const res = await fromWorkspace("/ws/v1/checkpoints", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "commit", nodeId: NODE2 }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "conflict" });
    expect(w.gate.workspaces.builder.tickets).toEqual([]);
  });
});

describe("作業トークンの監査ログ", () => {
  it("発行と失効を監査ログに残し、作業トークンそのものは入れない", async () => {
    await startWork(w, "builder");
    const { token, jti } = await issueTicket(w.gate.env, "builder", NODE, jst(9));
    w.clock.advance(jst(9, 51) - w.clock.now());
    await checkpoint();
    const actions = w.gate.audits.map((a) => [a.action, a.target]);
    expect(actions).toContainEqual(["ticket.issue", jti]);
    expect(actions).toContainEqual(["ticket.revoke", jti]);
    expect(JSON.stringify(w.gate.audits)).not.toContain(token);
  });
});

describe("ワークスペースを分ける", () => {
  it("ハートビートを叩き続ける", async () => {
    // 作業トークンの要らないハートビートとチェックポイントは、ワークスペースごとに合わせて 1 分 60 回まで
    await startWork(w, "builder");
    await startWork(w, "reviewer");
    w.clock.advance(jst(9, 1) - w.clock.now());
    for (let i = 0; i < 30; i += 1) expect((await beat()).status).toBe(204);
    for (let i = 0; i < 30; i += 1) expect((await checkpoint()).status).not.toBe(429);
    const over = await beat();
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ code: "rate_limited" });
    expect(over.headers.get("Retry-After")).toBe("60");
    expect((await checkpoint()).status).toBe(429);
    // ほかのワークスペースの数には入らない
    expect((await beat({ staffId: "reviewer", workspaceId: workspaceIdOf(w.gate.env, "reviewer") })).status).toBe(204);
    // 次の分には戻る
    w.clock.advance(MINUTE);
    expect((await beat()).status).toBe(204);
  });
});
