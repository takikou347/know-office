// 部屋の家具 (机、椅子、パソコン、明かり) を three.js の形で組む
import { BoxGeometry, CylinderGeometry, Group, type Material, Mesh, MeshStandardMaterial, PlaneGeometry, SphereGeometry } from "three";
import type { OfficeTheme } from "./themes.ts";

/** 椅子の座面の高さ */
export const SEAT_Y = 0.45;
/** 机の天板の高さ */
export const DESK_Y = 0.72;

/** 部品の名前から材質を返す関数 */
export type MaterialOf = (key: keyof OfficeTheme) => MeshStandardMaterial;

/**
 * 1 つの席 (机、椅子、パソコン、明かり) を組む
 * @param mat 部品の色の材質
 * @returns 席の組と、明かりと画面の材質
 */
export function buildDesk(mat: MaterialOf) {
  const desk = new Group();
  const box = (w: number, h: number, d: number, m: Material, x: number, y: number, z: number) => {
    const mesh = new Mesh(new BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    desk.add(mesh);
    return mesh;
  };
  // 天板と 4 本の脚
  box(1.3, 0.06, 0.7, mat("desk"), 0, DESK_Y, 0);
  for (const [x, z] of [[-0.6, -0.3], [0.6, -0.3], [-0.6, 0.3], [0.6, 0.3]] as const) box(0.05, DESK_Y, 0.05, mat("leg"), x, DESK_Y / 2, z);
  // 開いたパソコン。画面は座る人 (奥) に向ける
  box(0.44, 0.02, 0.3, mat("monitor"), 0, DESK_Y + 0.04, -0.12);
  const lid = new Group();
  lid.position.set(0, DESK_Y + 0.05, -0.27);
  lid.rotation.x = 0.25;
  const lidBack = new Mesh(new BoxGeometry(0.44, 0.28, 0.02), mat("monitor"));
  lidBack.position.y = 0.14;
  lidBack.castShadow = true;
  const screen = new MeshStandardMaterial({ color: 0xffffff });
  const glass = new Mesh(new PlaneGeometry(0.4, 0.24), screen);
  glass.position.set(0, 0.14, -0.011);
  glass.rotation.y = Math.PI;
  lid.add(lidBack, glass);
  desk.add(lid);
  // 机の明かり
  box(0.12, 0.02, 0.12, mat("leg"), 0.5, DESK_Y + 0.04, 0.12);
  box(0.02, 0.3, 0.02, mat("leg"), 0.5, DESK_Y + 0.19, 0.12);
  const bulbMat = new MeshStandardMaterial({ color: 0xffffff });
  const bulb = new Mesh(new SphereGeometry(0.07, 16, 12), bulbMat);
  bulb.position.set(0.5, DESK_Y + 0.36, 0.12);
  desk.add(bulb);
  return { desk, screen, bulbMat, bulbAt: bulb.position.clone() };
}

/**
 * 椅子を組む。背は座る人の後ろ (奥) に置く
 * @param mat 部品の色の材質
 * @returns 椅子
 */
export function buildChair(mat: MaterialOf): Group {
  const chair = new Group();
  const seat = new Mesh(new BoxGeometry(0.46, 0.06, 0.44), mat("chair"));
  seat.position.y = SEAT_Y - 0.03;
  const back = new Mesh(new BoxGeometry(0.46, 0.46, 0.06), mat("chair"));
  back.position.set(0, SEAT_Y + 0.26, -0.22);
  const post = new Mesh(new CylinderGeometry(0.03, 0.03, SEAT_Y - 0.06, 8), mat("leg"));
  post.position.y = (SEAT_Y - 0.06) / 2;
  const foot = new Mesh(new CylinderGeometry(0.22, 0.22, 0.03, 16), mat("leg"));
  foot.position.y = 0.015;
  for (const m of [seat, back, post, foot]) {
    m.castShadow = true;
    m.receiveShadow = true;
    chair.add(m);
  }
  return chair;
}
