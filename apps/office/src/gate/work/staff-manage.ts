// 社員の追加、設定、削除。書く条件は 1 文の WHERE に入れ、読んだ後の変更で崩れない形にする (タスクとレビューの 3.4、社員と勤怠の 3.4)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, type CreateStaffInput, isPricier, isStaffModel, newId, type StaffId, type UpdateStaffInput, WorkSchedule } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { staffOf } from "../guard/actions.ts";
import { clockAt, loadSchedule } from "./attendance.ts";
import { activeStaff, activeStaffRow, type StaffRow } from "./roster.ts";

/** 在籍の社員の上限。11 人目は断る */
export const MAX_STAFF = 10;

/** 作業中の社員の状態。この時は削除しない */
const BUSY = new Set(["working", "wrapping", "called"]);

/** 終わりでないタスクの状態の条件。名簿の pickStaff と同じ数え方 */
const OPEN = "status NOT IN ('done', 'dropped')";

/** 社員が在籍かの条件 */
const ACTIVE = "EXISTS (SELECT 1 FROM staff b WHERE b.id = ? AND b.retired_at IS NULL)";

/**
 * 職種の在籍の社員のうち、終わりでないタスクの少ない人を選ぶ副問い。居なければ社長。1 タスクずつ流すので、移す先が順に分かれる
 */
const HEIR = `coalesce(
  (SELECT s.id FROM staff s LEFT JOIN (SELECT assignee, count(*) AS n FROM nodes WHERE kind = 'task' AND ${OPEN} GROUP BY assignee) o ON o.assignee = s.id
    WHERE s.job = ? AND s.retired_at IS NULL ORDER BY coalesce(o.n, 0), s.created_at, s.id LIMIT 1),
  (SELECT id FROM staff WHERE job = 'president' AND retired_at IS NULL LIMIT 1))`;

/**
 * 6 字の小文字と数字を作る
 * @returns 6 字
 */
function suffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

/**
 * 社員を足す。社員の行と、同じ職種の最初の社員の最新の説明文の写しを 1 回のバッチで書く。上司が在籍で人数が上限より少ない時だけ書く
 * @param db 今の状態の D1
 * @param input 職種、名前、上司、モデル
 * @param now 今の時刻
 * @returns 足した社員の行
 * @throws refused 在籍の社員が上限に達している時
 * @throws validation_failed 上司が在籍の社員でない時
 */
export async function addStaff(db: D1Database, input: CreateStaffInput, now: number): Promise<StaffRow> {
  const base = await db.prepare("SELECT body FROM staff_prompts WHERE staff_id = ? ORDER BY version DESC LIMIT 1").bind(input.job).first<{ body: string }>();
  // ID の重なりは 36 の 6 乗に 1 つなので、1 度だけ作り直す
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = `${input.job}-${suffix()}`;
    const insert = db
      .prepare(
        `INSERT INTO staff (id, job, role, boss_id, model, effort, prompt_version, schedule, version, retired_at, created_at)
         SELECT ?, ?, ?, ?, ?, 'high', 1, NULL, 1, NULL, ? WHERE ${ACTIVE} AND (SELECT count(*) FROM staff WHERE retired_at IS NULL) < ? AND NOT EXISTS (SELECT 1 FROM staff WHERE id = ?)`,
      )
      .bind(id, input.job, input.role, input.bossId, input.model, now, input.bossId, MAX_STAFF, id);
    const prompt = db
      .prepare("INSERT INTO staff_prompts (id, staff_id, version, body, by, created_at) SELECT ?, ?, 1, ?, 'owner', ? WHERE EXISTS (SELECT 1 FROM staff WHERE id = ? AND created_at = ?)")
      .bind(newId(clockAt(now)), id, base?.body ?? "", now, id, now);
    const [made] = await db.batch([insert, prompt]);
    if (made?.meta.changes === 1) {
      const row = await activeStaffRow(db, id);
      if (row) return row;
    }
    if (!(await activeStaffRow(db, input.bossId))) throw new AppError("validation_failed", "上司は在籍の社員にする");
    if ((await activeStaff(db)).length >= MAX_STAFF) throw new AppError("refused", `社員は ${String(MAX_STAFF)} 人まで`);
  }
  throw new AppError("internal", "社員 ID を作れなかった");
}

/** 1 日の分 */
const DAY_MINUTES = 24 * 60;

