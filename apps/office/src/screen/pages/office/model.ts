// 子犬のモデル。Blender で作った .glb (形、骨、動き、表情) と毛の模様を読み、社員ごとの毛色の子犬にする。読めない時は形を組んだ子犬に戻す
import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  type Object3D,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector2,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { disposeScene } from "./cleanup.ts";
import { footShadow } from "./figure.ts";
import type { Activity, Pose } from "./motion.ts";
import { type Prop, type PropColors, addProp } from "./props.ts";

/** モデルと模様の置き場。apps/office/assets-src/puppy/build.py が書く */
export const PUPPY_MODEL_DIR = "/models/puppy/";

/** モデルに入っている動き。まばたきはほかの動きと一緒に流す */
export const PUPPY_CLIPS = ["wait", "sit", "work", "walk", "give", "blink"] as const;

/** モデルの動きの名前 */
export type PuppyClip = (typeof PUPPY_CLIPS)[number];

/** モデルの表情 (形の鍵)。通常は鍵を当てない形 */
export const PUPPY_EXPRESSIONS = ["sleepy", "trouble"] as const;

/** 毛色。3 体は同じ子の毛色違いで、毛色ごとに色の模様を 1 枚持つ */
export const PUPPY_COATS = ["president", "builder", "reviewer"] as const;

/** 毛色の名前 */
export type PuppyCoat = (typeof PUPPY_COATS)[number];

/** 読み込みを待つ時間 (ミリ秒)。過ぎたら形を組んだ子犬で部屋を出す */
export const MODEL_WAIT_MS = 3000;

/** 頭の真ん中 (モデルの単位)。小物と書類はここからの位置で置く */
const HEAD_CENTER = [0, 0.56, 0.14] as const;

/** 毛の法線の模様の強さ */
const NORMAL_STRENGTH = 0.9;

/** 毛の中で散った光の分の明るさ。影の側も少し明るくし、綿やフェルトのように柔らかく見せる */
const FUR_GLOW = 0.16;

/** 読み込んだ .glb の中身 */
export interface LoadedGltf {
  scene: Group;
  animations: AnimationClip[];
}

/** モデルと模様を読む口。テストでは置き場のファイルを読む口を渡す */
export interface ModelSource {
  /** .glb を読む */
  gltf: (url: string) => Promise<LoadedGltf>;
  /** 模様を読む */
  texture: (url: string) => Promise<Texture>;
}

/** 読み込んだ子犬のモデル。3 体で分け合う */
export interface PuppyModel {
  /** 写しの元にする形と骨 */
  scene: Group;
  /** 動き */
  clips: AnimationClip[];
  /** 毛色ごとの色の模様 */
  coats: Record<PuppyCoat, Texture>;
  /** 毛の流れの法線の模様 */
  normal: Texture;
  /** 形、材質、模様を捨てる */
  dispose: () => void;
}

/** モデルから作った 1 体の子犬 */
export interface ModelPuppy {
  /** 部屋に置く物。位置、向き、大きさはここに当てる */
  root: Group;
  /** 子犬の姿 (VRM と差し替える時に隠す) */
  body: Object3D;
  /** くわえて運ぶ書類 */
  paper: Mesh;
  /** ある時刻の形を当てる。動きは時刻から決め、止めて描く時は時刻 0 で同じ絵にする */
  apply: (pose: Pose, clip: PuppyClip, t: number) => void;
  /** 今流している動き */
  playing: () => PuppyClip | null;
}

/**
 * 社員の id から毛色を決める
 * @param staffId 社員の id
 * @returns 毛色
 */
export function coatIdOf(staffId: string): PuppyCoat {
  if (staffId === "builder" || staffId === "reviewer") return staffId;
  return "president";
}

/**
 * することから流す動きを決める
 * @param activity すること。書類を渡す間は give
 * @returns 動きの名前
 */
