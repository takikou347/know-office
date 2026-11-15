// 部屋を閉じる時の後始末。部屋の中の形、材質、模様、骨の模様と、使い回しの材質を捨てる
import { BufferGeometry, Material, Mesh, type Object3D, SkinnedMesh, Texture } from "three";

/**
 * 材質が持つ模様 (色、法線など) を全部捨てる
 * @param material 材質
 */
function disposeTextures(material: object): void {
  // 模様の置き場は材質の種類ごとに違うので、持ち物を見て模様だけを捨てる
  for (const value of Object.values(material)) {
    if (value instanceof Texture) value.dispose();
  }
}

/**
 * 部屋の中の形、材質、模様、骨の模様を入れ子の奥まで捨て、部屋に置いていない材質も捨てる
 * @param root 部屋
 * @param extra 使い回しの置き場にある材質
 */
export function disposeScene(root: Object3D, extra: Iterable<Material>): void {
  // 子の材質は型の引数が分からないので、物として集め、捨てる時に確かめる
  const materials = new Set<object>(extra);
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const geometry: unknown = o.geometry;
    const material: unknown = o.material;
    if (geometry instanceof BufferGeometry) geometry.dispose();
    const list: unknown[] = Array.isArray(material) ? material : [material];
    for (const m of list) if (m instanceof Material) materials.add(m);
    if (o instanceof SkinnedMesh) o.skeleton.dispose();
  });
  for (const m of materials) {
    disposeTextures(m);
    if (m instanceof Material) m.dispose();
  }
}
