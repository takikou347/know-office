// Cloudflare の GraphQL Analytics API と Workers Analytics Engine の SQL API から、Web アプリとコンテンツの 5 分の様子を、全部のサービスをそれぞれ 1 回の問い合わせで読む (サービスと拡張の 3.2)
import { AnalyticsEngineTables, AnalyticsEngineVisits, FETCH_TIMEOUT_MS, type Fetcher, Secret, WorkersInvocationsResponse } from "@know-office/core";
import { endpoints } from "../endpoints.ts";
import type { Bindings } from "../env.ts";
import { ANALYTICS_FAILED_CODE } from "../ledger/errors.ts";
import { recordsOf } from "../work/nodes.ts";
import { noticeOnce } from "../work/notice.ts";
import { type Analytics, type AnalyticsRead, type Metrics, UNCONNECTED_ANALYTICS } from "./deploys.ts";
import { REQUESTS_DATASET } from "./requests.ts";

/** 続けて落ちた時の通知の種類 */
export const ANALYTICS_FAILING_NOTICE = "analytics_failing";

/** 通知を出す、続けて落ちた区切りの数 */
const FAILING_STEPS = 3;

/** 1 回の問い合わせで読むスクリプトの上限。超えた分は読まず、呼ぶ側がエラーログに残す。費用の出る口を数で閉じる */
export const MAX_SCRIPTS_PER_QUERY = 50;

/**
 * 問い合わせの limit。スクリプトごとに 1 行 (datetime を dimensions に入れない) なので MAX_SCRIPTS_PER_QUERY より大きい。返事の行がこれに届いたら切れたとみなして読まない。
 * データセットごとの上限は Settings ノードの maxPageSize で、workersInvocationsAdaptive の値は文書に無い (https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/)。文書の例の limit は 100
 */
const ROW_LIMIT = 100;

/**
 * 全部のスクリプトの合計を、スクリプトごとの 1 行で読む問い合わせ。
 * 項目と filter (scriptName、datetime_geq): https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/。
 * 演算子 (_in、_lt): https://developers.cloudflare.com/analytics/graphql-api/features/filtering/。
 * 文書の curl の例が改行を除いて送る (tr -d '\n') ので、1 行で書く: https://developers.cloudflare.com/analytics/graphql-api/getting-started/execute-graphql-query/。
 * 一意の訪問者 (uniq.uniques) は zone のデータセットだけで workers.dev には zone が無いので、利用者数は Analytics Engine の訪問から読む (visitsQuery)
 */
const QUERY = `query Invocations($accountTag: string, $scriptNames: [string!], $datetimeStart: string, $datetimeEnd: string) { viewer { accounts(filter: { accountTag: $accountTag }) { workersInvocationsAdaptive(limit: ${String(ROW_LIMIT)}, filter: { scriptName_in: $scriptNames, datetime_geq: $datetimeStart, datetime_lt: $datetimeEnd }) { sum { requests errors } dimensions { scriptName } } } } }`;

