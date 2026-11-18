// 開発環境の代わりの Cloudflare の GraphQL Analytics API。workersInvocationsAdaptive だけを、本物と同じ鍵、変数、上限で返す
// 出典: https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/ (項目と期間)、
// https://developers.cloudflare.com/analytics/graphql-api/limits/ (5 分に 300 クエリ)、https://developers.cloudflare.com/workers/observability/metrics-and-analytics/ (期間は 1 週間まで)
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
  /** 受けた GraphQL の変数と Authorization */
  requests: { variables: Record<string, unknown>; authorization: string | null }[];
  /** 次の要求から返す失敗の HTTP ステータス。null なら通す */
  failWith: 429 | 500 | 502 | null;
};

/** 1 回の要求の期間の上限 (1 週間)。本物の Workers の Analytics の最大の区間 */
const MAX_RANGE_MS = 7 * 24 * 60 * 60_000;
/** 5 分に受けるクエリの数の上限 */
const QUERY_QUOTA = 300;
/** 1 回に返す行の上限。文書の例の limit と同じ上限を本物の最大 (maxPageSize) として扱う */
const MAX_PAGE_SIZE = 10_000;

const Body = z.object({
  query: z.string(),
  variables: z.object({ accountTag: z.string(), scriptName: z.string(), datetimeStart: z.iso.datetime(), datetimeEnd: z.iso.datetime() }),
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
  const fake: FakeCloudflare = { app: new Hono(), invocations: new Map(), requests: [], failWith: null };
  const stamps: number[] = [];
  fake.app.post("/client/v4/graphql", async (c) => {
    const authorization = c.req.header("authorization") ?? null;
    const raw: unknown = await c.req.json().catch(() => null);
    const body = Body.safeParse(raw);
    fake.requests.push({ variables: body.success ? body.data.variables : {}, authorization });
    if (fake.failWith !== null) return c.json({ data: null, errors: [{ message: "failed" }] }, fake.failWith);
    if (authorization !== `Bearer ${options.token}`) return c.json({ data: null, errors: [{ message: "authentication error" }] }, 403);
    const now = options.now();
    while (stamps[0] !== undefined && stamps[0] <= now - 5 * 60_000) stamps.shift();
    stamps.push(now);
    if (stamps.length > QUERY_QUOTA) return c.json({ data: null, errors: [{ message: "rate limit exceeded" }] }, 429);
    if (!body.success || !body.data.query.includes("workersInvocationsAdaptive") || /\n/.test(body.data.query)) return c.json({ data: null, errors: [{ message: "bad query" }] }, 400);
    const { accountTag, scriptName, datetimeStart, datetimeEnd } = body.data.variables;
    const range = Date.parse(datetimeEnd) - Date.parse(datetimeStart);
    if (range <= 0 || range > MAX_RANGE_MS) return c.json({ data: null, errors: [{ message: "time range exceeds the limit" }] }, 200);
    const limit = Number(/limit:\s*(\d+)/.exec(body.data.query)?.[1] ?? "100");
    if (limit > MAX_PAGE_SIZE) return c.json({ data: null, errors: [{ message: "limit exceeds the maximum page size" }] }, 200);
    const rows = accountTag === options.accountId ? (fake.invocations.get(scriptName) ?? [{ requests: 100, errors: 2 }]) : [];
    const found = accountTag === options.accountId ? [{ workersInvocationsAdaptive: rows.slice(0, limit).map((sum) => ({ sum, dimensions: { scriptName } })) }] : [];
    return c.json({ data: { viewer: { accounts: found } }, errors: null });
  });
  return fake;
}
