// 見つけて直す調べ。前の週のエラー、遅い所、無駄な費用と、見つけた時の急ぐ故障を原因の指紋ごとにまとめてレビュー担当のモデルに送り、1 つの原因を 1 件の Issue にする (サービスと拡張の 3.7)
import { type Clock, FindingAnswer, jstClock, jstDay, newId, OPUS, redactPublic } from "@know-office/core";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { answerJson, type BatchRequest, type BatchResult, recordBatchUsage } from "../jobs/claude-batch.ts";
import type { BatchRow, WeekRange, WeeklyDeps, WeeklyJob } from "../jobs/weekly.ts";
import { BURST_LIMIT, BURST_WINDOW_MS, CLAUDE_FAILED, recordError } from "../ledger/errors.ts";
import { clockAt } from "../work/attendance.ts";
import { type RecordDb, recordDbs } from "./records.ts";
import { costSignals, type Signal, slowSignals } from "./slow-cost.ts";
import { fingerprintMark, type IssueTracker, publicTracker, REPO_PATTERN } from "./tracker.ts";

/** 1 度に送るエラーの原因の上限。多い順に送る */
const MAX_GROUPS = 100;

/** 答えの長さの上限 */
const MAX_TOKENS = 2000;

/** Issue を作る印を、作れずに残った物とみなすまでの間 */
const STALE_CLAIM_MS = 10 * 60_000;

/** 変わらない先頭の指示。毎回同じ文にして読み直しの割引に当てる */
const SYSTEM = [
  "あなたは know-office のレビュー担当。記録から見つけた 1 つの原因を読む。",
  "種類は、エラー (同じ原因の指紋を持つエラー)、遅い所 (目安を超えて遅いツールの呼び出し)、無駄な費用 (読み直しの割引が当たらなかった Claude の呼び出し) のどれか。急ぐ故障は、今まさに続いているエラー。",
  "開発担当が直せるように、Issue の題、steps、見立てを書く。steps は、エラーなら再現の手順、遅い所なら直す手順、無駄な費用なら設定や指示の文の直しの案にする。",
  "直すのに費用が増える事が要る時は needs を cost_increase、外のサービスとの新しい連携が要る時は external_integration、どちらも要らなければ null にする。",
  '答えは JSON だけで返す: {"title":"...","steps":["..."],"needs":null,"reason":"..."}',
].join("\n");

/** 原因の種類 */
const Kind = z.enum(["error", "slow", "cost"]);

/** batches の detail に置く、custom_id ごとの原因。urgent は見つけた時に調べた急ぐ故障 */
const Detail = z.object({
  urgent: z.boolean().default(false),
  groups: z.array(
    z.object({
      customId: z.string(),
      fingerprint: z.string(),
      kind: Kind.default("error"),
      count: z.number().int(),
      firstAt: z.number(),
      lastAt: z.number(),
      facts: z.array(z.string()).default([]),
    }),
  ),
});

/** detail の 1 つの原因 */
type DetailGroup = z.infer<typeof Detail>["groups"][number];

const Group = z.object({ fingerprint: z.string(), n: z.number().int(), first_at: z.number(), last_at: z.number() });
const Sample = z.object({ source: z.string(), code: z.string(), route: z.string().nullable(), status: z.number().nullable(), message: z.string() });
const FindingRow = z.object({
  id: z.string(),
  fingerprint: z.string(),
  repo: z.string().nullable(),
  issue_number: z.number().nullable(),
  kind: Kind,
  count: z.number(),
  first_at: z.number(),
  last_at: z.number(),
});

/** findings の行のうち、Issue に使う所 */
type FindingRow = z.infer<typeof FindingRow>;

/** 指紋ごとのエラーのまとまり */
type ErrorGroup = { fingerprint: string; count: number; firstAt: number; lastAt: number; sample: z.infer<typeof Sample> | null };

