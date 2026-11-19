// 開発環境の代わりの Cloudflare。GraphQL Analytics API の workersInvocationsAdaptive と、Workers Analytics Engine の SQL API を、本物と同じ鍵、変数、上限で返す
// 出典: https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/ (項目と返事の形)、
// https://developers.cloudflare.com/analytics/graphql-api/limits/ (5 分に 300 クエリ)、https://developers.cloudflare.com/workers/observability/metrics-and-analytics/ (期間は 1 週間までの区間)
import { Hono } from "hono";
import { z } from "zod";

/** 開発の .dev.vars に置く API トークンとアカウント ID。代わりの Cloudflare が通す */
export const DEV_CLOUDFLARE = { token: "dev-fake-cloudflare-token", accountId: "dev-account" } as const;

/** 1 行の合計 */
export type FakeInvocationRow = { requests: number; errors: number };

/** 代わりの Cloudflare */
export type FakeCloudflare = {
  /** /client/v4/graphql を持つ Hono */
  app: Hono;
  /** スクリプトごとに返す行。置かないスクリプトは決まった値の 1 行 (requests 100、errors 2) を返す */
  invocations: Map<string, FakeInvocationRow[]>;
  /** 受けた GraphQL の変数 (scriptNames は読んだスクリプト名)と Authorization */
  requests: { variables: Record<string, unknown>; authorization: string | null }[];
  /** 次の要求から返す失敗の HTTP ステータス。null なら通す */
  failWith: 429 | 500 | 502 | null;
  /** Analytics Engine のスクリプトごとの点の和。置かないスクリプトは訪問 7 と 5xx 3 を返し、null なら行を返さない */
  points: Map<string, FakePoints | null>;
  /** 受けた SQL と、宛先のアカウント ID と Authorization */
  sqlRequests: { accountId: string; authorization: string | null; sql: string }[];
  /** 次の SQL から返す失敗の HTTP ステータス。null なら通す */
  sqlFailWith: 429 | 500 | 503 | null;
  /** データセットにまだ点が無く、テーブルが無いか */
  datasetMissing: boolean;
};

/** Analytics Engine の 1 スクリプトの和 */
export type FakePoints = { visits: number; serverErrors?: number };

/** 点の残る長さ (3 か月)。これより長い期間の問い合わせは断る。https://developers.cloudflare.com/analytics/analytics-engine/limits/ */
const POINT_RETENTION_S = 92 * 24 * 60 * 60;

/** 読み手が使うデータセットの名前 */
const DATASET = "knowidea_requests";

/** 1 回の要求の期間の上限 (1 週間)。本物の Workers の Analytics の最大の区間 */
const MAX_RANGE_MS = 7 * 24 * 60 * 60_000;
/** 5 分に受けるクエリの数の上限 */
const QUERY_QUOTA = 300;
/**
 * limit の上限。データセットごとの maxPageSize で、firewallEventsAdaptive の例は 10000 (https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/)。
 * workersInvocationsAdaptive の値は文書に無いので、読み手が使う 100 より十分大きい 10000 を置く。読み手はこれより大きく請わない
 */
const MAX_PAGE_SIZE = 10_000;

const Body = z.object({
  query: z.string(),
  variables: z.object({ accountTag: z.string(), scriptNames: z.array(z.string()), datetimeStart: z.iso.datetime(), datetimeEnd: z.iso.datetime() }),
});

/**
 * 代わりの Cloudflare を作る
 * @param options 通す API トークンとアカウント ID、今の時刻
 * @param options.token 通す API トークン
 * @param options.accountId 通すアカウント ID
 * @param options.now 今の時刻
 * @returns 代わりの Cloudflare
 */
