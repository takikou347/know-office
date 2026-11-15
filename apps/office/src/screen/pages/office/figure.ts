// 社員の姿を、基本の形の重ねで作る 2 頭身の人形。丸い頭に髪をかぶせ、服の色の胴、腕と手、膝で曲がる足を付ける。後から glTF か VRM のモデルに差し替えられる (avatars.ts)
import {
  CapsuleGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  SphereGeometry,
  TorusGeometry,
} from "three";
import type { Pose } from "./motion.ts";

/** 社員ごとの服の色。社長は KNOW IDEA の主の色 */
export const CLOTHES: Readonly<Record<string, string>> = {
  president: "#016C6C",
  builder: "#e0a458",
  reviewer: "#6b7fd7",
};

/** 役目の小物 */
export type Prop = "crown" | "pen" | "glasses" | null;

/** 社員ごとの小物。社長は小さな冠、作る役はペン、見る役は眼鏡 */
export const PROPS: Readonly<Record<string, Prop>> = { president: "crown", builder: "pen", reviewer: "glasses" };

/** 人形の大きさの倍率。部屋の机と比べて見分けやすい大きさにする */
export const DOLL_SCALE = 1.6;

/** 倍率をかける前の人形の背の高さ (足元から頭の上まで、タイルの単位)。差し替えたモデルもこの高さにそろえる */
export const DOLL_HEIGHT = 0.8;

/** 電話の幅で人形を大きくする倍率 */
const PHONE_DOLL_SCALE = 2.1;
/** これより狭い部屋を電話の幅と見る (CSS のピクセル) */
const PHONE_WIDTH = 600;

/**
 * 部屋の幅に合う人形の大きさの倍率を返す。電話の幅では部屋が小さく見えるので、人形を大きくする
 * @param width 部屋の幅 (CSS のピクセル)
 * @returns 倍率
 */
export function dollScaleFor(width: number): number {
  return width < PHONE_WIDTH ? PHONE_DOLL_SCALE : DOLL_SCALE;
}

const SKIN = "#f6dcc6";
const HAIR = "#4a3328";
const DARK = "#2b211c";
const BLUSH = "#f2a99a";

/** 頭の半径 */
const HEAD_R = 0.17;
/** 腰の高さ (足の付け根) */
const HIP_Y = 0.22;
/** 太ももとすねの長さ */
const THIGH = 0.1;

/** 作った人形 */
export interface Doll {
  /** 部屋に置く物。位置、向き、大きさはこれに当てる */
  root: Group;
  /** 体のすべて。差し替えたモデルを出す時は隠す */
  body: Group;
  /** 腰から上 */
  torso: Group;
  head: Group;
  /** 肩で回す左右の腕 */
  arms: [Group, Group];
  /** 付け根で回す左右の太もも */
  legs: [Group, Group];
  /** 膝で回す左右のすね */
  knees: [Group, Group];
  eyes: Object3D[];
  brows: Object3D[];
  /** 両手で運ぶ書類 */
  paper: Mesh;
}

/**
 * 柔らかい質感の材質を作る。人形の布と肌のように、光をあまり返さない
 * @param color 色
 * @returns 材質
 */
const soft = (color: string) => new MeshStandardMaterial({ color: new Color(color), roughness: 0.9, metalness: 0 });

/**
 * 球を置く
 * @param parent 置く先
 * @param r 半径
 * @param m 材質
 * @param at 位置
 * @param scale 伸ばす倍率
 * @returns 置いた球
 */
function ball(parent: Object3D, r: number, m: MeshStandardMaterial, at: [number, number, number], scale: [number, number, number] = [1, 1, 1]): Mesh {
  const mesh = new Mesh(new SphereGeometry(r, 20, 14), m);
  mesh.position.set(...at);
  mesh.scale.set(...scale);
  parent.add(mesh);
  return mesh;
}

/**
 * 付け根で回す手足を作る。付け根から下へ伸びる丸い棒
 * @param parent 置く先
 * @param at 付け根の位置
 * @param length 長さ
 * @param r 太さの半径
 * @param m 材質
 * @returns 付け根で回す入れ物
 */
function limb(parent: Object3D, at: [number, number, number], length: number, r: number, m: MeshStandardMaterial): Group {
  const pivot = new Group();
  pivot.position.set(...at);
  const bar = new Mesh(new CapsuleGeometry(r, Math.max(0.001, length - 2 * r), 4, 10), m);
  bar.position.y = -length / 2;
  pivot.add(bar);
  parent.add(pivot);
  return pivot;
}

