// テーブルに共通のカラムの書き方。データの 3.1
import { integer, text } from "drizzle-orm/sqlite-core";

/**
 * UUID v7 の主の鍵
 * @returns id のカラム
 */
export const id = () => text("id").primaryKey();

/**
 * 協定世界時のミリ秒の時刻
 * @param name カラムの名前 (`<動き>_at`)
 * @returns 時刻のカラム
 */
export const time = (name: string) => integer(name);

/**
 * 真偽を 0 と 1 で持つカラム
 * @param name カラムの名前
 * @returns 真偽のカラム
 */
export const flag = (name: string) => integer(name, { mode: "boolean" });

/**
 * JSON を文字列で持つカラム。書く前に Zod で確かめる
 * @param name カラムの名前
 * @returns JSON のカラム
 */
export const json = (name: string) => text(name, { mode: "json" }).$type<unknown>();