export function createFakeCloudflare(options: { token: string; accountId: string; now: () => number }): FakeCloudflare {
  const fake: FakeCloudflare = { app: new Hono(), invocations: new Map(), requests: [], failWith: null, points: new Map(), sqlRequests: [], sqlFailWith: null, datasetMissing: false };
  const stamps: number[] = [];
  fake.app.post("/client/v4/graphql", async (c) => {
    const authorization = c.req.header("authorization") ?? null;
    const raw: unknown = await c.req.json().catch(() => null);
    const body = Body.safeParse(raw);
    fake.requests.push({ variables: body.success ? body.data.variables : {}, authorization });
    if (fake.failWith !== null) return c.json({ data: null, errors: [{ message: "failed" }] }, fake.failWith);
    // 違う鍵の返事の形 (ステータスと本文) は文書で確かめられなかった (認証のページに記載が無い)。読み手はどの失敗も同じに扱うので、403 と errors とする
    if (authorization !== `Bearer ${options.token}`) return c.json({ data: null, errors: [{ message: "authentication error" }] }, 403);
    const now = options.now();
    while (stamps[0] !== undefined && stamps[0] <= now - 5 * 60_000) stamps.shift();
    stamps.push(now);
    if (stamps.length > QUERY_QUOTA) return c.json({ data: null, errors: [{ message: "rate limit exceeded" }] }, 429);
    if (!body.success || !body.data.query.includes("workersInvocationsAdaptive")) return c.json({ data: null, errors: [{ message: "bad query" }] }, 400);
    const { accountTag, scriptNames, datetimeStart, datetimeEnd } = body.data.variables;
    const range = Date.parse(datetimeEnd) - Date.parse(datetimeStart);
    if (range <= 0 || range > MAX_RANGE_MS) return c.json({ data: null, errors: [{ message: "time range exceeds the limit" }] }, 200);
    const limit = Number(/limit:\s*(\d+)/.exec(body.data.query)?.[1] ?? "100");
    if (limit > MAX_PAGE_SIZE) return c.json({ data: null, errors: [{ message: "limit exceeds the maximum page size" }] }, 200);
    // scriptName_in を使わない問い合わせは断る。読み手が 1 回の問い合わせで全部を読む形を守らせる
    if (!body.data.query.includes("scriptName_in")) return c.json({ data: null, errors: [{ message: "scriptName_in is required" }] }, 200);
    const rows = scriptNames.flatMap((scriptName) => (fake.invocations.get(scriptName) ?? [{ requests: 100, errors: 2 }]).map((sum) => ({ sum, dimensions: { scriptName } })));
    const found = accountTag === options.accountId ? [{ workersInvocationsAdaptive: rows.slice(0, limit) }] : [];
    return c.json({ data: { viewer: { accounts: found } }, errors: null });
  });
  // Workers Analytics Engine の SQL API。本文は SQL の文で、FORMAT JSON は {meta, data, rows} を返す
  // 出典: https://developers.cloudflare.com/analytics/analytics-engine/sql-api/ 、https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/statements/ 、
  // 失敗の形 (SQL の誤りは 422 と text/plain、鍵の断りは Cloudflare の API の JSON): https://developers.cloudflare.com/analytics/sql-api/errors/
  fake.app.post("/client/v4/accounts/:accountId/analytics_engine/sql", async (c) => {
    const authorization = c.req.header("authorization") ?? null;
    const sql = await c.req.text();
    const accountId = c.req.param("accountId");
    fake.sqlRequests.push({ accountId, authorization, sql });
    if (fake.sqlFailWith !== null) return c.text("failed", fake.sqlFailWith);
    if (authorization !== `Bearer ${options.token}` || accountId !== options.accountId) return c.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403);
    if (/^SHOW TABLES FORMAT JSON$/.test(sql)) {
      const data = fake.datasetMissing ? [] : [{ name: DATASET }];
      return c.json({ meta: [{ name: "name", type: "String" }], data, rows: data.length });
    }
    if (fake.datasetMissing) return c.text(`Input was invalid: unknown table ${DATASET}`, 422);
    const scripts = /blob1 IN \(((?:'[A-Za-z0-9-]+'(?:, )?)+)\)/.exec(sql)?.[1]?.split(", ").map((q) => q.slice(1, -1));
    const times = [...sql.matchAll(/toDateTime\((\d+)\)/g)].map((m) => Number(m[1]));
    const limit = Number(/ LIMIT (\d+) /.exec(sql)?.[1] ?? "0");
    if (!scripts || times.length !== 2 || limit === 0 || !sql.includes(`FROM ${DATASET} `) || !sql.endsWith(" FORMAT JSON")) return c.text("Input was invalid: unsupported query", 422);
    const [start = 0, end = 0] = times;
    if (end <= start || end - start > POINT_RETENTION_S) return c.text("Input was invalid: time range", 422);
    const data = scripts.flatMap((script) => {
      const sum = fake.points.has(script) ? fake.points.get(script) : { visits: 7, serverErrors: 3 };
      return sum ? [{ script, visits: sum.visits, server_errors: sum.serverErrors ?? 0 }] : [];
    });
    const meta = [{ name: "script", type: "String" }, { name: "visits", type: "Float64" }, { name: "server_errors", type: "Float64" }];
    return c.json({ meta, data: data.slice(0, limit), rows: Math.min(data.length, limit) });
  });
  return fake;
}
