// 利用場面の通しで社員を働かせる。勤務の時刻を一日に広げて出勤させ、代わりの Claude API にその社員の SDK が受ける返事を積む
import { expect, type Locator, type Page } from "@playwright/test";
import { jstClock } from "@know-office/core";
import { z } from "zod";
import { FAKES } from "../../helpers/fakes.ts";
import { useOwnerPasskey } from "./passkey.ts";
import { editCard, pickTime, post, saveCard } from "./screen.ts";

const Staff = z.object({ data: z.array(z.object({ id: z.string(), state: z.string(), nodeId: z.string().nullable() }).loose()) });
const State = z.object({ data: z.object({ stopped: z.array(z.object({ scope: z.string(), target: z.string(), stopId: z.string() })) }) });

/** パスキーの仮想の認証器を入れたページ。Chrome は 1 つのページに内蔵の認証器を 1 つしか入れられない */
const withPasskey = new WeakSet<Page>();

/**
 * ページにオーナーのパスキーを 1 度だけ入れる
 * @param page 画面を開くページ
 */
export async function ownerPasskey(page: Page): Promise<void> {
  if (withPasskey.has(page)) return;
  await useOwnerPasskey(page);
  withPasskey.add(page);
}

/**
 * 前の通しが止めたままにした社員を再開する。止まった社員はタスクを取らない
 * @param page 画面を開いたページ
 */
export async function resumeStaff(page: Page): Promise<void> {
  const state = State.parse(await (await page.request.get("/api/v1/guard/state")).json());
  for (const s of state.data.stopped.filter((x) => x.scope === "staff")) expect(await post(page, `/api/v1/guard/stops/${s.stopId}/resume`)).toBe(200);
}

const Settings = z.object({ data: z.array(z.object({ key: z.string(), value: z.unknown() }).loose()) });
const Schedule = z.object({ start: z.string(), end: z.string() }).loose();

/**
 * 勤務の時刻を API で読む。設定の画面は開くたびに 10 余りの要求を出し、ゲートウェイの 1 分の数 (300) を通しの頭で使い切るので、読むだけなら画面を開かない
 * @param page 画面を開いたページ
 * @returns 始まりと終わり (日本時間)
 */
async function readSchedule(page: Page): Promise<{ start: string; end: string }> {
  const res = await page.request.get("/api/v1/settings");
  expect(res.status()).toBe(200);
  const found = Settings.parse(await res.json()).data.find((x) => x.key === "workday.schedule");
  const { start, end } = Schedule.parse(found?.value);
  return { start, end };
}

/**
 * 設定の画面を開き、勤務の時刻のカードが読めるのを待つ
 * @param page 画面を開くページ
 * @returns カード
 */
async function scheduleCard(page: Page): Promise<Locator> {
  await page.goto("/settings");
  const box = page.getByRole("main").getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: "勤務の時刻", exact: true }) });
  await editCard(box, "勤務の時刻");
  await expect(box.getByRole("combobox", { name: "終わり (日本時間)" })).toHaveText(/\d\d:\d\d/);
  return box;
}

/**
 * 設定の画面の勤務の時刻を変える。時間を足す変更はパスキーで確かめる。既にその時刻なら、保存を押せないので画面を開かずに何もしない
 * @param page 画面を開くページ。useOwnerPasskey を付けておく
 * @param start 始まり (日本時間)
 * @param end 終わり (日本時間)
 */
async function setSchedule(page: Page, start: string, end: string): Promise<void> {
  const now = await readSchedule(page);
  if (now.start === start && now.end === end) return;
  const box = await scheduleCard(page);
  await pickTime(box, "始まり (日本時間)", start);
  await pickTime(box, "終わり (日本時間)", end);
  await saveCard(box, "勤務の時刻", "社員の仕事の通し");
  await expect(box.getByText(/勤務の時刻を変えました/)).toBeVisible();
}

/**
 * 社員の今の状態と持っているタスクを読む
 * @param page 画面を開いたページ
 * @param staffId 社員
 * @returns 状態と持っているタスク
 */
export async function staffNow(page: Page, staffId: string): Promise<{ state: string | undefined; nodeId: string | null }> {
  const found = Staff.parse(await (await page.request.get("/api/v1/staff")).json()).data.find((s) => s.id === staffId);
  return { state: found?.state, nodeId: found?.nodeId ?? null };
}

