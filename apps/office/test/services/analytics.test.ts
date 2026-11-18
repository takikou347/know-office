// Cloudflare の GraphQL Analytics API から読んだ値を service_metrics の行に直す。鍵が無い間は外へ何も送らない (サービスと拡張の 3.2)
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeCloudflare, DEV_CLOUDFLARE, type FakeCloudflare } from "../../dev/cloudflare.ts";
import { cloudflareAnalytics } from "../../src/gate/services/analytics.ts";
import { collectMetrics } from "../../src/gate/services/deploys.ts";
import { resetLedger } from "../helpers/d1.ts";
import { MINUTE, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

// 記録の D1 は useWork が戻さないので、前のテストの行を数えないよう戻す
beforeEach(async () => {
  await resetLedger(world.d1.REC_2026);
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

const metrics = (): Promise<Record<string, unknown>[]> => rows(world.d1.REC_2026, "SELECT service_id, requests, errors, users, reads FROM service_metrics ORDER BY service_id");
const failures = (): Promise<Record<string, unknown>[]> => rows(world.d1.REC_2026, "SELECT code, level, source FROM error_events");
const notices = (): Promise<Record<string, unknown>[]> => rows(world.d1.DB, "SELECT kind FROM notices WHERE kind = 'analytics_failing'");

describe("サービスの種類", () => {
  it("GraphQL の返事を service_metrics の行に直す", async () => {
    await watched("web_app");
    const fakes = connected();
    fakes.cloudflare.invocations.set("know-office", [{ requests: 30, errors: 3 }, { requests: 12, errors: 0 }]);
    await collect(fakes);
    // Workers の Analytics には一意の訪問者が無いので、利用者数は null
    expect(await metrics()).toEqual([
      { service_id: UI_ID, requests: 100, errors: 2, users: null, reads: null },
      { service_id: OFFICE_ID, requests: 42, errors: 3, users: null, reads: null },
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
    expect(await cloudflareAnalytics(half, fakes.fetch).read(SERVICE, 0, 5 * MINUTE)).toBeNull();
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
    await cloudflareAnalytics(fakes.env, spy).read(SERVICE, from, from + 5 * MINUTE);
    expect(inits).toHaveLength(1);
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(fakes.cloudflare.requests).toEqual([
      { authorization: `Bearer ${DEV_CLOUDFLARE.token}`, variables: { accountTag: DEV_CLOUDFLARE.accountId, scriptName: "know-office", datetimeStart: "2026-12-01T00:00:00.000Z", datetimeEnd: "2026-12-01T00:05:00.000Z" } },
    ]);
  });

  it("リポジトリの名前がスクリプト名の形でなければ送らずに断る", async () => {
    const fakes = connected();
    await expect(cloudflareAnalytics(fakes.env, fakes.fetch).read({ ...SERVICE, repo: "example/a b\"c" }, 0, 5 * MINUTE)).rejects.toThrow("スクリプト名");
    expect(fakes.sent).toEqual([]);
  });

  it("返事が行の上限ちょうどなら、切れたかもしれないので読まない", async () => {
    const fakes = connected();
    fakes.cloudflare.invocations.set("know-office", Array.from({ length: 100 }, () => ({ requests: 1, errors: 0 })));
    await expect(cloudflareAnalytics(fakes.env, fakes.fetch).read(SERVICE, 0, 5 * MINUTE)).rejects.toThrow("上限");
    fakes.cloudflare.invocations.set("know-office", Array.from({ length: 99 }, () => ({ requests: 1, errors: 0 })));
    expect(await cloudflareAnalytics(fakes.env, fakes.fetch).read(SERVICE, 0, 5 * MINUTE)).toMatchObject({ requests: 99 });
  });

  it("形の違う返事と失敗の返事は読まない", async () => {
    const fakes = connected();
    const answer = (body: unknown, status = 200) => cloudflareAnalytics(fakes.env, () => Promise.resolve(Response.json(body, { status }))).read(SERVICE, 0, 5 * MINUTE);
    await expect(answer({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: "1", errors: 0 } }] }] } } })).rejects.toThrow("形が違う");
    await expect(answer({ data: { viewer: { accounts: [] } } })).rejects.toThrow("アカウント");
    await expect(answer({ data: null, errors: [{ message: "time range exceeds the limit" }] })).rejects.toThrow("time range");
    await expect(answer({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } }, errors: [{ message: "x" }] })).rejects.toThrow("エラー");
    await expect(answer({}, 429)).rejects.toThrow("429");
    await expect(answer({ data: { viewer: { accounts: [] } } }, 500)).rejects.toThrow("500");
    await expect(cloudflareAnalytics(fakes.env, () => Promise.resolve(new Response("<html>", { status: 200 }))).read(SERVICE, 0, 5 * MINUTE)).rejects.toThrow("形が違う");
  });

  it("鍵が断られたら行を書かず、エラーログに残し、秘密を出さない", async () => {
    await watched("web_app");
    const fakes = connected("wrong-token");
    await collect(fakes);
    expect(await metrics()).toEqual([]);
    expect(await failures()).toEqual([
      { code: "cloudflare_analytics_failed", level: "warn", source: "job" },
      { code: "cloudflare_analytics_failed", level: "warn", source: "job" },
    ]);
    expect(JSON.stringify(await rows(world.d1.REC_2026, "SELECT message FROM error_events"))).not.toContain("wrong-token");
  });

  it("続けて落ちても通知は 1 件で、3 回目の区切りで出す", async () => {
    await watched("web_app");
    const fakes = connected();
    fakes.cloudflare.failWith = 500;
    await collect(fakes);
    await collect(fakes);
    // 2 つのサービスが落ちても 1 回と数える
    expect(await notices()).toEqual([]);
    await collect(fakes);
    expect(await notices()).toEqual([{ kind: "analytics_failing" }]);
    await collect(fakes);
    await collect(fakes);
    expect(await notices()).toEqual([{ kind: "analytics_failing" }]);
    expect((await failures()).length).toBe(10);
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

  it("代わりの Cloudflare は本物と同じく、違う鍵と長すぎる期間と大きすぎる上限を断る", async () => {
    const fakes = connected();
    const send = (authorization: string, query: string, span: number) =>
      fakes.cloudflare.app.request("/client/v4/graphql", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ query, variables: { accountTag: DEV_CLOUDFLARE.accountId, scriptName: "x", datetimeStart: "2026-12-01T00:00:00.000Z", datetimeEnd: new Date(Date.UTC(2026, 11, 1) + span).toISOString() } }),
      });
    const query = "query Q { viewer { accounts { workersInvocationsAdaptive(limit: 100) { sum { requests errors } } } } }";
    expect((await send("Bearer bad", query, MINUTE)).status).toBe(403);
    expect(await errorsOf(await send(`Bearer ${DEV_CLOUDFLARE.token}`, query, 8 * 24 * 60 * MINUTE))).toHaveLength(1);
    expect(await errorsOf(await send(`Bearer ${DEV_CLOUDFLARE.token}`, query.replace("100", "10001"), MINUTE))).toHaveLength(1);
    expect((await send(`Bearer ${DEV_CLOUDFLARE.token}`, query, MINUTE)).status).toBe(200);
  });
});
