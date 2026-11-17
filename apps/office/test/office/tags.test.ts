import { describe, expect, it } from "vitest";
import { type TagBox, createTagSizer, separateBoxes, spreadTags } from "../../src/screen/pages/office/tags.ts";

// 名札が重ならないように、上にずらす。画面の全体の 3.2

/**
 * 名札の箱を作る
 * @param id 社員の id
 * @param x 真ん中の横の位置
 * @param bottom 下の端の位置
 * @returns 幅 60、高さ 20 の名札
 */
const tag = (id: string, x: number, bottom: number): TagBox => ({ id, x, bottom, width: 60, height: 20 });

/**
 * 2 つの名札がずらした後に重なるかを返す
 * @param a 名札
 * @param b 名札
 * @param shift ずらす量
 * @returns 重なる時は true
 */
const overlaps = (a: TagBox, b: TagBox, shift: Record<string, number>) => {
  const top = (t: TagBox) => t.bottom - t.height - (shift[t.id] ?? 0);
  const horizontal = Math.abs(a.x - b.x) < (a.width + b.width) / 2;
  const vertical = top(a) < top(b) + b.height && top(b) < top(a) + a.height;
  return horizontal && vertical;
};

describe("名札をずらす", () => {
  it("重ならない名札はずらさない", () => {
    expect(spreadTags([tag("a", 0, 100), tag("b", 200, 100)])).toEqual({ a: 0, b: 0 });
  });

  it("重なる 2 つは、奥 (上) の名札を上へずらす", () => {
    const tags = [tag("front", 10, 120), tag("back", 0, 110)];
    const shift = spreadTags(tags);
    expect(shift["front"]).toBe(0);
    expect(shift["back"]).toBeGreaterThan(0);
    expect(overlaps(tags[0] ?? tag("", 0, 0), tags[1] ?? tag("", 0, 0), shift)).toBe(false);
  });

  it("3 つが重なっても、どの 2 つも重ならないようにずらす", () => {
    const tags = [tag("a", 0, 100), tag("b", 5, 100), tag("c", 10, 100)];
    const shift = spreadTags(tags);
    const pairs = tags.flatMap((a) => tags.filter((b) => b !== a).map((b) => overlaps(a, b, shift)));
    expect(pairs).toEqual([false, false, false, false, false, false]);
  });

  it("横にちょうど触れるだけなら重ならない", () => {
    expect(spreadTags([tag("a", 0, 100), tag("b", 60, 100)])).toEqual({ a: 0, b: 0 });
  });
});

/**
 * 測った回数を数える、名札の大きさを測る関数を作る
 * @returns 測る関数と、id ごとの測った回数
 */
const counter = () => {
  const counts: Record<string, number> = {};
  const measure = (id: string) => {
    counts[id] = (counts[id] ?? 0) + 1;
    return { width: 60, height: 20 };
  };
  return { measure, counts };
};

describe("名札の大きさ", () => {
  it("同じ字の名札は、描くたびに測り直さない", () => {
    const { measure, counts } = counter();
    const sizer = createTagSizer(measure);
    for (let frame = 0; frame < 3; frame++) {
      expect(sizer.sizeOf("a", "社長 働いている")).toEqual({ width: 60, height: 20 });
      sizer.sizeOf("b", "作る役 待っている");
    }
    expect(counts).toEqual({ a: 1, b: 1 });
  });

  it("字が変わった名札だけを測り直す", () => {
    const { measure, counts } = counter();
    const sizer = createTagSizer(measure);
    sizer.sizeOf("a", "社長 働いている");
    sizer.sizeOf("b", "作る役 待っている");
    sizer.sizeOf("a", "社長 止めた");
    sizer.sizeOf("b", "作る役 待っている");
    expect(counts).toEqual({ a: 2, b: 1 });
  });

  it("字の形が変わったら、全部を測り直す", () => {
    const { measure, counts } = counter();
    const sizer = createTagSizer(measure);
    sizer.sizeOf("a", "社長 働いている");
    sizer.sizeOf("b", "作る役 待っている");
    sizer.reset();
    sizer.sizeOf("a", "社長 働いている");
    sizer.sizeOf("b", "作る役 待っている");
    expect(counts).toEqual({ a: 2, b: 2 });
  });
});

const hit = (id: string, left: number, top: number, width = 40, height = 60) => ({ id, left, top, width, height });
const hitsOverlap = (a: ReturnType<typeof hit>, b: ReturnType<typeof hit>) =>
  Math.min(a.left + a.width, b.left + b.width) > Math.max(a.left, b.left) && Math.min(a.top + a.height, b.top + b.height) > Math.max(a.top, b.top);

describe("社員のリンクの箱を分ける", () => {
  it("重ならない箱はそのまま返す", () => {
    const boxes = [hit("a", 0, 0), hit("b", 100, 0)];
    expect(separateBoxes(boxes)).toEqual(boxes);
  });

  it("横に重なる 2 つは、重なりの真ん中で左右に分ける", () => {
    const [a, b] = separateBoxes([hit("a", 0, 0), hit("b", 20, 10)]);
    expect(a).toEqual(hit("a", 0, 0, 30, 60));
    expect(b).toEqual(hit("b", 30, 10, 30, 60));
  });

  it("縦に重なる 2 つは、重なりの真ん中で上下に分ける", () => {
    const [a, b] = separateBoxes([hit("a", 0, 40), hit("b", 5, 0)]);
    expect(b).toEqual(hit("b", 5, 0, 40, 50));
    expect(a).toEqual(hit("a", 0, 50, 40, 50));
  });

  it("3 つが重なっても、どの 2 つも重ならない", () => {
    const out = separateBoxes([hit("a", 0, 0), hit("b", 20, 20), hit("c", 10, 40)]);
    for (const [i, a] of out.entries()) for (const b of out.slice(i + 1)) expect(hitsOverlap(a, b)).toBe(false);
  });
});
