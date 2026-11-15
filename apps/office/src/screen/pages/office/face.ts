// 子犬の顔。大きく離れた潤んだ黒い目 (白い光の点 2 つ)、小さな黒い鼻と口を付け、通常、ねむい目、困り顔を切り替える
import { type Color, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D, SphereGeometry, TorusGeometry } from "three";

/** 顔の部品 */
export interface Face {
  /** 開いた目 (黒目と光の点) */
  open: Object3D[];
  /** 閉じた目 (下へ丸い線) */
  closed: Object3D[];
  /** 困り顔の眉 (内側を上げる) */
  brows: Object3D[];
  /** いつもの口と、困り顔の口 */
  smile: Group;
  frown: Object3D;
}

/** 顔の色 */
export interface FaceColors {
  eye: Color;
  /** 黒目の下の茶色 */
  iris: Color;
  nose: Color;
  mouth: Color;
  /** 眉の色 (毛色) */
  brow: Color;
}

/** 目の真ん中 (頭の形の単位)。手本に合わせて顔の真ん中より少し下に、大きく離して置く */
const EYE = { x: 0.115, y: -0.01, z: 0.215 };

/**
 * 半径 1 の球を伸ばして置く
 * @param parent 置く先
 * @param m 材質
 * @param at 位置
 * @param size 3 方向の半径
 * @returns 置いた球
 */
function blob(parent: Object3D, m: MeshStandardMaterial | MeshBasicMaterial, at: readonly [number, number, number], size: readonly [number, number, number]): Mesh {
  const mesh = new Mesh(new SphereGeometry(1, 16, 12), m);
  mesh.position.set(...at);
  mesh.scale.set(...size);
  parent.add(mesh);
  return mesh;
}

/**
 * 細い弧の線を置く
 * @param parent 置く先
 * @param m 材質
 * @param r 弧の半径
 * @param arc 弧の角度
 * @param at 位置
 * @param turn z 軸の回りの回転
 * @returns 置いた線
 */
function stroke(parent: Object3D, m: MeshStandardMaterial, r: number, arc: number, at: readonly [number, number, number], turn: number): Mesh {
  const mesh = new Mesh(new TorusGeometry(r, 0.0075, 6, 16, arc), m);
  mesh.position.set(...at);
  mesh.rotation.z = turn;
  parent.add(mesh);
  return mesh;
}

/**
 * 頭に顔を付ける
 * @param head 頭
 * @param colors 顔の色
 * @returns 顔の部品
 */
export function buildFace(head: Group, colors: FaceColors): Face {
  // 目は光を強く返す濡れた黒にし、白い光の点を上に大きく下に小さく置く
  const eyeMat = new MeshStandardMaterial({ color: colors.eye, roughness: 0.15, metalness: 0.1 });
  const shine = new MeshBasicMaterial({ color: 0xffffff });
  const line = new MeshStandardMaterial({ color: colors.mouth, roughness: 0.6 });
  // 黒目の下を茶色にして、潤んだ深い目に見せる
  const iris = new MeshStandardMaterial({ color: colors.iris, roughness: 0.2 });
  const open = [-1, 1].map((side) => {
    const eye = blob(head, eyeMat, [EYE.x * side, EYE.y, EYE.z], [0.052, 0.056, 0.024]);
    blob(eye, iris, [0, -0.32, 0.5], [0.72, 0.55, 0.55]);
    blob(eye, shine, [-0.3, 0.36, 0.88], [0.3, 0.3, 0.2]);
    blob(eye, shine, [0.3, -0.38, 0.95], [0.14, 0.14, 0.1]);
    return eye;
  });
  // ねむい目は下へ丸い短い線
  const closed = [-1, 1].map((side) => {
    const lid = stroke(head, line, 0.03, Math.PI * 0.8, [EYE.x * side, EYE.y + 0.012, EYE.z + 0.03], Math.PI * 1.1);
    lid.visible = false;
    return lid;
  });
  const browMat = new MeshStandardMaterial({ color: colors.brow, roughness: 0.9 });
  const brows = [-1, 1].map((side) => {
    const brow = blob(head, browMat, [0.09 * side, 0.08, 0.232], [0.035, 0.011, 0.012]);
    brow.rotation.z = -0.4 * side;
    brow.visible = false;
    return brow;
  });
  // 小さな黒い鼻
  blob(head, new MeshStandardMaterial({ color: colors.nose, roughness: 0.35 }), [0, -0.045, 0.262], [0.034, 0.024, 0.022]);
  // いつもの口: 鼻から下へ短い線と、左右に並べた下へ丸い小さな弧 (ω の形)
  const smile = new Group();
  smile.position.set(0, -0.066, 0.258);
  head.add(smile);
  blob(smile, line, [0, -0.008, 0], [0.005, 0.012, 0.005]);
  for (const side of [-1, 1]) stroke(smile, line, 0.015, Math.PI * 0.8, [0.015 * side, -0.012, -0.002], Math.PI * 1.1);
  // 困り顔の口: 上へ丸い小さな弧
  const frown = stroke(head, line, 0.018, Math.PI * 0.7, [0, -0.095, 0.252], Math.PI * 0.15);
  frown.visible = false;
  return { open, closed, brows, smile, frown };
}

/**
 * 顔つきを当てる
 * @param face 顔の部品
 * @param blink 目を閉じているか
 * @param trouble 困り顔か
 */
export function applyFace(face: Face, blink: boolean, trouble: boolean): void {
  for (const o of face.open) o.visible = !blink;
  for (const c of face.closed) c.visible = blink;
  for (const b of face.brows) b.visible = trouble;
  face.smile.visible = !trouble;
  face.frown.visible = trouble;
}
