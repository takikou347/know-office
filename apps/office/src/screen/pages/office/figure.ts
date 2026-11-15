// 子犬の社員の姿。手本 (ももたん) に合わせた 2 頭身のシーズー風の子犬を、ふわふわの毛の層を重ねた丸い形で組み、することごとの形を当てる
import { CircleGeometry, type Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Vector3 } from "three";
import { type Face, applyFace, buildFace } from "./face.ts";
import { MAX_LAYERS, PHONE_WIDTH, type Paint, type Puff, furGeometry, furMaterial, setFurLayers, solid } from "./fur.ts";
import type { Pose } from "./motion.ts";
import { type Prop, type PropColors, addProp } from "./props.ts";
import type { OfficeTheme } from "./themes.ts";

export { PROPS, type Prop } from "./props.ts";

/** 子犬の大きさの倍率。部屋の机と比べて見分けやすい大きさにする */
export const PUPPY_SCALE = 1.6;

/** 電話の幅で子犬を大きくする倍率 */
const PHONE_PUPPY_SCALE = 2.1;

/**
 * 部屋の幅に合う子犬の大きさの倍率を返す。電話の幅では部屋が小さく見えるので、子犬を大きくする
 * @param width 部屋の幅 (CSS のピクセル)
 * @returns 倍率
 */
export function puppyScaleFor(width: number): number {
  return width < PHONE_WIDTH ? PHONE_PUPPY_SCALE : PUPPY_SCALE;
}

/**
 * 社員の毛色を部屋の案から返す。3 体は同じ子の毛色違い
 * @param theme 部屋の案
 * @param id 社員の id
 * @returns 毛色
 */
export function coatOf(theme: OfficeTheme, id: string): string {
  if (id === "builder") return theme.coatBuilder;
  if (id === "reviewer") return theme.coatReviewer;
  return theme.coatPresident;
}

/** 子犬の色 */
export interface PuppyColors extends PropColors {
  coat: Color;
  cream: Color;
  eye: Color;
  iris: Color;
  nose: Color;
  mouth: Color;
  /** 足元の丸い影 */
  shadow: Color;
}

/** 作った子犬 */
export interface Puppy {
  root: Group;
  body: Group;
  torso: Group;
  head: Group;
  ears: [Group, Group];
  front: [Group, Group];
  back: [Group, Group];
  tail: Group;
  face: Face;
  paper: Mesh;
  /** 描く毛の層の数を変える */
  setFur: (layers: number) => void;
}

/**
 * 0 から 1 へなめらかに変わる値を返す。e0 が e1 より大きい時は逆向きに変わる
 * @param e0 0 になる所
 * @param e1 1 になる所
 * @param x 値
 * @returns 0 から 1 の値
 */
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * 頭の塗り方を作る。毛色の頭に、額から鼻へ白い筋を通し、口の周りと顎を白くし、目の周りは毛色に残す
 * @param coat 毛色
 * @param cream クリーム色
 * @returns 塗る関数
 */
const headPaint =
  (coat: Color, cream: Color): Paint =>
  (p: Vector3, out: Color) => {
    const ax = Math.abs(p.x);
    const front = smooth(-0.02, 0.1, p.z);
    const blazeHalf = 0.035 + 0.06 * smooth(0.1, -0.06, p.y) + 0.03 * smooth(0.16, 0.24, p.y);
    const blaze = smooth(blazeHalf + 0.045, blazeHalf - 0.01, ax) * smooth(-0.2, -0.04, p.z);
    const muzzleTop = -0.04 - 0.55 * Math.max(0, ax - 0.06);
    const muzzle = smooth(muzzleTop + 0.03, muzzleTop - 0.035, p.y) * front;
    out.copy(coat).lerp(cream, Math.max(blaze, muzzle));
  };

/**
 * 胴の塗り方を作る。クリーム色の胴の背中と肩に毛色の模様を置き、胸は白く残す
 * @param coat 毛色
 * @param cream クリーム色
 * @returns 塗る関数
 */
