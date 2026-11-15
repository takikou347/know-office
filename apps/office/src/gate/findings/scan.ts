// 見つけて直す調べ。前の週のエラーを原因の指紋ごとにまとめてレビュー担当のモデルに送り、1 つの原因を 1 件の Issue にする (サービスと拡張の 3.7)
import { type Clock, FindingAnswer, jstClock, jstDay, jstYear, newId, OPUS } from "@know-office/core";
import { z } from "zod";
import { type Bindings, RECORD_BINDINGS } from "../env.ts";
import { answerJson, type BatchRequest, type BatchResult, recordBatchUsage } from "../jobs/claude-batch.ts";
import type { BatchRow, WeekRange, WeeklyDeps, WeeklyJob } from "../jobs/weekly.ts";
import { recordError } from "../ledger/errors.ts";
import { clockAt } from "../work/attendance.ts";
import { fingerprintMark, type IssueTracker, REPO_PATTERN } from "./tracker.ts";

/** 1 度に送る原因の上限。多い順に送る */
const MAX_GROUPS = 100;

/** 答えの長さの上限 */
const MAX_TOKENS = 2000;

/** Issue を作る印を、作れずに残った物とみなすまでの間 */
const STALE_CLAIM_MS = 10 * 60_000;

/** 変わらない先頭の指示。毎週同じ文にして読み直しの割引に当てる */
const SYSTEM = [
  "あなたは know-office のレビュー担当。1 週間のエラーログのうち、同じ原因の指紋を持つ物をまとめて読む。",
  "開発担当が直せるように、Issue の題、再現の手順、見立てを書く。",
  "直すのに費用が増える事が要る時は needs を cost_increase、外のサービスとの新しい連携が要る時は external_integration、どちらも要らなければ null にする。",
  '答えは JSON だけで返す: {"title":"...","steps":["..."],"needs":null,"reason":"..."}',
].join("\n");

/** batches の detail に置く、custom_id ごとの原因 */
const Detail = z.object({
  groups: z.array(z.object({ customId: z.string(), fingerprint: z.string(), count: z.number().int(), firstAt: z.number(), lastAt: z.number() })),
});

const Group = z.object({ fingerprint: z.string(), n: z.number().int(), first_at: z.number(), last_at: z.number() });
const Sample = z.object({ source: z.string(), code: z.string(), route: z.string().nullable(), status: z.number().nullable(), message: z.string() });
const FindingRow = z.object({ id: z.string(), fingerprint: z.string(), repo: z.string().nullable(), issue_number: z.number().nullable(), count: z.number(), first_at: z.number(), last_at: z.number() });

/** findings の行のうち、Issue に使う所 */
type FindingRow = z.infer<typeof FindingRow>;

/**
 * 期間にかかる年の記録の D1 を返す
 * @param env バインディング
 * @param from 始め
 * @param to 終わり。含まない
 * @returns バインドした記録の D1
 */
export function recordDbs(env: Bindings, from: number, to: number): D1Like[] {
  const out: D1Like[] = [];
  for (let year = jstYear(from); year <= jstYear(to - 1); year += 1) {
    const name = RECORD_BINDINGS.find((b) => b === `REC_${String(year)}`);
    const db = name ? env[name] : undefined;
    if (db) out.push(db);
  }
  return out;
}

/** 記録の D1 */
type D1Like = NonNullable<Bindings["REC_2026"]>;

/**
 * 前の週のエラーを指紋ごとにまとめ、多い順に送る物を作る
 * @param env バインディング
 * @param range 前の週
 * @returns 原因ごとの要求と、custom_id から原因への対応。エラーが無ければ null
 */
