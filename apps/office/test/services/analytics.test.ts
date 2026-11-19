// Cloudflare の GraphQL Analytics API と Workers Analytics Engine の SQL API から読んだ値を service_metrics の行に直す。鍵が無い間は外へ何も送らない (サービスと拡張の 3.2)
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeCloudflare, DEV_CLOUDFLARE, type FakeCloudflare } from "../../dev/cloudflare.ts";
import { cloudflareAnalytics, MAX_SCRIPTS_PER_QUERY, visitsQuery } from "../../src/gate/services/analytics.ts";
import { collectMetrics } from "../../src/gate/services/deploys.ts";
import { resetLedger } from "../helpers/d1.ts";
import { MINUTE, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

// 記録の D1 は useWork が戻さないので、前のテストの行を数えないよう戻す
beforeEach(async () => {
  await resetLedger(world.d1.REC_2026);
  await resetLedger(world.d1.REC_2027);
});

const OFFICE_ID = "00000000-0000-7000-8000-000000000102";
const UI_ID = "00000000-0000-7000-8000-000000000101";
const BASE = "http://localhost:5199/cloudflare";
const SERVICE = { id: OFFICE_ID, repo: "example/know-office", kind: "web_app" };

type Fakes = { cloudflare: FakeCloudflare; env: WorkWorld["gate"]["env"]; fetch: (url: string, init?: RequestInit) => Promise<Response>; sent: string[] };

/**
 * 代わりの Cloudflare につないだ env と fetch を作る
 * @param token ゲートウェイに入れる API トークン。無ければ鍵を入れない
 * @returns 代わりの Cloudflare と、つないだ env と fetch
 */
function connected(token: string | null = DEV_CLOUDFLARE.token): Fakes {
  const cloudflare = createFakeCloudflare({ ...DEV_CLOUDFLARE, now: () => world.clock.now() });
  const sent: string[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    sent.push(url);
    return Promise.resolve(cloudflare.app.request(url.slice(BASE.length), init));
  };
  const keys = token === null ? {} : { CLOUDFLARE_ANALYTICS_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: DEV_CLOUDFLARE.accountId };
  return { cloudflare, env: { ...world.gate.env, ...keys }, fetch, sent };
}

/**
 * 最初の 2 つのサービスにリポジトリを付け、knowidea-ui を Web アプリかコンテンツにする
 * @param uiKind knowidea-ui の種類
 */
async function watched(uiKind: "web_app" | "content" = "content"): Promise<void> {
  await world.d1.DB.prepare("UPDATE services SET repo = 'example/know-office' WHERE id = ?").bind(OFFICE_ID).run();
  await world.d1.DB.prepare("UPDATE services SET repo = 'example/knowidea-ui', kind = ? WHERE id = ?").bind(uiKind, UI_ID).run();
}

/**
 * 5 分の区切りを進めて、様子を読む
 * @param fakes 代わりの Cloudflare
 */
async function collect(fakes: Fakes): Promise<void> {
  world.clock.advance(5 * MINUTE);
  await collectMetrics(fakes.env, cloudflareAnalytics(fakes.env, fakes.fetch), world.clock.now(), world.gate.deps);
}

// 返事の errors
const errorsOf = async (res: Response) => z.object({ errors: z.array(z.unknown()).nullable() }).parse(await res.json()).errors;

// SHOW TABLES にはデータセットがあるのに、問い合わせは断る SQL API
const listedButInvalid = (sql: string) => (sql.startsWith("SHOW TABLES") ? Response.json({ meta: [{ name: "name", type: "String" }], data: [{ name: "knowidea_requests" }], rows: 1 }) : new Response("Input was invalid", { status: 422 }));

// SQL API の FORMAT JSON の返事
const table = (data: unknown[]) => ({ meta: [], data, rows: data.length });

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

  it("Web アプリの利用者数に、アプリが数えた直前の 5 分の訪問の数を入れる", async () => {
    await watched("web_app");
    const fakes = connected();
    // SUM は小数になりうるので丸める
    fakes.cloudflare.points.set("know-office", { visits: 4.6 });
    await collect(fakes);
    expect(await rows(world.d1.REC_2026, "SELECT users FROM service_metrics WHERE service_id = ?", OFFICE_ID)).toEqual([{ users: 5 }]);
    // コンテンツは利用者数を持たない
    await resetLedger(world.d1.REC_2026);
    await watched("content");
    await collect(fakes);
    expect(await rows(world.d1.REC_2026, "SELECT users FROM service_metrics WHERE service_id = ?", UI_ID)).toEqual([{ users: null }]);
  });

  it("Analytics Engine に点の無いサービスの利用者数は null にする", async () => {
    await watched("web_app");
    const fakes = connected();
    fakes.cloudflare.points.set("know-office", null);
    await collect(fakes);
    expect(await rows(world.d1.REC_2026, "SELECT service_id, users FROM service_metrics ORDER BY service_id")).toEqual([
      { service_id: UI_ID, users: 7 },
      { service_id: OFFICE_ID, users: null },
    ]);
  });

  it("Analytics Engine の SQL を、形を確かめたスクリプト名と整数の秒の期間で、同じ鍵で 1 回だけ呼ぶ", async () => {
    const fakes = connected();
    const from = Date.UTC(2026, 11, 1, 0, 0);
    await cloudflareAnalytics(fakes.env, fakes.fetch).read([SERVICE, { ...SERVICE, id: UI_ID, repo: "example/knowidea-ui" }], from, from + 5 * MINUTE);
    expect(fakes.cloudflare.sqlRequests).toEqual([
      {
        accountId: DEV_CLOUDFLARE.accountId,
        authorization: `Bearer ${DEV_CLOUDFLARE.token}`,
        sql: "SELECT blob1 AS script, SUM(_sample_interval * double1) AS visits FROM knowidea_requests WHERE blob1 IN ('know-office', 'knowidea-ui') AND timestamp >= toDateTime(1796083200) AND timestamp < toDateTime(1796083500) GROUP BY blob1 LIMIT 100 FORMAT JSON",
      },
    ]);
    // SQL に値を渡す口が無いので、組み立てる所で名前の形と時刻を確かめる
    expect(() => visitsQuery(["a'b"], from, from + 5 * MINUTE)).toThrow("スクリプト名の形が違う");
    expect(() => visitsQuery(["know-office"], Number.NaN, from)).toThrow("期間の形が違う");
    expect(() => visitsQuery(["know-office"], from, from + 0.5)).toThrow("期間の形が違う");
    expect(() => visitsQuery([], from, from + 5 * MINUTE)).toThrow("スクリプト名の形が違う");
  });

  it("Analytics Engine を読めなければ、その区切りは書かずにエラーログに残す", async () => {
    await watched("web_app");
    const fakes = connected();
    fakes.cloudflare.sqlFailWith = 500;
    await collect(fakes);
    expect(fakes.cloudflare.requests).toHaveLength(1);
    expect(await metrics()).toEqual([]);
    expect(await failures()).toEqual([{ code: "cloudflare_analytics_failed", level: "warn", source: "job" }]);
  });

  it("まだ点の無いデータセットは、SHOW TABLES で無い事を確かめて 0 件として読む", async () => {
    await watched("web_app");
    const fakes = connected();
    fakes.cloudflare.datasetMissing = true;
    await collect(fakes);
    expect(fakes.cloudflare.sqlRequests.map((r) => r.sql)).toEqual([expect.stringContaining("FROM knowidea_requests"), "SHOW TABLES FORMAT JSON"]);
    expect(await rows(world.d1.REC_2026, "SELECT users FROM service_metrics ORDER BY service_id")).toEqual([{ users: null }, { users: null }]);
    expect(await failures()).toEqual([]);
    // データセットがあるのに読めない時は、無いと見なさず落とす
    const fetch = (url: string, init?: RequestInit) => (url.includes("/analytics_engine/sql") ? Promise.resolve(listedButInvalid(typeof init?.body === "string" ? init.body : "")) : fakes.fetch(url, init));
    await expect(cloudflareAnalytics(fakes.env, fetch).read([SERVICE], 0, 5 * MINUTE)).rejects.toThrow("422");
  });

  it("形の違う Analytics Engine の返事 (負、数でない、行の上限ちょうど) は読まない", async () => {
    const fakes = connected();
    const answer = (body: unknown) => {
      const fetch = (url: string, init?: RequestInit) => (url.includes("/analytics_engine/sql") ? Promise.resolve(Response.json(body)) : fakes.fetch(url, init));
      return cloudflareAnalytics(fakes.env, fetch).read([SERVICE], 0, 5 * MINUTE);
    };
    await expect(answer(table([{ script: "know-office", visits: -1 }]))).rejects.toThrow("形が違う");
    await expect(answer(table([{ script: "know-office", visits: "abc" }]))).rejects.toThrow("形が違う");
    await expect(answer(table([{ script: "know-office", visits: null }]))).rejects.toThrow("形が違う");
    await expect(answer(table([{ script: 1, visits: 1 }]))).rejects.toThrow("形が違う");
    await expect(answer({ rows: 0 })).rejects.toThrow("形が違う");
    await expect(answer(table(Array.from({ length: 100 }, (_, n) => ({ script: `app-${String(n)}`, visits: 1 }))))).rejects.toThrow("上限");
    // 64 ビットの数は文字列で返る事があるので、数の文字列は読む
    expect((await answer(table([{ script: "know-office", visits: "12" }])))?.metrics.get(OFFICE_ID)).toMatchObject({ users: 12 });
  });

  it("代わりの Cloudflare は Analytics Engine の SQL でも、違う鍵と長すぎる期間を断る", async () => {
    const fakes = connected();
    const send = (authorization: string, sql: string) => fakes.cloudflare.app.request(`/client/v4/accounts/${DEV_CLOUDFLARE.accountId}/analytics_engine/sql`, { method: "POST", headers: { authorization }, body: sql });
    const from = Date.UTC(2026, 11, 1) / 1000;
    const good = visitsQuery(["know-office"], from * 1000, (from + 300) * 1000);
    expect((await send("Bearer bad", good)).status).toBe(403);
    // 点は 3 か月だけ残るので、それより長い期間は断る
    expect((await send(`Bearer ${DEV_CLOUDFLARE.token}`, visitsQuery(["know-office"], from * 1000, (from + 93 * 24 * 3600) * 1000))).status).toBe(422);
    expect((await send(`Bearer ${DEV_CLOUDFLARE.token}`, good.replace(" LIMIT 100", ""))).status).toBe(422);
    expect((await send(`Bearer ${DEV_CLOUDFLARE.token}`, good)).status).toBe(200);
  });
});
