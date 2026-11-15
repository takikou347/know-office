// 子犬の頭の上に出す印。止めた赤い八角、承認の丸、差し戻しの戻す矢印。いつもカメラに向ける
import { type Camera, type Color, ConeGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, TorusGeometry } from "three";

/** 頭の上の印の組 */
export interface Marks {
  group: Group;
  stop: Group;
  ok: Group;
  back: Group;
}

/** 印を出す高さ (子犬の足元から、子犬の大きさの単位) */
const MARK_Y = 1.05;

/**
 * 光る材質を作る。印は影に入っても見えるようにする
 * @param color 色
 * @returns 材質
 */
const glow = (color: Color) => new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.6 });

/**
 * 頭の上の印を作る
 * @param colors 止めた印、承認の丸、差し戻しの印の色
 * @returns 印の組。初めはどれも出さない
 */
export function buildMarks(colors: { stop: Color; ok: Color; back: Color }): Marks {
  const group = new Group();
  const stop = new Group();
  const plate = new Mesh(new CylinderGeometry(0.12, 0.12, 0.03, 8), glow(colors.stop));
  plate.rotation.x = Math.PI / 2;
  stop.add(plate);
  const ok = new Group();
  ok.add(new Mesh(new TorusGeometry(0.11, 0.028, 10, 32), glow(colors.ok)));
  const back = new Group();
  // 4 分の 3 の輪の端に矢じりを付け、戻す向きを示す
  back.add(new Mesh(new TorusGeometry(0.1, 0.026, 10, 28, Math.PI * 1.5), glow(colors.back)));
  const head = new Mesh(new ConeGeometry(0.055, 0.1, 12), glow(colors.back));
  head.position.set(0.1, -0.02, 0);
  head.rotation.z = Math.PI;
  back.add(head);
  for (const m of [stop, ok, back]) {
    m.visible = false;
    group.add(m);
  }
  return { group, stop, ok, back };
}

/**
 * 印を 1 つだけ出し、カメラに向ける
 * @param marks 印の組
 * @param kind 出す印。null なら出さない
 * @param camera 向ける先のカメラ
 */
export function showMark(marks: Marks, kind: "stop" | "ok" | "back" | null, camera: Camera): void {
  marks.stop.visible = kind === "stop";
  marks.ok.visible = kind === "ok";
  marks.back.visible = kind === "back";
  marks.group.position.set(0, MARK_Y, 0);
  // 子犬の向きを打ち消してから、カメラの向きにそろえる
  const parent = marks.group.parent;
  if (parent) marks.group.quaternion.copy(parent.quaternion).invert().multiply(camera.quaternion);
}