async function prepare(env: Bindings, range: WeekRange): Promise<{ requests: BatchRequest[]; detail: z.infer<typeof Detail> } | null> {
  const merged = new Map<string, { count: number; firstAt: number; lastAt: number; sample: z.infer<typeof Sample> | null; db: D1Like }>();
  for (const db of recordDbs(env, range.from, range.to)) {
    const { results } = await db
      .prepare("SELECT fingerprint, count(*) AS n, min(at) AS first_at, max(at) AS last_at FROM error_events WHERE at >= ? AND at < ? GROUP BY fingerprint")
      .bind(range.from, range.to)
      .all();
    for (const g of z.array(Group).parse(results)) {
      const was = merged.get(g.fingerprint);
      merged.set(g.fingerprint, {
        count: (was?.count ?? 0) + g.n,
        firstAt: Math.min(was?.firstAt ?? g.first_at, g.first_at),
        lastAt: Math.max(was?.lastAt ?? g.last_at, g.last_at),
        sample: null,
        db: g.last_at >= (was?.lastAt ?? 0) ? db : (was?.db ?? db),
      });
    }
  }
  if (merged.size === 0) return null;
  const sorted = [...merged.entries()].toSorted(([fa, a], [fb, b]) => b.count - a.count || fa.localeCompare(fb)).slice(0, MAX_GROUPS);
  const groups = await Promise.all(
    sorted.map(async ([fingerprint, g], i) => {
      const sample = Sample.safeParse(
        await g.db.prepare("SELECT source, code, route, status, message FROM error_events WHERE fingerprint = ? AND at < ? ORDER BY at DESC LIMIT 1").bind(fingerprint, range.to).first(),
      );
      return { customId: `f${String(i)}`, fingerprint, count: g.count, firstAt: g.firstAt, lastAt: g.lastAt, sample: sample.success ? sample.data : null };
    }),
  );
  return {
    requests: groups.map((g) => ({
      customId: g.customId,
      model: OPUS,
      system: SYSTEM,
      prompt: [
        `起きた回数: ${String(g.count)}`,
        `最初: ${jstDay(g.firstAt)} ${jstClock(g.firstAt)}、最後: ${jstDay(g.lastAt)} ${jstClock(g.lastAt)}`,
        g.sample ? `起きた所: ${g.sample.source} ${g.sample.route ?? ""} 種類 ${g.sample.code} 状態 ${String(g.sample.status ?? "")}` : "",
        g.sample ? `文: ${g.sample.message}` : "",
      ].join("\n"),
      maxTokens: MAX_TOKENS,
    })),
    detail: { groups: groups.map(({ customId, fingerprint, count, firstAt, lastAt }) => ({ customId, fingerprint, count, firstAt, lastAt })) },
  };
}

/**
 * 知らせる先のリポジトリを返す。形の違う値は使わない
 * @param env バインディング
 * @returns owner/name。決まっていなければ null
 */
function officeRepo(env: Bindings): string | null {
  const repo = env.OFFICE_REPO ?? "";
  return REPO_PATTERN.test(repo) ? repo : null;
}

/**
 * 返った答えで findings を数え直し、要る時は承認に上げ、batches の行を applied にする。同じ 1 回で書き、先に入れた方だけが Issue を作るか書き足す
 * @param env バインディング
 * @param deps 外へ頼む口
 * @param row batches の行
 * @param results バッチの結果
 * @param now 今の時刻
 */