/**
 * 役目の小物を頭に付ける
 * @param head 頭
 * @param prop 小物
 */
function addProp(head: Group, prop: Prop): void {
  if (prop === "crown") {
    const gold = new MeshStandardMaterial({ color: "#e8b94a", roughness: 0.4, metalness: 0.3 });
    const crown = new Group();
    crown.position.set(0.04, 0.22, -0.02);
    crown.rotation.z = -0.25;
    crown.add(new Mesh(new CylinderGeometry(0.075, 0.085, 0.05, 12, 1, true), gold));
    for (let i = 0; i < 5; i++) {
      const tip = new Mesh(new ConeGeometry(0.018, 0.05, 6), gold);
      const a = (i / 5) * Math.PI * 2;
      tip.position.set(Math.cos(a) * 0.075, 0.045, Math.sin(a) * 0.075);
      crown.add(tip);
    }
    head.add(crown);
  } else if (prop === "pen") {
    const pen = new Group();
    pen.position.set(0.17, 0.12, 0.02);
    pen.rotation.z = 1.2;
    pen.add(new Mesh(new CylinderGeometry(0.016, 0.016, 0.2, 8), new MeshStandardMaterial({ color: "#f2c94c" })));
    const tip = new Mesh(new ConeGeometry(0.016, 0.04, 8), new MeshStandardMaterial({ color: DARK }));
    tip.position.y = -0.12;
    tip.rotation.z = Math.PI;
    pen.add(tip);
    head.add(pen);
  } else if (prop === "glasses") {
    const frame = new MeshStandardMaterial({ color: "#3a2a20" });
    for (const x of [-0.085, 0.085]) {
      const ring = new Mesh(new TorusGeometry(0.06, 0.009, 8, 20), frame);
      ring.position.set(x, 0.02, 0.215);
      head.add(ring);
    }
    const bridge = new Mesh(new CylinderGeometry(0.006, 0.006, 0.05, 6), frame);
    bridge.rotation.z = Math.PI / 2;
    bridge.position.set(0, 0.03, 0.22);
    head.add(bridge);
  }
}

/**
 * 人形の姿を作る
 * @param clothes 服の色
 * @param prop 役目の小物
 * @param paperColor 運ぶ書類の色
 * @returns 人形
 */
