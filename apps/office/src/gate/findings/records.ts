// 見つけて直す調べが読む、期間にかかる年ごとの記録の D1 を選ぶ (データの 2 章)
import { jstYear } from "@know-office/core";
import { type Bindings, RECORD_BINDINGS } from "../env.ts";

/** 記録の D1 */
export type RecordDb = NonNullable<Bindings["REC_2026"]>;

/**
 * 期間にかかる年の記録の D1 を返す
 * @param env バインディング
 * @param from 始め
 * @param to 終わり。含まない
 * @returns バインドした記録の D1
 */
export function recordDbs(env: Bindings, from: number, to: number): RecordDb[] {
  const out: RecordDb[] = [];
  for (let year = jstYear(from); year <= jstYear(to - 1); year += 1) {
    const name = RECORD_BINDINGS.find((b) => b === `REC_${String(year)}`);
    const db = name ? env[name] : undefined;
    if (db) out.push(db);
  }
  return out;
}
