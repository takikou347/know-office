import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AnimationClip, Color, Group, type Material, Mesh, MeshStandardMaterial, type Object3D, SkinnedMesh, Texture } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import {
  type LoadedGltf,
  type ModelSource,
  PUPPY_CLIPS,
  PUPPY_COATS,
  PUPPY_EXPRESSIONS,
  buildModelPuppy,
  clipOf,
  coatIdOf,
  loadPuppyModel,
  loadPuppyModelOrNull,
} from "../../src/screen/pages/office/model.ts";
import { poseOf } from "../../src/screen/pages/office/motion.ts";
import { THEME_IDS, themeOf } from "../../src/screen/pages/office/themes.ts";

// 子犬のモデル (Blender で作った .glb と毛のテクスチャ)。読めた時はモデルの子犬、読めない時は形を組んだ子犬。画面の 3.4

const DIR = join(import.meta.dirname, "../../public/models/puppy");
const SOURCE_DIR = join(import.meta.dirname, "../../assets-src/puppy");

/**
 * 置き場のファイルを読んで返す口を作る。模様は中身を読まずに作り物を返す (node には画像を読む口が無い)
 * @param textures 読んだ模様の URL を貯める並び
 * @returns 読む口
 */
function diskSource(textures: string[] = []): ModelSource {
  return {
    gltf: async (url) => {
      const file = readFileSync(join(DIR, url.replace("/models/puppy/", "")));
      const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
      return new GLTFLoader().parseAsync(buffer, "");
    },
    texture: async (url) => {
      textures.push(url);
      return new Texture();
    },
  };
}

/**
 * 置き場のファイルの大きさを返す
 * @param name ファイルの名前
 * @returns バイト数
 */
const size = (name: string) => statSync(join(DIR, name)).size;

/**
 * 後から外で解ける約束を作る
 * @returns 約束と、解く関数
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve: (value) => resolve?.(value) };
}

/** 作り物の色 */
const colors = { gold: new Color("#e8b94a"), pen: new Color("#f2c94c"), frame: new Color("#3a2a20"), shadow: new Color("#231917") };

/**
 * 物の下の、名前の合う物を探す
 * @param root 探す元
 * @param test 合うか
 * @returns 見つけた物の並び
 */
function findAll<T extends Object3D>(root: Object3D, test: (o: Object3D) => o is T): T[] {
  const found: T[] = [];
  root.traverse((o) => {
    if (test(o)) found.push(o);
  });
  return found;
}

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

describe("子犬のモデル", () => {
  it("モデルを読むと、動きの名前と表情がそろい、3 体の毛色の模様を読む", async () => {
    const textures: string[] = [];
    const model = await loadPuppyModel(diskSource(textures));
    const names = model.clips.map((c) => c.name);
    for (const clip of PUPPY_CLIPS) expect(names).toContain(clip);
    const morphs = findAll(model.scene, (o): o is Mesh => o instanceof Mesh && o.morphTargetDictionary !== undefined);
    expect(morphs.length).toBeGreaterThan(0);
    for (const m of morphs) for (const e of PUPPY_EXPRESSIONS) expect(Object.keys(m.morphTargetDictionary ?? {})).toContain(e);
    expect(findAll(model.scene, (o): o is SkinnedMesh => o instanceof SkinnedMesh).length).toBeGreaterThan(0);
    expect(Object.keys(model.coats).toSorted()).toEqual([...PUPPY_COATS].toSorted());
    expect(textures.toSorted()).toEqual(["/models/puppy/builder.webp", "/models/puppy/normal.webp", "/models/puppy/president.webp", "/models/puppy/reviewer.webp"]);
  });

  it("モデルと 1 体の毛の模様を合わせて 1 MB 以下", () => {
    const coat = Math.max(...PUPPY_COATS.map((c) => size(`${c}.webp`)));
    expect(size("puppy.glb") + size("normal.webp") + coat).toBeLessThanOrEqual(1_000_000);
  });

  it("モデルを作る時の毛色と顔の色は、どの部屋の案の色とも同じ", () => {
    const made: unknown = JSON.parse(readFileSync(join(SOURCE_DIR, "colors.json"), "utf8"));
    for (const id of THEME_IDS) {
      const t = themeOf(id);
      expect(made).toEqual({
        cream: t.furCream,
        president: t.coatPresident,
        builder: t.coatBuilder,
        reviewer: t.coatReviewer,
        eye: t.eye,
        iris: t.iris,
        nose: t.nose,
        mouth: t.mouth,
      });
    }
  });

  it("社員の id から毛色を決める", () => {
    expect(coatIdOf("president")).toBe("president");
    expect(coatIdOf("builder")).toBe("builder");
    expect(coatIdOf("reviewer")).toBe("reviewer");
  });

  it("することごとに動きを選ぶ", () => {
    expect(clipOf("work")).toBe("work");
    expect(clipOf("wait")).toBe("wait");
    expect(clipOf("walk")).toBe("walk");
    expect(clipOf("give")).toBe("give");
    expect(clipOf("stopped")).toBe("sit");
    expect(clipOf("off")).toBe("sit");
  });
});