export function clipOf(activity: Activity | "give"): PuppyClip {
  const map = { work: "work", wait: "wait", walk: "walk", give: "give", stopped: "sit", off: "sit" } as const;
  return map[activity];
}

/**
 * ブラウザで読む口を返す。模様は img で読む (blob: の URL を fetch しないので、画面の CSP の connect-src を広げずに済む)
 * @returns 読む口
 */
export function browserSource(): ModelSource {
  return {
    gltf: (url) => new GLTFLoader().loadAsync(url),
    texture: (url) => new TextureLoader().loadAsync(url),
  };
}

/** 形の鍵の名前から番号と、鍵ごとの重さ */
interface Morphs {
  dictionary: Record<string, number>;
  influences: number[];
}

/**
 * 物の下の、形の鍵を持つ形の鍵を集める
 * @param root 探す元
 * @returns 形の鍵の並び
 */
function morphsOf(root: Object3D): Morphs[] {
  const found: Morphs[] = [];
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const dictionary: Record<string, number> | undefined = o.morphTargetDictionary;
    const influences: number[] | undefined = o.morphTargetInfluences;
    if (dictionary && influences) found.push({ dictionary, influences });
  });
  return found;
}

/**
 * モデルに欠けている動きと表情の名前を返す
 * @param gltf 読んだ中身
 * @returns 欠けている名前の並び
 */
function missingOf(gltf: LoadedGltf): string[] {
  const clips = new Set(gltf.animations.map((c) => c.name));
  const faces = morphsOf(gltf.scene);
  const missingClips = PUPPY_CLIPS.filter((c) => !clips.has(c));
  const missingFaces = PUPPY_EXPRESSIONS.filter((e) => faces.length === 0 || faces.some((m) => m.dictionary[e] === undefined));
  return [...missingClips, ...missingFaces];
}

/**
 * 子犬のモデルと毛の模様を読む
 * @param source 読む口
 * @param dir 置き場
 * @returns 読んだモデル
 * @throws Error 読めない時と、動きか表情が欠けている時
 */
export async function loadPuppyModel(source: ModelSource = browserSource(), dir: string = PUPPY_MODEL_DIR): Promise<PuppyModel> {
  const results = await Promise.allSettled([
    source.gltf(`${dir}puppy.glb`),
    source.texture(`${dir}normal.webp`),
    ...PUPPY_COATS.map((c) => source.texture(`${dir}${c}.webp`)),
  ] as const);
  const [gltfResult, normalResult, ...coatResults] = results;
  const textures = [normalResult, ...coatResults].flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const scene = gltfResult.status === "fulfilled" ? gltfResult.value.scene : null;
  // 1 つでも読めなければ、読めた物を捨てて投げる
  const failed = results.find((r) => r.status === "rejected");
  const missing = gltfResult.status === "fulfilled" ? missingOf(gltfResult.value) : [];
  if (failed || missing.length > 0 || gltfResult.status !== "fulfilled" || normalResult.status !== "fulfilled") {
    for (const t of textures) t.dispose();
    if (scene) disposeScene(scene, []);
    if (failed?.status === "rejected") throw failed.reason instanceof Error ? failed.reason : new Error("子犬のモデルを読めない");
    throw new Error(`子犬のモデルに無い: ${missing.join(", ")}`);
  }
  // 書き出した UV は glTF の向きなので、模様を上下に返さない
  const normal = normalResult.value;
  normal.flipY = false;
  normal.colorSpace = NoColorSpace;
  const coatAt = (i: number) => {
    const r = coatResults[i];
    if (r?.status !== "fulfilled") throw new Error(`${PUPPY_COATS[i] ?? i} の模様が無い`);
    r.value.flipY = false;
    r.value.colorSpace = SRGBColorSpace;
    return r.value;
  };
  const coats: Record<PuppyCoat, Texture> = { president: coatAt(0), builder: coatAt(1), reviewer: coatAt(2) };
  const model = gltfResult.value;
  return {
    scene: model.scene,
    clips: model.animations,
    coats,
    normal,
    dispose: () => {
      disposeScene(model.scene, []);
      normal.dispose();
      for (const t of Object.values(coats)) t.dispose();
    },
  };
}