async function apply(env: Bindings, deps: WeeklyDeps, row: BatchRow, results: BatchResult[], now: number): Promise<void> {
  const { groups } = Detail.parse(row.detail);
  const db = env.DB;
  const repo = officeRepo(env);
  const still = "EXISTS (SELECT 1 FROM batches WHERE id = ? AND status = 'submitted')";
  const answers = new Map(groups.map((g) => [g.fingerprint, answerOf(results.find((r) => r.customId === g.customId))]));
  const before = await findingsOf(env, groups.map((g) => g.fingerprint));
  const statements = groups.flatMap((g, i) => {
    const upsert = db
      .prepare(
        `INSERT INTO findings (id, fingerprint, repo, issue_number, kind, count, first_at, last_at, status, fixed_at, effect, claimed_at)
         SELECT ?, ?, ?, NULL, 'error', ?, ?, ?, 'open', NULL, NULL, NULL WHERE ${still}
         ON CONFLICT (fingerprint) DO UPDATE SET count = findings.count + excluded.count, last_at = max(findings.last_at, excluded.last_at), repo = coalesce(findings.repo, excluded.repo)`,
      )
      .bind(newId(clockAt(now + i)), g.fingerprint, repo, g.count, g.firstAt, g.lastAt, row.id);
    const needs = answers.get(g.fingerprint)?.needs ?? null;
    if (needs === null) return [upsert];
    // 決まるまで、同じ原因の同じ種類の承認を重ねて上げない
    const target = "(SELECT id FROM findings WHERE fingerprint = ?)";
    const ask = db
      .prepare(
        `INSERT INTO approvals (id, kind, target, payload, status, requested_by, requested_at, decided_at, reason)
         SELECT ?, ?, ${target}, ?, 'pending', 'reviewer', ?, NULL, NULL
         WHERE ${still} AND NOT EXISTS (SELECT 1 FROM approvals WHERE kind = ? AND target = ${target} AND status = 'pending')`,
      )
      .bind(newId(clockAt(now + i)), needs, g.fingerprint, JSON.stringify({ fingerprint: g.fingerprint, reason: answers.get(g.fingerprint)?.reason ?? "" }), now, row.id, needs, g.fingerprint);
    return [upsert, ask];
  });
  // Issue の無い原因には同じ 1 回で作る印を付ける。結果を入れた方が答えの手順で作り、その間に作り直しに来た定期ジョブは印を見て待つ。
  // 定期ジョブが先に印を持っている (新しい印がある) 原因は奪わず、その定期ジョブに作らせる
  const claim = db
    .prepare(
      `UPDATE findings SET claimed_at = ? WHERE fingerprint IN (${groups.map(() => "?").join(", ")}) AND issue_number IS NULL AND repo IS NOT NULL
       AND (claimed_at IS NULL OR claimed_at < ?) AND ${still}`,
    )
    .bind(now, ...groups.map((g) => g.fingerprint), now - STALE_CLAIM_MS, row.id);
  // usage は年ごとの記録の D1 にあり、batches と同じ 1 回の batch に入れられない。先に重ねない形で残し、落ちたら applied にせず次に読み直す
  await recordBatchUsage(env, row.batchId, results, row.createdAt);
  const done = db.prepare("UPDATE batches SET status = 'applied', ended_at = ? WHERE id = ? AND status = 'submitted'").bind(now, row.id);
  const written = await db.batch([...statements, claim, done]);
  if (written.at(-1)?.meta.changes !== 1) return;
  const after = await findingsOf(env, groups.map((g) => g.fingerprint));
  for (const g of groups) {
    const finding = after.get(g.fingerprint);
    if (!finding || finding.repo === null) continue;
    const answer = answers.get(g.fingerprint) ?? null;
    const had = before.get(g.fingerprint)?.issue_number ?? null;
    try {
      if (had === null) await ensureIssue(env, deps.tracker, finding, answer, { now, owned: true });
      else await deps.tracker.comment(finding.repo, had, weekComment(g.count, finding.count, answer));
    } catch (error) {
      await recordError(env, { source: "job", level: "error", code: "finding_issue_failed", error }, clockOf(now));
    }
  }
}

/**
 * 結果から答えを読む。失敗した物と形の違う物は null
 * @param result バッチの 1 件の結果
 * @returns 調べの答え
 */
function answerOf(result: BatchResult | undefined): FindingAnswer | null {
  if (!result || result.text === null) return null;
  const parsed = FindingAnswer.safeParse(answerJson(result.text));
  return parsed.success ? parsed.data : null;
}

/**
 * 指紋ごとの findings の行を読む
 * @param env バインディング
 * @param fingerprints 指紋
 * @returns 指紋から行
 */
