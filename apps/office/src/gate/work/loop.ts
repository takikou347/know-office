// タスクの繰り返し。社員が自分の山から 1 つ取り、空なら上司に求め、終えたら次を取る (タスクとレビューの 3.1)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, jstDay, type ReleaseCondition, type ReviewFileStatus, StaffId, type StaffStatus, type StaffTask, type WorkResult } from "@know-office/core";
import { and, asc, desc, eq, exists, gte, inArray, not, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { approvals, nodes, staff, workEntries } from "../db/main.ts";
import { type DevIssues, UNCONNECTED_DEV_ISSUES } from "../devloop/dev-issues.ts";
import type { Bindings, Staff } from "../env.ts";
import { type Actor, appendNodeEvent, createNode, findNode, intakeProject, moveNode, type NodeRow, revertNode } from "./nodes.ts";

/** 2 つのコミットの間で変わった 1 ファイル。patch は統一形式の差分の本文で、GitHub が大きすぎて返さない時は null */
export type ChangedFile = { path: string; previousPath?: string; status: ReviewFileStatus; patch: string | null };

/** コミットのチェックの今。通った、待っている (走っている、まだ無い、読み切れない)、落ちた */
export type CheckState = "passed" | "pending" | "failed";

/** GitHub を呼ぶ口。鍵は github/app.ts が vault の App の鍵から作る (タスクとレビューの 3.3、3.4) */
export type Forge = {
  /** ブランチから main へのプルリクエストを出す */
  openPull(input: { repo: string; branch: string; title: string; body: string }): Promise<{ number: number; baseSha: string; headSha: string }>;
  /** コミットのチェックの今。すべて通れば passed、1 つでも落ちていれば failed、ほかは pending。sha は確かめたコミット */
  checkState(repo: string, sha: string): Promise<CheckState>;
  /** main を確かめたコミットへ fast-forward で進める。進めたら merged、main が先に進んでいて進められなければ behind (作った社員が rebase する)。branch は記録と代わりの GitHub のために渡す。ほかの断りは upstream_failed */
  merge(repo: string, head: { branch: string; sha: string }): Promise<"merged" | "behind">;
  /** main が、そのコミットを含むか。main に入った事を、閉じる前に確かめる */
  inMain(repo: string, sha: string): Promise<boolean>;
  /** main からブランチかコミット (head) までに変わったファイル。動かしたファイルは前の道も入れる。多すぎて全部を読めない時は null */
  changedPaths(repo: string, head: string): Promise<string[] | null>;
  /** 公開のリポジトリの既定のブランチに、main に入れる条件と同じルールセットを掛ける。非公開なら何もせず private を返す */
  protectMain(repo: string, when: readonly ReleaseCondition[]): Promise<"applied" | "private">;
  /** GitHub とつないでいるか。つないでいない間はルールセットを掛ける先が無い。vault を読むまで分からないので待つ */
  connected(): Promise<boolean>;
  /** プルリクエストに可か不可のレビューを出し、GitHub のレビューの ID を返す。App が出したプルリクエストで GitHub が断る時は、判断を本文の頭に書いたコメントにする */
  postReview(repo: string, pr: number, review: { event: "APPROVE" | "REQUEST_CHANGES"; body: string; commitId: string }): Promise<number>;
  /** コミットに know-office のオーナーの判断のステータスを出し、GitHub のステータスの ID を返す。同じ名前のステータスは GitHub が新しい物を今の値にする */
  postStatus(repo: string, sha: string, status: { state: "success" | "failure"; description: string }): Promise<number>;
  /** プルリクエストの 1 行にコメントを付け、GitHub のコメントの ID を返す。side は LEFT (前) か RIGHT (後) */
  postComment(repo: string, pr: number, comment: { body: string; path: string; line: number; side: "LEFT" | "RIGHT"; commitId: string }): Promise<number>;
  /** 本文に目印を含む、know-office が写したレビューか行のコメントを GitHub の一覧から探し、その ID を返す。無ければ null */
  findMirror(repo: string, pr: number, kind: "review" | "comment", marker: string): Promise<number | null>;
  /** ブランチに 1 ファイルを書き換えたコミットを足し、その sha を返す。parent はブランチの今の先で、先が進んでいれば conflict で断る。mode は今のファイルから引き継ぎ、シンボリックリンクとサブモジュールは rule_denied で断る */
  commitFile(repo: string, branch: string, change: { parent: string; path: string; content: string; message: string }): Promise<string>;
  /** プルリクエストで変わったファイルを、差分の本文と一緒に全部返す。pull_requests の読みだけに絞った鍵でページを回して読み、上限の 3,000 件に届けば upstream_failed で断る */
  pullFiles(repo: string, pr: number): Promise<ChangedFile[]>;
  /** base から head までに変わったファイルを、差分の本文と一緒に返す。contents の読みだけに絞った鍵で 1 回だけ読む。GitHub は 300 件で切るので、300 件ちょうどなら truncated */
  compare(repo: string, base: string, head: string): Promise<{ files: ChangedFile[]; truncated: boolean }>;
  /** コミット ref のファイルの中身を返す。無いか、ファイルでなければ null */
  readFile(repo: string, ref: string, path: string): Promise<string | null>;
  /** リポジトリの既定のブランチで、.github/workflows/ の workflow を動かし、動かしたブランチを返す。actions の書きだけに絞った鍵で送る */
  dispatchWorkflow(repo: string, workflow: string, inputs: Record<string, string>): Promise<string>;
  /** 既定のブランチの先のコミット */
  defaultHead(repo: string): Promise<string>;
  /** ブランチの先のコミット。設計書の PR を確かめる時に、変えたファイルと中身を同じコミットで読むために固定する */
  branchHead(repo: string, branch: string): Promise<string>;
  /** コミット ref の木のうち、prefix の下のファイルの道 (リポジトリの頭から) を返す。GitHub が木を切った時と、500 件を超えた時は null */
  listFiles(repo: string, ref: string, prefix: string): Promise<string[] | null>;
  /** 設計書から作る Issue の口。issue_plan だけが使う */
  issues: DevIssues;
};

/** まだつないでいない口。GitHub を呼ぶ操作は upstream_failed で断る */
export const UNCONNECTED_FORGE: Forge = {
  openPull: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  checkState: () => Promise.resolve("pending"),
  merge: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  inMain: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  changedPaths: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  protectMain: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  connected: () => Promise.resolve(false),
  postReview: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  postComment: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  postStatus: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  commitFile: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  findMirror: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  pullFiles: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  compare: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  readFile: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  dispatchWorkflow: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  defaultHead: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  branchHead: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  listFiles: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  issues: UNCONNECTED_DEV_ISSUES,
};

/** 社員 DO の中で次のタスクを取るのに使う、勤務の本の口 */
export type TaskBook = {
  /** 社員 ID */
  readonly staffId: StaffId;
  /** 今の状態 */
  status(now: number): Promise<StaffStatus>;
  /** タスクを取るかを決める */
  take(task: unknown, medianMs: number | null, now: number): Promise<{ taken: boolean }>;
};

/** 次のタスクを取った結果。nodeId は取ったか、もう持っていたタスク */
export type Pulled = { taken: boolean; nodeId: string | null };

/** 社員 DO の中で取った結果。carried は前の勤務で続きにしたタスクを取った時に true で、呼び出しを会話の記録の続きから始める */
export type PulledNext = Pulled & { carried: boolean };

/**
 * 社員 DO を返す
 * @param env バインディング
 * @param staffId 社員 ID
 * @returns StaffDO の RPC
 */
export function staffDo(env: Bindings, staffId: string): Staff {
  return env.STAFF.get(env.STAFF.idFromName(staffId));
}

/**
 * 社員がそのタスクを前の勤務で続きにしたか (その社員の最後のした仕事が continued か) の式。1 か 0
 * @param staffId 社員 ID
 * @param nodeId タスク ID の列
 * @returns SQL の式
 */
function carriedBy(staffId: string, nodeId: SQLWrapper): SQL<number> {
  const last = sql`(SELECT ${workEntries.result} FROM ${workEntries} WHERE ${workEntries.nodeId} = ${nodeId} AND ${workEntries.staffId} = ${staffId} ORDER BY ${workEntries.endedAt} DESC, ${workEntries.id} DESC LIMIT 1)`;
  return sql<number>`coalesce(${last} = 'continued', 0)`.mapWith(Number);
}

/**
 * 社員が前の勤務で続きにしたタスクかを読む。続きにしたタスクは、呼び出しを最後の会話の記録から始める
 * @param env バインディング
 * @param staffId 社員 ID
 * @param nodeId タスク ID
 * @returns 続きにしたタスクなら true
 */
export async function wasCarried(env: Bindings, staffId: string, nodeId: string): Promise<boolean> {
  const [row] = await drizzle(env.DB).select({ carried: carriedBy(staffId, nodes.id) }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  return row?.carried === 1;
}

/**
 * 子 Issue のタスクが、同じリポジトリの doing か review の子と触るファイルが重ならない事の条件。重なりは glob の固定の頭 (dev_issues.heads) で比べ、
 * どちらかの頭が他方の頭で始まれば重なる。頭が空か、heads の無い行はすべてと重なる (開発の回し方の 3.5)。dev_issues を持たないタスク (設計書、レビュー) とは比べない
 * @param self 取るタスクの、リポジトリと Issue の番号と ID を指す式
 * @param self.repo リポジトリ
 * @param self.issue Issue の番号
 * @param self.id タスク ID
 * @returns SQL の条件
 */
function noOverlap(self: { repo: SQLWrapper; issue: SQLWrapper; id: SQLWrapper }): SQL {
  return not(
    exists(sql`(
      SELECT 1 FROM nodes o
      JOIN dev_issues oi ON oi.repo = o.repo AND oi.number = o.issue_number AND oi.kind = 'child' AND o.source = 'issue:' || oi.number
      JOIN dev_issues mi ON mi.repo = ${self.repo} AND mi.number = ${self.issue} AND mi.kind = 'child',
      json_each(coalesce(oi.heads, '[""]')) a, json_each(coalesce(mi.heads, '[""]')) b
      WHERE o.repo = ${self.repo} AND o.status IN ('doing', 'review') AND o.id <> ${self.id}
        AND (a.value = '' OR b.value = '' OR substr(a.value, 1, length(b.value)) = b.value OR substr(b.value, 1, length(a.value)) = a.value))`),
  );
}

/**
 * 社員の次の todo のタスクを 1 つ読む。前の勤務で続きにしたタスク (この社員の最後のした仕事が continued) を先に、ほかは優先度の小さい順、作った順。
 * 触るファイルが doing か review の子と重なる子 Issue のタスクは飛ばす
 * @param env バインディング
 * @param staffId 社員 ID
 * @returns タスクと、続きにしたタスクか。無ければ undefined
 */
async function nextTodo(env: Bindings, staffId: string): Promise<{ row: NodeRow; carried: boolean } | undefined> {
  // 副問い合わせの中で外の nodes を指すので、列は表の名前を付けて書く (drizzle は 1 つの表の問い合わせでは列に表の名前を付けない)
  const carried = carriedBy(staffId, nodes.id);
  const [found] = await drizzle(env.DB)
    .select({ row: nodes, carried })
    .from(nodes)
    .where(and(eq(nodes.kind, "task"), eq(nodes.assignee, staffId), eq(nodes.status, "todo"), noOverlap({ repo: sql.raw('"nodes"."repo"'), issue: sql.raw('"nodes"."issue_number"'), id: sql.raw('"nodes"."id"') })))
    .orderBy(desc(carried), asc(nodes.priority), asc(nodes.createdAt), asc(nodes.id))
    .limit(1);
  return found ? { row: found.row, carried: found.carried === 1 } : undefined;
}

/**
 * 社員に todo のタスクが 1 つでもあるか。重なりで飛ばされた物も数える
 * @param env バインディング
 * @param staffId 社員 ID
 * @returns あれば true
 */
async function hasTodo(env: Bindings, staffId: string): Promise<boolean> {
  const [found] = await drizzle(env.DB).select({ id: nodes.id }).from(nodes).where(and(eq(nodes.kind, "task"), eq(nodes.assignee, staffId), eq(nodes.status, "todo"))).limit(1);
  return found !== undefined;
}

/**
 * タスクを doing に取る。読んだ時から版が進んでいれば取らない。子 Issue のタスクは、同じ文の中で重なる doing か review の子が無い事も確かめる。
 * 同時に重なる 2 つが取りに来ても、書きは 1 つずつなので、後から書く方は先の doing を見て取れない
 * @param env バインディング
 * @param row 読んだ時のタスクの行
 * @param now 今の時刻
 * @returns 取った行。取れなければ null
 */
export async function claimNode(env: Bindings, row: NodeRow, now: number): Promise<NodeRow | null> {
  if (row.issueNumber === null || row.repo === null) return moveNode(env.DB, row, "doing", now);
  const done = await drizzle(env.DB)
    .update(nodes)
    .set({ status: "doing", version: row.version + 1, updatedAt: now })
    .where(and(eq(nodes.id, row.id), eq(nodes.version, row.version), eq(nodes.status, "todo"), noOverlap({ repo: sql`${row.repo}`, issue: sql`${row.issueNumber}`, id: sql`${row.id}` })))
    .returning({ id: nodes.id });
  return done.length > 0 ? { ...row, status: "doing", version: row.version + 1, updatedAt: now } : null;
}

/**
 * 社員 DO に渡すタスクの形にする
 * @param row タスクの行
 * @param promptVersion 始めた時の役目の説明文の版
 * @returns StaffTask
 */
function taskOf(row: NodeRow, promptVersion: number | undefined): StaffTask {
  return { nodeId: row.id, title: row.title, scope: row.scope, ...(promptVersion === undefined ? {} : { promptVersion }) };
}

/**
 * タスクを doing にしてから社員に渡し、始めた時の役目の説明文の版と直近の承認の答えを出来事に残す。役目の説明文は次のタスクから効くので、版はここで決まる
 * @param env バインディング
 * @param staffId 社員 ID
 * @param row 読んだ時のタスクの行
 * @param now 今の時刻
 * @param hand 社員に渡す。受け取ったかを返す
 * @returns 始めたら started。読んでから担当か状態が変わったか、重なる子ができて取れなければ lost、社員が受け取らなければ refused
 */
async function start(env: Bindings, staffId: string, row: NodeRow, now: number, hand: (task: StaffTask) => Promise<boolean>): Promise<"started" | "lost" | "refused"> {
  // 読んでからオーナーが担当を変えるとバージョンが進むので、先に doing にして取れた時だけ渡す。2 人が同じタスクを取らない
  const claimed = await claimNode(env, row, now);
  if (!claimed) return "lost";
  // 版は渡す前に読み、社員 DO の記憶にタスクと一緒に置く。続きの呼び出しもこの版で呼ぶ
  const [who] = await drizzle(env.DB).select({ promptVersion: staff.promptVersion }).from(staff).where(eq(staff.id, staffId)).limit(1);
  let handed = false;
  try {
    handed = await hand(taskOf(claimed, who?.promptVersion));
  } finally {
    if (!handed) await revertNode(env.DB, claimed.id, "doing", "todo", now);
  }
  if (!handed) return "refused";
  // 承認を待って戻ったタスクは、直近の答え (承認か差し戻しと理由) をタスクの文脈に入れ、社員が読んで続ける
  const [answer] = await drizzle(env.DB)
    .select({ id: approvals.id, kind: approvals.kind, status: approvals.status, reason: approvals.reason })
    .from(approvals)
    .where(and(sql`json_extract(${approvals.payload}, '$.nodeId') = ${row.id}`, inArray(approvals.status, ["approved", "rejected"])))
    .orderBy(desc(approvals.decidedAt), desc(approvals.id))
    .limit(1);
  const detail = { promptVersion: who?.promptVersion ?? null, ...(answer ? { approval: answer } : {}) };
  await appendNodeEvent(env, { nodeId: row.id, staffId, kind: "started", detail }, { by: staffId, now });
  return "started";
}

/** 重なる子が先に doing になって取れなかった時に、次の候補を選び直す回数の上限 */
const PULL_TRIES = 3;

/** 早い退勤の中央値に使う、直前の日数 */
const MEDIAN_DAYS = 7;
const DAY_MS = 24 * 3_600_000;
/** 中央値に読むした仕事の行の上限。1 日 8 時間で 1 分ずつ区切っても届かない */
const MEDIAN_ROWS = 4_000;

/**
 * 同じ社員の同じ種類のタスクが、チェックポイントか終わりに届くまでに働いた時間の、直前 7 日の中央値を出す
 * した仕事は終えた時 (done) とチェックポイントで退勤して続けた時 (continued) に区切るので、その行の働いた時間を使う
 * @param db 今の状態の D1
 * @param staffId 社員 ID
 * @param taskKind タスクの種類。無ければ null を返す
 * @param now 今の時刻
 * @returns 中央値。行が無ければ null
 */
async function recentMedian(db: D1Database, staffId: string, taskKind: NodeRow["taskKind"], now: number): Promise<number | null> {
  if (taskKind === null) return null;
  const found = await drizzle(db)
    .select({ activeMs: workEntries.activeMs })
    .from(workEntries)
    .innerJoin(nodes, eq(nodes.id, workEntries.nodeId))
    .where(
      and(
        eq(workEntries.staffId, staffId),
        eq(nodes.taskKind, taskKind),
        inArray(workEntries.result, ["done", "continued"]),
        // 日で索引を使って絞り、終えた時刻で 7 日ちょうどに切る
        gte(workEntries.day, jstDay(now - MEDIAN_DAYS * DAY_MS)),
        gte(workEntries.endedAt, now - MEDIAN_DAYS * DAY_MS),
      ),
    )
    .orderBy(asc(workEntries.activeMs))
    .limit(MEDIAN_ROWS);
  if (found.length === 0) return null;
  const mid = Math.floor(found.length / 2);
  const at = (i: number) => found[i]?.activeMs ?? 0;
  return found.length % 2 === 1 ? at(mid) : Math.round((at(mid - 1) + at(mid)) / 2);
}

/**
 * 勤務中で手が空いていれば、自分の山から 1 つ取って doing にする。山が空なら上司に次を求める。社員 DO の鎖の中で呼ぶ
 * @param env バインディング
 * @param book 勤務の本
 * @param now 今の時刻
 * @returns 取ったか
 */
export async function pullNext(env: Bindings, book: TaskBook, now: number): Promise<PulledNext> {
  const status = await book.status(now);
  if (status.state !== "working" || status.nodeId !== null) return { taken: false, nodeId: status.nodeId, carried: false };
  // 読んだ後に重なる子が doing になって取れなかった時は、次の候補を選び直す。選び直しは 3 回まで
  for (let attempt = 0; attempt < PULL_TRIES; attempt += 1) {
    const next = await nextTodo(env, book.staffId);
    if (!next) {
      // 重なりで飛ばした todo が残っている間は、山が空ではない。上司に求めず、重なっていた作業が出るのを待つ
      if (!(await hasTodo(env, book.staffId))) await askBoss(env, book.staffId, "山が空になった", now);
      return { taken: false, nodeId: null, carried: false };
    }
    const { row, carried } = next;
    const medianMs = await recentMedian(env.DB, book.staffId, row.taskKind, now);
    const started = await start(env, book.staffId, row, now, async (task) => (await book.take(task, medianMs, now)).taken);
    if (started === "started") return { taken: true, nodeId: row.id, carried };
    if (started === "refused") break;
  }
  return { taken: false, nodeId: null, carried: false };
}

/**
 * 社員にタスクが来た事を知らせる。勤務時間外で呼び出してよい時は呼び出し、勤務中で手が空いていれば次のタスクを取らせる
 * @param env バインディング
 * @param staffId 社員 ID
 * @param now 今の時刻
 * @param call 勤務時間外なら呼び出すか。オーナーが頼んだ時だけ true
 * @param traceId 頼んだ要求の traceId。始めた呼び出しを同じ流れで追える
 */
export async function notifyStaff(env: Bindings, staffId: string, now: number, call: boolean, traceId?: string): Promise<void> {
  const id = StaffId.safeParse(staffId);
  if (!id.success) return;
  const target = staffDo(env, id.data);
  const status = await target.status(now);
  if (status.state === "working" && status.nodeId === null) {
    await target.pull(now, traceId);
    return;
  }
  if (status.state !== "off" || !call) return;
  const next = await nextTodo(env, id.data);
  if (!next) return;
  // 社員 DO が呼び出さなかった時 (退勤していなかった時) は、start がタスクを todo に戻す
  await start(env, id.data, next.row, now, (task) => target.call(task, now, traceId));
}

/**
 * 時間外に話しかけた時に、退勤している社員に次のタスクを取らせて呼び出す。発言は最初の呼び出しの頭で渡る
 * 取るタスクが無い時と、社員 DO が 1 日の回数の上限で断った時は呼び出さず、タスクを todo に戻す
 * @param env バインディング
 * @param staffId 社員 ID
 * @param now 今の時刻
 * @param perDay 社員ごとの 1 日の回数
 * @param traceId 話しかけた要求の traceId
 * @returns 呼び出したか
 */
export async function callForMessage(env: Bindings, staffId: StaffId, now: number, perDay: number, traceId?: string): Promise<boolean> {
  const next = await nextTodo(env, staffId);
  if (!next) return false;
  const target = staffDo(env, staffId);
  return start(env, staffId, next.row, now, (task) => target.call(task, now, traceId, { perDay }));
}

/**
 * 上司に次のタスクを求める。上司に、部下の次のタスクを作る plan のタスクを足す。同じ部下の plan のタスクが開いていれば足さない
 * @param env バインディング
 * @param staffId 求める社員
 * @param reason 理由
 * @param now 今の時刻
 * @returns 上司の plan のタスク。上司がいなければ null
 */
export async function askBoss(env: Bindings, staffId: string, reason: string, now: number): Promise<NodeRow | null> {
  const orm = drizzle(env.DB);
  const [me] = await orm.select({ role: staff.role, bossId: staff.bossId }).from(staff).where(eq(staff.id, staffId)).limit(1);
  const boss = StaffId.safeParse(me?.bossId);
  if (!me || !boss.success) return null;
  const source = `ask_boss:${staffId}`;
  const [open] = await orm
    .select()
    .from(nodes)
    .where(and(eq(nodes.assignee, boss.data), eq(nodes.source, source), inArray(nodes.status, ["todo", "doing", "waiting_owner"])))
    .limit(1);
  if (open) return open;
  const actor: Actor = { by: staffId, now };
  const project = await intakeProject(env, "office", actor);
  const row = await createNode(
    env,
    { kind: "task", parentId: project.id, scope: "office", title: `${me.role}の次のタスクを作る`, body: reason, taskKind: "plan", assignee: boss.data, source },
    actor,
  );
  await notifyStaff(env, boss.data, now, false);
  return row;
}

/**
 * 社員が今のタスクを離れ、次のタスクを取らせる
 * @param env バインディング
 * @param staffId 社員 ID
 * @param result 離れた時の結果
 * @param now 今の時刻
 */
export async function leaveTask(env: Bindings, staffId: string, result: WorkResult, now: number): Promise<void> {
  const target = staffDo(env, staffId);
  await target.finish(result, now);
  await target.pull(now);
}

/**
 * タスクを done にし、社員がそのタスクを離れて次を取る。ワークスペースの完了の知らせから呼ぶ
 * @param env バインディング
 * @param staffId 社員 ID
 * @param nodeId タスク ID
 * @param now 今の時刻
 * @throws conflict 社員の今のタスクでない時、同時に終えて書けなかった時
 */
export async function finishTask(env: Bindings, staffId: string, nodeId: string, now: number): Promise<void> {
  const status = await staffDo(env, staffId).status(now);
  if (status.nodeId !== nodeId) throw new AppError("conflict", "今のタスクと違う");
  const row = await findNode(env.DB, nodeId);
  if (row.status !== "doing") throw new AppError("conflict", "タスクはもう変わった");
  // 同時の 2 回の終わりでは、先に書けた方だけが出来事を残して次を取る
  if ((await moveNode(env.DB, row, "done", now)) === null) throw new AppError("conflict", "タスクはもう変わった");
  await appendNodeEvent(env, { nodeId, staffId, kind: "finished", detail: {} }, { by: staffId, now });
  await leaveTask(env, staffId, "done", now);
}

/** 受け付ける物。chat はオーナーの発言、issue は選んだリポジトリの Issue */
export type Intake = { scope: string; title: string; body: string; source: "chat" | "issue"; issueNumber?: number };

/**
 * オーナーの発言か Issue を、受け付けのプロジェクトの下に社長が分けるタスクとして足す
 * @param env バインディング
 * @param input 受け付ける物
 * @param now 今の時刻
 * @returns 足したタスクの ID
 */
export async function intakeTask(env: Bindings, input: Intake, now: number): Promise<string> {
  const actor: Actor = { by: input.source === "chat" ? "owner" : "github", now };
  const project = await intakeProject(env, input.scope, actor);
  const row = await createNode(
    env,
    { kind: "task", parentId: project.id, scope: input.scope, title: input.title, body: input.body, taskKind: "plan", assignee: "president", source: input.source, issueNumber: input.issueNumber },
    actor,
  );
  // 勤務時間外には呼び出さず、手の空いた社長が次に取る
  await notifyStaff(env, "president", now, false);
  return row.id;
}
