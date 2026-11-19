// Workers Analytics Engine の SQL API から読んだ訪問と 5xx を service_metrics の行に直す (サービスと拡張の 3.2)
import { beforeEach, describe, expect, it } from "vitest";
import { DEV_CLOUDFLARE } from "../../dev/cloudflare.ts";
import { cloudflareAnalytics, visitsQuery } from "../../src/gate/services/analytics.ts";
import { type CloudflareFakes, collectStep, connectCloudflare, OFFICE_ID, SERVICE, UI_ID, watchServices } from "../helpers/cloudflare.ts";
import { resetLedger } from "../helpers/d1.ts";
import { MINUTE, rows, useWork } from "../helpers/work.ts";

const world = useWork();

// 記録の D1 は useWork が戻さないので、前のテストの行を数えないよう戻す
beforeEach(async () => {
  await resetLedger(world.d1.REC_2026);
});

const connected = (token?: string | null) => connectCloudflare(world, token);
const watched = (uiKind?: "web_app" | "content") => watchServices(world, uiKind);
const collect = (fakes: CloudflareFakes) => collectStep(world, fakes);

// SHOW TABLES にはデータセットがあるのに、問い合わせは断る SQL API
const listedButInvalid = (sql: string) => (sql.startsWith("SHOW TABLES") ? Response.json({ meta: [{ name: "name", type: "String" }], data: [{ name: "knowidea_requests" }], rows: 1 }) : new Response("Input was invalid", { status: 422 }));

// SQL API の FORMAT JSON の返事
const table = (data: unknown[]) => ({ meta: [], data, rows: data.length });

const metrics = (): Promise<Record<string, unknown>[]> => rows(world.d1.REC_2026, "SELECT service_id, requests, errors, users, reads FROM service_metrics ORDER BY service_id");
const failures = (): Promise<Record<string, unknown>[]> => rows(world.d1.REC_2026, "SELECT code, level, source FROM error_events");

describe("サービスの種類", () => {
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
        sql: "SELECT blob1 AS script, SUM(_sample_interval * double1) AS visits, SUM(_sample_interval * double2) AS server_errors FROM knowidea_requests WHERE blob1 IN ('know-office', 'knowidea-ui') AND timestamp >= toDateTime(1796083200) AND timestamp < toDateTime(1796083500) GROUP BY blob1 LIMIT 100 FORMAT JSON",
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
    await expect(answer(table([{ script: "know-office", visits: -1, server_errors: 0 }]))).rejects.toThrow("形が違う");
    await expect(answer(table([{ script: "know-office", visits: 1, server_errors: "abc" }]))).rejects.toThrow("形が違う");
    await expect(answer(table([{ script: "know-office", visits: 1, server_errors: null }]))).rejects.toThrow("形が違う");
    await expect(answer(table([{ script: 1, visits: 1, server_errors: 0 }]))).rejects.toThrow("形が違う");
    await expect(answer({ rows: 0 })).rejects.toThrow("形が違う");
    await expect(answer(table(Array.from({ length: 100 }, (_, n) => ({ script: `app-${String(n)}`, visits: 1, server_errors: 0 }))))).rejects.toThrow("上限");
    // 64 ビットの数は文字列で返る事があるので、数の文字列は読む
    expect((await answer(table([{ script: "know-office", visits: "12", server_errors: "1" }])))?.metrics.get(OFFICE_ID)).toMatchObject({ users: 12, serverErrors: 1 });
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

  it("アプリが返した 5xx を、Worker のエラーと別の列に読んで失敗率に足す", async () => {
    await watched("web_app");
    const fakes = connected();
    // 代わりの Cloudflare は置いていないスクリプトに 5xx 3 を返す。点の無いスクリプトは 5xx を数えた 0 にする
    fakes.cloudflare.points.set("know-office", null);
    await collect(fakes);
    expect(await rows(world.d1.REC_2026, "SELECT service_id, errors, server_errors FROM service_metrics ORDER BY service_id")).toEqual([
      { service_id: UI_ID, errors: 2, server_errors: 3 },
      { service_id: OFFICE_ID, errors: 2, server_errors: 0 },
    ]);
    // SUM は小数になりうるので丸める
    fakes.cloudflare.points.set("know-office", { visits: 1, serverErrors: 2.4 });
    await collect(fakes);
    expect(await rows(world.d1.REC_2026, "SELECT server_errors FROM service_metrics WHERE service_id = ? ORDER BY at", OFFICE_ID)).toEqual([{ server_errors: 0 }, { server_errors: 2 }]);
  });

  it("5xx の数が呼び出しの数を超えても、失敗は呼び出しの数までにしてエラーログに残す", async () => {
    await watched("web_app");
    const fakes = connected();
    // 2 つの API は別々に集まるので、和が呼び出しの数を超える事がある
    fakes.cloudflare.invocations.set("know-office", [{ requests: 10, errors: 4 }]);
    fakes.cloudflare.points.set("know-office", { visits: 0, serverErrors: 9 });
    await collect(fakes);
    expect(await rows(world.d1.REC_2026, "SELECT requests, errors, server_errors FROM service_metrics WHERE service_id = ?", OFFICE_ID)).toEqual([{ requests: 10, errors: 4, server_errors: 6 }]);
    expect(await failures()).toEqual([{ code: "cloudflare_analytics_capped", level: "warn", source: "job" }]);
  });
});
