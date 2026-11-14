// 気付く: Claude の API の失敗が続いたら 5 分以内に通知を出し、画面が読む通知のルートで読めて、既読にできる (サービスと拡張の 3.5)
import type { Fetcher, StaffId } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Caller, routeEgress } from "../../src/gate/egress.ts";
import { issueTicket, workspaceIdOf } from "../../src/gate/work/ticket.ts";
import { addNode, MINUTE, rows, useGuardWorld } from "../helpers/guard.ts";

const w = useGuardWorld();

/**
 * 2026-12-08 (日本時間) の時刻を返す。エラーログは年ごとの REC_<年> に入るので、テストの D1 がある 2026 年にする
 * REC_2026 はテストの間で空にしないので、テストごとに違う時を使い、5 分の窓が重ならないようにする
 * @param h 時
 * @param m 分
 * @returns 協定世界時のミリ秒
 */
function at(h: number, m = 0): number {
  return Date.UTC(2026, 11, 8, h - 9, m);
}

const Notice = z
  .object({
    id: z.uuid(),
    at: z.iso.datetime(),
    level: z.enum(["info", "warn", "stop"]),
    kind: z.string(),
    title: z.string(),
    body: z.string(),
    scope: z.string(),
    readAt: z.iso.datetime().nullable(),
  })
  .strict();
const NoticeList = z.object({ data: z.array(Notice), meta: z.object({ next: z.string().nullable() }).loose() }).strict();

/**
 * 社員を出勤させ、新しいタスクを持たせて作業トークンを出す
 * @param start 始める時刻
 * @param staffId 社員 ID
 * @returns 社員と作業トークン
 */
async function startTask(start: number, staffId: StaffId = "builder"): Promise<{ staffId: StaffId; token: string }> {
  const nodeId = crypto.randomUUID();
  w.clock.advance(start - w.clock.now());
  const { book } = w.gate.staff[staffId];
  await book.wake(start);
  await book.wake(start + MINUTE);
  await addNode(w, nodeId, staffId);
  await book.take({ nodeId, title: "直す", scope: "office" }, null, start + MINUTE);
  w.clock.advance(2 * MINUTE);
  const { token } = await issueTicket(w.gate.env, staffId, nodeId, w.clock.now());
  return { staffId, token };
}

/**
 * ワークスペースの SDK と同じ形で Claude を呼ぶ
 * @param work 社員と作業トークン
 * @param when 呼ぶ時刻
 * @param fetcher ゲートウェイが外へ出す fetch。省くと代わりの Claude API に回す
 * @returns 受け手の返事
 */
async function callClaude(work: { staffId: StaffId; token: string }, when: number, fetcher: Fetcher = w.gate.fetch): Promise<Response> {
  w.clock.advance(when - w.clock.now());
  await w.gate.staff[work.staffId].book.heartbeat(w.clock.now());
  const caller: Caller = { staffId: work.staffId, workspaceId: workspaceIdOf(w.gate.env, work.staffId) };
  const request = new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": work.token, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 1024, messages: [{ role: "user", content: "直す" }] }),
  });
  return routeEgress(request, w.gate.env, caller, { clock: w.clock, guard: w.gate.deps, fetch: fetcher });
}

/**
 * オーナーとして通知の一覧を読む
 * @param query 問い
 * @returns 通知の一覧
 */
async function readNotices(query = ""): Promise<z.infer<typeof NoticeList>> {
  const headers = await w.gate.signIn();
  const res = await w.gate.request(`/api/v1/notices${query}`, { headers });
  expect(res.status).toBe(200);
  return NoticeList.parse(await res.json());
}

/**
 * 代わりの Claude API に届かない fetch
 * @returns 落ちる Promise
 */
function unreachable(): Promise<Response> {
  return Promise.reject(new TypeError("届かない"));
}

describe("気付く", () => {
  it("API の失敗が続く", async () => {
    const work = await startTask(at(9));
    const first = at(9, 10);
    for (const [i, status] of ([500, 500, 500] as const).entries()) {
      w.gate.claude.pushError(status, "api_error");
      expect((await callClaude(work, first + i * MINUTE)).status).toBe(status);
    }
    // 3 回目の失敗の時に通知が入る。画面は 1 分ごとに読むので、5 分以内に出る
    const { data } = await readNotices();
    const found = data.filter((n) => n.kind === "claude_failing");
    expect(found).toEqual([expect.objectContaining({ level: "warn", scope: "office", readAt: null })]);
    expect(Date.parse(found[0]?.at ?? "")).toBeLessThanOrEqual(first + 5 * MINUTE);
    expect(found[0]?.title).toContain("Claude");
  });
});