const bodyPaint =
  (coat: Color, cream: Color): Paint =>
  (p: Vector3, out: Color) => {
    const saddle = smooth(0.02, 0.09, p.y) * smooth(0.17, 0.1, Math.abs(p.z + 0.02));
    const haunch = smooth(0.09, 0.14, Math.abs(p.x)) * smooth(0.06, 0.0, Math.abs(p.z + 0.15)) * smooth(0.09, 0.02, Math.abs(p.y));
    out.copy(cream).lerp(coat, Math.max(saddle, haunch) * 0.9);
  };

/**
 * 足元の丸い影を作る。子犬は日の光の影を落とさず、この影で置く。動く物が影を落とさなければ、影の地図を描き直さずに済む
 * @param color 影の色
 * @returns 床に寝かせた影
 */
export function footShadow(color: Color): Mesh {
  const shadow = new Mesh(new CircleGeometry(0.27, 24), new MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.006;
  return shadow;
}

/**
 * 子犬の姿を作る
 * @param colors 子犬の色
 * @param prop 役目の小物
 * @param paperColor くわえて運ぶ書類の色
 * @returns 子犬
 */
export function buildPuppy(colors: PuppyColors, prop: Prop, paperColor: Color): Puppy {
  const { material: fur, uniforms } = furMaterial(0.022, 150);
  const { material: longFur } = furMaterial(0.032, 130, uniforms);
  const geometries: ReturnType<typeof furGeometry>[] = [];
  const furry = (parent: Group, puffs: Puff[], paint: Paint, long = false, fine = false) => {
    const g = furGeometry(puffs, paint, fine ? [16, 11] : undefined);
    geometries.push(g);
    parent.add(new Mesh(g, long ? longFur : fur));
  };
  const cream = solid(colors.cream);
  const ear = colors.coat.clone().multiplyScalar(0.9);

  const root = new Group();
  root.scale.setScalar(PUPPY_SCALE);
  const body = new Group();
  root.add(body);
  root.add(footShadow(colors.shadow));

  // 胴: 頭より小さな丸い胴に、ふくらんだ胸とお尻
  const torso = new Group();
  torso.position.set(0, 0.23, 0);
  body.add(torso);
  furry(
    torso,
    [
      { at: [0, 0, -0.02], size: [0.18, 0.15, 0.2] },
      { at: [0, -0.005, 0.11], size: [0.165, 0.155, 0.12] },
      { at: [0, -0.015, -0.14], size: [0.165, 0.14, 0.12] },
    ],
    bodyPaint(colors.coat, colors.cream),
  );

  // 頭: 体より大きな丸く平たい顔。上にふさふさの毛を盛り、頬と口の周りをふくらませる
  const head = new Group();
  head.position.set(0, 0.56, 0.14);
  body.add(head);
  furry(
    head,
    [
      { at: [0, 0.02, 0.01], size: [0.28, 0.21, 0.23], reach: 0.6 },
      { at: [0, 0.14, -0.02], size: [0.22, 0.11, 0.18] },
      { at: [0.1, -0.08, 0.1], size: [0.12, 0.09, 0.09], reach: 0.5 },
      { at: [-0.1, -0.08, 0.1], size: [0.12, 0.09, 0.09], reach: 0.5 },
      { at: [0, -0.07, 0.16], size: [0.09, 0.065, 0.08], reach: 0.3 },
      { at: [0, -0.14, 0.07], size: [0.13, 0.065, 0.09], reach: 0.6 },
    ],
    headPaint(colors.coat, colors.cream),
    false,
    true,
  );
  const face = buildFace(head, { eye: colors.eye, iris: colors.iris, nose: colors.nose, mouth: colors.mouth, brow: ear });
  // 顔の周りから垂れる長い耳。上で頭に付き、肩の高さまで広がって垂れる
  const earAt = (side: number) => {
    const pivot = new Group();
    pivot.position.set(0.2 * side, 0.15, -0.04);
    // 上は細く頭に沿い、下へ広がって肩の高さまで垂れる 1 枚の房
    furry(
      pivot,
      [
        { at: [0.02 * side, -0.06, 0], size: [0.09, 0.12, 0.13] },
        { at: [0.04 * side, -0.18, 0.01], size: [0.1, 0.13, 0.13] },
        { at: [0.045 * side, -0.29, 0.015], size: [0.088, 0.07, 0.12] },
      ],
      solid(ear),
      true,
    );
    head.add(pivot);
    return pivot;
  };
  const ears: [Group, Group] = [earAt(-1), earAt(1)];
  addProp(head, prop, colors);

  // 短い脚と丸い前足
  const leg = (x: number, z: number) => {
    const pivot = new Group();
    pivot.position.set(x, 0.14, z);
    furry(
      pivot,
      [
        { at: [0, -0.05, 0], size: [0.065, 0.07, 0.065] },
        { at: [0, -0.105, 0.02], size: [0.068, 0.045, 0.078], reach: 0.6 },
      ],
      cream,
    );
    body.add(pivot);
    return pivot;
  };
  const front: [Group, Group] = [leg(-0.095, 0.12), leg(0.095, 0.12)];
  const back: [Group, Group] = [leg(-0.105, -0.13), leg(0.105, -0.13)];

  // 背中に巻く丸いふさふさのしっぽ
  const tail = new Group();
  tail.position.set(0, 0.32, -0.22);
  furry(
    tail,
    [
      { at: [0, 0.05, -0.03], size: [0.1, 0.11, 0.1] },
      { at: [0, 0.13, 0.03], size: [0.09, 0.08, 0.09] },
    ],
    (p, out) => {
      out.copy(colors.coat).lerp(colors.cream, smooth(0.0, 0.07, p.y));
    },
    true,
  );
  body.add(tail);

  // くわえて運ぶ書類
  const paper = new Mesh(new CylinderGeometry(0.02, 0.02, 0.2, 8), new MeshStandardMaterial({ color: paperColor }));
  paper.rotation.z = Math.PI / 2;
  paper.position.set(0, 0.48, 0.43);
  paper.visible = false;
  body.add(paper);

  const setFur = (layers: number) => {
    uniforms.layers.value = Math.min(layers, MAX_LAYERS);
    for (const g of geometries) setFurLayers(g, layers);
  };
  return { root, body, torso, head, ears, front, back, tail, face, paper, setFur };
}

/**
 * 子犬に、ある時刻の形を当てる
 * @param p 子犬
 * @param pose 形
 */
export function applyPuppyPose(p: Puppy, pose: Pose): void {
  p.root.visible = pose.visible;
  const sitting = pose.posture === "sit";
  const trouble = pose.face === "trouble";
  p.body.position.y = pose.lift;
  // おすわりは胴を起こし、後ろ足を前へたたむ
  p.torso.rotation.x = sitting ? -0.5 : 0;
  p.torso.position.y = sitting ? 0.22 : 0.23;
  p.head.position.y = sitting ? 0.6 : 0.56;
  p.head.position.z = sitting ? 0.08 : 0.14;
  p.head.rotation.y = pose.head;
  p.head.rotation.x = trouble ? 0.18 : 0;
  // 困り顔は耳を下げて内へ寄せる
  for (const [i, e] of p.ears.entries()) e.rotation.z = (i === 0 ? -1 : 1) * (0.05 + pose.ears) + (trouble ? (i === 0 ? 0.15 : -0.15) : 0);
  applyFace(p.face, pose.blink, trouble);
  const [fl, fr] = p.front;
  const [bl, br] = p.back;
  if (sitting) {
    // 机で打つ時は前足を前へ上げる
    const typing = pose.paws !== 0;
    fl.rotation.x = typing ? -1.1 + pose.paws : 0;
    fr.rotation.x = typing ? -1.1 - pose.paws : 0;
    bl.rotation.x = -1.3;
    br.rotation.x = -1.3;
  } else {
    fl.rotation.x = pose.legs;
    br.rotation.x = pose.legs;
    fr.rotation.x = -pose.legs;
    bl.rotation.x = -pose.legs;
  }
  p.tail.rotation.y = pose.tail;
}
