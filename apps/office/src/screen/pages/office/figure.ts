// 社員の姿を形の組み合わせで作り、ある時刻の形を当てる
import { CapsuleGeometry, Color, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry } from "three";
import { SEAT_Y } from "./furniture.ts";
import type { Pose } from "./motion.ts";

/** 形を組み合わせた社員の姿 */
export interface ShapeAvatar {
  root: Group;
  body: Group;
  head: Group;
  armL: Group;
  armR: Group;
  mark: Mesh;
  tinted: { mat: MeshStandardMaterial; base: Color }[];
}

/**
 * 形を組み合わせた社員の姿を作る。丸い胴、頭、帽子のような髪、短い腕だけの、どの作品にも寄らない形
 * @param colors 体、顔、目、止めた印の色
 * @returns 姿
 */
export function buildShapeAvatar(colors: { body: Color; face: Color; eye: Color; stop: Color }): ShapeAvatar {
  const root = new Group();
  const body = new Group();
  root.add(body);
  const bodyMat = new MeshStandardMaterial({ color: colors.body, roughness: 0.6 });
  const faceMat = new MeshStandardMaterial({ color: colors.face, roughness: 0.8 });
  const eyeMat = new MeshStandardMaterial({ color: colors.eye });
  const torso = new Mesh(new CapsuleGeometry(0.2, 0.26, 6, 16), bodyMat);
  torso.position.y = SEAT_Y + 0.33;
  torso.castShadow = true;
  body.add(torso);
  const head = new Group();
  head.position.y = SEAT_Y + 0.74;
  const skull = new Mesh(new SphereGeometry(0.19, 24, 16), faceMat);
  skull.castShadow = true;
  // 頭の上半分を覆う髪。前は額の上で切る
  const hair = new Mesh(new SphereGeometry(0.2, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.42), bodyMat);
  hair.rotation.x = -0.25;
  const eyes = [-0.07, 0.07].map((x) => {
    const e = new Mesh(new SphereGeometry(0.028, 10, 8), eyeMat);
    e.position.set(x, 0.0, 0.17);
    return e;
  });
  head.add(skull, hair, ...eyes);
  body.add(head);
  const arm = (side: number) => {
    const pivot = new Group();
    pivot.position.set(0.24 * side, SEAT_Y + 0.47, 0);
    const limb = new Mesh(new CapsuleGeometry(0.055, 0.22, 4, 8), bodyMat);
    limb.position.y = -0.15;
    const hand = new Mesh(new SphereGeometry(0.06, 12, 8), faceMat);
    hand.position.y = -0.3;
    pivot.add(limb, hand);
    body.add(pivot);
    return pivot;
  };
  const armL = arm(-1);
  const armR = arm(1);
  // 止めた印。八角の板を頭の上に立てる
  const mark = new Mesh(new CylinderGeometry(0.11, 0.11, 0.03, 8), new MeshStandardMaterial({ color: colors.stop, emissive: colors.stop, emissiveIntensity: 0.4 }));
  mark.rotation.x = Math.PI / 2;
  mark.position.y = SEAT_Y + 1.12;
  root.add(mark);
  const tinted = [bodyMat, faceMat].map((mat) => ({ mat, base: mat.color.clone() }));
  return { root, body, head, armL, armR, mark, tinted };
}

const GRAY = new Color(0x8a8a8a);

/**
 * 形を組み合わせた姿に、ある時刻の形を当てる
 * @param a 姿
 * @param pose 形
 */
export function applyShapePose(a: ShapeAvatar, pose: Pose): void {
  a.body.visible = pose.visible;
  a.body.position.y = pose.lift;
  a.head.rotation.y = pose.head;
  // 腕は前へ出し、キーボードの上で振る
  a.armL.rotation.x = -1.1 + pose.arm;
  a.armR.rotation.x = -1.1 - pose.arm;
  a.mark.visible = pose.visible && pose.mark === "stop";
  for (const t of a.tinted) t.mat.color.copy(pose.dim ? t.base.clone().lerp(GRAY, 0.6) : t.base);
}