/** workers.dev の Worker の名前の形。英数字と - の 63 字までで、頭と終わりに - を置かない。出典: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/ */
const SCRIPT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Analytics Engine の問い合わせの LIMIT。スクリプトごとに 1 行なので MAX_SCRIPTS_PER_QUERY より大きい。返事の行がこれに届いたら切れたとみなして読まない。
 * SQL API の上限は文の長さ 10 KiB だけが数で書かれ、行の数はデータセットごとの上限を超える LIMIT を断るとだけある (https://developers.cloudflare.com/analytics/sql-api/limits/)
 */
const VISITS_ROW_LIMIT = 100;

/**
 * 訪問の数とアプリが返した 5xx の数をスクリプトごとに読む SQL を組み立てる。SQL API に値を渡す口が無いので、名前の形と時刻をここで確かめてから文に入れる。
 * _sample_interval を掛けて足す (https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)。IN と toDateTime は SQL の決まりの物
 * (https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/operators/ 、https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/date-time-functions/)
 * @param scripts スクリプト名。workers.dev の Worker の名前の形だけ
 * @param from 期間の始まり (ミリ秒の整数)
 * @param to 期間の終わり (含まない、ミリ秒の整数)
 * @returns SQL の文
 */
export function visitsQuery(scripts: string[], from: number, to: number): string {
  if (scripts.length === 0 || scripts.some((script) => !SCRIPT_NAME.test(script))) throw new Error("スクリプト名の形が違う");
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) throw new Error("期間の形が違う");
  const names = scripts.map((script) => `'${script}'`).join(", ");
  const start = String(Math.floor(from / 1000));
  const end = String(Math.floor(to / 1000));
  return `SELECT blob1 AS script, SUM(_sample_interval * double1) AS visits, SUM(_sample_interval * double2) AS server_errors FROM ${REQUESTS_DATASET} WHERE blob1 IN (${names}) AND timestamp >= toDateTime(${start}) AND timestamp < toDateTime(${end}) GROUP BY blob1 LIMIT ${String(VISITS_ROW_LIMIT)} FORMAT JSON`;
}

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
  const base = endpoints(env).cloudflareApi;
  return {
    async read(services, from, to) {
      const skipped: AnalyticsRead["skipped"] = [];
      const queried: { id: string; kind: string; script: string }[] = [];
      const scripts = new Set<string>();
      for (const service of services) {
        // リポジトリ (owner/name) の name を、デプロイした Workers のスクリプト名とする
        const script = service.repo?.split("/")[1] ?? "";
        if (!SCRIPT_NAME.test(script)) skipped.push({ serviceId: service.id, reason: "スクリプト名の形が違う" });
        else if (scripts.size >= MAX_SCRIPTS_PER_QUERY && !scripts.has(script)) skipped.push({ serviceId: service.id, reason: "1 回に読むスクリプトの上限を超えた" });
        else {
          scripts.add(script);
          queried.push({ id: service.id, kind: service.kind, script });
        }
      }
      const metrics = new Map<string, Metrics>();
      if (queried.length === 0) return { metrics, skipped };
      const response = await fetcher(url, {
        method: "POST",
        headers: { authorization: `Bearer ${secret.reveal()}`, "content-type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { accountTag: accountId, scriptNames: [...scripts], datetimeStart: new Date(from).toISOString(), datetimeEnd: new Date(to).toISOString() } }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new AnalyticsReadError(`Cloudflare の Analytics が ${String(response.status)} を返した`);
      const totals = totalsOf(await response.json().catch(() => null));
      // GraphQL が通っても訪問が読めなければ、その区切りは書かない
      const sql = (body: string) =>
        fetcher(`${base}/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`, { method: "POST", headers: { authorization: `Bearer ${secret.reveal()}` }, body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const points = await pointsOf(sql, visitsQuery([...scripts], from, to));
      for (const q of queried) {
        // 呼び出しの無かったスクリプトは行が無いので、0 件の区切りにする
        const total = totals.get(q.script) ?? { requests: 0, errors: 0 };
        // 点の無いスクリプトは訪問を数えていない (書かないサービスか、訪問が無かった) ので利用者数は null。5xx は読めたので 0 と数える
        const point = points.get(q.script);
        metrics.set(q.id, { ...total, serverErrors: point?.serverErrors ?? 0, users: q.kind === "web_app" ? (point?.visits ?? null) : null, reads: q.kind === "content" ? total.requests : null });
      }
      return { metrics, skipped };
    },
  };
}

/**
 * Analytics Engine からスクリプトごとの訪問の数と 5xx の数を読む。断られた時は SHOW TABLES でデータセットがあるかを確かめ、まだ点が 1 つも無く
 * テーブルが無い時だけ 0 件とする (テーブルは最初に書いた時に作られる: https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)。
 * テーブルが無い時の失敗の形は文書に無いので、失敗の中身でなく SHOW TABLES で分ける
 * @param sql SQL の文を送る口
 * @param query 訪問を読む SQL
 * @returns スクリプト名ごとの訪問の数と 5xx の数 (丸めた整数)
 * @throws AnalyticsReadError 読めない時、形が違う時、行が上限に届いた時
 */
async function pointsOf(sql: (body: string) => Promise<Response>, query: string): Promise<Map<string, { visits: number; serverErrors: number }>> {
  const response = await sql(query);
  if (!response.ok) {
    const status = response.status;
    // 読まない本文は Workers でつながりを塞ぐので、次を呼ぶ前に捨てる
    await response.body?.cancel();
    const tables = await sql("SHOW TABLES FORMAT JSON");
    const listed = AnalyticsEngineTables.safeParse(tables.ok ? await tables.json().catch(() => null) : null);
    const missing = listed.success && !listed.data.data.some((row) => Object.values(row).includes(REQUESTS_DATASET));
    if (!missing) throw new AnalyticsReadError(`Cloudflare の Analytics Engine が ${String(status)} を返した`);
    return new Map();
  }
  const parsed = AnalyticsEngineVisits.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new AnalyticsReadError("Cloudflare の Analytics Engine の返事の形が違う");
  // 上限ちょうどの行数は切れたかもしれないので、足りない数を残さない
  if (parsed.data.data.length >= VISITS_ROW_LIMIT) throw new AnalyticsReadError("Cloudflare の Analytics Engine の返事が行の上限に届いた");
  const points = new Map<string, { visits: number; serverErrors: number }>();
  for (const row of parsed.data.data) {
    const sum = points.get(row.script) ?? { visits: 0, serverErrors: 0 };
    points.set(row.script, { visits: sum.visits + Math.round(row.visits), serverErrors: sum.serverErrors + Math.round(row.server_errors) });
  }
  return points;
}

/**
 * 返事をスクリプトごとの合計に直す
 * @param body 外から来た返事
 * @returns スクリプト名ごとの呼び出しの数とエラーの数
 * @throws AnalyticsReadError 形が違う時、errors を返した時、アカウントが見えない時、行が上限に届いた時
 */
function totalsOf(body: unknown): Map<string, { requests: number; errors: number }> {
  const parsed = WorkersInvocationsResponse.safeParse(body);
  if (!parsed.success) throw new AnalyticsReadError("Cloudflare の Analytics の返事の形が違う");
  const first = parsed.data.errors?.[0];
  if (first) throw new AnalyticsReadError(`Cloudflare の Analytics がエラーを返した: ${first.message.slice(0, 100)}`);
  const account = parsed.data.data?.viewer.accounts[0];
  if (!account) throw new AnalyticsReadError("Cloudflare の Analytics にアカウントが見えない");
  const found = account.workersInvocationsAdaptive;
  // 上限ちょうどの行数は切れたかもしれないので、足りない合計を残さない
  if (found.length >= ROW_LIMIT) throw new AnalyticsReadError("Cloudflare の Analytics の返事が行の上限に届いた");
  const totals = new Map<string, { requests: number; errors: number }>();
  for (const row of found) {
    const total = totals.get(row.dimensions.scriptName) ?? { requests: 0, errors: 0 };
    totals.set(row.dimensions.scriptName, { requests: total.requests + row.sum.requests, errors: total.errors + row.sum.errors });
  }
  return totals;
}

/**
 * 直前の 3 回の区切りで続けて読めなかった時だけ通知を出す。同じ区切りで何件落ちても 1 回と数え、通知は読むまで 1 件。年をまたぐ時は前の年の記録も数える
 * @param env バインディング
 * @param now 今の時刻
 * @param stepMs 区切りの長さ
 */
export async function noticeIfFailing(env: Bindings, now: number, stepMs: number): Promise<void> {
  // 1 分の余裕を足して、3 回前の区切りを含め、4 回前を含めない
  const since = now - (FAILING_STEPS - 1) * stepMs - 60_000;
  let failed = 0;
  // 前の年の記録の D1 が無い (最初の年の初め) 時は、今の年だけを数える
  const before = (() => {
    try {
      return recordsOf(env, since);
    } catch {
      return null;
    }
  })();
  for (const db of new Set([recordsOf(env, now), ...(before ? [before] : [])])) {
    const row = await db.prepare("SELECT count(DISTINCT at) AS n FROM error_events WHERE code = ? AND at > ?").bind(ANALYTICS_FAILED_CODE, since).first<{ n: number }>();
    failed += row?.n ?? 0;
  }
  if (failed < FAILING_STEPS) return;
  await noticeOnce(env, { kind: ANALYTICS_FAILING_NOTICE, title: "サービスの様子を Cloudflare から読めない", body: `${String(FAILING_STEPS)} 回続けて読めなかった。エラーの一覧の ${ANALYTICS_FAILED_CODE} を見て、API トークンとアカウント ID を確かめる。直ったら、この通知を読む` }, now);
}
