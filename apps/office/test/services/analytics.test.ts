// Cloudflare の GraphQL Analytics API から読んだ値を service_metrics の行に直す。鍵が無い間は外へ何も送らない (サービスと拡張の 3.2)。Analytics Engine の訪問と 5xx は analytics-engine.test.ts
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { DEV_CLOUDFLARE } from "../../dev/cloudflare.ts";
import { cloudflareAnalytics, MAX_SCRIPTS_PER_QUERY } from "../../src/gate/services/analytics.ts";
import { collectMetrics } from "../../src/gate/services/deploys.ts";
import { type CloudflareFakes, collectStep, connectCloudflare, OFFICE_ID, SERVICE, UI_ID, watchServices } from "../helpers/cloudflare.ts";
import { resetLedger } from "../helpers/d1.ts";
import { MINUTE, rows, useWork } from "../helpers/work.ts";

const world = useWork();

// 記録の D1 は useWork が戻さないので、前のテストの行を数えないよう戻す
beforeEach(async () => {
  await resetLedger(world.d1.REC_2026);
  await resetLedger(world.d1.REC_2027);
});

// 共通の口を、このファイルの world で包む
const connected = (token?: string | null) => connectCloudflare(world, token);
const watched = (uiKind?: "web_app" | "content") => watchServices(world, uiKind);
const collect = (fakes: CloudflareFakes) => collectStep(world, fakes);

// 返事の errors
const errorsOf = async (res: Response) => z.object({ errors: z.array(z.unknown()).nullable() }).parse(await res.json()).errors;

const metrics = (): Promise<Record<string, unknown>[]> => rows(world.d1.REC_2026, "SELECT service_id, requests, errors, users, reads FROM service_metrics ORDER BY service_id");
const failures = (): Promise<Record<string, unknown>[]> => rows(world.d1.REC_2026, "SELECT code, level, source FROM error_events");
const notices = (): Promise<Record<string, unknown>[]> => rows(world.d1.DB, "SELECT kind FROM notices WHERE kind = 'analytics_failing'");

