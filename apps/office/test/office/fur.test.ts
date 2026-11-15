import { Color } from "three";
import { describe, expect, it } from "vitest";
import { MAX_LAYERS, furGeometry, setFurLayers, solid } from "../../src/screen/pages/office/fur.ts";

// 子犬の毛の層を 1 つの形にまとめ、描く層の数を描く範囲で変える。画面の 3.4

/**
 * 毛の形を 2 つまとめた形を作る
 * @returns 層を重ねた形
 */
const sample = () =>
  furGeometry(
    [
      { at: [0, 0, 0], size: [0.2, 0.2, 0.2] },
      { at: [0.1, 0, 0], size: [0.1, 0.1, 0.1] },
    ],
    solid(new Color("#ffffff")),
  );

describe("毛の層", () => {
  it("下地と 1 層ごとの三角の数を持つ", () => {
    const g = sample();
    expect(Number(g.userData["baseIndices"])).toBeGreaterThan(0);
    expect(Number(g.userData["layerIndices"])).toBeGreaterThan(0);
    expect(g.index?.count).toBe(Number(g.userData["baseIndices"]) + Number(g.userData["layerIndices"]) * MAX_LAYERS);
  });

  it("描く範囲は、下地と描く層の数の分になる", () => {
    const g = sample();
    const base = Number(g.userData["baseIndices"]);
    const per = Number(g.userData["layerIndices"]);
    setFurLayers(g, 2);
    expect(g.drawRange.count).toBe(base + per * 2);
    setFurLayers(g, 3);
    expect(g.drawRange.count).toBe(base + per * 3);
  });
});
