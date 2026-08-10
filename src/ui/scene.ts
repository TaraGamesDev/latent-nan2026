/**
 * Three.js scene: a wall of bolted steel plates, and the holders below it.
 *
 * The parts are real models — see `assets.ts` — but nothing here is hand-made:
 * every mesh comes out of a committed, deterministic Blender script, and the
 * metal look comes from an image-based light generated at runtime rather than
 * from an HDRI download. The build stays self-contained and the first load stays
 * quick, which matters more than it sounds: the judge's first impression is
 * whether the link opens.
 *
 * If you can see a screw, you can turn it. Occlusion very nearly gives that for
 * free, since a screw is unreachable exactly when a plate covers its position,
 * but the rule tests the screw's *centre* and a head is wider than a point — so
 * unreachable screws are hidden outright rather than left to peek past an edge.
 *
 * The renderer never decides anything. It reads board state and plays back what
 * already happened, so a dropped frame cannot desynchronise it from the engine.
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PCFSoftShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  SRGBColorSpace,
  RepeatWrapping,
  CanvasTexture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import {
  type Assets,
  instance,
  meshOf,
  nineSlice,
  replaceMaterial,
} from './assets';

import {
  type Board,
  type Colour,
  HOLDERS,
  HOLDER_CAPACITY,
  UNDECIDED,
  isReachable,
} from '../core/plates';

/** Anodised finishes. Separated in hue *and* value, so they survive both a
 *  colour-blind player and a compressed video. */
export const COLOUR_HEX = [
  0xff3d63, 0xffa510, 0x18c96f, 0x1f9dff, 0x9a5cff, 0xff6a1f, 0xc8d422, 0xff4fc4,
];

/** Board units are about one plate-corner apart; scale up so a screw is a
 *  comfortable thumb target rather than a speck. */
const S = 1.55;
/** Plate thickness, matching assets/blender/plate.py. */
const PLATE_T = 0.26;
const LAYER_GAP = 0.34;
const HOLD_DROP = 1.9;
/** Distance between the holder's three wells. Fixed by holder.glb, so the game
 *  must use the model's number rather than deriving one from the wall width. */
const WELL_PITCH = 0.576;
/** Sits a part a hair proud of the surface below it, out of the z-fight zone. */
const EPS = 0.005;
/** The modelled screw is engineering-accurate, which reads small on a phone.
 *  Games in this genre draw a deliberately chunky screw; this is that. */
const SCREW_SCALE = 1.34;
/**
 * How much of the bolt hole's depth survives.
 *
 * The plate's front face is solid, so a full-depth bore is simply hidden behind
 * it and the hole flattens into a ring. Compressing the model along its axis
 * brings its dark floor forward of the plate face, so the recess reads as a
 * recess. It is a cheat, and it is invisible.
 */
const HOLE_SQUASH = 0.16;

/**
 * A brushed-steel roughness map, drawn at runtime on a 2D canvas.
 *
 * Uniform roughness is what makes a metal read as plastic: the highlight is a
 * single clean gradient with nothing breaking it up. A few thousand horizontal
 * streaks of varying roughness is all it takes, and it costs nothing to
 * download — which is the whole argument for keeping it over a generated map.
 */
function brushedRoughness(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#8a8a8a';
  ctx.fillRect(0, 0, 512, 512);
  ctx.globalAlpha = 0.3;
  for (let i = 0; i < 5000; i++) {
    const y = Math.random() * 512;
    const v = Math.round(138 + (Math.random() - 0.5) * 110);
    ctx.strokeStyle = `rgb(${v},${v},${v})`;
    ctx.lineWidth = Math.random() < 0.15 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(512, y);
    ctx.stroke();
  }
  const t = new CanvasTexture(c);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.repeat.set(3, 3);
  return t;
}

interface Tween {
  t0: number;
  dur: number;
  update: (k: number) => void;
  done?: () => void;
}

export class WallScene {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera: PerspectiveCamera;
  private plateGroup = new Group();
  private screwGroup = new Group();
  private holderGroup = new Group();

  private plateObjects = new Map<number, Group>();
  private screwObjects = new Map<number, Group>();
  private holderSlots: Group[] = [];
  private tweens: Tween[] = [];

  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private hovered: number | null = null;
  private highlighted = new Set<number>();

