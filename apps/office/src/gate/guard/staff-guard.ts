// 社員 1 人のシグナルの数と、有効な作業トークンの一覧。StaffDO が持ち、テストは同じ物を手元の入れ物で使う (自動停止の 2 章、3.4)
import type { D1Database } from "@cloudflare/workers-types";
import {
  AppError,
  type Baseline,
  countStaff,
  emptyStaffCounts,
  GuardEvent,
  jstDay,
  median,
  newId,
  resetTask,
  setBaseline,
  isStaffEvent,
  StaffCounts,
  type StaffId,
  Thresholds,
} from "@know-office/core";
import { and, eq, gte, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { staffBuckets } from "../db/main.ts";
import { clockAt } from "../work/attendance.ts";
import type { StaffBook, StaffStorage } from "../work/staff-book.ts";
import type { Observed, RecentOp } from "./deps.ts";

/** 残す直前の出来事の数 */
export const RECENT_OPS = 20;
/** 作業トークンの長さ */
export const TICKET_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** 発行した作業トークン。ID と発行した先だけを持ち、署名は 7.2 で付ける */
const Ticket = z.object({ jti: z.string(), nodeId: z.string(), workspaceId: z.string(), expiresAt: z.number() }).strict();
const Tickets = z.array(Ticket);
const RecentOps = z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])));

/** 作業トークンを確かめた答え。misuse は発行した先と違うワークスペースから使われた */
export type TicketCheck = "ok" | "revoked" | "expired" | "misuse";

/** 社員 1 人のシグナルを数え、作業トークンを発行と失効する。時刻はすべて引数で受ける */
export class StaffGuard {
  /**
   * @param staffId 社員 ID
   * @param storage 記憶の入れ物。StaffBook と同じ物
   * @param db D1 の DB。5 分ごとの使った量を書き、普段の値を読む
   * @param book 勤務の本。止めたタスクを離れ、社員を止める
   */
  constructor(
    private readonly staffId: StaffId,
    private readonly storage: StaffStorage,
    private readonly db: D1Database,
    private readonly book: StaffBook,
  ) {}

