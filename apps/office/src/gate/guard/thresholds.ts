// 今の基準を settings の最新の行から読む。行が無い間は初期値をバージョン 0 として使う (自動停止の 3.1、3.3)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, DEFAULT_THRESHOLDS, Thresholds } from "@know-office/core";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { settings } from "../db/main.ts";

/**
 * 今の基準とそのバージョンを読む
 * @param db 今の状態の D1
 * @returns 基準とバージョン
 * @throws internal 置いた基準の形が違う時
 */
export async function loadThresholds(db: D1Database): Promise<{ thresholds: Thresholds; version: number }> {
  const [row] = await drizzle(db).select().from(settings).where(eq(settings.key, "guard.thresholds")).orderBy(desc(settings.version)).limit(1);
  if (!row) return { thresholds: DEFAULT_THRESHOLDS, version: 0 };
  const parsed = Thresholds.safeParse(row.value);
  // 形の違う基準で数えると止めるべき物を見逃すので、読めない時は失敗にする
  if (!parsed.success) throw new AppError("internal", "guard.thresholds の形が違う");
  return { thresholds: parsed.data, version: row.version };
}