/**
 * 社員の今の状態を読む
 * @param page 画面を開いたページ
 * @param staffId 社員
 * @returns 状態
 */
export async function staffState(page: Page, staffId: string): Promise<string | undefined> {
  return (await staffNow(page, staffId)).state;
}

/** 通しが勤務の時刻を日をまたぐ形に広げる、日本時間の時 (この時から 0 時まで) */
const LATE_HOUR = 22;

/** 設定の画面の時刻の欄 (TimePicker) の刻み (分)。通しが選ぶ時刻はこの刻みに乗せる */
const TIME_STEP = 15;

/**
 * 0 時からの分を HH:MM にする
 * @param total 0 時からの分
 * @returns 時刻
 */
function clock(total: number): string {
  const m = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * 通しの間だけ広げる勤務の時刻を作る。時刻の欄の刻み (15 分) に乗せる。ふだんは 00:00 から 23:45 にする。
 * 日本時間の 22 時より後は、終わりから 0:00 の間で通しの途中に終わりに届いて退勤するので、1 時間前より前の刻みに始まりその 1 刻み前 (翌日) に終わる 23 時間 45 分にし、空く 15 分を今から遠ざける。
 * 日をまたぐ形は早退の指示を出せない (所定の終わりが同じ日の始まりより前になる) ので、22 時より前は使わない
 * @param now 今の時刻
 * @returns 始まりと終わり (日本時間)
 */
function wideSchedule(now: number): { start: string; end: string } {
  if (Number(jstClock(now).slice(0, 2)) < LATE_HOUR) return { start: "00:00", end: clock(24 * 60 - TIME_STEP) };
  const start = Math.floor(minutes(jstClock(now - 60 * 60 * 1000)) / TIME_STEP) * TIME_STEP;
  return { start: clock(start), end: clock(start - TIME_STEP) };
}

/**
 * HH:MM を 0 時からの分に直す
 * @param hhmm 時刻
 * @returns 分
 */
function minutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/**
 * 勤務の時刻が、通しが広げた 23 時間 45 分 (前の形の 23 時間 59 分を含む) のままか
 * @param schedule 始まりと終わり (日本時間)
 * @param schedule.start 始まり
 * @param schedule.end 終わり
 * @returns 広げたままなら true
 */
function widened({ start, end }: { start: string; end: string }): boolean {
  // 前の形 (1 分だけ空ける) で広げたまま残った物も見分ける
  const gap = (minutes(start) - minutes(end) + 24 * 60) % (24 * 60);
  return gap === 1 || gap === TIME_STEP;
}

/**
 * 前に流した時のワークスペースが落ちて社員が待っていれば、止めて再開して作り直させる
 * @param page 画面を開いたページ
 * @param staffId 社員
 */
export async function unstick(page: Page, staffId: string): Promise<void> {
  if ((await staffState(page, staffId)) !== "waiting") return;
  const stopped = await page.request.post("/api/v1/guard/stops", { headers: { Origin: new URL(page.url()).origin }, data: { scope: "staff", target: staffId, reason: "社員の仕事の通しの前に作り直す" } });
  expect(stopped.status()).toBe(201);
  await resumeStaff(page);
  await expect.poll(() => staffState(page, staffId), { timeout: 30_000 }).not.toMatch(/^(waiting|stopped)$/);
}

/**
 * 社員を勤務の中にする。時間外の呼び出しはチェックポイントで退勤し、タスクを翌日へ続けるため
 * 前に流した時のワークスペースが落ちて待っていれば、止めて再開して作り直させる。勤務の中でなければ、勤務の時刻を一日に広げて出勤させる
 * @param page 画面を開いたページ
 * @param staffId 社員
 * @param allDay 勤務の中でも勤務の時刻を一日に広げるか。通しの中で退勤させて出勤し直す時は、前の通しが戻した時刻のまま勤務の中に残っていても広げる
 * @returns 元の勤務の時刻に戻す関数。広げなかった時は何もしない
 */
export async function clockIn(page: Page, staffId: string, allDay = false): Promise<() => Promise<void>> {
  await unstick(page, staffId);
  // 時間外の呼び出し (called) の間も、勤務の中と同じにタスクを進める
  if (!allDay && /^(working|called)$/.test((await staffState(page, staffId)) ?? "")) return () => Promise.resolve();
  await ownerPasskey(page);
  const read = await readSchedule(page);
  // 前の通しが落ちて一日に広げたまま残していれば、それを元にせず、勤務の時刻の初期値 (DEFAULT_SCHEDULE) に戻す
  const was = widened(read) ? { start: "09:00", end: "17:00" } : read;
  const restore = () => setSchedule(page, was.start, was.end);
  const wide = wideSchedule(Date.now());
  await setSchedule(page, wide.start, wide.end);
  try {
    // 同じ日に一度退勤した社員はその日にもう出勤しないので、手元の DO を使い回して流し直す時は、開発の道で退勤した日の印を消して出勤させる
    expect((await page.request.post(`/__dev/staff/${staffId}/forget-day`)).status()).toBe(204);
    await expect.poll(() => staffState(page, staffId)).toBe("working");
  } catch (error) {
    // 出勤できずに落ちても、広げた勤務の時刻を次の通しに残さない
    await restore();
    throw error;
  }
  return restore;
}

/**
 * 代わりの Claude API に、社員の SDK が受ける返事を 1 つ積む
 * @param page 画面を開いたページ
 * @param staffId 受ける社員。ほかの社員も同じ時に SDK を呼ぶので、この社員の作業トークンの呼び出しにだけ返させる
 * @param content 返す中身のブロック
 * @param stopReason 止まった理由
 * @param delayMs 受けてから返すまで待つ長さ。無ければすぐ返す
 */
export async function scriptReply(page: Page, staffId: string, content: Record<string, unknown>[], stopReason: "tool_use" | "end_turn", delayMs?: number): Promise<void> {
  const res = await page.request.post(`${FAKES}/anthropic/__fake/responses`, { data: { staffId, content, stop_reason: stopReason, ...(delayMs === undefined ? {} : { delay_ms: delayMs }) } });
  expect(res.status()).toBe(204);
}

/**
 * 代わりの Claude API に、その社員に積んだまま残った返事を外す。途中で落ちた通しの返事を、後でその社員が取ったほかのタスクに返さない
 * @param page 画面を開いたページ
 * @param staffId 社員
 */
export async function forgetReplies(page: Page, staffId: string): Promise<void> {
  const res = await page.request.delete(`${FAKES}/anthropic/__fake/responses/${staffId}`);
  expect(res.status()).toBe(204);
}

/**
 * 社員が持っているタスクを離れて手が空くのを待つ。見本のタスクや前の通しが残したタスクを持っていれば、その呼び出しに終わりの返事を返して終えさせ、離れさせる
 * @param page 画面を開いたページ
 * @param staffId 社員
 */
export async function idleStaff(page: Page, staffId: string): Promise<void> {
  const held = async () => (await staffNow(page, staffId)).nodeId;
  if ((await held()) === null) return;
  // 呼び出しは代わりの Claude API の返事を待っているので、終わりの返事で閉じる
  await scriptReply(page, staffId, [{ type: "text", text: "通しの前に終えた" }], "end_turn");
  await expect.poll(held, { timeout: 60_000 }).toBeNull();
}

/**
 * 時と分の選ぶ欄で時刻を選ぶ
 * @param page 開いているページ
 * @param label 欄の名前。時は「<名前>の時」、分は「<名前>の分」
 * @param hhmm 選ぶ時刻 HH:MM
 */
export async function chooseTime(page: Page, label: string, hhmm: string): Promise<void> {
  for (const [part, value] of [["時", hhmm.slice(0, 2)], ["分", hhmm.slice(3, 5)]] as const) {
    const box = page.getByRole("main").getByRole("combobox", { name: `${label}の${part}` });
    await box.click();
    await page.getByRole("option", { name: value, exact: true }).click();
    // 選び肢の一覧が閉じ切る前に次の欄を押すと、閉じる途中の一覧が押した事を受けるので、選んだ値が出て一覧が消えるまで待つ
    await expect(box).toHaveText(value);
    await expect(page.getByRole("listbox")).toHaveCount(0);
  }
}