/** 種類ごとの、Claude に渡す名前と Issue の見出し */
const KINDS: Record<z.infer<typeof Kind>, { label: string; lead: string; steps: string }> = {
  error: { label: "エラー", lead: "レビュー担当が記録から見つけた、同じ原因のエラー。", steps: "再現の手順" },
  slow: { label: "遅い所", lead: "レビュー担当が記録から見つけた、遅い所。", steps: "直す手順" },
  cost: { label: "無駄な費用", lead: "レビュー担当が記録から見つけた、無駄な費用。", steps: "直しの案" },
};

/**
 * 期間のエラーを指紋ごとにまとめ、回数が下限を超えた物を多い順に返す。年をまたぐ期間は年ごとの記録を合わせる
 * @param env バインディング
 * @param from 始め
 * @param to 終わり。含まない
 * @param filter 数える条件
 * @param filter.over この回数を超えた物だけ。初期値は 0
 * @param filter.urgentOnly true なら、急ぐ故障に数える物 (error で、自分の通知を持つ種類でない物) だけ
 * @returns エラーのまとまりと、いちばん新しい 1 件
 */
async function errorGroups(env: Bindings, from: number, to: number, filter: { over?: number; urgentOnly?: boolean } = {}): Promise<ErrorGroup[]> {
  const where = filter.urgentOnly === true ? `AND level = 'error' AND code <> '${CLAUDE_FAILED}'` : "";
  const merged = new Map<string, { count: number; firstAt: number; lastAt: number; db: RecordDb }>();
  for (const db of recordDbs(env, from, to)) {
    const { results } = await db
      .prepare(`SELECT fingerprint, count(*) AS n, min(at) AS first_at, max(at) AS last_at FROM error_events WHERE at >= ? AND at < ? ${where} GROUP BY fingerprint`)
      .bind(from, to)
      .all();
    for (const g of z.array(Group).parse(results)) {
      const was = merged.get(g.fingerprint);
      merged.set(g.fingerprint, {
        count: (was?.count ?? 0) + g.n,
        firstAt: Math.min(was?.firstAt ?? g.first_at, g.first_at),
        lastAt: Math.max(was?.lastAt ?? g.last_at, g.last_at),
        db: g.last_at >= (was?.lastAt ?? 0) ? db : (was?.db ?? db),
      });
    }
  }
  const sorted = [...merged.entries()]
    .filter(([, g]) => g.count > (filter.over ?? 0))
    .toSorted(([fa, a], [fb, b]) => b.count - a.count || fa.localeCompare(fb))
    .slice(0, MAX_GROUPS);
  return Promise.all(
    sorted.map(async ([fingerprint, g]) => {
      const sample = Sample.safeParse(
        await g.db.prepare("SELECT source, code, route, status, message FROM error_events WHERE fingerprint = ? AND at < ? ORDER BY at DESC LIMIT 1").bind(fingerprint, to).first(),
      );
      return { fingerprint, count: g.count, firstAt: g.firstAt, lastAt: g.lastAt, sample: sample.success ? sample.data : null };
    }),
  );
}

/**
 * 1 つの原因の要求を作る。答えは Issue の文になるので、送る前に鍵、ID、メールを伏せ、答えに写させない
 * @param group 原因
 * @param lines 種類ごとの中身の行
 * @param urgent 急ぐ故障か
 * @returns 要求
 */
function requestOf(group: DetailGroup, lines: string[], urgent: boolean): BatchRequest {
  const label = urgent ? `急ぐ故障 (${KINDS[group.kind].label})` : KINDS[group.kind].label;
  const when = `最初: ${jstDay(group.firstAt)} ${jstClock(group.firstAt)}、最後: ${jstDay(group.lastAt)} ${jstClock(group.lastAt)}`;
  return { customId: group.customId, model: OPUS, system: SYSTEM, prompt: redactPublic([`種類: ${label}`, ...lines, when].join("\n")), maxTokens: MAX_TOKENS };
}

/**
 * エラーのまとまりを、detail の原因と Claude に渡す行にする
 * @param g エラーのまとまり
 * @param customId custom_id
 * @returns 原因と行
 */