export function buildDoll(clothes: string, prop: Prop, paperColor: Color): Doll {
  const skin = soft(SKIN);
  const cloth = soft(clothes);
  const hair = soft(HAIR);
  const shoe = soft(DARK);
  const dark = new MeshStandardMaterial({ color: DARK, roughness: 0.3 });
  const shine = new MeshStandardMaterial({ color: "#ffffff", emissive: "#ffffff", emissiveIntensity: 0.6 });
  const blush = new MeshBasicMaterial({ color: BLUSH, transparent: true, opacity: 0.55, depthWrite: false });
  const root = new Group();
  root.scale.setScalar(DOLL_SCALE);
  const body = new Group();
  root.add(body);
  // 人形は日の光の影を落とさず、足元の丸い影で置く。動く物が影を落とさなければ、影の地図を描き直さずに済む
  const shadow = new Mesh(new CircleGeometry(0.2, 24), new MeshBasicMaterial({ color: DARK, transparent: true, opacity: 0.22, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.006;
  root.add(shadow);

  // 胴: 腰から肩へ少しすぼまる服
  const torso = new Group();
  torso.position.y = HIP_Y;
  body.add(torso);
  const coat = new Mesh(new CylinderGeometry(0.1, 0.13, 0.2, 20), cloth);
  coat.position.y = 0.1;
  torso.add(coat);
  ball(torso, 0.13, cloth, [0, 0.005, 0], [1, 0.5, 0.95]);
  ball(torso, 0.1, cloth, [0, 0.2, 0], [1, 0.45, 0.9]);

  // 頭: 大きな丸い頭に髪をかぶせ、前髪を 3 つ並べる
  const head = new Group();
  head.position.y = 0.21 + HEAD_R;
  torso.add(head);
  ball(head, HEAD_R, skin, [0, 0, 0]);
  const cap = new Mesh(new SphereGeometry(HEAD_R * 1.05, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
  cap.rotation.x = -0.35;
  head.add(cap);
  for (const x of [-0.07, 0, 0.07]) ball(head, 0.05, hair, [x, 0.09, 0.12], [1.1, 0.7, 0.6]);
  const eyes = [-0.06, 0.06].map((x) => {
    const eye = new Group();
    eye.position.set(x, -0.01, HEAD_R * 0.93);
    ball(eye, 0.026, dark, [0, 0, 0], [1, 1.25, 0.6]);
    ball(eye, 0.009, shine, [0.008, 0.012, 0.014]);
    head.add(eye);
    return eye;
  });
  for (const x of [-0.105, 0.105]) {
    const cheek = new Mesh(new CircleGeometry(0.022, 16), blush);
    cheek.position.set(x, -0.055, HEAD_R * 0.86);
    cheek.rotation.y = x > 0 ? 0.55 : -0.55;
    head.add(cheek);
  }
  ball(head, 0.012, dark, [0, -0.065, HEAD_R * 0.97], [1.4, 0.6, 0.6]);
  // 困り顔の眉。内側を上げる
  const brows = [-1, 1].map((side) => {
    const brow = new Mesh(new CapsuleGeometry(0.006, 0.03, 4, 6), dark);
    brow.position.set(0.06 * side, 0.045, HEAD_R * 0.95);
    brow.rotation.z = Math.PI / 2 + 0.45 * side;
    brow.visible = false;
    head.add(brow);
    return brow;
  });
  // 小物の置き場は半径 0.22 の頭に合わせて書いてあるので、人形の頭の大きさに縮めて付ける
  const props = new Group();
  props.scale.setScalar(HEAD_R / 0.22);
  addProp(props, prop);
  head.add(props);

  // 腕: 肩から下げ、先に手の丸を付ける
  const arm = (side: number) => {
    const pivot = limb(torso, [0.125 * side, 0.18, 0], 0.15, 0.035, cloth);
    ball(pivot, 0.04, skin, [0, -0.16, 0]);
    return pivot;
  };
  const arms: [Group, Group] = [arm(-1), arm(1)];

  // 足: 付け根の太ももと、膝から下のすねと靴
  const leg = (side: number) => {
    const thigh = limb(body, [0.06 * side, HIP_Y, 0], THIGH, 0.045, cloth);
    const knee = limb(thigh, [0, -THIGH, 0], HIP_Y - THIGH, 0.04, skin);
    ball(knee, 0.048, shoe, [0, -(HIP_Y - THIGH) + 0.02, 0.02], [1, 0.7, 1.3]);
    return [thigh, knee] as const;
  };
  const [left, right] = [leg(-1), leg(1)];

  // 両手で運ぶ書類
  const paper = new Mesh(new CylinderGeometry(0.02, 0.02, 0.2, 8), new MeshStandardMaterial({ color: paperColor }));
  paper.rotation.z = Math.PI / 2;
  paper.position.set(0, 0.12, 0.17);
  paper.visible = false;
  torso.add(paper);

  return { root, body, torso, head, arms, legs: [left[0], right[0]], knees: [left[1], right[1]], eyes, brows, paper };
}

/**
 * 人形に、ある時刻の形を当てる。書類を運ぶ時 (paper が見える時) は両腕を前へ出す
 * @param d 人形
 * @param pose 形
 */
export function applyDollPose(d: Doll, pose: Pose): void {
  d.root.visible = pose.visible;
  const sitting = pose.posture === "sit";
  // 座る時は腰を座面の高さ (人形の足元) まで下げる
  d.body.position.y = pose.lift - (sitting ? HIP_Y : 0);
  d.torso.rotation.z = 0.06 * pose.sway;
  d.head.rotation.y = pose.head;
  d.head.rotation.z = pose.face === "trouble" ? 0.15 : 0;
  for (const e of d.eyes) e.scale.y = pose.blink ? 0.12 : 1;
  for (const b of d.brows) b.visible = pose.face === "trouble";
  const [al, ar] = d.arms;
  for (const [i, leg] of d.legs.entries()) {
    const side = i === 0 ? 1 : -1;
    leg.rotation.x = sitting ? -Math.PI / 2 : side * pose.legs;
    d.knees[i]?.rotation.set(sitting ? Math.PI / 2 : 0, 0, 0);
  }
  al.rotation.z = -0.12;
  ar.rotation.z = 0.12;
  if (d.paper.visible) {
    al.rotation.x = -1.3;
    ar.rotation.x = -1.3;
  } else if (sitting) {
    // 机で打つ時は手を前へ上げる
    const typing = pose.paws !== 0;
    al.rotation.x = typing ? -1.1 + pose.paws : 0;
    ar.rotation.x = typing ? -1.1 - pose.paws : 0;
  } else {
    al.rotation.x = -0.8 * pose.legs;
    ar.rotation.x = 0.8 * pose.legs;
  }
}