describe("子犬のモデルを読めない時", () => {
  it(".glb を読めなければ、形を組んだ子犬に戻す (null を返す)", async () => {
    const source = { ...diskSource(), gltf: () => Promise.reject(new Error("404")) };
    expect(await loadPuppyModelOrNull(source)).toBeNull();
  });

  it("毛の模様を読めなければ、形を組んだ子犬に戻す", async () => {
    const source = { ...diskSource(), texture: () => Promise.reject(new Error("404")) };
    expect(await loadPuppyModelOrNull(source)).toBeNull();
  });

  it("動きが欠けたモデルは使わない", async () => {
    const source: ModelSource = {
      gltf: async () => ({ scene: new Group(), animations: [new AnimationClip("walk", 1, [])] }),
      texture: async () => new Texture(),
    };
    await expect(loadPuppyModel(source)).rejects.toThrow(/wait/);
    expect(await loadPuppyModelOrNull(source)).toBeNull();
  });

  it("決めた時間までに読めなければ待たずに戻し、後から届いたモデルは捨てる", async () => {
    const { promise: late, resolve: arrive } = deferred<LoadedGltf>();
    const real = diskSource();
    const loaded = await real.gltf("/models/puppy/puppy.glb");
    const meshes = findAll(loaded.scene, (o): o is Mesh => o instanceof Mesh);
    const gone = meshes.map((m) => watch(m.geometry));
    expect(await loadPuppyModelOrNull({ ...real, gltf: () => late }, 20)).toBeNull();
    arrive(loaded);
    await new Promise((r) => setTimeout(r, 20));
    expect(gone.every((g) => g())).toBe(true);
  });
});

describe("モデルの子犬", () => {
  it("社員ごとの毛色の模様を当て、法線の模様は 3 体で分け合う", async () => {
    const model = await loadPuppyModel(diskSource());
    const furOf = (coat: (typeof PUPPY_COATS)[number]) => {
      const p = buildModelPuppy(model, coat, null, colors, new Color("#ffffff"));
      const fur = findAll(p.root, (o): o is SkinnedMesh => o instanceof SkinnedMesh && o.name.startsWith("Fur"))[0];
      const m: Material | Material[] | undefined = fur?.material;
      if (!(m instanceof MeshStandardMaterial)) throw new Error("毛の材質が無い");
      return m;
    };
    const [a, b, c] = [furOf("president"), furOf("builder"), furOf("reviewer")];
    expect(a.map).toBe(model.coats.president);
    expect(b.map).toBe(model.coats.builder);
    expect(c.map).toBe(model.coats.reviewer);
    expect(a.normalMap).toBe(model.normal);
    expect(b.normalMap).toBe(model.normal);
  });

  it("することの動きを流し、止めた時は困り顔にし、時刻 0 では目を開けている", async () => {
    const model = await loadPuppyModel(diskSource());
    const p = buildModelPuppy(model, "builder", "pen", colors, new Color("#ffffff"));
    const face = findAll(p.root, (o): o is Mesh => o instanceof Mesh && o.morphTargetDictionary?.["trouble"] !== undefined)[0];
    if (!face?.morphTargetInfluences || !face.morphTargetDictionary) throw new Error("表情が無い");
    const trouble = face.morphTargetDictionary["trouble"] ?? -1;
    const sleepy = face.morphTargetDictionary["sleepy"] ?? -1;
    p.apply(poseOf("walk", 0), "walk", 0);
    expect(p.playing()).toBe("walk");
    expect(face.morphTargetInfluences[sleepy]).toBe(0);
    p.apply(poseOf("stopped", 0), "sit", 0);
    expect(p.playing()).toBe("sit");
    expect(face.morphTargetInfluences[trouble]).toBe(1);
    p.apply(poseOf("wait", 0), "wait", 0);
    expect(face.morphTargetInfluences[trouble]).toBe(0);
    // まばたきの動きで、3.7 秒の周期の終わりに目を閉じる
    p.apply(poseOf("wait", 3600), "wait", 3600);
    expect(face.morphTargetInfluences[sleepy]).toBe(1);
  });

  it("退勤した時は姿を出さない", async () => {
    const model = await loadPuppyModel(diskSource());
    const p = buildModelPuppy(model, "president", "crown", colors, new Color("#ffffff"));
    p.apply(poseOf("off", 0), "sit", 0);
    expect(p.root.visible).toBe(false);
  });

  it("モデルを捨てると、形、材質、模様を捨てる", async () => {
    const model = await loadPuppyModel(diskSource());
    const meshes = findAll(model.scene, (o): o is Mesh => o instanceof Mesh);
    const checks = [watch(model.normal), ...PUPPY_COATS.map((c) => watch(model.coats[c])), ...meshes.map((m) => watch(m.geometry))];
    model.dispose();
    expect(checks.every((gone) => gone())).toBe(true);
  });
});