describe("Claude の失敗の通知", () => {
  it("5 分に 2 回の失敗では出さない", async () => {
    const work = await startTask(at(10));
    w.gate.claude.pushError(500, "api_error");
    await callClaude(work, at(10, 10));
    w.gate.claude.pushError(500, "api_error");
    await callClaude(work, at(10, 12));
    // 5 分の窓を外れた 3 回目
    w.gate.claude.pushError(500, "api_error");
    await callClaude(work, at(10, 16));
    expect((await readNotices()).data.filter((n) => n.kind === "claude_failing")).toEqual([]);
  });

  it("届かない失敗も数え、続く間は読むまで重ねない", async () => {
    const work = await startTask(at(11));
    w.gate.claude.pushError(500, "api_error");
    await callClaude(work, at(11, 10));
    expect((await callClaude(work, at(11, 11), unreachable)).status).toBe(502);
    w.gate.claude.pushError(500, "api_error");
    await callClaude(work, at(11, 12));
    w.gate.claude.pushError(500, "api_error");
    await callClaude(work, at(11, 13));
    expect(await rows(w, "SELECT kind FROM notices WHERE kind = 'claude_failing'")).toEqual([{ kind: "claude_failing" }]);
    const failures = await w.d1.REC_2026.prepare("SELECT code, status FROM error_events WHERE at >= ? AND at < ? ORDER BY at").bind(at(11), at(12)).all();
    expect(failures.results).toEqual([
      { code: "claude_failed", status: 500 },
      { code: "claude_failed", status: 502 },
      { code: "claude_failed", status: 500 },
      { code: "claude_failed", status: 500 },
    ]);
  });

  it("429 と 529 は上限の待ちで、失敗に数えない", async () => {
    const work = await startTask(at(12));
    for (const [i, status] of ([429, 529, 429] as const).entries()) {
      w.gate.claude.pushError(status, status === 429 ? "rate_limit_error" : "overloaded_error");
      await callClaude(work, at(12, 10 + i));
    }
    expect((await readNotices()).data.filter((n) => n.kind === "claude_failing")).toEqual([]);
  });
});

/**
 * 通知を直に置く
 * @param id 通知 ID
 * @param when 時刻
 * @param body 本文。無い事がある
 */
async function put(id: string, when: number, body: string | null = "本文"): Promise<void> {
  await w.d1.DB.prepare("INSERT INTO notices (id, at, level, kind, title, body, scope) VALUES (?, ?, 'warn', 'storage', ?, ?, 'office')").bind(id, when, `題 ${id.slice(-1)}`, body).run();
}

describe("通知のルート", () => {
  it("新しい順に読め、カーソルで続きを読める", async () => {
    w.clock.advance(at(13) - w.clock.now());
    await put("0190f4a8-0000-7000-8000-000000000001", at(8));
    await put("0190f4a8-0000-7000-8000-000000000002", at(8, 1), null);
    await put("0190f4a8-0000-7000-8000-000000000003", at(8, 2));
    const first = await readNotices("?limit=2");
    expect(first.data.map((n) => n.id)).toEqual(["0190f4a8-0000-7000-8000-000000000003", "0190f4a8-0000-7000-8000-000000000002"]);
    // 本文の無い通知は空の文で返す
    expect(first.data[1]?.body).toBe("");
    expect(first.meta.next).toBe("0190f4a8-0000-7000-8000-000000000002");
    const rest = await readNotices(`?limit=2&cursor=${first.meta.next ?? ""}`);
    expect(rest.data.map((n) => n.id)).toEqual(["0190f4a8-0000-7000-8000-000000000001"]);
    expect(rest.meta.next).toBeNull();
  });

  it("既読にでき、既読なら何もせず、無い通知は 404", async () => {
    w.clock.advance(at(13) - w.clock.now());
    const id = "0190f4a8-0000-7000-8000-000000000009";
    await put(id, at(8));
    const headers = await w.gate.signIn();
    const read = (noticeId: string) => w.gate.request(`/api/v1/notices/${noticeId}/read`, { method: "PUT", headers });
    expect((await read(id)).status).toBe(204);
    w.clock.advance(MINUTE);
    expect((await read(id)).status).toBe(204);
    expect(await rows(w, `SELECT read_at FROM notices WHERE id = '${id}'`)).toEqual([{ read_at: at(13) }]);
    expect((await read("0190f4a8-0000-7000-8000-0000000000ff")).status).toBe(404);
  });
});
