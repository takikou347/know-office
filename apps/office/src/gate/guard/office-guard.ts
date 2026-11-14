// 全体とサービスのシグナルの数と、全体を止めた後の外の鍵の印。GuardDO が持ち、テストは同じ物を手元の入れ物で使う (自動停止の 2 章、3.5)
import { AppError, countOffice, isStaffEvent, emptyOfficeCounts, GuardEvent, OfficeCounts, Thresholds } from "@know-office/core";
import { z } from "zod";
import type { GuardStorage } from "../auth/guard-book.ts";
import type { Observed } from "./deps.ts";
import { RECENT_OPS } from "./staff-guard.ts";

const OpenStops = z.record(z.string(), z.string());
const Released = z.array(z.string());
const RecentOps = z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])));

/** 全体とサービスのシグナルを数える。時刻はすべて引数で受ける */
export class OfficeGuard {
  /**
   * @param storage 記憶の入れ物。GuardBook と同じ物
   */
  constructor(private readonly storage: GuardStorage) {}

  /** 権利を取る操作を 1 つずつ流す鎖 */
  #chain: Promise<unknown> = Promise.resolve();

  /**
   * 出来事を数え、止めるか、近かったかを返す
   * @param input GuardEvent
   * @param now 今の時刻
   * @param th Thresholds
   * @returns 答えと直前の出来事
   * @throws validation_failed 形が違うか、社員の出来事の時
   */
  async observe(input: unknown, now: number, th: unknown): Promise<Observed> {
    const event = GuardEvent.safeParse(input);
    const thresholds = Thresholds.safeParse(th);
    if (!event.success || !thresholds.success) throw new AppError("validation_failed", "全体の出来事の形が違う");
    const e = event.data;
    if (isStaffEvent(e)) throw new AppError("validation_failed", "社員の出来事は社員 DO で数える");
    const stored = await this.storage.get("office_signals");
    const counts = stored === undefined ? emptyOfficeCounts() : OfficeCounts.parse(stored);
    const before = await this.storage.get("office_recent");
    const recent = [...(before === undefined ? [] : RecentOps.parse(before)), { at: now, ...e }].slice(-RECENT_OPS);
    const judgment = countOffice(counts, e, now, thresholds.data);
    await this.storage.put("office_signals", counts);
    await this.storage.put("office_recent", recent);
    return { ...judgment, recentOps: recent, externalSources: [] };
  }

  /**
   * 全体を止めた時に、外の鍵 (GitHub App と Claude) を入れ直すまで使えない印を付ける
   * @returns 無し
   */
  async holdKeys(): Promise<null> {
    await this.storage.put("keys_held", true);
    return null;
  }

  /**
   * 外の鍵が使えない印が付いているかを返す
   * @returns 印が付いているか
   */
  async keysHeld(): Promise<boolean> {
    return (await this.storage.get("keys_held")) === true;
  }

  /**
   * 外の鍵を入れ直した時に印を外す。入れ直すルートはまだ無く、今はテストだけが呼ぶ
   * @returns 無し
   */
  // TODO(#47): GitHub App と Claude の鍵を入れ直すルートから呼ぶ
  async releaseKeys(): Promise<null> {
    await this.storage.put("keys_held", false);
    return null;
  }

  /**
   * その範囲と相手を止める権利を取る。同じ相手への止めが同時に来ても 1 つだけが取れる
   * @param scope 範囲
   * @param target 相手
   * @param stopId 取れた時に使う、止めた記録の ID
   * @returns 取れたか
   */
  claimStop(scope: string, target: string, stopId: string): Promise<boolean> {
    return this.#serial(async () => {
      const open = await this.#open();
      const key = `${scope}|${target}`;
      if (open[key] !== undefined) return false;
      await this.storage.put("open_stops", { ...open, [key]: stopId });
      return true;
    });
  }

  /**
   * 止めた記録を再開する権利を取る。同じ記録の再開が同時に来ても 1 つだけが取れる
   * @param stopId 止めた記録の ID
   * @returns 取れたか
   */
  releaseStop(stopId: string): Promise<boolean> {
    return this.#serial(async () => {
      const released = await this.#released();
      if (released.includes(stopId)) return false;
      const open = await this.#open();
      await this.storage.put("open_stops", Object.fromEntries(Object.entries(open).filter(([, id]) => id !== stopId)));
      await this.storage.put("released_stops", [...released, stopId]);
      return true;
    });
  }

  /**
   * 再開する権利を、再開が途中で失敗した時に返す。止めたままに戻し、もう一度再開できるようにする
   * @param scope 範囲
   * @param target 相手
   * @param stopId 止めた記録の ID
   * @returns 無し
   */
  restoreStop(scope: string, target: string, stopId: string): Promise<null> {
    return this.#serial(async () => {
      const released = await this.#released();
      await this.storage.put("released_stops", released.filter((id) => id !== stopId));
      await this.storage.put("open_stops", { ...(await this.#open()), [`${scope}|${target}`]: stopId });
      return null;
    });
  }

  /**
   * 止めた記録を取った権利を、記録を残せなかった時に返す
   * @param stopId 止めた記録の ID
   * @returns 無し
   */
  dropClaim(stopId: string): Promise<null> {
    return this.#serial(async () => {
      const open = await this.#open();
      await this.storage.put("open_stops", Object.fromEntries(Object.entries(open).filter(([, id]) => id !== stopId)));
      return null;
    });
  }

  /**
   * 止めている範囲と相手を読む
   * @returns 「範囲|相手」から止めた記録の ID への対応
   */
  async #open(): Promise<Record<string, string>> {
    const stored = await this.storage.get("open_stops");
    return stored === undefined ? {} : OpenStops.parse(stored);
  }

  /**
   * 再開した止めた記録の ID を読む
   * @returns ID
   */
  async #released(): Promise<string[]> {
    const stored = await this.storage.get("released_stops");
    return stored === undefined ? [] : Released.parse(stored);
  }

  /**
   * 読んでから書くまでの間に、ほかの呼び出しを割り込ませない
   * @param step 読んで書く操作
   * @returns 操作の答え
   */
  #serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(step, step);
    this.#chain = run.catch(() => null);
    return run;
  }
}
