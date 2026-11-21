import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

/**
 * Models built by tools/blender (docs/design/art/model-contract.md). Every one is optional: until a file has loaded,
 * or if it fails, the game keeps its procedural placeholder for that thing.
 */
export type ModelId = 'props' | 'ent_skin_stealer' | 'ent_howler' | 'ent_smiler' | 'vm_pistol';

export const MODEL_FILES: Record<ModelId, string> = {
  props: 'props.glb',
  ent_skin_stealer: 'ent_skin_stealer.glb',
  ent_howler: 'ent_howler.glb',
  ent_smiler: 'ent_smiler.glb',
  vm_pistol: 'vm_pistol.glb',
};

interface LoadedModel {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
}

/** A copy of an animated model with its own skeleton; clips are shared between copies. */
export interface ModelInstance {
  root: THREE.Object3D;
  clips: THREE.AnimationClip[];
}

const ASSET_FLAG = 'fromAssets';

/** Meshes from a loaded model share geometry and materials with the cache: never dispose them with a level. */
export function isAssetMesh(obj: THREE.Object3D): boolean {
  return obj.userData[ASSET_FLAG] === true;
}

function markShared(root: THREE.Object3D): void {
  root.traverse((obj) => {
    obj.userData[ASSET_FLAG] = true;
  });
}

export class GameAssets {
  private readonly models = new Map<ModelId, LoadedModel>();
  private readonly loader = new GLTFLoader();
  public readonly failed: ModelId[] = [];

  constructor(private readonly baseUrl: string) {}

  /** Load every model; resolves once all have loaded or failed. Missing files are not errors. */
  public async loadAll(onEach?: (id: ModelId, ok: boolean) => void): Promise<void> {
    await Promise.all(
      (Object.keys(MODEL_FILES) as ModelId[]).map(async (id) => {
        try {
          const gltf = await this.loader.loadAsync(this.baseUrl + MODEL_FILES[id]);
          gltf.scene.updateMatrixWorld(true);
          this.models.set(id, { scene: gltf.scene, clips: gltf.animations });
          onEach?.(id, true);
        } catch {
          this.failed.push(id);
          onEach?.(id, false);
        }
      }),
    );
  }

  public has(id: ModelId): boolean {
    return this.models.has(id);
  }

  public get loadedIds(): ModelId[] {
    return [...this.models.keys()];
  }

  /**
   * A copy of one top-level node of props.glb, with its position reset (the node's origin is the prop's pivot).
   * Geometry and materials are shared with the cache.
   */
  public prop(name: string): THREE.Object3D | null {
    const node = this.models.get('props')?.scene.getObjectByName(name);
    if (!node) return null;
    const copy = node.clone(true);
    copy.position.set(0, 0, 0);
    copy.rotation.set(0, 0, 0);
    copy.scale.set(1, 1, 1);
    markShared(copy);
    return copy;
  }

  /**
   * Geometry of a mesh inside a props.glb node, with the mesh's transform relative to that node baked in
   * (for instancing, e.g. the troffer frame and lens). A new geometry: the caller owns it.
   */
  public propGeometry(nodeName: string, meshName: string): THREE.BufferGeometry | null {
    const node = this.models.get('props')?.scene.getObjectByName(nodeName);
    if (!node) return null;
    let found: THREE.Mesh | null = null;
    node.traverse((obj) => {
      if (!found && (obj as THREE.Mesh).isMesh && (obj.name === meshName || obj.parent?.name === meshName)) {
        found = obj as THREE.Mesh;
      }
    });
    if (!found) return null;
    const mesh = found as THREE.Mesh;
    node.updateMatrixWorld(true);
    const relative = new THREE.Matrix4().copy(node.matrixWorld).invert().multiply(mesh.matrixWorld);
    return mesh.geometry.clone().applyMatrix4(relative);
  }

  /** A copy of a rigged model (entity or viewmodel) with its own skeleton. */
  public instance(id: ModelId): ModelInstance | null {
    const model = this.models.get(id);
    if (!model) return null;
    const root = skeletonClone(model.scene);
    markShared(root);
    return { root, clips: model.clips };
  }
}

/** Find a mesh by its name or by its parent's name (the glTF exporter wraps multi-material meshes in a group). */
export function findMesh(root: THREE.Object3D, name: string): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh && (obj.name === name || obj.parent?.name === name)) out.push(obj as THREE.Mesh);
  });
  return out;
}

/** Every mesh whose material has this name. */
export function findByMaterial(root: THREE.Object3D, materialName: string): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mats.some((m) => m.name === materialName)) out.push(mesh);
  });
  return out;
}