/** 削除の印を書いてから、日次の定期ジョブが残りを移すまでの間。作業中と分かって印を戻す途中の社員を移さない */
const LEFTOVER_GRACE_MS = 10 * 60_000;

/**
 * HH:MM を 0 時からの分にする
 * @param hhmm 時刻
 * @returns 分
 */
function minutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
}

/**
 * 勤務の時刻の週の分を数える。終わりが始まりより前の勤務は、予定と同じく翌日の終わりまでを数える
 * @param schedule 勤務の時刻
 * @returns 週の分
 */
function weekMinutes(schedule: WorkSchedule): number {
  const start = minutes(schedule.start);
  const end = minutes(schedule.end);
  const day = end > start ? end - start : end + DAY_MINUTES - start;
  return day * new Set(schedule.days).size;
}

/**
 * 設定の変更がパスキーの確認を要るかを返す。単価の高いモデルに替える時と、週の勤務の分が増える時
 * @param db 今の状態の D1
 * @param row 今の社員の行
 * @param input 変える物
 * @returns 要る時 true
 */
export async function needsStepUp(db: D1Database, row: StaffRow, input: UpdateStaffInput): Promise<boolean> {
  // 今のモデルが選べるモデルでない時は、比べられないので確かめる側に倒す
  if (input.model !== undefined && input.model !== row.model && (!isStaffModel(row.model) || isPricier(input.model, row.model))) return true;
  if (input.schedule === undefined) return false;
  const office = await loadSchedule(db);
  const own = WorkSchedule.safeParse(row.schedule);
  const before = own.success ? own.data : office;
  return weekMinutes(input.schedule ?? office) > weekMinutes(before);
}

/**
 * 社員の設定を直す。読んだ版のままで在籍の時だけ 1 文で書き、版を 1 上げる。上司は在籍で、自分と自分の下でない時だけ書く
 * @param db 今の状態の D1
 * @param row 読んだ社員の行
 * @param input 変える物
 * @returns 直した後の行
 * @throws validation_failed 社長に上司を付ける時、上司が在籍でないか自分か自分の下の時
 * @throws conflict 読んだ後に設定が変わったか、削除された時
 */
export async function updateStaff(db: D1Database, row: StaffRow, input: UpdateStaffInput): Promise<StaffRow> {
  if (input.bossId !== undefined && row.job === "president") throw new AppError("validation_failed", "社長に上司は付けない");
  const bossId = input.bossId ?? row.bossId;
  const schedule = input.schedule === undefined ? row.schedule : input.schedule;
  // 新しい上司から上へたどった中に自分が居ない時だけ書く。同時に A の上司を B、B の上司を A にしても、後の文が輪を見て止まる
  const res = await db
    .prepare(
      `WITH RECURSIVE up(id) AS (SELECT ? UNION SELECT s.boss_id FROM staff s JOIN up ON s.id = up.id WHERE s.boss_id IS NOT NULL)
       UPDATE staff SET role = ?, boss_id = ?, model = ?, schedule = ?, version = version + 1
       WHERE id = ? AND version = ? AND retired_at IS NULL
         AND (? IS NULL OR (${ACTIVE} AND ? NOT IN (SELECT id FROM up)))`,
    )
    .bind(bossId, input.role ?? row.role, bossId, input.model ?? row.model, schedule === null ? null : JSON.stringify(schedule), row.id, input.version, bossId, bossId, row.id)
    .run();
  if (res.meta.changes === 1) {
    const next = await activeStaffRow(db, row.id);
    if (next) return next;
  }
  const now = await activeStaffRow(db, row.id);
  if (!now || now.version !== input.version) throw new AppError("conflict", "読んだ後に社員の設定が変わった");
  throw new AppError("validation_failed", "上司は在籍の社員で、自分と自分の下でない社員にする");
}

/**
 * 社員を削除する。先に削除の印を書き、作業中なら印を戻して断る。作業中でなければ、終わりでないタスクを同じ職種の手の空いた社員に 1 つずつ移し、部下の上司を社長にする
 * @param env バインディング
 * @param staffId 社員 ID
 * @param now 今の時刻
 * @returns 移したタスクの ID と移した先
 * @throws not_found 在籍の社員でない時
 * @throws refused 社長か、職種の最後の 1 人の時
 * @throws conflict 作業中の時、同時に削除した時
 */
