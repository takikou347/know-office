import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene, Texture } from "three";
import { describe, expect, it } from "vitest";
import { disposeScene } from "../../src/screen/pages/office/cleanup.ts";

// 部屋を閉じる時の後始末。形、材質、模様を捨てる。画面の 3.4

/**
 * three.js の物が捨てられた事を数える
 * @param thing 捨てる時に dispose の知らせを出す物
 * @returns 捨てられたかを返す関数
 */
function watch(thing: { addEventListener: (type: "dispose", fn: () => void) => void }) {
  let gone = false;
  thing.addEventListener("dispose", () => (gone = true));
  return () => gone;
}

describe("後始末", () => {
  it("部屋の中の形、材質、模様を、入れ子の奥まで捨てる", () => {
    const scene = new Scene();
    const geometry = new BoxGeometry();
    const map = new Texture();
    const material = new MeshStandardMaterial({ map });
    const inner = new Group();
    inner.add(new Mesh(geometry, material));
    scene.add(inner);
    const checks = [watch(geometry), watch(material), watch(map)];
    disposeScene(scene, []);
    expect(checks.map((gone) => gone())).toEqual([true, true, true]);
  });

  it("部屋に置いていない材質 (使い回しの置き場) も捨てる", () => {
    const spare = new MeshStandardMaterial();
    const gone = watch(spare);
    disposeScene(new Scene(), [spare]);
    expect(gone()).toBe(true);
  });
});
