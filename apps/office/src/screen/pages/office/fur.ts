// 子犬のふわふわの毛。丸い形の重ねに色を塗り、同じ形を少しずつ膨らませた層 (シェル) を 1 つの形にまとめ、ノイズで毛先を透かして輪郭に毛羽を出す
import { BufferAttribute, type BufferGeometry, Color, MeshStandardMaterial, SphereGeometry, Vector3 } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** 広い幅で重ねる毛の層の数。GPU の無い描き方でも 1 枚の重さが元の部屋に近くなるよう 5 にする */
const WIDE_LAYERS = 5;
/** 電話の幅で重ねる毛の層の数。子犬が小さく見えるので減らしても違いが見えない */
const PHONE_LAYERS = 3;
/** これより狭い部屋を電話の幅と見る (CSS のピクセル)。子犬の大きさと毛の層の数の両方がこの幅で切り替わる */
export const PHONE_WIDTH = 600;
/** 作る時に用意する層の数。描く層の数はこの中で変える */
export const MAX_LAYERS = WIDE_LAYERS;

/**
 * 部屋の幅に合う毛の層の数を返す
 * @param width 部屋の幅 (CSS のピクセル)
 * @returns 層の数
 */
export function furLayersFor(width: number): number {
  return width < PHONE_WIDTH ? PHONE_LAYERS : WIDE_LAYERS;
}

/** 毛の色を、形の中の位置から決める関数。out に色を書く */
export type Paint = (at: Vector3, out: Color) => void;

/** 毛の形の 1 つ。半径 1 の球を伸ばして置く */
export interface Puff {
  /** 真ん中の位置 */
  at: readonly [number, number, number];
  /** 3 方向の半径 */
  size: readonly [number, number, number];
  /** 塗り方。無ければ組の塗り方を使う */
  paint?: Paint;
  /** 毛の長さの倍率。顔の前のように短い毛の所は小さくする。無ければ 1 */
  reach?: number;
}

/**
 * 1 色で塗る関数を作る
 * @param color 色
 * @returns 塗る関数
 */
export const solid =
  (color: Color): Paint =>
  (_at, out) => {
    out.copy(color);
  };

/**
 * 毛の形をまとめ、層を重ねた 1 つの形にする。層は内から順に並べるので、描く範囲を前から切ると層を減らせる
 * @param puffs 毛の形の並び
 * @param paint 組の塗り方
 * @param shellSegments 外の層の球の横と縦の分け方。細かな模様のある所 (顔) は細かくする
 * @returns 層を重ねた形。shell の属性に層の番号を持つ
 */
export function furGeometry(puffs: readonly Puff[], paint: Paint, shellSegments: readonly [number, number] = [10, 7]): BufferGeometry {
  const at = new Vector3();
  const color = new Color();
  // 下地は細かく、外の層は粗く分ける。外の層は毛先で輪郭がぼけるので粗くても角が見えず、描く三角が減る
  const shape = (fine: boolean) => {
    const parts = puffs.map((p) => {
      const g = fine ? new SphereGeometry(1, 16, 11) : new SphereGeometry(1, ...shellSegments);
      g.scale(...p.size);
      g.translate(...p.at);
      const pos = g.getAttribute("position");
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        at.fromBufferAttribute(pos, i);
        (p.paint ?? paint)(at, color);
        color.toArray(colors, i * 3);
      }
      g.setAttribute("color", new BufferAttribute(colors, 3));
      g.setAttribute("reach", new BufferAttribute(new Float32Array(pos.count).fill(p.reach ?? 1), 1));
      return g;
    });
    const merged = mergeGeometries(parts);
    for (const g of parts) g.dispose();
    if (!merged) throw new Error("毛の形をまとめられない");
    return merged;
  };
  const fine = shape(true);
  const coarse = shape(false);
  const layers = Array.from({ length: MAX_LAYERS + 1 }, (_, i) => {
    const g = (i === 0 ? fine : coarse).clone();
    g.setAttribute("shell", new BufferAttribute(new Float32Array(g.getAttribute("position").count).fill(i), 1));
    return g;
  });
  const merged = mergeGeometries(layers);
  const counts = { base: fine.index?.count ?? 0, layer: coarse.index?.count ?? 0 };
  for (const g of [fine, coarse, ...layers]) g.dispose();
  if (!merged) throw new Error("毛の層をまとめられない");
  merged.userData["baseIndices"] = counts.base;
  merged.userData["layerIndices"] = counts.layer;
  return merged;
}

