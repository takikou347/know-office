// タスクの繰り返し。社員が自分の山から 1 つ取り、空なら上司に求め、終えたら次を取る (タスクとレビューの 3.1)
import { AppError, type ReleaseCondition, type ReviewFileStatus, StaffId, type StaffStatus, type StaffTask, type WorkResult } from "@know-office/core";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { nodes, staff } from "../db/main.ts";
import type { Bindings, Staff } from "../env.ts";
import { type Actor, appendNodeEvent, createNode, findNode, intakeProject, moveNode, type NodeRow, revertNode } from "./nodes.ts";

/** 2 つのコミットの間で変わった 1 ファイル。patch は統一形式の差分の本文で、GitHub が大きすぎて返さない時は null */
export type ChangedFile = { path: string; previousPath?: string; status: ReviewFileStatus; patch: string | null };

/** GitHub を呼ぶ口。鍵は github/app.ts が vault の App の鍵から作る (タスクとレビューの 3.3、3.4) */
export type Forge = {
  /** ブランチから main へのプルリクエストを出す */
  openPull(input: { repo: string; branch: string; title: string; body: string }): Promise<{ number: number; baseSha: string; headSha: string }>;
  /** コミットのチェックがすべて通ったか。sha は確かめたコミット */
  checksPassed(repo: string, sha: string): Promise<boolean>;
  /** main を確かめたコミットへ fast-forward で進める。branch は記録と代わりの GitHub のために渡す */
  merge(repo: string, head: { branch: string; sha: string }): Promise<void>;
  /** main からブランチかコミット (head) までに変わったファイル。動かしたファイルは前の道も入れる。多すぎて全部を読めない時は null */
  changedPaths(repo: string, head: string): Promise<string[] | null>;
  /** 公開のリポジトリの既定のブランチに、main に入れる条件と同じルールセットを掛ける。非公開なら何もせず private を返す */
  protectMain(repo: string, when: readonly ReleaseCondition[]): Promise<"applied" | "private">;
  /** GitHub とつないでいるか。つないでいない間はルールセットを掛ける先が無い。vault を読むまで分からないので待つ */
  connected(): Promise<boolean>;
  /** プルリクエストに可か不可のレビューを出し、GitHub のレビューの ID を返す。App が出したプルリクエストで GitHub が断る時は、判断を本文の頭に書いたコメントにする */
  postReview(repo: string, pr: number, review: { event: "APPROVE" | "REQUEST_CHANGES"; body: string; commitId: string }): Promise<number>;
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
};

/** まだつないでいない口。GitHub を呼ぶ操作は upstream_failed で断る */
export const UNCONNECTED_FORGE: Forge = {
  openPull: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  checksPassed: () => Promise.resolve(false),
  merge: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  changedPaths: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  protectMain: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  connected: () => Promise.resolve(false),
  postReview: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  postComment: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  commitFile: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  findMirror: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  pullFiles: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  compare: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  readFile: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
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
 * 社員の次の todo のタスクを、優先度の小さい順、作った順に 1 つ読む
 * @param env バインディング
 * @param staffId 社員 ID
 * @returns タスク。無ければ undefined
 */
async function nextTodo(env: Bindings, staffId: string): Promise<NodeRow | undefined> {
  const [row] = await drizzle(env.DB)
    .select()
    .from(nodes)
    .where(and(eq(nodes.kind, "task"), eq(nodes.assignee, staffId), eq(nodes.status, "todo")))
    .orderBy(asc(nodes.priority), asc(nodes.createdAt), asc(nodes.id))
    .limit(1);
  return row;
}

/**
 * 社員 DO に渡すタスクの形にする
 * @param row タスクの行
 * @returns StaffTask
 */
function taskOf(row: NodeRow): StaffTask {
  return { nodeId: row.id, title: row.title, scope: row.scope };
}

/**
 * タスクを doing にしてから社員に渡し、始めた時の役目の説明文の版を出来事に残す。役目の説明文は次のタスクから効くので、版はここで決まる
 * @param env バインディング
 * @param staffId 社員 ID
 * @param row 読んだ時のタスクの行
 * @param now 今の時刻
 * @param hand 社員に渡す。受け取ったかを返す
 * @returns 始めたか。読んでから担当か状態が変わっていれば始めない
 */
async function start(env: Bindings, staffId: string, row: NodeRow, now: number, hand: (task: StaffTask) => Promise<boolean>): Promise<boolean> {
  // 読んでからオーナーが担当を変えるとバージョンが進むので、先に doing にして取れた時だけ渡す。2 人が同じタスクを取らない
  const claimed = await moveNode(env.DB, row, "doing", now);
  if (!claimed) return false;
  let handed = false;
  try {
    handed = await hand(taskOf(claimed));
  } finally {
    if (!handed) await revertNode(env.DB, claimed.id, "doing", "todo", now);
  }
  if (!handed) return false;
  const [who] = await drizzle(env.DB).select({ promptVersion: staff.promptVersion }).from(staff).where(eq(staff.id, staffId)).limit(1);
  await appendNodeEvent(env, { nodeId: row.id, staffId, kind: "started", detail: { promptVersion: who?.promptVersion ?? null } }, { by: staffId, now });
  return true;
}

/**
 * 勤務中で手が空いていれば、自分の山から 1 つ取って doing にする。山が空なら上司に次を求める。社員 DO の鎖の中で呼ぶ
 * @param env バインディング
 * @param book 勤務の本
 * @param now 今の時刻
 * @returns 取ったか
 */
export async function pullNext(env: Bindings, book: TaskBook, now: number): Promise<Pulled> {
  const status = await book.status(now);
  if (status.state !== "working" || status.nodeId !== null) return { taken: false, nodeId: status.nodeId };
  const row = await nextTodo(env, book.staffId);
  if (!row) {
    await askBoss(env, book.staffId, "山が空になった", now);
    return { taken: false, nodeId: null };
  }
  // TODO(#54): 中央値を直前 7 日のチェックポイントの記録から出す。今は null で渡し、早い退勤を考えない
  const taken = await start(env, book.staffId, row, now, async (task) => (await book.take(task, null, now)).taken);
  return taken ? { taken: true, nodeId: row.id } : { taken: false, nodeId: null };
}

/**
 * 社員にタスクが来た事を知らせる。勤務時間外で呼び出してよい時は呼び出し、勤務中で手が空いていれば次のタスクを取らせる
 * @param env バインディング
 * @param staffId 社員 ID
 * @param now 今の時刻
 * @param call 勤務時間外なら呼び出すか。オーナーが頼んだ時だけ true
 */
export async function notifyStaff(env: Bindings, staffId: string, now: number, call: boolean): Promise<void> {
  const id = StaffId.safeParse(staffId);
  if (!id.success) return;
  const target = staffDo(env, id.data);
  const status = await target.status(now);
  if (status.state === "working" && status.nodeId === null) {
    await target.pull(now);
    return;
  }
  if (status.state !== "off" || !call) return;
  const row = await nextTodo(env, id.data);
  if (!row) return;
  await start(env, id.data, row, now, async (task) => {
    await target.call(task, now);
    return true;
  });
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
 * @throws conflict 社員の今のタスクでない時
 */
export async function finishTask(env: Bindings, staffId: string, nodeId: string, now: number): Promise<void> {
  const status = await staffDo(env, staffId).status(now);
  if (status.nodeId !== nodeId) throw new AppError("conflict", "今のタスクと違う");
  const row = await findNode(env.DB, nodeId);
  await moveNode(env.DB, row, "done", now);
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
