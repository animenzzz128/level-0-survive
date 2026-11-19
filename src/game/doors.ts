import * as THREE from 'three';
import { BoxCollider, CELL_SIZE, DoorSpec, WALL_HEIGHT, segmentsIntersect } from './maze';

const HALF_SPAN = CELL_SIZE / 2;
const OPENING_HALF = 0.65;
const OPENING_HEIGHT = 2.3;
const STUB_THICKNESS = 0.2;
const PANEL_THICKNESS = 0.05;
const OPEN_ANGLE = -1.5;
const SWING_SPEED = 4.5;
const BROKEN_SWING_SPEED = 20;

export interface DoorMaterials {
  wall: THREE.Material;
  frame: THREE.Material;
  panel: THREE.Material;
}

/** Shrink box UVs so wallpaper on a narrow wall stub keeps the same pattern scale as a full wall. */
function scaleUv(geo: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
}

/**
 * A hinged door filling a one-cell corridor: two wall stubs, a header, and a swinging panel.
 * Closed doors block movement, sight and entity routing; entities that cannot route around bash them open.
 */
export class DoorInstance {
  public readonly spec: DoorSpec;
  public readonly group = new THREE.Group();
  /** Meshes bullets should stop on. */
  public readonly rayMeshes: THREE.Object3D[] = [];
  /** Two always-solid wall stubs plus the panel (solid only while closed). */
  public readonly colliders: BoxCollider[];
  public closed = false;
  public broken = false;
  /** Seconds entities have spent battering this door; it bursts open past a threshold. */
  public bashTimer = 0;
  public bashSoundTimer = 0;

  private readonly panelCollider: BoxCollider;
  private readonly pivot = new THREE.Group();
  private angle = OPEN_ANGLE;
  private readonly plane: [number, number, number, number];
  private readonly stubs: Array<[number, number, number, number]>;

