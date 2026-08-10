/**
 * Loading the 3D parts.
 *
 * The screw, plate, bolt hole and holder are real models, built by the Blender
 * scripts in `assets/blender/` and exported to glTF. Those scripts are committed
 * and deterministic — running `npm run models` reproduces every byte — so the
 * repository still contains no hand-authored binary that cannot be regenerated
 * from source.
 *
 * Everything here is prepared once at startup and then cloned per placement.
 * Two things are normalised on the way in:
 *
 *   - Orientation. The models are authored Z-up and exported Y-up, so their
 *     "out of the wall" axis arrives as +Y. Rotating the geometry once here
 *     turns that into the +Z the renderer already works in, and nothing
 *     downstream has to think about it again.
 *
 *   - Planar UVs on the plate. The plate is resized at runtime by translating
 *     its border outward, so a normalised 0-1 unwrap would stretch. UVs are
 *     recomputed from world position instead, which keeps the brushed-steel
 *     grain at a constant real size on a plate of any dimension.
 */

import {
  Box3,
  BufferAttribute,
  RepeatWrapping,
  type Texture,
  TextureLoader,
  type BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface Assets {
  screw: Object3D;
  plate: Object3D;
  hole: Object3D;
  holder: Object3D;
  /** The plate's source half-extent in the board plane, for the nine-slice. */
  plateHalf: number;
  /** Brushed-steel roughness for the plates. */
  steelRoughness: Texture;
}

/** World units covered by one repeat of the steel texture. */
export const STEEL_TILE = 1.6;

async function load(loader: GLTFLoader, name: string): Promise<Object3D> {
  // The build uses a relative base so GitHub Pages can serve it from a project
  // subpath, so the model URL has to be resolved the same way.
  const url = new URL(`./models/${name}.glb`, document.baseURI).href;
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;

  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    // glTF arrives Y-up with +Y out of the wall; the renderer works in +Z out.
    m.geometry.rotateX(Math.PI / 2);
    m.geometry.computeBoundingSphere();
    m.castShadow = true;
    m.receiveShadow = true;
  });

  return root;
}

/** Every material in a subtree whose glTF name matches. */
export function materialsNamed(root: Object3D, name: string): MeshStandardMaterial[] {
  const out: MeshStandardMaterial[] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const list = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of list) {
      if ((mat as MeshStandardMaterial).name === name) out.push(mat as MeshStandardMaterial);
    }
  });
  return out;
}

/**
 * Swap one named material on a clone, without disturbing the others.
 *
 * A glTF mesh with two primitives arrives as a mesh carrying an array of
 * materials, and assigning to `mesh.material` would replace the whole array —
 * which paints the shaft and the driver recess the same colour as the head. The
 * slot has to be found by name and written individually.
 */
export function replaceMaterial(root: Object3D, name: string, next: MeshStandardMaterial): void {
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    if (Array.isArray(m.material)) {
      for (let i = 0; i < m.material.length; i++) {
        if ((m.material[i] as MeshStandardMaterial).name === name) m.material[i] = next;
      }
    } else if ((m.material as MeshStandardMaterial).name === name) {
      m.material = next;
    }
  });
}

/** Clone for placement. Geometry stays shared; the material array does not. */
export function instance(template: Object3D): Group {
  const g = new Group();
  const c = template.clone(true);
  c.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    if (Array.isArray(m.material)) m.material = m.material.slice();
  });
  g.add(c);
  return g;
}

/** The single mesh inside a template, for assets that have exactly one. */
export function meshOf(root: Object3D): Mesh {
  let found: Mesh | null = null;
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh && !found) found = m;
  });
  if (!found) throw new Error('asset has no mesh');
  return found;
}

/**
 * Stretch a plate to an arbitrary rectangle by moving its border outward.
 *
 * Scaling would be wrong: the plate's whole quality is in a bevel, a rim band
 * and a groove that are a fixed real width, and a plate stretched four times
 * wider than tall would smear all three. Instead every vertex outside a
 * threshold is *translated*, which leaves the profile exactly as modelled at
 * every size — this is the reason the plate was built with a clean flat band
 * between its detailed border and its centre.
 */
export function nineSlice(source: BufferGeometry, w: number, h: number, half: number): BufferGeometry {
  const geo = source.clone();
  const pos = geo.attributes.position;
  const dx = Math.max(0, w / 2 - half);
  const dy = Math.max(0, h / 2 - half);
  // Anywhere inside the modelled border ring, and outside the flat centre.
  const t = half * 0.6;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    if (x > t) pos.setX(i, x + dx);
    else if (x < -t) pos.setX(i, x - dx);
    if (y > t) pos.setY(i, y + dy);
    else if (y < -t) pos.setY(i, y - dy);
  }
  pos.needsUpdate = true;

  // UVs follow position, so the grain keeps a constant real-world scale rather
  // than stretching with the plate.
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / STEEL_TILE;
    uv[i * 2 + 1] = pos.getY(i) / STEEL_TILE;
  }
  geo.setAttribute('uv', new BufferAttribute(uv, 2));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

export async function loadAssets(): Promise<Assets> {
  const loader = new GLTFLoader();
  const tex = new TextureLoader();
  const [screw, plate, hole, holder, steelRoughness] = await Promise.all([
    load(loader, 'screw'),
    load(loader, 'plate'),
    load(loader, 'hole'),
    load(loader, 'holder'),
    tex.loadAsync(new URL('./textures/steel-roughness.png', document.baseURI).href),
  ]);

  // The plate's UVs are world position over STEEL_TILE, so the tiling comes from
  // UV values running past 1 rather than from a repeat factor.
  steelRoughness.wrapS = RepeatWrapping;
  steelRoughness.wrapT = RepeatWrapping;
  steelRoughness.anisotropy = 4;

  const box = new Box3().setFromObject(plate);
  const size = box.getSize(new Vector3());
  const plateHalf = Math.max(size.x, size.y) / 2;

  return { screw, plate, hole, holder, plateHalf, steelRoughness };
}
