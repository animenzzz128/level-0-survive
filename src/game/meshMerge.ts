import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const MERGE_ATTRIBUTES = ['position', 'normal', 'uv'] as const;

/** Same vertex layout (position, normal, uv; all indexed or none), so mergeGeometries can join them. */
function compatible(geometries: THREE.BufferGeometry[]): boolean {
  const indexed = geometries[0].index !== null;
  return geometries.every(
    (g) =>
      (g.index !== null) === indexed &&
      Object.keys(g.morphAttributes).length === 0 &&
      MERGE_ATTRIBUTES.every((name) => g.getAttribute(name) !== undefined),
  );
}

/**
 * Join the static leaf meshes under `root` that share a material into one mesh per material and parent
 * (performance-optimization skill: for many small parts the cost is draw calls, not triangles).
 *
 * Only direct mesh children of each object are joined, baked into their parent's space, so animated pivots
 * (limb groups, the slide) keep moving their parts. Meshes in `keep`, meshes with children and instanced
 * meshes are left alone. Returns how many meshes were removed.
 */
export function mergeStaticMeshes(root: THREE.Object3D, keep: ReadonlySet<THREE.Object3D> = new Set()): number {
  let removed = 0;
  const replaced: THREE.BufferGeometry[] = [];

  const visit = (parent: THREE.Object3D): void => {
    const byMaterial = new Map<THREE.Material, THREE.Mesh[]>();
    for (const child of parent.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) continue;
      if (mesh.children.length > 0 || keep.has(mesh) || !mesh.visible || Array.isArray(mesh.material)) continue;
      const list = byMaterial.get(mesh.material);
      if (list) list.push(mesh);
      else byMaterial.set(mesh.material, [mesh]);
    }

    for (const [material, meshes] of byMaterial) {
      if (meshes.length < 2 || !compatible(meshes.map((m) => m.geometry))) continue;
      const baked = meshes.map((m) => {
        m.updateMatrix();
        const g = new THREE.BufferGeometry();
        for (const name of MERGE_ATTRIBUTES) g.setAttribute(name, m.geometry.getAttribute(name).clone());
        if (m.geometry.index) g.setIndex(m.geometry.index.clone());
        g.applyMatrix4(m.matrix);
        return g;
      });
      const merged = mergeGeometries(baked);
      for (const g of baked) g.dispose();
      if (!merged) continue;

      const joined = new THREE.Mesh(merged, material);
      joined.name = `merged:${meshes.length}`;
      joined.castShadow = meshes.some((m) => m.castShadow);
      joined.receiveShadow = meshes.some((m) => m.receiveShadow);
      joined.renderOrder = meshes[0].renderOrder;
      for (const m of meshes) {
        parent.remove(m);
        replaced.push(m.geometry);
      }
      parent.add(joined);
      removed += meshes.length - 1;
    }

    for (const child of parent.children) {
      if (child.children.length > 0) visit(child);
    }
  };

  visit(root);

  // Free the originals, unless another mesh under root still draws with the same geometry.
  const inUse = new Set<THREE.BufferGeometry>();
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) inUse.add((obj as THREE.Mesh).geometry);
  });
  for (const g of new Set(replaced)) {
    if (!inUse.has(g)) g.dispose();
  }
  return removed;
}