  private steel: MeshStandardMaterial;
  private steelEdge: MeshStandardMaterial;
  private hole: MeshStandardMaterial;
  private shaftMat: MeshStandardMaterial;
  private blank: MeshStandardMaterial;
  private colourMats = new Map<number, MeshStandardMaterial>();

  private spanX = 6;
  private spanY = 6;
  private wallH = 6;
  private centreY = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private assets: Assets,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.78;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    // An image-based light generated in-process. This is what makes the metal
    // read as metal; a MeshStandardMaterial with high metalness and nothing to
    // reflect renders nearly black. Kept dim — at full strength it washes the
    // anodised colours out to pastel.
    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.05).texture;
    this.scene.environmentIntensity = 0.34;

    this.camera = new PerspectiveCamera(32, 1, 0.1, 120);

    const key = new DirectionalLight(0xfff2e0, 1.55);
    key.position.set(3.5, 7, 14);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 45;
    key.shadow.camera.left = -14;
    key.shadow.camera.right = 14;
    key.shadow.camera.top = 14;
    key.shadow.camera.bottom = -14;
    key.shadow.bias = -0.0009;
    key.shadow.radius = 3;
    this.scene.add(key);

    const rim = new DirectionalLight(0x6fa8ff, 0.75);
    rim.position.set(-8, -2, 5);
    this.scene.add(rim);
    this.scene.add(new AmbientLight(0x2b3346, 0.9));

    const brushed = brushedRoughness();
    this.steel = new MeshStandardMaterial({
      color: 0x6f7887,
      // Rougher than the earlier procedural plate. The modelled plate has a real
      // rim and groove catching the key light, so it no longer needs a mirror
      // finish to look like metal — and a mirror finish blew the top half out.
      metalness: 0.82,
      roughness: 0.58,
      roughnessMap: assets.steelRoughness,
    });
    this.steelEdge = new MeshStandardMaterial({
      color: 0x545c6a,
      metalness: 0.84,
      roughness: 0.5,
      // The holder has no UVs, so this map does nothing there; it is kept only
      // so the two steels stay defined the same way.
      roughnessMap: brushed,
    });
    this.hole = new MeshStandardMaterial({ color: 0x333c4d, metalness: 0.75, roughness: 0.62 });
    this.shaftMat = new MeshStandardMaterial({ color: 0x3d4453, metalness: 0.85, roughness: 0.5 });
    // An undecided screw is raw, unfinished metal. Nothing is being concealed —
    // there is no colour there yet.
    this.blank = new MeshStandardMaterial({ color: 0x707a8c, metalness: 0.55, roughness: 0.78 });
    this.blank.name = 'ScrewHead';

    // A backing wall so plates cast onto something and the stack reads deep.
    const back = new Mesh(
      new PlaneGeometry(90, 90),
      new MeshStandardMaterial({ color: 0x11151e, metalness: 0.1, roughness: 1 }),
    );
    back.position.z = -2.2;
    back.receiveShadow = true;
    this.scene.add(back);

    /*
     * The models ship with their own materials, but the palette lives here.
     * Overriding by slot name at load time keeps the look decided in one place
     * rather than split between a Blender script and a renderer, and keeps the
     * brushed-steel map, the metalness and the deliberately dim environment
     * consistent with one another.
     */
    replaceMaterial(assets.plate, 'PlateSteel', this.steel);
    replaceMaterial(assets.holder, 'HolderBody', this.steelEdge);
    replaceMaterial(assets.holder, 'HolderWell', this.hole);
    replaceMaterial(assets.screw, 'ScrewMetal', this.shaftMat);

    this.scene.add(this.plateGroup, this.screwGroup, this.holderGroup);

    canvas.addEventListener('pointerleave', () => {
      this.hovered = null;
    });
  }

  private matFor(colour: Colour): MeshStandardMaterial {
    if (colour === UNDECIDED) return this.blank;
    let m = this.colourMats.get(colour);
    if (!m) {
      m = new MeshStandardMaterial({
        color: COLOUR_HEX[colour % COLOUR_HEX.length],
        metalness: 0.45,
        roughness: 0.28,
      });
      // Keeps the glTF slot's name, so a later swap can still find it.
      m.name = 'ScrewHead';
      this.colourMats.set(colour, m);
    }
    return m;
  }

  /* -------------------------------- build -------------------------------- */

  build(board: Board): void {
    for (const g of [this.plateGroup, this.screwGroup, this.holderGroup]) g.clear();
    this.plateObjects.clear();
    this.screwObjects.clear();
    this.holderSlots = [];
    this.tweens.length = 0;

    let maxX = 0;
    let maxY = 0;
    for (const p of board.plates) {
      maxX = Math.max(maxX, p.x + p.w);
      maxY = Math.max(maxY, p.y + p.h);
    }
    const ox = (maxX / 2) * S;
    const oy = (maxY / 2) * S;
    const world = (bx: number, by: number): [number, number] => [bx * S - ox, -by * S + oy];

    for (const p of board.plates) {
      const g = new Group();
      const w = p.w * S - 0.1;
      const h = p.h * S - 0.1;
      const [cx, cy] = world(p.x + p.w / 2, p.y + p.h / 2);

      // One modelled plate, stretched to this plate's rectangle by translating
      // its border. The bevel, rim band and groove keep their real width at
      // every size, which scaling would not preserve.
      const body = new Mesh(
        nineSlice(meshOf(this.assets.plate).geometry, w, h, this.assets.plateHalf),
        this.steel,
      );
      body.castShadow = true;
      body.receiveShadow = true;
      g.add(body);

      // Recessed bolt holes. Once a screw leaves, its hole stays — which is what
      // tells the player at a glance how far along a plate is.
      for (const id of p.screws) {
        const s = board.screws[id];
        const [sx, sy] = world(s.x, s.y);
        const ring = instance(this.assets.hole);
        ring.scale.z = HOLE_SQUASH;
        ring.position.set(sx - cx, sy - cy, PLATE_T / 2 + EPS);
        g.add(ring);
      }

      g.position.set(cx, cy, p.layer * LAYER_GAP);
      g.userData.plateId = p.id;
      this.plateGroup.add(g);
      this.plateObjects.set(p.id, g);
    }

    for (const s of board.screws) {
      const g = this.makeScrew();
      const [sx, sy] = world(s.x, s.y);
      g.position.set(sx, sy, board.plates[s.plate].layer * LAYER_GAP + PLATE_T / 2);
      g.userData.screwId = s.id;
      g.userData.home = g.position.clone();
      this.screwGroup.add(g);
      this.screwObjects.set(s.id, g);
    }

    this.spanX = maxX * S;
    this.wallH = maxY * S;
    this.spanY = this.wallH + HOLD_DROP + 1.6;

    this.buildHolders(this.wallH);
    this.sync(board);
    this.resize();
  }

  /**
   * A screw, cloned from the model.
   *
   * Only the head takes the colour. The glTF mesh carries an array of two
   * materials, so the head slot has to be written by name — assigning to
   * `mesh.material` would replace the whole array and paint the thread and the
   * driver recess the same colour as the head.
   */
  private makeScrew(): Group {
    const g = instance(this.assets.screw);
    g.scale.setScalar(SCREW_SCALE);
    return g;
  }

  /** Paint one screw's head, leaving its steel parts alone. */
  private paintScrew(g: Group, colour: Colour): void {
    replaceMaterial(g, 'ScrewHead', this.matFor(colour));
  }

  private buildHolders(wallH: number): void {
    // The tray is a fixed-size model now, so this only controls the gaps between
    // the three of them. The distance between wells comes from the model.
    const spacing = Math.max(2.5, this.spanX / HOLDERS);
    const startX = -((HOLDERS - 1) * spacing) / 2;
    const y = -wallH / 2 - HOLD_DROP;

    for (let i = 0; i < HOLDERS; i++) {
      const slot = new Group();
      slot.position.set(startX + i * spacing, y, 0.6);
      slot.userData.pitch = WELL_PITCH;
      slot.add(instance(this.assets.holder));

      for (let k = 0; k < HOLDER_CAPACITY; k++) {
        // A real screw standing in the well, not a stand-in cap. Its shaft runs
        // back through the tray, which is opaque and face-on to the camera.
        const seated = instance(this.assets.screw);
        seated.scale.setScalar(SCREW_SCALE);
        seated.position.set((k - 1) * WELL_PITCH, 0, -0.02 + EPS);
        seated.visible = false;
        seated.userData.socket = k;
        slot.add(seated);
      }

      this.holderGroup.add(slot);
      this.holderSlots.push(slot);
    }
  }

  /* -------------------------------- sync --------------------------------- */

  sync(board: Board): void {
    for (const p of board.plates) {
      const g = this.plateObjects.get(p.id);
      if (g && p.fallen && !g.userData.falling) g.visible = false;
    }

    for (const s of board.screws) {
      const g = this.screwObjects.get(s.id);
      if (!g) continue;
      if (s.removed) {
        if (!g.userData.leaving) g.visible = false;
        continue;
      }
      /*
       * Only reachable screws are drawn.
       *
       * Occlusion nearly carries the rule on its own — a screw is unreachable
       * exactly when a plate covers its position — but "covers its position" is
       * a test on the screw's centre, and a chunky head whose centre is just
       * inside the plate above still pokes out past the edge. A visible thing
       * that cannot be tapped is worse than an invisible one.
       */
      g.visible = isReachable(board, s);
      // While a reveal is playing the head deliberately stays raw metal, so the
      // player watches the colour get decided instead of finding it already set.
      if (!g.userData.revealing) this.paintScrew(g, s.colour);
    }

    for (let i = 0; i < HOLDERS; i++) {
      const h = board.holders[i];
      const slot = this.holderSlots[i];
      if (!slot) continue;
      for (const child of slot.children) {
        const k = child.userData.socket;
        if (k === undefined) continue;
        const filled = h.colour !== UNDECIDED && k < h.count;
        child.visible = filled;
        if (filled) this.paintScrew(child as Group, h.colour);
      }
    }
  }

  /**
   * Which turnable screw is under this point, if any.
   *
   * Plates take part in the ray test on purpose: a screw behind a plate must not
   * be clickable, and letting the plate win the depth sort *is* that rule. There
   * is no second reachability check here.
   */
  pick(board: Board, clientX: number, clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const hits = this.raycaster.intersectObjects(
      [...this.screwGroup.children, ...this.plateGroup.children],
      true,
    );
    for (const hit of hits) {
      let o: Object3D | null = hit.object;
      while (o && o.userData.screwId === undefined && o.userData.plateId === undefined) o = o.parent;
      if (!o) continue;
      if (o.userData.plateId !== undefined) return null;
      const s = board.screws[o.userData.screwId as number];
      return s && !s.removed && s.colour !== UNDECIDED ? s.id : null;
    }
    return null;
  }

  setHovered(id: number | null): void {
    this.hovered = id;
    this.canvas.style.cursor = id === null ? 'default' : 'pointer';
  }

  setHighlight(ids: number[]): void {
    this.highlighted = new Set(ids);
  }

  /* ------------------------------ animation ------------------------------ */

  private tween(dur: number, update: (k: number) => void, done?: () => void): void {
    this.tweens.push({ t0: performance.now(), dur, update, done });
  }

  /** A screw spins out of its hole and drops into a holder socket. */
  animateUnscrew(screwId: number, holderIndex: number, socket: number): void {
    const g = this.screwObjects.get(screwId);
    if (!g) return;
    g.userData.leaving = true;
    const from = g.position.clone();
    const slot = this.holderSlots[holderIndex];
    const to = slot
      ? new Vector3(
          slot.position.x + (socket - 1) * (slot.userData.pitch as number),
          slot.position.y,
          slot.position.z + 0.24,
        )
      : from.clone().add(new Vector3(0, -5, 1));

    this.tween(
      460,
      (k) => {
        // Fast spin up front — that is the part that reads as unscrewing — then
        // an arc across to the holder.
        g.rotation.z = -k * Math.PI * 8;
        if (k < 0.3) {
          g.position.z = from.z + (k / 0.3) * 0.7;
        } else {
          const t = (k - 0.3) / 0.7;
          const e = t * t * (3 - 2 * t);
          g.position.x = MathUtils.lerp(from.x, to.x, e);
          g.position.y = MathUtils.lerp(from.y, to.y, e) + Math.sin(t * Math.PI) * 1.3;
          g.position.z = MathUtils.lerp(from.z + 0.7, to.z, e);
        }
      },
      () => {
        g.visible = false;
        g.userData.leaving = false;
        g.scale.setScalar(SCREW_SCALE);
        g.rotation.z = 0;
        g.position.copy(g.userData.home as Vector3);
      },
    );
  }

  /** The last screw is out, so the plate tips off the wall and falls away. */
  animatePlateFall(plateId: number): void {
    const g = this.plateObjects.get(plateId);
    if (!g) return;
    g.userData.falling = true;
    const from = g.position.clone();
    const drift = (Math.random() - 0.5) * 2.2;
    const spin = (Math.random() - 0.5) * 2.6;

    this.tween(
      860,
      (k) => {
        // It hangs for a beat, tips, then accelerates. The pause is what sells
        // the weight; without it the plate just teleports downward.
        const tip = Math.min(1, k / 0.16);
        g.rotation.z = tip * spin * 0.2 + k * k * spin;
        g.rotation.x = k * k * 1.4;
        g.position.x = from.x + drift * k * k;
        g.position.y = from.y - 26 * k * k * k;
        g.position.z = from.z + k * 1.4;
      },
      () => {
        g.visible = false;
        g.userData.falling = false;
      },
    );
  }

  /**
   * A newly reachable screw is decided in front of the player.
   *
   * It sits as raw metal for a beat after the plate above comes off, then takes
   * its colour with a pop. The delay is the point of the whole project made
   * visible: that screw had no colour until the moment you could see it.
   */
  animateReveal(screwId: number, colour: Colour): void {
    const g = this.screwObjects.get(screwId);
    if (!g) return;
    replaceMaterial(g, 'ScrewHead', this.blank);
    g.userData.revealing = true;
    let swapped = false;

    this.tween(
      780,
      (k) => {
        if (!swapped && k > 0.55) {
          this.paintScrew(g, colour);
          swapped = true;
        }
        if (k > 0.55) {
          const t = (k - 0.55) / 0.45;
          g.scale.setScalar(SCREW_SCALE * (1 + Math.sin(t * Math.PI) * 0.38));
          g.rotation.z = Math.sin(t * Math.PI * 2) * 0.55;
        }
      },
      () => {
        this.paintScrew(g, colour);
        g.userData.revealing = false;
        g.scale.setScalar(SCREW_SCALE);
        g.rotation.z = 0;
      },
    );
  }

  /* -------------------------------- frame -------------------------------- */

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;

    // Fit the wall and the holders together, whatever the viewport shape.
    const vFov = MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const distV = this.spanY / 2 / Math.tan(vFov / 2);
    const distH = this.spanX / 2 / Math.tan(hFov / 2);
    const dist = Math.max(distV, distH) * 1.06 + 0.9;

    // On a tall screen the fit is bound by width, so there is vertical room
    // going spare. Zooming in would crop the wall; pushing the holders further
    // down spends the room on something useful instead, and keeps them near the
    // thumb rather than floating in the middle of the display.
    const visibleH = 2 * dist * Math.tan(vFov / 2);
    const spare = Math.max(0, visibleH * 0.88 - this.spanY);
    const drop = Math.min(spare, this.wallH * 0.55);
    this.holderGroup.position.y = -drop;

    const top = this.wallH / 2;
    const bottom = -this.wallH / 2 - HOLD_DROP - drop - 0.7;
    this.centreY = (top + bottom) / 2;

    this.camera.position.set(0, this.centreY, dist);
    this.camera.lookAt(0, this.centreY, 0);
    this.camera.updateProjectionMatrix();
  }

  render(now: number): void {
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const t = this.tweens[i];
      const k = Math.min(1, (now - t.t0) / t.dur);
      t.update(k);
      if (k >= 1) {
        t.done?.();
        this.tweens.splice(i, 1);
      }
    }

    for (const [id, g] of this.screwObjects) {
      if (!g.visible || g.userData.leaving || g.userData.revealing) continue;
      const hl = this.highlighted.has(id) ? 0.1 + 0.05 * Math.sin(now / 200) : 0;
      const hover = this.hovered === id ? 0.14 : 0;
      g.scale.setScalar(SCREW_SCALE * (1 + hl + hover));
    }

    this.renderer.render(this.scene, this.camera);
  }

  get busy(): boolean {
    return this.tweens.length > 0;
  }

  /** Snap every animation to its end state. Used by the screenshot mode, where a
   *  plate caught mid-fall makes a confusing still. */
  settle(): void {
    for (const t of this.tweens) {
      t.update(1);
      t.done?.();
    }
    this.tweens.length = 0;
  }
}