/**
 * 子犬のモデルを読む。読めない時と、決めた時間までに読めない時は null を返し、後から届いたモデルは捨てる
 * @param source 読む口
 * @param waitMs 待つ時間 (ミリ秒)
 * @returns 読んだモデルか null
 */
export async function loadPuppyModelOrNull(source: ModelSource = browserSource(), waitMs: number = MODEL_WAIT_MS): Promise<PuppyModel | null> {
  const loading = loadPuppyModel(source);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  const first = await Promise.race([loading.catch(() => null), timeout]);
  clearTimeout(timer);
  if (first === null) {
    loading.then(
      (late) => late.dispose(),
      () => undefined,
    );
  }
  return first;
}

/**
 * モデルから 1 体の子犬を作る。形と骨を写し、毛色の模様の材質を当て、頭の骨に小物と書類を付ける
 * @param model 読んだモデル
 * @param coat 毛色
 * @param prop 役目の小物
 * @param colors 小物と影の色
 * @param paperColor 書類の色
 * @param phase 動きの時刻のずらし (ミリ秒)。3 体が同じ時にまばたきしないようにする
 * @returns 子犬
 */
export function buildModelPuppy(model: PuppyModel, coat: PuppyCoat, prop: Prop, colors: PropColors & { shadow: Color }, paperColor: Color, phase = 0): ModelPuppy {
  const body = clone(model.scene);
  const fur = new MeshStandardMaterial({
    map: model.coats[coat],
    normalMap: model.normal,
    // UV から接線を作る時は、glTF の法線の模様の緑を返す (GLTFLoader と同じ)
    normalScale: new Vector2(NORMAL_STRENGTH, -NORMAL_STRENGTH),
    roughness: 1,
    metalness: 0,
    emissive: new Color(FUR_GLOW, FUR_GLOW, FUR_GLOW),
    emissiveMap: model.coats[coat],
  });
  body.traverse((o) => {
    if (o instanceof Mesh && o.name.startsWith("Fur")) o.material = fur;
  });
  const faces = morphsOf(body);

  // 小物と書類は頭の骨に付ける。休みの形で頭の真ん中に置いてから骨へ移し、骨と一緒に動かす
  const anchor = new Group();
  anchor.position.set(...HEAD_CENTER);
  body.add(anchor);
  body.updateMatrixWorld(true);
  body.getObjectByName("head")?.attach(anchor);
  addProp(anchor, prop, colors);
  const paper = new Mesh(new CylinderGeometry(0.02, 0.02, 0.2, 8), new MeshStandardMaterial({ color: paperColor }));
  paper.rotation.z = Math.PI / 2;
  paper.position.set(0, -0.08, 0.29);
  paper.visible = false;
  anchor.add(paper);

  const root = new Group();
  root.add(body, footShadow(colors.shadow));
  const mixer = new AnimationMixer(body);
  const actions = new Map<string, AnimationAction>(model.clips.map((c) => [c.name, mixer.clipAction(c)]));
  actions.get("blink")?.play();
  let current: PuppyClip | null = null;

  return {
    root,
    body,
    paper,
    apply: (pose, clip, t) => {
      root.visible = pose.visible;
      if (current !== clip) {
        if (current) actions.get(current)?.stop();
        actions.get(clip)?.play();
        current = clip;
      }
      mixer.setTime((t + phase) / 1000);
      // 困り顔は動きの後に当てる。まばたきの動きは形の鍵の重さを全部書くので、先に当てると消える
      for (const m of faces) {
        const at = m.dictionary["trouble"];
        if (at !== undefined) m.influences[at] = pose.face === "trouble" ? 1 : 0;
      }
    },
    playing: () => current,
  };
}