function errorEntry(g: ErrorGroup, customId: string): { group: DetailGroup; lines: string[] } {
  const lines = [
    `起きた回数: ${String(g.count)}`,
    g.sample ? `起きた所: ${g.sample.source} ${g.sample.route ?? ""} 種類 ${g.sample.code} 状態 ${String(g.sample.status ?? "")}` : "",
    g.sample ? `文: ${g.sample.message}` : "",
  ];
  return { group: { customId, fingerprint: g.fingerprint, kind: "error", count: g.count, firstAt: g.firstAt, lastAt: g.lastAt, facts: [] }, lines };
}

/**
 * 遅い所か無駄な費用を、detail の原因と Claude に渡す行にする
 * @param s 遅い所か無駄な費用
 * @param customId custom_id
 * @returns 原因と行
 */
function signalEntry(s: Signal, customId: string): { group: DetailGroup; lines: string[] } {
  return { group: { customId, fingerprint: s.fingerprint, kind: s.kind, count: s.count, firstAt: s.firstAt, lastAt: s.lastAt, facts: s.facts }, lines: s.facts };
}

/**
 * 前の週のエラー (f)、遅い所 (s)、無駄な費用 (c) を原因ごとにまとめ、送る物を作る
 * @param env バインディング
 * @param range 前の週
 * @returns 原因ごとの要求と、custom_id から原因への対応。どれも無ければ null
 */
async function prepare(env: Bindings, range: WeekRange): Promise<{ requests: BatchRequest[]; detail: z.input<typeof Detail> } | null> {
  const entries = [
    ...(await errorGroups(env, range.from, range.to)).map((g, i) => errorEntry(g, `f${String(i)}`)),
    ...(await slowSignals(env, range)).map((s, i) => signalEntry(s, `s${String(i)}`)),
    ...(await costSignals(env, range)).map((s, i) => signalEntry(s, `c${String(i)}`)),
  ];
  if (entries.length === 0) return null;
  return { requests: entries.map((e) => requestOf(e.group, e.lines, false)), detail: { urgent: false, groups: entries.map((e) => e.group) } };
}

/** 急ぐ故障の調べを 1 回に送る原因の上限。多い順に送る */
const URGENT_PER_RUN = 3;

/** 急ぐ故障の調べを 1 日に送るバッチの上限 */
export const URGENT_PER_DAY = 10;

/**
 * 直前の 5 分に同じ原因のエラーが 3 回を超えた急ぐ故障を、多い順に 3 原因まで、原因ごとに 1 つのバッチにする物を作る。5 分ごとの定期ジョブが呼ぶ。
 * 費用が出るので、オーナーの はい の後に URGENT_SCAN を on にした時と、Issue を置くリポジトリが決まっている時だけ作る
 * @param env バインディング
 * @param now 今の時刻
 * @returns 原因ごとの、その日のうちに重ねないための鍵と送る物と、1 日の数を数える鍵の頭
 */
