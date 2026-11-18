// Cloudflare の GraphQL Analytics API から、Web アプリとコンテンツの Workers の直前の 5 分の様子を読む (サービスと拡張の 3.2)
import { FETCH_TIMEOUT_MS, type Fetcher, Secret, WorkersInvocationsResponse } from "@know-office/core";
import { ANALYTICS_FAILED_CODE } from "../ledger/errors.ts";
import { endpoints } from "../endpoints.ts";
import type { Bindings } from "../env.ts";
import { recordsOf } from "../work/nodes.ts";
import { noticeOnce } from "../work/notice.ts";
import { type Analytics, type Metrics, UNCONNECTED_ANALYTICS } from "./deploys.ts";

/** 続けて落ちた時の通知の種類 */
export const ANALYTICS_FAILING_NOTICE = "analytics_failing";

/** 通知を出す、続けて落ちた区切りの数 */
const FAILING_STEPS = 3;

/** 1 回に返してもらう行の上限。1 つのスクリプトの合計を 1 行で受けるので、届いたら切れたとみなして読まない。出典: 文書の例の limit (https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/) */
const ROW_LIMIT = 100;

/**
 * Workers のスクリプトの合計を 1 行で読む問い合わせ。1 行にして送る (GraphQL の POST の決まり)
 * 出典: https://developers.cloudflare.com/analytics/graphql-api/getting-started/querying-basics/ (query は 1 行の文字、variables は別)
 * 項目は https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/ の sum.requests、sum.errors、scriptName、datetime_geq。
 * datetime_lt は https://developers.cloudflare.com/analytics/graphql-api/getting-started/querying-basics/ の例にある。
 * 一意の訪問者 (uniq.uniques) は zone のデータセットだけで workers.dev には zone が無いので、利用者数は読まない
 */
const QUERY = `query Invocations($accountTag: string, $scriptName: string, $datetimeStart: string, $datetimeEnd: string) { viewer { accounts(filter: { accountTag: $accountTag }) { workersInvocationsAdaptive(limit: ${String(ROW_LIMIT)}, filter: { scriptName: $scriptName, datetime_geq: $datetimeStart, datetime_lt: $datetimeEnd }) { sum { requests errors } dimensions { scriptName } } } } }`;

/** Workers のスクリプト名の形。Cloudflare のスクリプト名は英数字と - と _ の 63 字まで */
const SCRIPT_NAME = /^[A-Za-z0-9_-]{1,63}$/;

/** Analytics を読めなかった失敗。メッセージに鍵を入れない */
export class AnalyticsReadError extends Error {
  override readonly name = "AnalyticsReadError";
}

/**
 * Cloudflare の GraphQL Analytics API から様子を読む口を作る。鍵が無ければ、何も読まず外へ何も送らない口を返す
 * @param env バインディング
 * @param fetcher 外への fetch
 * @returns 様子を読む口
 */
export function cloudflareAnalytics(env: Bindings, fetcher: Fetcher): Analytics {
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN ?? "";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (token === "" || accountId === "") return UNCONNECTED_ANALYTICS;
  const secret = new Secret(token);
  const url = endpoints(env).cloudflareGraphql;
  return {
    async read(service, from, to) {
      // リポジトリ (owner/name) の name を、デプロイした Workers のスクリプト名とする
      const scriptName = service.repo?.split("/")[1] ?? "";
      if (!SCRIPT_NAME.test(scriptName)) throw new AnalyticsReadError("スクリプト名の形が違う");
      const response = await fetcher(url, {
        method: "POST",
        headers: { authorization: `Bearer ${secret.reveal()}`, "content-type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { accountTag: accountId, scriptName, datetimeStart: new Date(from).toISOString(), datetimeEnd: new Date(to).toISOString() } }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new AnalyticsReadError(`Cloudflare の Analytics が ${String(response.status)} を返した`);
      const body: unknown = await response.json().catch(() => null);
      return metricsOf(body, service.kind);
    },
  };
}

/**
 * 返事を様子に直す
 * @param body 外から来た返事
 * @param kind サービスの種類。コンテンツだけ読まれた数を持つ
 * @returns 様子
 * @throws AnalyticsReadError 形が違う時、errors を返した時、アカウントが見えない時、行が上限に届いた時
 */
function metricsOf(body: unknown, kind: string): Metrics {
  const parsed = WorkersInvocationsResponse.safeParse(body);
  if (!parsed.success) throw new AnalyticsReadError("Cloudflare の Analytics の返事の形が違う");
  const first = parsed.data.errors?.[0];
  if (first) throw new AnalyticsReadError(`Cloudflare の Analytics がエラーを返した: ${first.message.slice(0, 100)}`);
  const account = parsed.data.data?.viewer.accounts[0];
  if (!account) throw new AnalyticsReadError("Cloudflare の Analytics にアカウントが見えない");
  const found = account.workersInvocationsAdaptive;
  // 上限ちょうどの行数は切れたかもしれないので、足りない合計を残さない
  if (found.length >= ROW_LIMIT) throw new AnalyticsReadError("Cloudflare の Analytics の返事が行の上限に届いた");
  const requests = found.reduce((sum, row) => sum + row.sum.requests, 0);
  const errors = found.reduce((sum, row) => sum + row.sum.errors, 0);
  return { requests, errors, users: null, reads: kind === "content" ? requests : null };
}

/**
 * 直前の 3 回の区切りで続けて読めなかった時だけ通知を出す。同じ区切りで何件落ちても 1 回と数え、通知は読むまで 1 件
 * @param env バインディング
 * @param now 今の時刻
 * @param stepMs 区切りの長さ
 */
export async function noticeIfFailing(env: Bindings, now: number, stepMs: number): Promise<void> {
  // 1 分の余裕を足して、3 回前の区切りを含め、4 回前を含めない
  const since = now - (FAILING_STEPS - 1) * stepMs - 60_000;
  const row = await recordsOf(env, now)
    .prepare("SELECT count(DISTINCT at) AS n FROM error_events WHERE code = ? AND at > ?")
    .bind(ANALYTICS_FAILED_CODE, since)
    .first<{ n: number }>();
  if ((row?.n ?? 0) < FAILING_STEPS) return;
  await noticeOnce(env, { kind: ANALYTICS_FAILING_NOTICE, title: "サービスの様子を Cloudflare から読めない", body: `${String(FAILING_STEPS)} 回続けて読めなかった。エラーの一覧の ${ANALYTICS_FAILED_CODE} を見て、API トークンとアカウント ID を確かめる。直ったら、この通知を読む` }, now);
}
