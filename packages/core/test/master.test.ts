// 選択肢のマスタデータの形。セレクトの選択肢、名前、入力の確かめを同じ並びから作る (詳細設計の目次)
import { describe, expect, it } from "vitest";
import { defineMaster, labelOf, masterSchema, optionsOf } from "../src/master/master.ts";

const SIZES = defineMaster([
  { value: "s", label: "小" },
  { value: "m", label: "中", note: "迷ったらこれ" },
]);

describe("マスタデータ", () => {
  it("並びの順でセレクトの選択肢と名前を作り、知らない値はそのまま出す", () => {
    expect(optionsOf(SIZES)).toEqual([{ value: "s", label: "小" }, { value: "m", label: "中" }]);
    expect(labelOf(SIZES, "m")).toBe("中");
    expect(labelOf(SIZES, "x")).toBe("x");
  });

  it("入力の確かめはマスタデータの値だけを通す", () => {
    expect(masterSchema(SIZES).safeParse("s").success).toBe(true);
    expect(masterSchema(SIZES).safeParse("x").success).toBe(false);
  });

  it("値の重なったマスタデータは作らない", () => {
    expect(() => defineMaster([{ value: "s", label: "小" }, { value: "s", label: "小さい" }])).toThrow("重なっている");
  });
});