  constructor(spec: DoorSpec, mats: DoorMaterials) {
    this.spec = spec;
    this.group.position.set(spec.x, 0, spec.z);
    // Built with the door plane along local X. A corridor running along world X needs the plane along world Z.
    if (spec.axis === 'x') this.group.rotation.y = Math.PI / 2;

    const stubWidth = HALF_SPAN - OPENING_HALF;
    for (const side of [-1, 1]) {
      const geo = new THREE.BoxGeometry(stubWidth, WALL_HEIGHT, STUB_THICKNESS);
      scaleUv(geo, stubWidth / CELL_SIZE, 1);
      const stub = new THREE.Mesh(geo, mats.wall);
      stub.position.set(side * (OPENING_HALF + stubWidth / 2), WALL_HEIGHT / 2, 0);
      stub.castShadow = true;
      stub.receiveShadow = true;
      this.group.add(stub);
      this.rayMeshes.push(stub);
    }
    const headerHeight = WALL_HEIGHT - OPENING_HEIGHT;
    const headerGeo = new THREE.BoxGeometry(OPENING_HALF * 2, headerHeight, STUB_THICKNESS);
    scaleUv(headerGeo, (OPENING_HALF * 2) / CELL_SIZE, headerHeight / WALL_HEIGHT);
    const header = new THREE.Mesh(headerGeo, mats.wall);
    header.position.set(0, OPENING_HEIGHT + headerHeight / 2, 0);
    header.receiveShadow = true;
    this.group.add(header);
    this.rayMeshes.push(header);

    const jambGeo = new THREE.BoxGeometry(0.07, OPENING_HEIGHT, STUB_THICKNESS + 0.04);
    for (const side of [-1, 1]) {
      const jamb = new THREE.Mesh(jambGeo, mats.frame);
      jamb.position.set(side * OPENING_HALF, OPENING_HEIGHT / 2, 0);
      this.group.add(jamb);
    }
    const lintel = new THREE.Mesh(
      new THREE.BoxGeometry(OPENING_HALF * 2 + 0.07, 0.07, STUB_THICKNESS + 0.04),
      mats.frame,
    );
    lintel.position.set(0, OPENING_HEIGHT, 0);
    this.group.add(lintel);

    const panelWidth = OPENING_HALF * 2 - 0.08;
    const panelHeight = OPENING_HEIGHT - 0.04;
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(panelWidth, panelHeight, PANEL_THICKNESS),
      mats.panel,
    );
    panel.position.set(panelWidth / 2, panelHeight / 2, 0);
    panel.castShadow = true;
    panel.receiveShadow = true;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.11), mats.frame);
    handle.position.set(panelWidth - 0.12, 1.0, 0);
    this.pivot.position.set(-OPENING_HALF + 0.04, 0, 0);
    this.pivot.add(panel, handle);
    this.pivot.rotation.y = this.angle;
    this.group.add(this.pivot);
    this.rayMeshes.push(panel);

    // World-space colliders and sight segments
    const alongZ = spec.axis === 'x'; // door plane spans world Z
    const box = (offset: number, halfSpan: number, halfThick: number): BoxCollider =>
      alongZ
        ? { x: spec.x, z: spec.z + offset, halfX: halfThick, halfZ: halfSpan, active: true }
        : { x: spec.x + offset, z: spec.z, halfX: halfSpan, halfZ: halfThick, active: true };
    const stubOffset = OPENING_HALF + stubWidth / 2;
    this.panelCollider = box(0, OPENING_HALF, 0.07);
    this.panelCollider.active = false;
    this.colliders = [
      box(-stubOffset, stubWidth / 2, STUB_THICKNESS / 2),
      box(stubOffset, stubWidth / 2, STUB_THICKNESS / 2),
      this.panelCollider,
    ];
    const seg = (from: number, to: number): [number, number, number, number] =>
      alongZ
        ? [spec.x, spec.z + from, spec.x, spec.z + to]
        : [spec.x + from, spec.z, spec.x + to, spec.z];
    this.plane = seg(-HALF_SPAN, HALF_SPAN);
    this.stubs = [seg(-HALF_SPAN, -OPENING_HALF), seg(OPENING_HALF, HALF_SPAN)];
  }

  public get x(): number {
    return this.spec.x;
  }

  public get z(): number {
    return this.spec.z;
  }

  /** Whether a closed panel would overlap a circle at (x, z) — closing on someone is not allowed. */
  public panelOverlaps(x: number, z: number, radius: number): boolean {
    const c = this.panelCollider;
    const dx = x - THREE.MathUtils.clamp(x, c.x - c.halfX, c.x + c.halfX);
    const dz = z - THREE.MathUtils.clamp(z, c.z - c.halfZ, c.z + c.halfZ);
    return dx * dx + dz * dz < radius * radius;
  }

  /** Open or close; broken doors no longer close. Returns whether the state changed. */
  public toggle(): boolean {
    if (this.broken) return false;
    this.closed = !this.closed;
    this.panelCollider.active = this.closed;
    this.bashTimer = 0;
    return true;
  }

  /** Battered open by an entity: stays open for good. */
  public burstOpen(): void {
    this.closed = false;
    this.broken = true;
    this.panelCollider.active = false;
    this.bashTimer = 0;
    this.pivot.rotation.z = 0.06;
  }

  /** Does the segment a→b pass through solid parts of this door (whole plane when closed, stubs otherwise)? */
  public blocksSegment(ax: number, az: number, bx: number, bz: number): boolean {
    if (this.closed) {
      const [p1x, p1z, p2x, p2z] = this.plane;
      return segmentsIntersect(ax, az, bx, bz, p1x, p1z, p2x, p2z);
    }
    return this.stubs.some(([p1x, p1z, p2x, p2z]) => segmentsIntersect(ax, az, bx, bz, p1x, p1z, p2x, p2z));
  }

  public update(delta: number): void {
    const target = this.closed ? 0 : OPEN_ANGLE;
    const speed = this.broken ? BROKEN_SWING_SPEED : SWING_SPEED;
    const diff = target - this.angle;
    this.angle += THREE.MathUtils.clamp(diff, -speed * delta, speed * delta);
    this.pivot.rotation.y = this.angle;
  }
}