export async function retireStaff(env: Bindings, staffId: StaffId, now: number): Promise<{ id: string; assignee: string }[]> {
  const row = await activeStaffRow(env.DB, staffId);
  if (!row) throw new AppError("not_found", "在籍の社員でない");
  if (row.job === "president") throw new AppError("refused", "社長は削除できない");
  const mark = await env.DB.prepare(
    "UPDATE staff SET retired_at = ?, version = version + 1 WHERE id = ? AND retired_at IS NULL AND job != 'president' AND EXISTS (SELECT 1 FROM staff o WHERE o.job = staff.job AND o.id != staff.id AND o.retired_at IS NULL)",
  )
    .bind(now, staffId)
    .run();
  if (mark.meta.changes !== 1) {
    if (!(await activeStaffRow(env.DB, staffId))) throw new AppError("conflict", "もう削除された");
    throw new AppError("refused", "職種の最後の 1 人は削除できない");
  }
  // 印を書いた後に社員 DO の予定を消させてから状態を読む。印の後はタスクを取る文が担当の在籍を見て断るので、ここで作業中でなければこの後も作業に入らない
  const member = staffOf(env, staffId);
  const busy = await member
    .wake(now)
    .then(() => member.status(now))
    .then(async (status) => BUSY.has(status.state) || (await env.DB.prepare(`SELECT 1 FROM nodes WHERE assignee = ? AND status = 'doing' LIMIT 1`).bind(staffId).first()) !== null);
  if (busy) {
    await env.DB.prepare("UPDATE staff SET retired_at = NULL, version = version + 1 WHERE id = ? AND retired_at = ?").bind(staffId, now).run();
    // 印を見て消した予定を組み直させる
    await member.wake(now);
    throw new AppError("conflict", "作業中の社員は削除できない。区切りの後にもう一度削除する");
  }
  return handOver(env.DB, staffId, now);
}

/**
 * 削除した社員の終わりでないタスクと部下を移す。タスクは 1 つずつ別の文にし、文ごとに手の空いた社員を選び直す
 * @param db 今の状態の D1
 * @param staffId 削除した社員 ID
 * @param now 今の時刻
 * @returns 移したタスクの ID と移した先
 */
export async function handOver(db: D1Database, staffId: StaffId, now: number): Promise<{ id: string; assignee: string }[]> {
  const job = await db.prepare("SELECT job FROM staff WHERE id = ? AND retired_at IS NOT NULL").bind(staffId).first<{ job: string }>();
  if (!job) return [];
  const { results } = await db.prepare(`SELECT id FROM nodes WHERE assignee = ? AND ${OPEN} ORDER BY created_at, id`).bind(staffId).all<{ id: string }>();
  const moves = results.map(({ id }) =>
    // 印の直前に取って誰も進めていない doing は、移した先が取れるよう todo に戻す
    db.prepare(`UPDATE nodes SET assignee = ${HEIR}, status = CASE WHEN status = 'doing' THEN 'todo' ELSE status END, version = version + 1, updated_at = ? WHERE id = ? AND assignee = ? AND ${OPEN} RETURNING id, assignee`).bind(job.job, now, id, staffId),
  );
  const bosses = db.prepare("UPDATE staff SET boss_id = (SELECT id FROM staff WHERE job = 'president' AND retired_at IS NULL LIMIT 1), version = version + 1 WHERE boss_id = ?").bind(staffId);
  // D1 の 1 回のバッチは 100 文までなので分けて流す
  const moved: { id: string; assignee: string }[] = [];
  const statements = [...moves, bosses];
  for (let i = 0; i < statements.length; i += 50) {
    for (const r of await db.batch<{ id: string; assignee: string }>(statements.slice(i, i + 50))) moved.push(...r.results);
  }
  return moved;
}

/**
 * 削除の途中で落ちて、削除した社員に残ったタスクを移し直す。日次の定期ジョブが呼ぶ。印を書いて 10 分たった社員だけを見る
 * @param db 今の状態の D1
 * @param now 今の時刻
 * @returns 移したタスクの数
 */
export async function handOverLeftovers(db: D1Database, now: number): Promise<number> {
  const { results } = await db
    .prepare("SELECT DISTINCT s.id FROM staff s JOIN nodes n ON n.assignee = s.id WHERE s.retired_at IS NOT NULL AND s.retired_at <= ? AND n.status NOT IN ('done', 'dropped')")
    .bind(now - LEFTOVER_GRACE_MS)
    .all<{ id: StaffId }>();
  let count = 0;
  for (const { id } of results) count += (await handOver(db, id, now)).length;
  return count;
}
