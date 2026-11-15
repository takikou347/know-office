// 子犬の役目の小物。社長は小さな冠、作る役は耳に挟んだペン、見る役は眼鏡
import { type Color, ConeGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, TorusGeometry } from "three";

/** 役目の小物 */
export type Prop = "crown" | "pen" | "glasses" | null;

/** 社員ごとの小物 */
export const PROPS: Readonly<Record<string, Prop>> = { president: "crown", builder: "pen", reviewer: "glasses" };

/** 小物の色 */
export interface PropColors {
  gold: Color;
  pen: Color;
  frame: Color;
}

/**
 * 役目の小物を頭に付ける
 * @param head 頭
 * @param prop 小物
 * @param colors 小物の色
 */
export function addProp(head: Group, prop: Prop, colors: PropColors): void {
  if (prop === "crown") {
    const gold = new MeshStandardMaterial({ color: colors.gold, roughness: 0.4, metalness: 0.3 });
    const crown = new Group();
    crown.position.set(0.05, 0.3, 0.02);
    crown.rotation.z = -0.25;
    crown.add(new Mesh(new CylinderGeometry(0.07, 0.08, 0.05, 12, 1, true), gold));
    for (let i = 0; i < 5; i++) {
      const tip = new Mesh(new ConeGeometry(0.017, 0.045, 6), gold);
      const a = (i / 5) * Math.PI * 2;
      tip.position.set(Math.cos(a) * 0.07, 0.045, Math.sin(a) * 0.07);
      crown.add(tip);
    }
    head.add(crown);
  } else if (prop === "pen") {
    const pen = new Group();
    pen.position.set(0.25, 0.2, 0.08);
    pen.rotation.set(0.3, 0, 1.1);
    pen.add(new Mesh(new CylinderGeometry(0.015, 0.015, 0.18, 8), new MeshStandardMaterial({ color: colors.pen })));
    const tip = new Mesh(new ConeGeometry(0.015, 0.035, 8), new MeshStandardMaterial({ color: colors.frame }));
    tip.position.y = -0.105;
    tip.rotation.z = Math.PI;
    pen.add(tip);
    head.add(pen);
  } else if (prop === "glasses") {
    const frame = new MeshStandardMaterial({ color: colors.frame });
    for (const x of [-0.115, 0.115]) {
      const ring = new Mesh(new TorusGeometry(0.068, 0.008, 8, 24), frame);
      ring.position.set(x, -0.01, 0.27);
      head.add(ring);
    }
    const bridge = new Mesh(new CylinderGeometry(0.006, 0.006, 0.06, 6), frame);
    bridge.rotation.z = Math.PI / 2;
    bridge.position.set(0, 0.005, 0.273);
    head.add(bridge);
  }
}