describe("サービスの種類", () => {
  it("GraphQL の返事を service_metrics の行に直す", async () => {
    await watched("web_app");
    const fakes = connected();
    fakes.cloudflare.invocations.set("know-office", [{ requests: 30, errors: 3 }, { requests: 12, errors: 0 }]);
    await collect(fakes);
    // 利用者数は Analytics Engine から読む。代わりの Cloudflare は置いていないスクリプトに訪問 7 を返す
    expect(await metrics()).toEqual([
      { service_id: UI_ID, requests: 100, errors: 2, users: 7, reads: null },
      { service_id: OFFICE_ID, requests: 42, errors: 3, users: 7, reads: null },
    ]);
    expect(await failures()).toEqual([]);
  });

  it("コンテンツの読まれた数に呼び出しの数を入れる", async () => {
    await watched("content");
    const fakes = connected();
    fakes.cloudflare.invocations.set("knowidea-ui", [{ requests: 8, errors: 0 }]);
    await collect(fakes);
    expect(await rows(world.d1.REC_2026, "SELECT requests, reads FROM service_metrics WHERE service_id = ?", UI_ID)).toEqual([{ requests: 8, reads: 8 }]);
  });

  it("呼び出しが 0 件の区切りは 0 の行にする", async () => {
    await watched("web_app");
    const fakes = connected();
    fakes.cloudflare.invocations.set("know-office", []);
    await collect(fakes);
    expect(await rows(world.d1.REC_2026, "SELECT requests, errors FROM service_metrics WHERE service_id = ?", OFFICE_ID)).toEqual([{ requests: 0, errors: 0 }]);
  });

  it("鍵が無い間は外へ何も送らず、何も書かない", async () => {
    await watched();
    const fakes = connected(null);
    await collect(fakes);
    expect(fakes.sent).toEqual([]);
    expect(fakes.cloudflare.requests).toEqual([]);
    expect(await metrics()).toEqual([]);
    expect(await failures()).toEqual([]);
  });

  it("鍵が片方だけの時も外へ何も送らない", async () => {
    const fakes = connected();
    const half = { ...fakes.env, CLOUDFLARE_ACCOUNT_ID: "" };
    expect(await cloudflareAnalytics(half, fakes.fetch).read([SERVICE], 0, 5 * MINUTE)).toBeNull();
    expect(fakes.sent).toEqual([]);
  });

  it("スクリプト名と期間と鍵を付けて 10 秒の時間切れで 1 回だけ呼ぶ", async () => {
    const fakes = connected();
    const inits: (RequestInit | undefined)[] = [];
    const spy = (url: string, init?: RequestInit) => {
      inits.push(init);
      return fakes.fetch(url, init);
    };
    const from = Date.UTC(2026, 11, 1, 0, 0);
    await cloudflareAnalytics(fakes.env, spy).read([SERVICE], from, from + 5 * MINUTE);
    // GraphQL と Analytics Engine の SQL を 1 回ずつ呼ぶ
    expect(inits).toHaveLength(2);
    for (const init of inits) expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(fakes.cloudflare.requests).toEqual([
      { authorization: `Bearer ${DEV_CLOUDFLARE.token}`, variables: { accountTag: DEV_CLOUDFLARE.accountId, scriptNames: ["know-office"], datetimeStart: "2026-12-01T00:00:00.000Z", datetimeEnd: "2026-12-01T00:05:00.000Z" } },
    ]);
  });

  it("リポジトリの名前がスクリプト名の形でなければ読まず、外へ送らずにエラーログに残す", async () => {
    const fakes = connected();
    const read = await cloudflareAnalytics(fakes.env, fakes.fetch).read([{ ...SERVICE, repo: "example/a b\"c" }, { ...SERVICE, repo: "example/-edge" }], 0, 5 * MINUTE);
    expect(read?.skipped).toHaveLength(2);
    expect(fakes.sent).toEqual([]);
    await watched("web_app");
    await world.d1.DB.prepare("UPDATE services SET repo = 'example/bad name' WHERE id = ?").bind(UI_ID).run();
    await collect(fakes);
    expect(await failures()).toEqual([{ code: "cloudflare_analytics_skipped", level: "warn", source: "job" }]);
    expect(await metrics()).toEqual([{ service_id: OFFICE_ID, requests: 100, errors: 2, users: 7, reads: null }]);
  });

  it("4 件以上飛ばしても、同じエラーの続きの通知は出さない", async () => {
    const skipped = Array.from({ length: 5 }, (_, n) => ({ serviceId: `s${String(n)}`, reason: "スクリプト名の形が違う" }));
    await collectMetrics(world.gate.env, { read: () => Promise.resolve({ metrics: new Map(), skipped }) }, world.clock.now() + 10 * MINUTE, world.gate.deps);
    expect(await failures()).toHaveLength(5);
    expect(await rows(world.d1.DB, "SELECT kind FROM notices WHERE kind = 'error_burst'")).toEqual([]);
  });

  it("全部のサービスを 1 回の問い合わせで読む", async () => {
    await watched("web_app");
    const fakes = connected();
    await collect(fakes);
    expect(fakes.cloudflare.requests.map((r) => r.variables["scriptNames"])).toEqual([["knowidea-ui", "know-office"]]);
  });

  it("1 回に読むスクリプトの上限を超えた分は読まず、同じスクリプトは数えない", async () => {
    const fakes = connected();
    const many = Array.from({ length: MAX_SCRIPTS_PER_QUERY + 1 }, (_, n) => ({ id: `s${String(n)}`, repo: `example/app-${String(n)}`, kind: "web_app" }));
    const read = await cloudflareAnalytics(fakes.env, fakes.fetch).read([...many, { id: "same", repo: "example/app-0", kind: "web_app" }], 0, 5 * MINUTE);
    expect(fakes.cloudflare.requests.map((r) => z.array(z.string()).parse(r.variables["scriptNames"]).length)).toEqual([MAX_SCRIPTS_PER_QUERY]);
    expect(read?.skipped.map((k) => k.serviceId)).toEqual([`s${String(MAX_SCRIPTS_PER_QUERY)}`]);
    expect(read?.metrics.size).toBe(MAX_SCRIPTS_PER_QUERY + 1);
  });

  it("集まる遅れの分、1 つ前の区切りを読んで、行はその区切りの終わりに置く", async () => {
    await watched("web_app");
    const fakes = connected();
    await collect(fakes);
    const now = world.clock.now();
    const end = Math.floor((now - 5 * MINUTE) / (5 * MINUTE)) * 5 * MINUTE;
    expect(fakes.cloudflare.requests[0]?.variables).toMatchObject({ datetimeStart: new Date(end - 5 * MINUTE).toISOString(), datetimeEnd: new Date(end).toISOString() });
    expect(await rows(world.d1.REC_2026, "SELECT DISTINCT at FROM service_metrics")).toEqual([{ at: end }]);
  });

  it("返事が行の上限ちょうどなら、切れたかもしれないので読まない", async () => {
    const fakes = connected();
    fakes.cloudflare.invocations.set("know-office", Array.from({ length: 100 }, () => ({ requests: 1, errors: 0 })));
    await expect(cloudflareAnalytics(fakes.env, fakes.fetch).read([SERVICE], 0, 5 * MINUTE)).rejects.toThrow("上限");
    fakes.cloudflare.invocations.set("know-office", Array.from({ length: 99 }, () => ({ requests: 1, errors: 0 })));
    expect((await cloudflareAnalytics(fakes.env, fakes.fetch).read([SERVICE], 0, 5 * MINUTE))?.metrics.get(OFFICE_ID)).toMatchObject({ requests: 99 });
  });

  it("形の違う返事と失敗の返事は読まない", async () => {
    const fakes = connected();
    const answer = (body: unknown, status = 200) => cloudflareAnalytics(fakes.env, () => Promise.resolve(Response.json(body, { status }))).read([SERVICE], 0, 5 * MINUTE);
    await expect(answer({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: "1", errors: 0 }, dimensions: { scriptName: "know-office" } }] }] } } })).rejects.toThrow("形が違う");
    await expect(answer({ data: { viewer: { accounts: [] } } })).rejects.toThrow("アカウント");
    await expect(answer({ data: null, errors: [{ message: "time range exceeds the limit" }] })).rejects.toThrow("time range");
    await expect(answer({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } }, errors: [{ message: "x" }] })).rejects.toThrow("エラー");
    await expect(answer({}, 429)).rejects.toThrow("429");
    await expect(answer({ data: { viewer: { accounts: [] } } }, 500)).rejects.toThrow("500");
    await expect(cloudflareAnalytics(fakes.env, () => Promise.resolve(new Response("<html>", { status: 200 }))).read([SERVICE], 0, 5 * MINUTE)).rejects.toThrow("形が違う");
  });

  it("鍵が断られたら行を書かず、エラーログに残し、秘密を出さない", async () => {
    await watched("web_app");
    const fakes = connected("wrong-token");
    await collect(fakes);
    expect(await metrics()).toEqual([]);
    expect(await failures()).toEqual([{ code: "cloudflare_analytics_failed", level: "warn", source: "job" }]);
    expect(JSON.stringify(await rows(world.d1.REC_2026, "SELECT message FROM error_events"))).not.toContain("wrong-token");
  });

  it("続けて落ちても通知は 1 件で、3 回目の区切りで出す", async () => {
    await watched("web_app");
    const fakes = connected();
    fakes.cloudflare.failWith = 500;
    await collect(fakes);
    await collect(fakes);
    expect(await notices()).toEqual([]);
    await collect(fakes);
    expect(await notices()).toEqual([{ kind: "analytics_failing" }]);
    await collect(fakes);
    await collect(fakes);
    expect(await notices()).toEqual([{ kind: "analytics_failing" }]);
    expect((await failures()).length).toBe(5);
  });

  it("間に読めた区切りがあれば、落ちた回数を数え直す", async () => {
    await watched("web_app");
    const fakes = connected();
    fakes.cloudflare.failWith = 500;
    await collect(fakes);
    await collect(fakes);
    fakes.cloudflare.failWith = null;
    await collect(fakes);
    fakes.cloudflare.failWith = 500;
    await collect(fakes);
    await collect(fakes);
    expect(await notices()).toEqual([]);
  });

  it("年をまたいでも、前の年の失敗を数えて 3 回目で通知を出す", async () => {
    await watched("web_app");
    const fakes = connected();
    fakes.cloudflare.failWith = 500;
    // 日本時間の 2026-12-31 23:50 から 3 回の区切り。3 回目は 2027 年に入る
    world.clock.advance(Date.UTC(2026, 11, 31, 14, 50) - world.clock.now() - 5 * MINUTE);
    await collect(fakes);
    await collect(fakes);
    expect(await notices()).toEqual([]);
    await collect(fakes);
    expect(await rows(world.d1.REC_2027, "SELECT code FROM error_events")).toEqual([{ code: "cloudflare_analytics_failed" }]);
    expect(await notices()).toEqual([{ kind: "analytics_failing" }]);
  });

  it("代わりの Cloudflare は本物と同じく、違う鍵と長すぎる期間と大きすぎる上限を断る", async () => {
    const fakes = connected();
    const send = (authorization: string, query: string, span: number) =>
      fakes.cloudflare.app.request("/client/v4/graphql", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ query, variables: { accountTag: DEV_CLOUDFLARE.accountId, scriptNames: ["x"], datetimeStart: "2026-12-01T00:00:00.000Z", datetimeEnd: new Date(Date.UTC(2026, 11, 1) + span).toISOString() } }),
      });
    const query = "query Q { viewer { accounts { workersInvocationsAdaptive(limit: 100, filter: { scriptName_in: $scriptNames }) { sum { requests errors } } } } }";
    expect((await send("Bearer bad", query, MINUTE)).status).toBe(403);
    expect(await errorsOf(await send(`Bearer ${DEV_CLOUDFLARE.token}`, query, 8 * 24 * 60 * MINUTE))).toHaveLength(1);
    expect(await errorsOf(await send(`Bearer ${DEV_CLOUDFLARE.token}`, query.replace("100", "10001"), MINUTE))).toHaveLength(1);
    expect((await send(`Bearer ${DEV_CLOUDFLARE.token}`, query, MINUTE)).status).toBe(200);
  });
});
