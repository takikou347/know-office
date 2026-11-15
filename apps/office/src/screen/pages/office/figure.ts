// 子犬の社員の姿を、丸い形の重ねで作る。シーズー風の丸い頭、垂れた長い耳、クリーム色と毛色の 2 色、大きな黒い目、短い足、丸いしっぽ
import {
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  SphereGeometry,
  TorusGeometry,
} from "three";
import type { Pose } from "./motion.ts";

/** 社員ごとの毛色。3 体は同じ子の毛色違い */
export const COATS: Readonly<Record<string, string>> = {
  president: "#c99a6e",
  builder: "#9c9a9e",
  reviewer: "#6e4a32",
};

/** 役目の小物 */
export type Prop = "crown" | "pen" | "glasses" | null;

/** 社員ごとの小物。社長は小さな冠、作る役はペン、見る役は眼鏡 */
export const PROPS: Readonly<Record<string, Prop>> = { president: "crown", builder: "pen", reviewer: "glasses" };

/** 子犬の大きさの倍率。部屋の机と比べて見分けやすい大きさにする */
export const PUPPY_SCALE = 1.6;

const CREAM = "#f7ecdc";
const DARK = "#2b211c";

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
  eyes: Object3D[];
  brows: Object3D[];
  paper: Mesh;
}

/**
 * 柔らかい質感の材質を作る。毛のふわふわを出すため、光をあまり返さない
 * @param color 色
 * @returns 材質
 */
const fluffy = (color: string) => new MeshStandardMaterial({ color: new Color(color), roughness: 1, metalness: 0 });

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
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
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
 * 子犬の姿を作る
 * @param coat 毛色
 * @param prop 役目の小物
 * @param paperColor くわえて運ぶ書類の色
 * @returns 子犬
 */
export function buildPuppy(coat: string, prop: Prop, paperColor: Color): Puppy {
  const cream = fluffy(CREAM);
  const fur = fluffy(coat);
  const dark = new MeshStandardMaterial({ color: DARK, roughness: 0.3 });
  const shine = new MeshStandardMaterial({ color: "#ffffff", emissive: "#ffffff", emissiveIntensity: 0.6 });
  const root = new Group();
  root.scale.setScalar(PUPPY_SCALE);
  const body = new Group();
  root.add(body);

  // 胴: クリーム色の丸に、背中の毛色を重ね、胸にふわふわを足す
  const torso = new Group();
  torso.position.set(0, 0.24, 0);
  body.add(torso);
  ball(torso, 0.2, cream, [0, 0, 0], [1, 0.9, 1.15]);
  ball(torso, 0.19, fur, [0, 0.05, -0.04], [1.04, 0.72, 1.08]);
  ball(torso, 0.12, cream, [0, 0.02, 0.15]);
  ball(torso, 0.09, cream, [0.1, -0.05, 0.12]);
  ball(torso, 0.09, cream, [-0.1, -0.05, 0.12]);

  // 頭: 丸い頭に毛色の帽子をかぶせ、額に白い筋を通す
  const head = new Group();
  head.position.set(0, 0.52, 0.1);
  body.add(head);
  ball(head, 0.22, cream, [0, 0, 0]);
  const cap = new Mesh(new SphereGeometry(0.228, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.5), fur);
  cap.rotation.x = -0.55;
  cap.castShadow = true;
  head.add(cap);
  ball(head, 0.07, cream, [0, 0.13, 0.15], [0.55, 1, 0.5]);
  ball(head, 0.1, cream, [0, -0.08, 0.16], [1.25, 0.85, 0.9]);
  ball(head, 0.075, cream, [0.08, -0.07, 0.13]);
  ball(head, 0.075, cream, [-0.08, -0.07, 0.13]);
  ball(head, 0.032, dark, [0, -0.04, 0.26]);
  const eyes = [-0.085, 0.085].map((x) => {
    const eye = new Group();
    eye.position.set(x, 0.02, 0.18);
    ball(eye, 0.052, dark, [0, 0, 0]);
    ball(eye, 0.016, shine, [0.016, 0.02, 0.042]);
    head.add(eye);
    return eye;
  });
  // 困り顔の眉。内側を上げる
  const brows = [-1, 1].map((side) => {
    const brow = new Mesh(new CapsuleGeometry(0.008, 0.045, 4, 6), dark);
    brow.position.set(0.085 * side, 0.095, 0.2);
    brow.rotation.z = Math.PI / 2 + 0.45 * side;
    brow.visible = false;
    head.add(brow);
    return brow;
  });
  // 垂れた長い耳。先にふわふわの丸を付ける
  const ear = (side: number) => {
    const pivot = new Group();
    pivot.position.set(0.19 * side, 0.06, 0);
    const flap = new Mesh(new CapsuleGeometry(0.075, 0.2, 6, 12), fur);
    flap.position.y = -0.14;
    flap.castShadow = true;
    pivot.add(flap);
    ball(pivot, 0.08, fur, [0.01 * side, -0.27, 0]);
    head.add(pivot);
    return pivot;
  };
  const ears: [Group, Group] = [ear(-1), ear(1)];
  addProp(head, prop);

  // 短い足。前足は胸の下、後ろ足はお尻の下
  const leg = (x: number, z: number) => {
    const pivot = new Group();
    pivot.position.set(x, 0.13, z);
    const limb = new Mesh(new CapsuleGeometry(0.055, 0.06, 4, 8), cream);
    limb.position.y = -0.06;
    limb.castShadow = true;
    pivot.add(limb);
    ball(pivot, 0.062, cream, [0, -0.11, 0.015]);
    body.add(pivot);
    return pivot;
  };
  const front: [Group, Group] = [leg(-0.1, 0.12), leg(0.1, 0.12)];
  const back: [Group, Group] = [leg(-0.11, -0.12), leg(0.11, -0.12)];

  // 丸いしっぽ
  const tail = new Group();
  tail.position.set(0, 0.33, -0.2);
  ball(tail, 0.1, fur, [0, 0.05, -0.04]);
  ball(tail, 0.07, cream, [0, 0.1, -0.02]);
  body.add(tail);

  // くわえて運ぶ書類
  const paper = new Mesh(new CylinderGeometry(0.02, 0.02, 0.2, 8), new MeshStandardMaterial({ color: paperColor }));
  paper.rotation.z = Math.PI / 2;
  paper.position.set(0, 0.42, 0.36);
  paper.visible = false;
  body.add(paper);

  return { root, body, torso, head, ears, front, back, tail, eyes, brows, paper };
}

/**
 * 子犬に、ある時刻の形を当てる
 * @param p 子犬
 * @param pose 形
 */
export function applyPuppyPose(p: Puppy, pose: Pose): void {
  p.root.visible = pose.visible;
  const sitting = pose.posture === "sit";
  p.body.position.y = pose.lift;
  // おすわりは胴を起こし、後ろ足を前へたたむ
  p.torso.rotation.x = sitting ? -0.45 : 0;
  p.torso.position.y = sitting ? 0.22 : 0.24;
  p.head.position.y = sitting ? 0.56 : 0.5;
  p.head.position.z = sitting ? 0.06 : 0.14;
  p.head.rotation.y = pose.head;
  p.head.rotation.x = pose.face === "trouble" ? 0.2 : 0;
  for (const [i, e] of p.ears.entries()) e.rotation.z = (i === 0 ? -1 : 1) * (0.12 + pose.ears) + (pose.face === "trouble" ? (i === 0 ? 0.2 : -0.2) : 0);
  for (const e of p.eyes) e.scale.y = pose.blink ? 0.12 : 1;
  for (const b of p.brows) b.visible = pose.face === "trouble";
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
