// VRM のモデルを読む口。モデルを指した社員だけが使い、指していなければ VRM のコードも読まない
import type { VRMHumanBoneName } from "@pixiv/three-vrm";
import type { ModelAvatar } from "./avatars.ts";

/** 部屋の姿の背の高さに合わせる倍率。VRM は人の背 (約 1.6) で作られている */
const SCALE = 0.72;

/**
 * VRM のモデルを読み、座った形の姿にする
 * @param url モデルの URL
 * @returns 読み込んだ姿
 */
export async function loadVrmAvatar(url: string): Promise<ModelAvatar> {
  const [{ GLTFLoader }, { VRM, VRMLoaderPlugin, VRMUtils }] = await Promise.all([
    import("three/addons/loaders/GLTFLoader.js"),
    import("@pixiv/three-vrm"),
  ]);
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const model: unknown = gltf.userData["vrm"];
  if (!(model instanceof VRM)) throw new Error("VRM ではないモデル");
  // VRM 0.x は向きが逆なので、1.0 と同じ向きにそろえる
  VRMUtils.rotateVRM0(model);
  model.scene.scale.setScalar(SCALE);
  const bone = (name: VRMHumanBoneName) => model.humanoid.getNormalizedBoneNode(name);
  return {
    object: model.scene,
    applyPose: (pose) => {
      model.scene.visible = pose.visible;
      model.scene.position.y = pose.lift;
      const legs = pose.posture === "sit" ? Math.PI / 2 : 0;
      bone("leftUpperLeg")?.rotation.set(-legs, 0, 0);
      bone("rightUpperLeg")?.rotation.set(-legs, 0, 0);
      bone("leftLowerLeg")?.rotation.set(legs, 0, 0);
      bone("rightLowerLeg")?.rotation.set(legs, 0, 0);
      bone("leftUpperArm")?.rotation.set(-0.9 + pose.paws, 0, 1.1);
      bone("rightUpperArm")?.rotation.set(-0.9 - pose.paws, 0, -1.1);
      bone("head")?.rotation.set(0, pose.head, 0);
    },
    update: (seconds) => model.update(seconds),
    dispose: () => VRMUtils.deepDispose(model.scene),
  };
}
