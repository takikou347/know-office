// 部屋を閉じる時の後始末。部屋の中の形、材質、模様と、使い回しの材質を捨てる
import { BufferGeometry, Material, Mesh, MeshStandardMaterial, type Object3D } from "three";

/**
 * 部屋の中の形、材質、模様を入れ子の奥まで捨て、部屋に置いていない材質も捨てる
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
    if (material instanceof Material) materials.add(material);
  });
  for (const m of materials) {
    if (m instanceof MeshStandardMaterial) m.map?.dispose();
    if (m instanceof Material) m.dispose();
  }
}
