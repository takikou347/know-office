// 選択肢のマスタデータの形。画面のセレクトの選択肢と名前、ゲートウェイの入力の確かめを、同じ並びから作る
import { z } from "zod";

/** マスタデータの 1 項目 */
export interface MasterItem<V extends string> {
  /** 保存と API に使う値 */
  value: V;
  /** 画面に出す日本語の名前 */
  label: string;
  /** 選ぶ時に添える 1 行の説明 */
  note?: string;
}

/** マスタデータ。並びの順が画面に出す順になる */
export type Master<V extends string> = readonly MasterItem<V>[];

/**
 * マスタデータを作る。値の重なりを型と実行の両方で断る
 * @param items 画面に出す順の項目
 * @returns 同じ項目
 * @throws Error 値が重なった時
 */
export function defineMaster<const V extends string>(items: readonly MasterItem<V>[]): Master<V> {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.value)) throw new Error(`マスタデータの値が重なっている: ${item.value}`);
    seen.add(item.value);
  }
  return items;
}

/**
 * マスタデータの値だけを受ける Zod スキーマ。ゲートウェイの入力の確かめに使う
 * @param master マスタデータ
 * @returns 値の enum
 */
export function masterSchema<V extends string>(master: Master<V>) {
  const [first, ...rest] = master.map((item) => item.value);
  if (first === undefined) throw new Error("空のマスタデータは確かめに使えない");
  return z.enum([first, ...rest]);
}

/**
 * 値の画面の名前を引く。知らない値はそのまま返す
 * @param master マスタデータ
 * @param value 値
 * @returns 名前
 */
export function labelOf<V extends string>(master: Master<V>, value: V | string): string {
  return master.find((item) => item.value === value)?.label ?? value;
}

/**
 * セレクトの選択肢を作る。knowidea-ui の Select の options の形
 * @param master マスタデータ
 * @returns 値と名前の並び
 */
export function optionsOf<V extends string>(master: Master<V>): { value: V; label: string }[] {
  return master.map(({ value, label }) => ({ value, label }));
}
