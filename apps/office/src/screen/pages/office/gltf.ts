// glTF (.glb と .gltf) のモデルを読む口。モデルを指した社員だけが使い、指していなければ読み込みのコードも読まない
import type { ModelAvatar } from "./avatars.ts";
import { disposeScene } from "./cleanup.ts";
import { DOLL_HEIGHT } from "./figure.ts";

/** 3 つの軸の値 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * モデルの箱から、人形と同じ背の高さに縮める倍率と、足元を原点に合わせるずらしを決める。高さの無い箱と 0 以下の背の高さは縮めない
 * @param min 箱の小さい側の角
 * @param max 箱の大きい側の角
 * @param height そろえる背の高さ
 * @returns 倍率と、縮めた後に足すずらし
 */
export function fitToHeight(min: Vec3, max: Vec3, height: number): { scale: number; offset: Vec3 } {
  const tall = max.y - min.y;
  const scale = tall > 0 && height > 0 ? height / tall : 1;
  return { scale, offset: { x: (-(min.x + max.x) / 2) * scale, y: -min.y * scale, z: (-(min.z + max.z) / 2) * scale } };
}

/**
 * glTF のモデルを読み、人形と同じ背の高さで足元に置いた姿にする。"head" の名前の節があれば首の向きを当てる
 * @param url モデルの URL
 * @returns 読み込んだ姿
 */
export async function loadGltfAvatar(url: string): Promise<ModelAvatar> {
  const [{ GLTFLoader }, { Box3, Group }] = await Promise.all([import("three/addons/loaders/GLTFLoader.js"), import("three")]);
  const gltf = await new GLTFLoader().loadAsync(url);
  const model = gltf.scene;
  const box = new Box3().setFromObject(model);
  const fit = fitToHeight(box.min, box.max, DOLL_HEIGHT);
  model.scale.multiplyScalar(fit.scale);
  model.position.set(fit.offset.x, fit.offset.y, fit.offset.z);
  const object = new Group();
  object.add(model);
  const head = model.getObjectByName("head") ?? model.getObjectByName("Head");
  return {
    object,
    applyPose: (pose) => {
      object.visible = pose.visible;
      object.position.y = pose.lift;
      object.rotation.z = 0.06 * pose.sway;
      if (head) head.rotation.y = pose.head;
    },
    update: () => undefined,
    dispose: () => disposeScene(model, []),
  };
}