  /**
   * 出来事を数え、止めるか、近かったかを返す
   * @param input GuardEvent
   * @param now 今の時刻
   * @param th Thresholds
   * @returns 答えと、直前の出来事と、読んだ外部の文章の出所
   * @throws validation_failed 形が違う、社員の出来事でない、ほかの社員の出来事の時
   */
  async observe(input: unknown, now: number, th: unknown): Promise<Observed> {
    const event = GuardEvent.safeParse(input);
    const thresholds = Thresholds.safeParse(th);
    if (!event.success || !thresholds.success || !isStaffEvent(event.data) || event.data.staffId !== this.staffId) {
      throw new AppError("validation_failed", "社員の出来事の形が違う");
    }
    const counts = await this.#counts();
    if ((event.data.type === "usage" || event.data.type === "tool_call") && counts.baselineDay !== jstDay(now)) {
      setBaseline(counts, await this.#baseline(now, thresholds.data.baselineDays), jstDay(now));
    }
    const recent = [...(await this.#recent()), { at: now, ...event.data }].slice(-RECENT_OPS);
    const judgment = countStaff(counts, event.data, now, thresholds.data);
    const nodeId = "nodeId" in event.data ? event.data.nodeId : null;
    const externalSources = nodeId === null ? [] : (counts.tasks[nodeId]?.external ?? []);
    await this.#flush(counts, now);
    await this.storage.put("signals", counts);
    await this.storage.put("recent", recent);
    return { ...judgment, recentOps: recent, externalSources };
  }

  /**
   * 止めたタスクを離れ、そのタスクの作業トークンを失効させ、タスクの数を消す
   * @param nodeId タスク ID
   * @param now 今の時刻
   * @returns 無し
   */
  async dropTask(nodeId: string, now: number): Promise<null> {
    await this.book.drop(nodeId, now);
    await this.#revoke((t) => t.nodeId === nodeId);
    const counts = await this.#counts();
    resetTask(counts, nodeId);
    await this.storage.put("signals", counts);
    return null;
  }

  /**
   * 社員を止め、作業トークンをすべて失効させる
   * @param now 今の時刻
   * @returns 無し
   */
  async halt(now: number): Promise<null> {
    await this.book.halt(now);
    await this.#revoke(() => true);
    return null;
  }

  /**
   * 再開したタスクの数を 0 に戻す。社員ごとの 60 分の数は残す
   * @param nodeId タスク ID
   * @returns 無し
   */
  async resumeTask(nodeId: string): Promise<null> {
    const counts = await this.#counts();
    resetTask(counts, nodeId);
    await this.storage.put("signals", counts);
    return null;
  }

  /**
   * 今のタスクの働いた時間を返す
   * @param now 今の時刻
   * @returns タスク ID と働いた時間。タスクを持っていなければ null
   */
  taskClock(now: number): Promise<{ nodeId: string; activeMs: number } | null> {
    return this.book.taskClock(now);
  }

  /**
   * タスクの作業トークンを発行し、有効な一覧に足す
   * @param nodeId タスク ID
   * @param workspaceId 渡すワークスペースの ID
   * @param now 今の時刻
   * @returns 作業トークン ID
   */
  async issueToken(nodeId: string, workspaceId: string, now: number): Promise<{ jti: string }> {
    const jti = newId(clockAt(now));
    const live = (await this.#tickets()).filter((t) => t.expiresAt > now);
    await this.storage.put("tickets", [...live, { jti, nodeId, workspaceId, expiresAt: now + TICKET_MS }]);
    return { jti };
  }

  /**
   * 作業トークンが使えるかを確かめる。ゲートウェイはプロキシのたびに呼ぶ
   * @param jti 作業トークン ID
   * @param workspaceId 使ったワークスペースの ID
   * @param now 今の時刻
   * @returns ok、失効した、期限切れ、発行した先と違う
   */
  async checkToken(jti: string, workspaceId: string, now: number): Promise<TicketCheck> {
    const ticket = (await this.#tickets()).find((t) => t.jti === jti);
    if (!ticket) return "revoked";
    if (ticket.workspaceId !== workspaceId) return "misuse";
    return ticket.expiresAt > now ? "ok" : "expired";
  }

  /**
   * 合う作業トークンを有効な一覧から消す
   * @param match 消す作業トークン
   */
  async #revoke(match: (t: z.infer<typeof Ticket>) => boolean): Promise<void> {
    await this.storage.put(
      "tickets",
      (await this.#tickets()).filter((t) => !match(t)),
    );
  }

  /**
   * 閉じた 5 分の区切りを staff_buckets に書く。勤務中かは書く時の状態で決める
   * @param counts 社員の数
   * @param now 今の時刻
   */
  async #flush(counts: StaffCounts, now: number): Promise<void> {
    const [first, ...rest] = counts.closed;
    if (!first) return;
    const onDuty = (await this.book.status(now)).state !== "off";
    const orm = drizzle(this.db);
    const row = (b: typeof first) => orm.insert(staffBuckets).values({ id: newId(clockAt(b.at)), staffId: this.staffId, bucketAt: b.at, tokens: b.tokens, toolCalls: b.toolCalls, onDuty });
    await orm.batch([row(first), ...rest.map(row)]);
    counts.closed = [];
  }

  /**
   * 普段の値を作る。直前 7 日の勤務中の 5 分の値の中央値
   * @param now 今の時刻
   * @param days 見る日数
   * @returns 普段の値と、値のあった日数
   */
  async #baseline(now: number, days: number): Promise<Baseline> {
    const found = await drizzle(this.db)
      .select()
      .from(staffBuckets)
      .where(and(eq(staffBuckets.staffId, this.staffId), eq(staffBuckets.onDuty, true), gte(staffBuckets.bucketAt, now - days * DAY_MS), lt(staffBuckets.bucketAt, now)));
    return {
      tokens: median(found.map((b) => b.tokens)),
      toolCalls: median(found.map((b) => b.toolCalls)),
      days: new Set(found.map((b) => jstDay(b.bucketAt))).size,
    };
  }

  /**
   * 数を読む。無ければ空から始める
   * @returns 社員の数
   */
  async #counts(): Promise<StaffCounts> {
    const stored = await this.storage.get("signals");
    return stored === undefined ? emptyStaffCounts(this.staffId) : StaffCounts.parse(stored);
  }

  /**
   * 直前の出来事を読む
   * @returns 古い順の出来事
   */
  async #recent(): Promise<RecentOp[]> {
    const stored = await this.storage.get("recent");
    return stored === undefined ? [] : RecentOps.parse(stored);
  }

  /**
   * 有効な作業トークンの一覧を読む
   * @returns 一覧
   */
  async #tickets(): Promise<z.infer<typeof Tickets>> {
    const stored = await this.storage.get("tickets");
    return stored === undefined ? [] : Tickets.parse(stored);
  }
}