export async function urgentBatches(env: Bindings, now: number): Promise<{ key: string; day: string; requests: BatchRequest[]; detail: z.input<typeof Detail> }[]> {
  if (env.URGENT_SCAN !== "on" || officeRepo(env) === null) return [];
  // 通知 (error_burst) と同じ 5 分に 3 回を超えた物。今の時刻ちょうどの物まで含める
  const groups = (await errorGroups(env, now - BURST_WINDOW_MS, now + 1, { over: BURST_LIMIT, urgentOnly: true })).slice(0, URGENT_PER_RUN);
  return groups.map((g) => {
    const { group, lines } = errorEntry(g, "u0");
    return { key: `${jstDay(now)}:${g.fingerprint}`, day: `${jstDay(now)}:`, requests: [requestOf(group, lines, true)], detail: { urgent: true, groups: [group] } };
  });
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
 * 返った答えで findings を数え直し、要る時は承認に上げ、batches の行を applied にする。同じ 1 回で書き、先に入れた方だけが Issue を作るか書き足す。
 * 急ぐ故障の回数は週の調べが同じエラーを数え直すので、findings の回数に足さない
 * @param env バインディング
 * @param deps 外へ頼む口
 * @param row batches の行
 * @param results バッチの結果
 * @param now 今の時刻
 */
async function apply(env: Bindings, deps: WeeklyDeps, row: BatchRow, results: BatchResult[], now: number): Promise<void> {
  const { groups, urgent } = Detail.parse(row.detail);
  const db = env.DB;
  const repo = officeRepo(env);
  const tracker = publicTracker(deps.tracker);
  const still = "EXISTS (SELECT 1 FROM batches WHERE id = ? AND status = 'submitted')";
  const answers = new Map(groups.map((g) => [g.fingerprint, answerOf(results.find((r) => r.customId === g.customId))]));
  const before = await findingsOf(env, groups.map((g) => g.fingerprint));
  const onConflict = urgent
    ? "repo = coalesce(findings.repo, excluded.repo)"
    : "count = findings.count + excluded.count, last_at = max(findings.last_at, excluded.last_at), repo = coalesce(findings.repo, excluded.repo)";
  const statements = groups.flatMap((g, i) => {
    const upsert = db
      .prepare(
        `INSERT INTO findings (id, fingerprint, repo, issue_number, kind, count, first_at, last_at, status, fixed_at, effect, claimed_at)
         SELECT ?, ?, ?, NULL, ?, ?, ?, ?, 'open', NULL, NULL, NULL WHERE ${still}
         ON CONFLICT (fingerprint) DO UPDATE SET ${onConflict}`,
      )
      .bind(newId(clockAt(now + i)), g.fingerprint, repo, g.kind, urgent ? 0 : g.count, g.firstAt, g.lastAt, row.id);
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
    // 急ぐ故障の Issue には、findings に足さなかったこの回の回数と時刻を書く
    const shown = urgent ? { ...finding, count: g.count, first_at: g.firstAt, last_at: g.lastAt } : finding;
    try {
      if (had === null) await ensureIssue(env, tracker, shown, answer, { now, owned: true }, { facts: g.facts, urgent });
      else await tracker.comment(finding.repo, had, urgent ? urgentComment(g.count, answer) : weekComment(g, finding.count, answer));
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
    `SELECT id, fingerprint, repo, issue_number, kind, count, first_at, last_at FROM findings WHERE fingerprint IN (${fingerprints.map(() => "?").join(", ")})`,
  )
    .bind(...fingerprints)
    .all();
  return new Map(z.array(FindingRow).parse(results).map((r) => [r.fingerprint, r]));
}

/** Issue の本文に足す物 */
type IssueExtra = {
  /** 遅い所と無駄な費用の根拠の行 */
  facts: string[];
  /** 急ぐ故障か */
  urgent: boolean;
};

/**
 * 1 つの原因の Issue を、無ければ作る。作る前に印を付け、同時に作る 2 つの片方だけが作る。前に作った Issue が本文の指紋で見つかれば作り直さない
 * @param env バインディング
 * @param tracker GitHub の Issue。伏せる口で包んだ物
 * @param finding findings の行
 * @param answer 調べの答え。無ければ手順を後で足す
 * @param claim 今の時刻と、結果を入れた時に付けた自分の印か
 * @param claim.now 今の時刻。印の値にもする
 * @param claim.owned true なら結果を入れた時に付けた印 (値は now) を引き継ぐ。false なら印の無い物か古い印の物だけを取る
 * @param extra 根拠の行と、急ぐ故障か
 * @throws Error GitHub に届かない時。印は外す
 */
async function ensureIssue(
  env: Bindings,
  tracker: IssueTracker,
  finding: FindingRow,
  answer: FindingAnswer | null,
  claim: { now: number; owned: boolean },
  extra: IssueExtra = { facts: [], urgent: false },
): Promise<void> {
  if (finding.repo === null) return;
  const now = claim.now;
  const claimed = claim.owned
    ? await env.DB.prepare("UPDATE findings SET claimed_at = ? WHERE id = ? AND issue_number IS NULL AND claimed_at = ?").bind(now, finding.id, now).run()
    : await env.DB.prepare("UPDATE findings SET claimed_at = ? WHERE id = ? AND issue_number IS NULL AND (claimed_at IS NULL OR claimed_at < ?)")
        .bind(now, finding.id, now - STALE_CLAIM_MS)
        .run();
  if (claimed.meta.changes !== 1) return;
  try {
    const number = (await tracker.findIssue(finding.repo, finding.fingerprint)) ?? (await tracker.createIssue(finding.repo, issueOf(finding, answer, extra)));
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
 * @param extra 根拠の行と、急ぐ故障か
 * @returns 題と本文
 */
function issueOf(finding: FindingRow, answer: FindingAnswer | null, extra: IssueExtra): { title: string; body: string } {
  const kind = KINDS[finding.kind];
  const title = answer?.title ?? `${kind.label}の原因 ${finding.fingerprint.slice(0, 12)}`;
  const when = `- 最初: ${jstDay(finding.first_at)} ${jstClock(finding.first_at)}、最後: ${jstDay(finding.last_at)} ${jstClock(finding.last_at)} (日本時間)`;
  const body = [
    ...(extra.urgent ? ["急ぐ故障として、見つけた時に調べた。", ""] : []),
    kind.lead,
    "",
    ...(finding.kind === "error" ? [`- 起きた回数: ${String(finding.count)}`] : []),
    when,
    ...(extra.facts.length > 0 ? ["", ...extra.facts] : []),
    "",
    `## ${kind.steps}`,
    "",
    stepsOf(finding.kind, answer),
    ...(answer ? ["", "## 見立て", "", answer.reason] : []),
    "",
    fingerprintMark(finding.fingerprint),
  ].join("\n");
  return { title, body };
}

/**
 * 手順を番号付きの並びにする
 * @param kind 原因の種類
 * @param answer 調べの答え
 * @returns 手順の文
 */
function stepsOf(kind: z.infer<typeof Kind>, answer: FindingAnswer | null): string {
  if (!answer) return `${KINDS[kind].steps}は次の調べで足す。`;
  return answer.steps.map((s, i) => `${String(i + 1)}. ${s}`).join("\n");
}

/**
 * 同じ原因が続いた週に、Issue に書き足す文を作る
 * @param group この週の原因
 * @param total 合わせた回数
 * @param answer 調べの答え
 * @returns 書き足す文
 */
function weekComment(group: DetailGroup, total: number, answer: FindingAnswer | null): string {
  const kind = KINDS[group.kind];
  return [`この週に ${String(group.count)} 回、合わせて ${String(total)} 回起きた。`, ...(group.facts.length > 0 ? ["", ...group.facts] : []), "", `## ${kind.steps}`, "", stepsOf(group.kind, answer)].join(
    "\n",
  );
}

/**
 * 急ぐ故障が、もう Issue のある原因で起きた時に書き足す文を作る
 * @param count 直前の 5 分の回数
 * @param answer 調べの答え
 * @returns 書き足す文
 */
function urgentComment(count: number, answer: FindingAnswer | null): string {
  return [`急ぐ故障として、見つけた時に調べた。直前の 5 分に ${String(count)} 回起きた。`, "", `## ${KINDS.error.steps}`, "", stepsOf("error", answer)].join("\n");
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
 * 前の回に作れなかった Issue を作る。手順と根拠は次の調べで足す
 * @param env バインディング
 * @param tracker GitHub の Issue
 * @param now 今の時刻
 */
export async function syncIssues(env: Bindings, tracker: IssueTracker, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, fingerprint, repo, issue_number, kind, count, first_at, last_at FROM findings WHERE issue_number IS NULL AND repo IS NOT NULL AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY id",
  )
    .bind(now - STALE_CLAIM_MS)
    .all();
  for (const finding of z.array(FindingRow).parse(results)) {
    try {
      await ensureIssue(env, publicTracker(tracker), finding, null, { now, owned: false });
    } catch (error) {
      await recordError(env, { source: "job", level: "error", code: "finding_issue_failed", error }, clockOf(now));
    }
  }
}

/** 見つけて直す調べの週のバッチ処理 */
export const FINDINGS_JOB: WeeklyJob = { prepare, apply };

/** 急ぐ故障のバッチ処理。始めるのは 5 分ごとの定期ジョブ (urgentBatches) で、結果の入れ方は週の調べと同じ */
export const URGENT_JOB: WeeklyJob = { prepare: () => Promise.resolve(null), apply };
