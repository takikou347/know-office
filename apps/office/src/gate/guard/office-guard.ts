// 全体とサービスのシグナルの数と、全体を止めた後の外の鍵の印。GuardDO が持ち、テストは同じ物を手元の入れ物で使う (自動停止の 2 章、3.5)
import { AppError, countOffice, isStaffEvent, emptyOfficeCounts, GuardEvent, OfficeCounts, Thresholds } from "@know-office/core";
import { z } from "zod";
import type { GuardStorage } from "../auth/guard-book.ts";
import type { Observed } from "./deps.ts";
import { RECENT_OPS } from "./staff-guard.ts";

const RecentOps = z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])));

/** 全体とサービスのシグナルを数える。時刻はすべて引数で受ける */
export class OfficeGuard {
  /**
   * @param storage 記憶の入れ物。GuardBook と同じ物
   */
  constructor(private readonly storage: GuardStorage) {}

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
   * 外の鍵を入れ直した時に印を外す。入れ直すルートが呼ぶ
   * @returns 無し
   */
  async releaseKeys(): Promise<null> {
    await this.storage.put("keys_held", false);
    return null;
  }
}