async function findingsOf(env: Bindings, fingerprints: string[]): Promise<Map<string, FindingRow>> {
  if (fingerprints.length === 0) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT id, fingerprint, repo, issue_number, count, first_at, last_at FROM findings WHERE fingerprint IN (${fingerprints.map(() => "?").join(", ")})`,
  )
    .bind(...fingerprints)
    .all();
  return new Map(z.array(FindingRow).parse(results).map((r) => [r.fingerprint, r]));
}

/**
 * 1 つの原因の Issue を、無ければ作る。作る前に印を付け、同時に作る 2 つの片方だけが作る。前に作った Issue が本文の指紋で見つかれば作り直さない
 * @param env バインディング
 * @param tracker GitHub の Issue
 * @param finding findings の行
 * @param answer 調べの答え。無ければ手順を後で足す
 * @param claim 今の時刻と、結果を入れた時に付けた自分の印か
 * @param claim.now 今の時刻。印の値にもする
 * @param claim.owned true なら結果を入れた時に付けた印 (値は now) を引き継ぐ。false なら印の無い物か古い印の物だけを取る
 * @throws Error GitHub に届かない時。印は外す
 */
async function ensureIssue(env: Bindings, tracker: IssueTracker, finding: FindingRow, answer: FindingAnswer | null, claim: { now: number; owned: boolean }): Promise<void> {
  if (finding.repo === null) return;
  const now = claim.now;
  const claimed = claim.owned
    ? await env.DB.prepare("UPDATE findings SET claimed_at = ? WHERE id = ? AND issue_number IS NULL AND claimed_at = ?").bind(now, finding.id, now).run()
    : await env.DB.prepare("UPDATE findings SET claimed_at = ? WHERE id = ? AND issue_number IS NULL AND (claimed_at IS NULL OR claimed_at < ?)")
        .bind(now, finding.id, now - STALE_CLAIM_MS)
        .run();
  if (claimed.meta.changes !== 1) return;
  try {
    const number = (await tracker.findIssue(finding.repo, finding.fingerprint)) ?? (await tracker.createIssue(finding.repo, issueOf(finding, answer)));
    await env.DB.prepare("UPDATE findings SET issue_number = ?, claimed_at = NULL WHERE id = ? AND claimed_at = ?").bind(number, finding.id, now).run();
  } catch (error) {
    await env.DB.prepare("UPDATE findings SET claimed_at = NULL WHERE id = ? AND claimed_at = ?").bind(finding.id, now).run();
    throw error;
  }
}

/**
 * Issue の題と本文を作る。本文の終わりに指紋を隠して入れる
 * @param finding findings の行
 * @param answer 調べの答え
 * @returns 題と本文
 */
function issueOf(finding: FindingRow, answer: FindingAnswer | null): { title: string; body: string } {
  const title = answer?.title ?? `エラーの原因 ${finding.fingerprint.slice(0, 12)}`;
  const body = [
    "レビュー担当が記録から見つけた、同じ原因のエラー。",
    "",
    `- 起きた回数: ${String(finding.count)}`,
    `- 最初: ${jstDay(finding.first_at)} ${jstClock(finding.first_at)}、最後: ${jstDay(finding.last_at)} ${jstClock(finding.last_at)} (日本時間)`,
    "",
    "## 再現の手順",
    "",
    stepsOf(answer),
    ...(answer ? ["", "## 見立て", "", answer.reason] : []),
    "",
    fingerprintMark(finding.fingerprint),
  ].join("\n");
  return { title, body };
}

/**
 * 再現の手順を番号付きの並びにする
 * @param answer 調べの答え
 * @returns 手順の文
 */
function stepsOf(answer: FindingAnswer | null): string {
  if (!answer) return "再現の手順は次の調べで足す。";
  return answer.steps.map((s, i) => `${String(i + 1)}. ${s}`).join("\n");
}

/**
 * 同じ原因が続いた週に、Issue に書き足す文を作る
 * @param week この週の回数
 * @param total 合わせた回数
 * @param answer 調べの答え
 * @returns 書き足す文
 */
function weekComment(week: number, total: number, answer: FindingAnswer | null): string {
  return [`この週に ${String(week)} 回、合わせて ${String(total)} 回起きた。`, "", "## 再現の手順", "", stepsOf(answer)].join("\n");
}

/**
 * 時刻を Clock にする
 * @param now 時刻
 * @returns その時刻を返す Clock
 */
function clockOf(now: number): Clock {
  return { now: () => now };
}

/**
 * 前の回に作れなかった Issue を作る。手順は次の調べで足す
 * @param env バインディング
 * @param tracker GitHub の Issue
 * @param now 今の時刻
 */
export async function syncIssues(env: Bindings, tracker: IssueTracker, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, fingerprint, repo, issue_number, count, first_at, last_at FROM findings WHERE issue_number IS NULL AND repo IS NOT NULL AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY id",
  )
    .bind(now - STALE_CLAIM_MS)
    .all();
  for (const finding of z.array(FindingRow).parse(results)) {
    try {
      await ensureIssue(env, tracker, finding, null, { now, owned: false });
    } catch (error) {
      await recordError(env, { source: "job", level: "error", code: "finding_issue_failed", error }, clockOf(now));
    }
  }
}

/** 見つけて直す調べの週のバッチ処理 */
export const FINDINGS_JOB: WeeklyJob = { prepare, apply };