/**
 * 描く毛の層の数を変える
 * @param geometry furGeometry で作った形
 * @param layers 外に重ねる層の数 (0 なら下地だけ)
 */
export function setFurLayers(geometry: BufferGeometry, layers: number): void {
  const base = Number(geometry.userData["baseIndices"] ?? 0);
  const per = Number(geometry.userData["layerIndices"] ?? 0);
  geometry.setDrawRange(0, base + per * Math.min(layers, MAX_LAYERS));
}

/** 毛の材質の、描く間に変える値 */
export interface FurUniforms {
  /** 描く層の数。外の層ほど膨らみ、毛先が細る */
  layers: { value: number };
}

// 毛の流れのノイズ。細かい毛の筋と、筋を束ねる大きな房を混ぜ、層ごとに残す筋を減らして毛先を細らせる
const NOISE = /* glsl */ `
uniform float furLayers;
uniform float furDensity;
varying float vShell;
varying vec3 vFurPos;
float furHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float furNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(furHash(i), furHash(i + vec3(1, 0, 0)), f.x), mix(furHash(i + vec3(0, 1, 0)), furHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(furHash(i + vec3(0, 0, 1)), furHash(i + vec3(1, 0, 1)), f.x), mix(furHash(i + vec3(0, 1, 1)), furHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
`;

/**
 * 毛の材質を作る。光をほとんど返さず、根元を暗く毛先を明るくして、綿やフェルトのように見せる
 * @param length 一番外の層の膨らみ (子犬の形の単位)
 * @param density 毛の筋の細かさ (子犬の形の単位あたりの数)
 * @param uniforms 描く間に変える値。同じ子犬の材質で分け合う
 * @returns 材質と、描く間に変える値
 */
export function furMaterial(
  length: number,
  density: number,
  uniforms: FurUniforms = { layers: { value: MAX_LAYERS } },
): { material: MeshStandardMaterial; uniforms: FurUniforms } {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms["furLayers"] = uniforms.layers;
    shader.uniforms["furLength"] = { value: length };
    shader.uniforms["furDensity"] = { value: density };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float shell;\nattribute float reach;\nuniform float furLayers;\nuniform float furLength;\nvarying float vShell;\nvarying vec3 vFurPos;",
      )
      .replace(
        "#include <begin_vertex>",
        // 毛は外へ伸び、先ほど少し下へ垂れる
        "#include <begin_vertex>\nvShell = shell / max(furLayers, 1.0);\nvFurPos = position;\ntransformed += objectNormal * vShell * furLength * reach;\ntransformed.y -= vShell * vShell * furLength * reach * 0.45;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${NOISE}`)
      // 毛の中で散った光の分だけ、影の側も少し明るくし、綿のように柔らかく見せる
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.16;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        // 細かい筋はなめらかなノイズにし、格子の筋目が出ないようにする
        float strand = furNoise(vFurPos * furDensity);
        float tuft = furNoise(vFurPos * furDensity * 0.17 + 7.0);
        float strandLen = strand * 0.75 + tuft * 0.45 - 0.08;
        if (vShell > 0.0 && strandLen < vShell) discard;
        diffuseColor.rgb *= mix(0.88, 1.05, vShell) * mix(0.95, 1.04, tuft);`,
      );
  };
  // 長さと細かさは値で渡すので、どの毛の材質も同じプログラムを使い回し、組み立ての重さを 1 回分にする
  material.customProgramCacheKey = () => "fur";
  return { material, uniforms };
}
