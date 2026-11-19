import * as THREE from 'three';
import { HEADSHOT_MULTIPLIER } from './combat';
import { mergeStaticMeshes } from './meshMerge';
import { EntityArchetype, EntityState } from './types';

export interface EntityHitResult {
  hit: boolean;
  killed: boolean;
  headshot: boolean;
  /** Bullets do nothing to this entity (Smiler). */
  immune: boolean;
  /** The shot exposed a disguised Skin-Stealer. */
  revealed: boolean;
  damage: number;
  entityName: string;
}

export interface EntityTextureBundle {
  smilerFace: THREE.MeshBasicMaterial;
  smilerHaloTex: THREE.CanvasTexture;
  softShadowTex: THREE.CanvasTexture;
  howlerBodyTex: THREE.CanvasTexture;
  howlerNormalTex: THREE.DataTexture;
  bruteSkinTex: THREE.CanvasTexture;
  bruteNormalTex: THREE.DataTexture;
}

/** Positional sound source attached to an entity (implemented by the audio engine). */
export interface EntityVoice {
  setPosition(x: number, y: number, z: number): void;
  /** Muffle the voice when a wall or closed door is between it and the player. */
  setOccluded(occluded: boolean): void;
  playStep(heavy: boolean): void;
  playScreech(archetype: EntityArchetype): void;
  playIdle(archetype: EntityArchetype): void;
  /** Rising rasp right before a melee swing lands: the player's cue to back off. */
  playWindup(archetype: EntityArchetype): void;
  playDeath(): void;
  dispose(): void;
}

/** Level queries provided by the engine, so entities never touch the grid, doors or colliders directly. */
export interface EntityWorld {
  lineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean;
  /** Next waypoint toward `to`; routes around closed doors when another way exists. */
  nextStepToward(from: THREE.Vector3, to: THREE.Vector3, allowClosedDoors?: boolean): THREE.Vector3 | null;
  resolveCollision(pos: THREE.Vector3, radius: number): void;
  randomPointNear(center: THREE.Vector3, radiusCells: number): THREE.Vector3 | null;
  randomPatrolPoint(from: THREE.Vector3): THREE.Vector3 | null;
}

/** What entities may know about the player each frame. */
export interface PlayerPerception {
  pos: THREE.Vector3;
  /** Horizontal unit vector the player (and flashlight) faces. */
  forwardX: number;
  forwardZ: number;
  flashlightOn: boolean;
  crouched: boolean;
  hidden: boolean;
}

export interface EntityHooks {
  onAttack(entity: BackroomsEntity, damage: number): void;
  onScreech(entity: BackroomsEntity): void;
  /** The death / banish animation finished; the entity is out of play until respawned. */
  onRemoved(entity: BackroomsEntity, reason: 'killed' | 'banished'): void;
}

interface ArchetypeProfile {
  label: string;
  maxHealth: number;
  speedPatrol: number;
  speedChase: number;
  attackDamage: number;
  /** Vision range while the player's flashlight is off / on. */
  sightDark: number;
  sightLit: number;
  /** Cosine of the vision half-angle; -1 sees all around. */
  fovCos: number;
  /** Multiplier on noise radii; 0 is deaf. */
  hearing: number;
  immune: boolean;
  fearsLight: boolean;
}

/** Max health for an archetype (Smilers are immune to bullets; their value is unused). */
export function entityMaxHealth(archetype: EntityArchetype, nightmare: boolean): number {
  return buildProfile(archetype, nightmare).maxHealth;
}

export function isBulletImmune(archetype: EntityArchetype): boolean {
  return buildProfile(archetype, false).immune;
}

function buildProfile(archetype: EntityArchetype, nightmare: boolean): ArchetypeProfile {
  const hp = nightmare ? 1.35 : 1.0;
  const spd = nightmare ? 1.18 : 1.0;
  if (archetype === 'howler') {
    // Nearly blind sound hunter: fast and fragile, it tracks footsteps and gunshots.
    return {
      label: 'Bacteria Howler',
      maxHealth: Math.round(90 * hp),
      speedPatrol: 1.85 * spd,
      speedChase: 4.55 * spd,
      attackDamage: nightmare ? 28 : 20,
      sightDark: 3,
      sightLit: 3,
      fovCos: -1,
      hearing: 1.6,
      immune: false,
      fearsLight: false,
    };
  }
  if (archetype === 'smiler') {
    // Bullets pass through it; holding the flashlight on it banishes it. Sees far in the dark, deaf.
    return {
      label: 'Smiler',
      maxHealth: 1,
      speedPatrol: 1.6 * spd,
      speedChase: 3.3 * spd,
      attackDamage: nightmare ? 32 : 22,
      sightDark: 20,
      sightLit: 11,
      fovCos: -1,
      hearing: 0,
      immune: true,
      fearsLight: true,
    };
  }
  // Skin-Stealer: hides as an Almond Water bottle; slow but hits hard and spots a lit flashlight from afar.
  return {
    label: 'Skin-Stealer',
    maxHealth: Math.round(165 * hp),
    speedPatrol: 1.45 * spd,
    speedChase: 3.65 * spd,
    attackDamage: nightmare ? 38 : 28,
    sightDark: 9,
    sightLit: 16,
    fovCos: 0.26,
    hearing: 1.0,
    immune: false,
    fearsLight: false,
  };
}

const LIT_CONE_COS = 0.86; // ~31°, inside the flashlight spot cone
const LIT_RANGE = 15;
const BANISH_EXPOSURE = 1.6; // seconds of direct light that banish a Smiler
const REVEAL_RANGE = 2.2;
const REVEAL_DURATION = 0.7;
const DYING_DURATION = 0.8;
const ATTACK_RANGE = 1.6;
const STOP_RANGE = 1.25;
const SEARCH_DURATION = 7;
const GIVE_UP_AFTER = 8;
const ENTITY_RADIUS = 0.44;
// Awareness (game-ai skill: "delay the first reaction by roughly 0.2-0.5 s"). Seeing the player fills a 0-1
// meter, faster up close and at half speed against a crouching player. At AWARENESS_NOTICE the entity turns
// and comes to look; at 1 it hunts. Within arm's reach it is instant.
const AWARENESS_NOTICE = 0.35;
const AWARENESS_DECAY = 0.4; // per second while the player is out of view
const FIRST_STRIKE_DELAY = 0.45; // after a chase starts: the screech always comes before the first blow
// Melee is telegraphed (fps-shooter skill): a wind-up, then the blow lands only if the player is still close.
const WINDUP_TIME = 0.3;
const WINDUP_REACH = ATTACK_RANGE * 1.2;
// Hit reactions (game-feel skill): one stagger per burst, a tiny hit-stop on the target only, an eased flinch.
const STAGGER_COOLDOWN = 0.7;
const HIT_FREEZE = 0.05;
const KILL_FREEZE = 0.1;
/** Parts smaller than this (bounding radius, m) do not cast shadows: they are invisible in them anyway. */
const SHADOW_CASTER_MIN_RADIUS = 0.12;

export class BackroomsEntity {
  public readonly id: number;
  public readonly archetype: EntityArchetype;
  public readonly label: string;
  public readonly group: THREE.Group;
  public readonly position: THREE.Vector3;
  public health: number;
  public readonly maxHealth: number;
  /** Can be hit and can attack (false while dying, removed, or waiting to respawn). */
  public alive = true;
  public state: EntityState = 'patrol';
  public voice: EntityVoice | null = null;
  /** Line of sight to the player on the last update (drives audio occlusion). */
  public hasLineOfSightToPlayer = false;

  private readonly profile: ArchetypeProfile;
  private readonly bodyHitMeshes: THREE.Mesh[] = [];
  private readonly bodyParts: THREE.Object3D[] = [];
  private disguiseGroup: THREE.Group | null = null;
  private disguiseHitMesh: THREE.Mesh | null = null;
  private smilerFaceMesh: THREE.Mesh | null = null;
  private smilerHaloMat: THREE.MeshBasicMaterial | null = null;

  private patrolTarget = new THREE.Vector3();
  private lastKnown = new THREE.Vector3();
  private hasLastKnown = false;
  private cachedNextWaypoint = new THREE.Vector3();
  private pathTimer = 0;
  private animPhase = Math.random() * 10;
  private attackCooldown = 0;
  private staggerTimer = 0;
  private hitFlashTimer = 0;
  private screechCooldown = 0;
  private lostTimer = 0;
  private searchTimer = 0;
  private timeSinceSeen = 999;
  private lightExposure = 0;
  private dyingTimer = 0;
  private revealTimer = 0;
  private removalReason: 'killed' | 'banished' = 'killed';
  private stepTimer = 0;
  private idleTimer = 3 + Math.random() * 5;
  private twitchTimer = 4 + Math.random() * 4;
  private twitchLeft = 0;
  private stuckTimer = 0;
  private awareness = 0;
  private windupTimer = 0;
  private staggerCooldown = 0;
  private hitFreeze = 0;
  private flinch = 0;
  private lastProgressPos = new THREE.Vector3();
  private stateAtLastUpdate: EntityState = 'patrol';

  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly accentMat: THREE.MeshStandardMaterial;

  private torsoRef!: THREE.Object3D;
  private headRef!: THREE.Object3D;
  private leftArmRef!: THREE.Object3D;
  private rightArmRef!: THREE.Object3D;
  private leftLegRef?: THREE.Object3D;
  private rightLegRef?: THREE.Object3D;
  private contactShadow!: THREE.Mesh;

  constructor(
    id: number,
    archetype: EntityArchetype,
    spawnX: number,
    spawnZ: number,
    textures: EntityTextureBundle,
    nightmare: boolean,
    disguised = false,
  ) {
    this.id = id;
    this.archetype = archetype;
    this.profile = buildProfile(archetype, nightmare);
    this.label = this.profile.label;
    this.maxHealth = this.profile.maxHealth;
    this.health = this.maxHealth;
    this.group = new THREE.Group();
    this.position = this.group.position;
    this.position.set(spawnX, 0, spawnZ);

    if (archetype === 'howler') {
      this.bodyMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: textures.howlerBodyTex,
        normalMap: textures.howlerNormalTex,
        normalScale: new THREE.Vector2(1.1, 1.1),
        roughness: 0.72,
        metalness: 0.28,
      });
      this.accentMat = new THREE.MeshStandardMaterial({
        color: 0xd0c6b4,
        map: textures.howlerBodyTex,
        normalMap: textures.howlerNormalTex,
        normalScale: new THREE.Vector2(1.0, 1.0),
        roughness: 0.62,
        metalness: 0.34,
      });
      this.buildHowlerMesh(textures.softShadowTex);
    } else if (archetype === 'smiler') {
      this.bodyMat = new THREE.MeshStandardMaterial({
        color: 0x030305,
        roughness: 0.96,
        metalness: 0.0,
      });
      this.accentMat = new THREE.MeshStandardMaterial({
        color: 0x09090d,
        roughness: 0.92,
        metalness: 0.02,
        transparent: true,
        opacity: 0.86,
      });
      this.buildSmilerMesh(textures.smilerFace, textures.smilerHaloTex, textures.softShadowTex);
    } else {
      this.bodyMat = new THREE.MeshStandardMaterial({
        color: 0xd8cab8,
        map: textures.bruteSkinTex,
        normalMap: textures.bruteNormalTex,
        normalScale: new THREE.Vector2(1.0, 1.0),
        roughness: 0.68,
        metalness: 0.04,
      });
      this.accentMat = new THREE.MeshStandardMaterial({
        color: 0x785648,
        map: textures.bruteSkinTex,
        normalMap: textures.bruteNormalTex,
        normalScale: new THREE.Vector2(1.1, 1.1),
        roughness: 0.56,
        metalness: 0.06,
      });
      this.buildBruteMesh(textures.softShadowTex);
    }

    // Fewer draw calls (performance C3): join each rig piece's static parts per material, and let only large lit
    // parts cast shadows (teeth, claws, eyes and even the contact-shadow decal used to cast one each).
    const keep = new Set<THREE.Object3D>([this.contactShadow, ...this.bodyHitMeshes]);
    if (this.smilerFaceMesh) keep.add(this.smilerFaceMesh);
    mergeStaticMeshes(this.group, keep);
    if (archetype !== 'smiler') this.configureShadows();
    this.bodyParts.push(...this.group.children);
    if (archetype === 'brute') this.buildDisguise(textures.softShadowTex);

    this.cachedNextWaypoint.copy(this.position);
    this.patrolTarget.copy(this.position);
    this.lastProgressPos.copy(this.position);
    if (disguised) this.disguise();
  }

  private configureShadows(): void {
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || mesh === this.contactShadow || this.bodyHitMeshes.includes(mesh)) return;
      const lit = !(mesh.material as THREE.MeshBasicMaterial).isMeshBasicMaterial;
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
      const radius = mesh.geometry.boundingSphere?.radius ?? 0;
      mesh.castShadow = lit && radius >= SHADOW_CASTER_MIN_RADIUS;
      mesh.receiveShadow = lit;
    });
  }

  private addContactShadow(radius: number, softShadowTex: THREE.CanvasTexture): void {
    const geo = new THREE.PlaneGeometry(radius * 2.2, radius * 2.2);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: softShadowTex,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
    });
    this.contactShadow = new THREE.Mesh(geo, mat);
    this.contactShadow.position.y = 0.02;
    this.group.add(this.contactShadow);
  }

  private addHitbox(
    width: number,
    height: number,
    depth: number,
    yCenter: number,
    isHead: boolean,
  ): void {
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    box.position.y = yCenter;
    box.userData.entityId = this.id;
    box.userData.isHead = isHead;
    this.group.add(box);
    this.bodyHitMeshes.push(box);
  }

  private buildJointedLimb(
    upperLen: number,
    lowerLen: number,
    topR: number,
    midR: number,
    botR: number,
    matUpper: THREE.Material,
    matLower: THREE.Material,
  ): THREE.Group {
    const limb = new THREE.Group();
    const hipJoint = new THREE.Mesh(new THREE.SphereGeometry(topR * 1.15, 8, 8), matUpper);
    limb.add(hipJoint);

    const upper = new THREE.Mesh(
      new THREE.CylinderGeometry(topR, midR, upperLen, 8),
      matUpper,
    );
    upper.position.y = -upperLen * 0.5;
    limb.add(upper);

    const kneeJoint = new THREE.Mesh(new THREE.SphereGeometry(midR * 1.2, 8, 8), matLower);
    kneeJoint.position.y = -upperLen;
    limb.add(kneeJoint);

    const lower = new THREE.Mesh(
      new THREE.CylinderGeometry(midR, botR, lowerLen, 8),
      matLower,
    );
    lower.position.y = -upperLen - lowerLen * 0.5;
    limb.add(lower);

    return limb;
  }

  private buildHowlerMesh(softShadowTex: THREE.CanvasTexture): void {
    this.addContactShadow(0.68, softShadowTex);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });
    const socketMat = new THREE.MeshBasicMaterial({ color: 0x050403 });

    // Grounded, cleanly jointed wire-like legs meeting pelvis at y=1.18
    this.leftLegRef = this.buildJointedLimb(0.58, 0.6, 0.062, 0.042, 0.03, this.bodyMat, this.accentMat);
    this.leftLegRef.position.set(-0.15, 1.18, 0);

    this.rightLegRef = this.buildJointedLimb(0.58, 0.6, 0.062, 0.042, 0.03, this.bodyMat, this.accentMat);
    this.rightLegRef.position.set(0.15, 1.18, 0);

    // Continuous pelvis + hunched spine + knotted wire torso
    this.torsoRef = new THREE.Group();
    this.torsoRef.position.set(0, 1.16, 0);

    const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.145, 10, 8), this.bodyMat);
    pelvis.scale.set(1.2, 0.78, 0.88);
    this.torsoRef.add(pelvis);

    const lowerSpine = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.11, 0.48, 9), this.bodyMat);
    lowerSpine.position.set(0, 0.24, -0.02);
    lowerSpine.rotation.x = 0.14;
    this.torsoRef.add(lowerSpine);

    // Twisted secondary wire cables braiding around spine
    for (let s = -1; s <= 1; s += 2) {
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.62, 6), this.accentMat);
      cable.position.set(s * 0.075, 0.42, 0.04);
      cable.rotation.set(0.22, 0, s * 0.14);
      this.torsoRef.add(cable);
    }

    const upperChest = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.09, 0.54, 10), this.bodyMat);
    upperChest.position.set(0, 0.64, 0.04);
    upperChest.rotation.x = 0.24;
    upperChest.scale.set(1.22, 1.0, 0.76);
    this.torsoRef.add(upperChest);

    // Twisted wire shoulder bridge + asymmetrical dorsal spines
    const shoulders = new THREE.Mesh(new THREE.CapsuleGeometry(0.068, 0.44, 4, 8), this.bodyMat);
    shoulders.rotation.z = Math.PI / 2;
    shoulders.position.set(0, 0.86, 0.08);
    this.torsoRef.add(shoulders);

    const backTendrilL = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.46, 6), this.accentMat);
    backTendrilL.position.set(-0.15, 0.98, -0.1);
    backTendrilL.rotation.set(-0.5, 0, 0.3);
    const backTendrilR = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.48, 6), this.accentMat);
    backTendrilR.position.set(0.15, 1.0, -0.1);
    backTendrilR.rotation.set(-0.44, 0, -0.26);
    this.torsoRef.add(backTendrilL, backTendrilR);

    // Neck + gaunt elongated skull with recessed ocular hollows
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.068, 0.22, 8), this.bodyMat);
    neck.position.set(0, 0.94, 0.11);
    neck.rotation.x = 0.32;
    this.torsoRef.add(neck);

    this.headRef = new THREE.Group();
    this.headRef.position.set(0, 1.08, 0.16);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.155, 10, 10), this.bodyMat);
    skull.scale.set(0.78, 1.28, 0.95);
    const socketL = new THREE.Mesh(new THREE.SphereGeometry(0.036, 8, 8), socketMat);
    socketL.position.set(-0.054, 0.03, 0.112);
    const socketR = new THREE.Mesh(new THREE.SphereGeometry(0.036, 8, 8), socketMat);
    socketR.position.set(0.054, 0.05, 0.112);
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 8), eyeMat);
    eyeL.position.set(-0.054, 0.03, 0.14);
    const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 8), eyeMat);
    eyeR.position.set(0.054, 0.05, 0.14);
    const jaw = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.15, 7), this.accentMat);
    jaw.position.set(0, -0.14, 0.055);
    jaw.rotation.x = Math.PI;
    this.headRef.add(skull, socketL, socketR, eyeL, eyeR, jaw);
    this.torsoRef.add(this.headRef);

    // Elongated articulated arms + 3 gnarled wire claws
    this.leftArmRef = this.buildJointedLimb(0.55, 0.62, 0.052, 0.036, 0.022, this.bodyMat, this.accentMat);
    this.leftArmRef.position.set(-0.24, 0.86, 0.08);
    this.leftArmRef.rotation.x = -0.35;

    this.rightArmRef = this.buildJointedLimb(0.55, 0.62, 0.052, 0.036, 0.022, this.bodyMat, this.accentMat);
    this.rightArmRef.position.set(0.24, 0.86, 0.08);
    this.rightArmRef.rotation.x = -0.35;

    for (const arm of [this.leftArmRef, this.rightArmRef]) {
      for (let c = -1; c <= 1; c++) {
        const claw = new THREE.Mesh(new THREE.ConeGeometry(0.011, 0.17, 5), this.accentMat);
        claw.position.set(c * 0.018, -1.24, 0.02);
        claw.rotation.x = Math.PI - 0.18;
        arm.add(claw);
      }
    }

    this.torsoRef.add(this.leftArmRef, this.rightArmRef);
    this.group.add(this.leftLegRef, this.rightLegRef, this.torsoRef);

    // Body box spans 0.275–1.91 so its top meets the head box (1.91–2.39) with no unhittable gap.
    this.addHitbox(0.7, 1.635, 0.65, 1.0925, false);
    this.addHitbox(0.45, 0.48, 0.45, 2.15, true);
  }

  private buildSmilerMesh(
    smilerFaceMat: THREE.MeshBasicMaterial,
    smilerHaloTex: THREE.CanvasTexture,
    softShadowTex: THREE.CanvasTexture,
  ): void {
    this.addContactShadow(0.84, softShadowTex);

    this.torsoRef = new THREE.Group();
    this.torsoRef.position.set(0, 1.15, 0);

    // Tapered abyssal void torso fading into a shadowy wisp above the carpet (no flat bell skirt)
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.06, 1.52, 12), this.bodyMat);
    core.position.y = 0.06;
    this.torsoRef.add(core);

    const mantle = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.34, 0.56, 12), this.accentMat);
    mantle.position.y = 0.45;
    this.torsoRef.add(mantle);

    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      const wisp = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.95, 7), this.accentMat);
      wisp.position.set(Math.cos(ang) * 0.18, -0.35, Math.sin(ang) * 0.16);
      wisp.rotation.set(Math.PI + Math.sin(ang) * 0.14, 0, Math.cos(ang) * 0.14);
      this.torsoRef.add(wisp);
    }

    const hood = new THREE.Mesh(new THREE.SphereGeometry(0.35, 14, 12), this.bodyMat);
    hood.position.set(0, 0.84, -0.02);
    hood.scale.set(0.98, 1.14, 0.92);
    this.torsoRef.add(hood);

    // Slender shadowy tendrils hanging down cleanly from shoulders
    this.leftArmRef = new THREE.Group();
    this.leftArmRef.position.set(-0.29, 0.64, 0.02);
    const lShoulder = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 8), this.bodyMat);
    const lTendril = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.01, 0.92, 8), this.accentMat);
    lTendril.position.set(-0.04, -0.44, 0.12);
    lTendril.rotation.set(-0.26, 0, 0.1);
    this.leftArmRef.add(lShoulder, lTendril);

    this.rightArmRef = new THREE.Group();
    this.rightArmRef.position.set(0.29, 0.64, 0.02);
    const rShoulder = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 8), this.bodyMat);
    const rTendril = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.01, 0.92, 8), this.accentMat);
    rTendril.position.set(0.04, -0.44, 0.12);
    rTendril.rotation.set(-0.26, 0, -0.1);
    this.rightArmRef.add(rShoulder, rTendril);

    this.torsoRef.add(this.leftArmRef, this.rightArmRef);

    // Iconic glowing Smiler face + eerie halo aura
    this.headRef = new THREE.Group();
    this.headRef.position.set(0, 0.84, 0.35);
    const haloMat = new THREE.MeshBasicMaterial({
      map: smilerHaloTex,
      transparent: true,
      opacity: 0.48,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const haloPlane = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 1.05), haloMat);
    haloPlane.position.z = -0.02;
    const facePlane = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.68), smilerFaceMat);
    this.headRef.add(haloPlane, facePlane);
    this.smilerFaceMesh = facePlane;
    this.smilerHaloMat = haloMat;
    this.torsoRef.add(this.headRef);

    this.group.add(this.torsoRef);

    // Body box spans 0.175–1.605 so its top meets the head box (1.605–2.155) with no unhittable gap.
    this.addHitbox(0.85, 1.43, 0.75, 0.89, false);
    this.addHitbox(0.6, 0.55, 0.6, 1.88, true);
  }

  private buildBruteMesh(softShadowTex: THREE.CanvasTexture): void {
    this.addContactShadow(0.9, softShadowTex);
    const socketMat = new THREE.MeshBasicMaterial({ color: 0x160a08 });
    const pupilMat = new THREE.MeshBasicMaterial({ color: 0xffe49e });
    const toothMat = new THREE.MeshStandardMaterial({ color: 0xd9cfb8, roughness: 0.4 });
    const collarMat = new THREE.MeshStandardMaterial({ color: 0x2a241e, roughness: 0.92 });

    this.leftLegRef = this.buildJointedLimb(0.5, 0.5, 0.145, 0.115, 0.09, this.bodyMat, this.bodyMat);
    this.leftLegRef.position.set(-0.22, 0.98, 0);

    this.rightLegRef = this.buildJointedLimb(0.5, 0.5, 0.145, 0.115, 0.09, this.bodyMat, this.bodyMat);
    this.rightLegRef.position.set(0.22, 0.98, 0);

    this.torsoRef = new THREE.Group();
    this.torsoRef.position.set(0, 0.96, 0);

    const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), collarMat);
    pelvis.scale.set(1.12, 0.68, 0.82);
    this.torsoRef.add(pelvis);

    const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.27, 0.84, 12), this.bodyMat);
    chest.position.y = 0.46;
    chest.scale.set(1.16, 1.0, 0.74);
    this.torsoRef.add(chest);

    // Asymmetrical hunched muscle mass (flesh-toned, not cartoonish red)
    const shoulderHump = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), this.accentMat);
    shoulderHump.position.set(0.2, 0.78, -0.04);
    shoulderHump.scale.set(1.05, 0.9, 0.95);
    this.torsoRef.add(shoulderHump);

    const tornCollar = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.045, 6, 12), collarMat);
    tornCollar.rotation.x = Math.PI / 2 + 0.15;
    tornCollar.position.set(0, 0.86, 0.02);
    this.torsoRef.add(tornCollar);

    // Sculpted gaunt skull with dark sunken eye sockets & jagged toothed maw
    this.headRef = new THREE.Group();
    this.headRef.position.set(-0.02, 1.04, 0.08);
    const cranium = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 10), this.bodyMat);
    cranium.scale.set(0.88, 1.18, 0.98);
    this.headRef.add(cranium);

    const socketL = new THREE.Mesh(new THREE.SphereGeometry(0.048, 8, 8), socketMat);
    socketL.position.set(-0.072, 0.045, 0.165);
    const socketR = new THREE.Mesh(new THREE.SphereGeometry(0.048, 8, 8), socketMat);
    socketR.position.set(0.072, 0.03, 0.165);
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.015, 8, 8), pupilMat);
    eyeL.position.set(-0.072, 0.045, 0.205);
    const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.015, 8, 8), pupilMat);
    eyeR.position.set(0.072, 0.03, 0.205);

    const mawCavity = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), socketMat);
    mawCavity.position.set(0, -0.095, 0.15);
    mawCavity.scale.set(1.05, 0.88, 0.65);

    for (let t = -2; t <= 2; t++) {
      const upperTooth = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.042, 4), toothMat);
      upperTooth.position.set(t * 0.028, -0.058, 0.195);
      upperTooth.rotation.x = Math.PI;
      const lowerTooth = new THREE.Mesh(new THREE.ConeGeometry(0.013, 0.038, 4), toothMat);
      lowerTooth.position.set(t * 0.026 + 0.012, -0.132, 0.19);
      this.headRef.add(upperTooth, lowerTooth);
    }

    this.headRef.add(socketL, socketR, eyeL, eyeR, mawCavity);
    this.torsoRef.add(this.headRef);

    this.leftArmRef = this.buildJointedLimb(0.48, 0.5, 0.11, 0.088, 0.062, this.bodyMat, this.accentMat);
    this.leftArmRef.position.set(-0.42, 0.78, 0);

    this.rightArmRef = this.buildJointedLimb(0.52, 0.56, 0.12, 0.092, 0.068, this.bodyMat, this.accentMat);
    this.rightArmRef.position.set(0.42, 0.78, 0);

    this.torsoRef.add(this.leftArmRef, this.rightArmRef);
    this.group.add(this.leftLegRef, this.rightLegRef, this.torsoRef);

    // Body box spans 0.3–1.77 so its top meets the head box (1.77–2.27) with no unhittable gap.
    this.addHitbox(0.95, 1.47, 0.75, 1.035, false);
    this.addHitbox(0.55, 0.5, 0.55, 2.02, true);
  }

  private buildDisguise(softShadowTex: THREE.CanvasTexture): void {
    // Looks exactly like an Almond Water pickup, except that it never spins and now and then shudders.
    const disguise = new THREE.Group();
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x5ea2b0,
      roughness: 0.24,
      metalness: 0.65,
      emissive: new THREE.Color(0x215863),
      emissiveIntensity: 0.45,
    });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xd4a63a, roughness: 0.26, metalness: 0.85 });
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.42).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: softShadowTex, transparent: true, opacity: 0.78, depthWrite: false }),
    );
    shadow.position.y = 0.015;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.3, 12), waterMat);
    body.position.y = 0.15;
    const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.09, 0.07, 12), waterMat);
    shoulder.position.y = 0.335;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 10), capMat);
    cap.position.y = 0.39;
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.55, 0.4),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.y = 0.25;
    hit.userData.entityId = this.id;
    hit.userData.isHead = false;
    disguise.add(shadow, body, shoulder, cap, hit);
    disguise.visible = false;
    this.group.add(disguise);
    this.disguiseGroup = disguise;
    this.disguiseHitMesh = hit;
  }

  public get isDisguised(): boolean {
    return this.state === 'disguised';
  }

  /** Counts toward proximity cues (heartbeat, HUD); a disguised Skin-Stealer must not give itself away. */
  public get isThreat(): boolean {
    return this.alive && this.state !== 'disguised';
  }

  public get isRemoved(): boolean {
    return this.state === 'removed';
  }

  /** Hunting the player or a noise (used for door bashing). */
  public get isEngaged(): boolean {
    return this.alive && (this.state === 'chase' || this.state === 'investigate');
  }

  /** 0-1 detection meter (debug / tests). */
  public get awarenessLevel(): number {
    return this.awareness;
  }

  public get isWindingUp(): boolean {
    return this.windupTimer > 0;
  }

  public activeHitMeshes(): THREE.Mesh[] {
    if (!this.alive) return [];
    if (this.state === 'disguised' && this.disguiseHitMesh) return [this.disguiseHitMesh];
    return this.bodyHitMeshes;
  }

  public faceWorldPoint(x: number, z: number): void {
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    if (dx * dx + dz * dz > 1e-4) {
      this.group.rotation.y = Math.atan2(dx, dz);
    }
  }

  private setBodyVisible(visible: boolean): void {
    for (const part of this.bodyParts) part.visible = visible;
    if (this.disguiseGroup) this.disguiseGroup.visible = !visible;
  }

  public disguise(): void {
    if (!this.disguiseGroup) return;
    this.state = 'disguised';
    this.setBodyVisible(false);
    this.group.scale.set(1, 1, 1);
    this.disguiseGroup.rotation.z = 0;
    this.twitchLeft = 0;
    this.hasLastKnown = false;
    this.revealTimer = 0;
    this.stuckTimer = 0;
  }

  /** Start hunting. A fresh chase always gives the player a beat before the first blow. */
  private enterChase(): void {
    if (this.state !== 'chase') this.attackCooldown = Math.max(this.attackCooldown, FIRST_STRIKE_DELAY);
    this.state = 'chase';
    this.awareness = 1;
  }

  private reveal(): void {
    this.setBodyVisible(true);
    this.state = 'chase';
    this.awareness = 1;
    this.revealTimer = REVEAL_DURATION;
    this.group.scale.set(1, 0.25, 1);
    this.screechCooldown = 5.5;
    this.stuckTimer = 0;
  }

  /** Bring a removed entity back into play (director respawns). */
  public respawn(x: number, z: number, disguised: boolean): void {
    this.position.set(x, 0, z);
    this.health = this.maxHealth;
    this.alive = true;
    this.group.visible = true;
    this.group.scale.set(1, 1, 1);
    this.torsoRef.rotation.set(0, 0, 0);
    this.bodyMat.emissive.setHex(0x000000);
    this.bodyMat.emissiveIntensity = 0;
    this.lightExposure = 0;
    this.hasLastKnown = false;
    this.hasLineOfSightToPlayer = false;
    this.lostTimer = 0;
    this.searchTimer = 0;
    this.staggerTimer = 0;
    this.dyingTimer = 0;
    this.hitFlashTimer = 0;
    this.screechCooldown = 0;
    this.timeSinceSeen = 999;
    this.revealTimer = 0;
    this.attackCooldown = 0;
    this.pathTimer = 0;
    this.twitchLeft = 0;
    this.stuckTimer = 0;
    this.awareness = 0;
    this.windupTimer = 0;
    this.staggerCooldown = 0;
    this.hitFreeze = 0;
    this.flinch = 0;
    if (this.disguiseGroup) this.disguiseGroup.rotation.z = 0;
    this.cachedNextWaypoint.copy(this.position);
    this.patrolTarget.copy(this.position);
    this.lastProgressPos.copy(this.position);
    if (this.smilerFaceMesh) this.smilerFaceMesh.visible = true;
    if (this.smilerHaloMat) this.smilerHaloMat.opacity = 0.48;
    this.state = 'patrol';
    this.setBodyVisible(true);
    if (disguised) this.disguise();
    this.stateAtLastUpdate = this.state;
  }

  public applyDamage(baseDamage: number, isHead: boolean): EntityHitResult {
    if (!this.alive) {
      return {
        hit: false,
        killed: false,
        headshot: false,
        immune: false,
        revealed: false,
        damage: 0,
        entityName: this.label,
      };
    }
    if (this.profile.immune) {
      this.hitFlashTimer = 0.15;
      return {
        hit: true,
        killed: false,
        headshot: false,
        immune: true,
        revealed: false,
        damage: 0,
        entityName: this.label,
      };
    }

    let revealed = false;
    if (this.state === 'disguised') {
      this.reveal();
      revealed = true;
    }
    const finalDamage = Math.round(baseDamage * (isHead ? HEADSHOT_MULTIPLIER : 1.0));
    this.health = Math.max(0, this.health - finalDamage);
    this.hitFlashTimer = 0.07;
    this.hitFreeze = HIT_FREEZE;
    this.flinch = 1;
    // Only the first hit of a burst staggers; otherwise a steady trigger froze a charging Howler in place.
    if (!revealed && this.staggerCooldown <= 0) {
      this.state = 'stagger';
      this.staggerTimer = 0.18;
      this.staggerCooldown = STAGGER_COOLDOWN;
      this.windupTimer = 0; // a staggering hit interrupts a swing
    }

    // Subtle whole-body impact tint (never cartoonish red boots/gloves)
    this.bodyMat.emissive.setHex(0x3a0c08);
    this.bodyMat.emissiveIntensity = 0.28;

    const killed = this.health <= 0;
    if (killed) {
      this.hitFreeze = KILL_FREEZE;
      this.beginDying('killed');
    }
    return {
      hit: true,
      killed,
      headshot: isHead,
      immune: false,
      revealed,
      damage: finalDamage,
      entityName: this.label,
    };
  }

  private beginDying(reason: 'killed' | 'banished'): void {
    this.alive = false;
    this.state = 'dying';
    this.dyingTimer = DYING_DURATION;
    this.removalReason = reason;
    this.voice?.playDeath();
  }

  /** A sound of the given radius at `pos`. Howlers hear 1.6x as far; Smilers are deaf. */
  public hearNoise(pos: THREE.Vector3, radius: number): void {
    if (!this.alive || this.profile.hearing <= 0) return;
    if (this.state === 'disguised' || this.state === 'retreat') return;
    const d = Math.hypot(pos.x - this.position.x, pos.z - this.position.z);
    if (d > radius * this.profile.hearing) return;
    this.lastKnown.copy(pos);
    this.hasLastKnown = true;
    this.lostTimer = 0;
    this.pathTimer = 0;
    if (this.state === 'chase' || this.state === 'stagger') return;
    // Howlers lunge at nearby sounds; everything else goes to look.
    if (this.archetype === 'howler' && d < 10) this.enterChase();
    else this.state = 'investigate';
  }

  /** Director-level omniscience (e.g. final tape): every active entity (including deaf Smilers) knows where you are. */
  public alertTo(pos: THREE.Vector3): void {
    if (!this.alive || this.state === 'disguised' || this.state === 'retreat') return;
    this.lastKnown.copy(pos);
    this.hasLastKnown = true;
    this.lostTimer = 0;
    this.pathTimer = 0;
    if (this.state !== 'stagger') this.enterChase();
  }

  public update(
    delta: number,
    player: PlayerPerception,
    world: EntityWorld,
    hooks: EntityHooks,
  ): void {
    if (this.state === 'removed') return;
    if (this.state === 'dying') {
      this.updateDying(delta, hooks);
      return;
    }

    if (this.hitFlashTimer > 0) {
      this.hitFlashTimer -= delta;
      if (this.hitFlashTimer <= 0) {
        this.bodyMat.emissive.setHex(0x000000);
        this.bodyMat.emissiveIntensity = 0;
      }
    }
    if (this.attackCooldown > 0) this.attackCooldown -= delta;
    if (this.screechCooldown > 0) this.screechCooldown -= delta;
    if (this.staggerCooldown > 0) this.staggerCooldown -= delta;
    if (this.hitFreeze > 0) {
      // Hit-stop on this entity only: hold the pose for a few frames; the rest of the world keeps running.
      this.hitFreeze -= delta;
      return;
    }

    const dx = player.pos.x - this.position.x;
    const dz = player.pos.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    const los = dist < 32 && world.lineOfSight(this.position, player.pos);
    this.hasLineOfSightToPlayer = los;
    if (this.voice) {
      this.voice.setPosition(this.position.x, 1.4, this.position.z);
      this.voice.setOccluded(!los);
    }

    if (this.state === 'disguised') {
      this.updateDisguised(delta, dist, los, player, hooks);
      this.stateAtLastUpdate = this.state;
      return;
    }

    if (this.revealTimer > 0) {
      // Unfolding out of the bottle: grow to full height, then hunt.
      this.revealTimer -= delta;
      const t = 1 - Math.max(0, this.revealTimer) / REVEAL_DURATION;
      this.group.scale.set(1, 0.25 + 0.75 * t, 1);
      this.turnToward(player.pos.x, player.pos.z, delta, 12);
      this.lastKnown.copy(player.pos);
      this.hasLastKnown = true;
      this.animate(delta, false);
      this.stateAtLastUpdate = this.state;
      return;
    }

    if (this.state === 'stagger') {
      this.staggerTimer -= delta;
      if (this.staggerTimer <= 0) {
        if (this.hasLastKnown) this.state = 'chase';
        else this.enterSearch(world);
      }
    }

    // Smiler: the flashlight beam drives it back and, held on it long enough, banishes it.
    let lit = false;
    if (this.profile.fearsLight && this.state !== 'stagger') {
      lit =
        player.flashlightOn &&
        los &&
        dist < LIT_RANGE &&
        dist > 0.01 &&
        (-dx * player.forwardX - dz * player.forwardZ) / dist >= LIT_CONE_COS;
      if (lit) {
        this.lightExposure += delta;
        this.state = 'retreat';
        if (this.lightExposure >= BANISH_EXPOSURE) {
          this.beginDying('banished');
          return;
        }
      } else {
        this.lightExposure = Math.max(0, this.lightExposure - delta * 0.5);
        if (this.state === 'retreat') this.state = this.hasLastKnown ? 'chase' : 'patrol';
      }
    }

    // Vision: range depends on the player's light and stance; most entities only see in front of them.
    // Seeing the player fills the awareness meter instead of triggering a chase on the spot.
    let sees = false;
    if (this.state !== 'retreat' && this.state !== 'stagger') {
      let sight = player.flashlightOn ? this.profile.sightLit : this.profile.sightDark;
      if (player.crouched) sight *= 0.6;
      if (player.hidden) sight = Math.min(sight, 1.0);
      let inView = false;
      if (los && dist <= sight) {
        if (dist < 3 || this.profile.fovCos <= -1) {
          inView = true;
        } else {
          const fx = Math.sin(this.group.rotation.y);
          const fz = Math.cos(this.group.rotation.y);
          inView = (dx * fx + dz * fz) / dist >= this.profile.fovCos;
        }
      }
      // Anything standing in the open within arm's reach gets noticed at once.
      const armsReach = los && dist < 1.8 && !player.hidden;
      sees = inView || armsReach;
      if (sees) {
        if (armsReach || this.state === 'chase') {
          this.awareness = 1;
        } else {
          const closeness = 1 - Math.min(1, dist / Math.max(sight, 0.001));
          const rate = (0.6 + 4.4 * closeness) * (player.crouched ? 0.5 : 1);
          this.awareness = Math.min(1, this.awareness + rate * delta);
        }
        this.timeSinceSeen = 0;
      } else {
        this.awareness = Math.max(0, this.awareness - AWARENESS_DECAY * delta);
        this.timeSinceSeen += delta;
      }
      if (sees && this.awareness >= 1) {
        this.lastKnown.copy(player.pos);
        this.hasLastKnown = true;
        this.lostTimer = 0;
        this.enterChase();
      } else if (
        sees &&
        this.awareness >= AWARENESS_NOTICE &&
        (this.state === 'patrol' || this.state === 'search' || this.state === 'investigate')
      ) {
        // Something moved: turn and come closer to look. This bark is the player's cue to back off or hide.
        if (this.state !== 'investigate') {
          this.voice?.playIdle(this.archetype);
          this.pathTimer = 0;
        }
        this.state = 'investigate';
        this.lastKnown.copy(player.pos);
        this.hasLastKnown = true;
        this.lostTimer = 0;
      }
    }

    if (this.state === 'chase' && this.stateAtLastUpdate !== 'chase' && this.screechCooldown <= 0) {
      this.screechCooldown = 5.5;
      hooks.onScreech(this);
    }

    // Losing the trail: walk to the last known spot, search around it, then go back to wandering.
    if (this.state === 'chase' && !sees) {
      this.lostTimer += delta;
      if (!this.hasLastKnown || this.distanceTo(this.lastKnown) < 1.0 || this.lostTimer > GIVE_UP_AFTER) {
        this.enterSearch(world);
      }
    } else if (this.state === 'investigate') {
      if (!this.hasLastKnown || this.distanceTo(this.lastKnown) < 1.0) this.enterSearch(world);
    } else if (this.state === 'search') {
      this.searchTimer -= delta;
      if (this.distanceTo(this.patrolTarget) < 1.0) this.pickSearchPoint(world);
      if (this.searchTimer <= 0) {
        if (this.disguiseGroup && this.timeSinceSeen > 20 && dist > 14) {
          // A Skin-Stealer that lost its prey goes back to pretending to be supplies.
          this.disguise();
          this.stateAtLastUpdate = this.state;
          return;
        }
        this.state = 'patrol';
        this.pickPatrolPoint(world);
      }
    } else if (this.state === 'patrol') {
      if (this.distanceTo(this.patrolTarget) < 1.2) this.pickPatrolPoint(world);
    }

    let target: THREE.Vector3 | null = null;
    let speed = 0;
    if (this.state === 'chase') {
      target = sees ? player.pos : this.lastKnown;
      speed = sees ? this.profile.speedChase : this.profile.speedChase * 0.8;
    } else if (this.state === 'investigate') {
      target = this.lastKnown;
      speed = this.profile.speedChase * 0.7;
    } else if (this.state === 'search') {
      target = this.patrolTarget;
      speed = this.profile.speedPatrol * 1.15;
    } else if (this.state === 'patrol') {
      target = this.patrolTarget;
      speed = this.profile.speedPatrol;
    }

    let moved = false;
    if (this.state === 'retreat') {
      if (dist > 0.01) {
        const step = 2.6 * delta;
        this.position.x -= (dx / dist) * step;
        this.position.z -= (dz / dist) * step;
        world.resolveCollision(this.position, ENTITY_RADIUS);
      }
      this.turnToward(player.pos.x, player.pos.z, delta, 10);
    } else if (target) {
      this.pathTimer -= delta;
      if (this.pathTimer <= 0) {
        this.pathTimer = this.state === 'chase' ? 0.35 : 0.8;
        if (sees && this.state === 'chase') {
          this.cachedNextWaypoint.copy(player.pos);
        } else {
          const stepPos = world.nextStepToward(this.position, target, this.isEngaged);
          if (stepPos) {
            this.cachedNextWaypoint.copy(stepPos);
          } else {
            // Closed door seals off this non-engaged patrol/search target; pick another reachable spot.
            if (this.state === 'search') this.pickSearchPoint(world);
            else if (this.state === 'patrol') this.pickPatrolPoint(world);
            this.cachedNextWaypoint.copy(this.position);
          }
        }
      }
      const wx = this.cachedNextWaypoint.x - this.position.x;
      const wz = this.cachedNextWaypoint.z - this.position.z;
      const len = Math.hypot(wx, wz);
      const holdDistance = this.state === 'chase' && sees && dist <= STOP_RANGE;
      if (len > 0.08 && !holdDistance) {
        const step = Math.min(speed * delta, len);
        this.position.x += (wx / len) * step;
        this.position.z += (wz / len) * step;
        world.resolveCollision(this.position, ENTITY_RADIUS);
        this.turnToward(this.cachedNextWaypoint.x, this.cachedNextWaypoint.z, delta, 9);
        moved = true;

        // If patrolling/searching gets pinned against a corner or closed door, pick a new destination.
        if (this.state === 'patrol' || this.state === 'search') {
          if (Math.hypot(this.position.x - this.lastProgressPos.x, this.position.z - this.lastProgressPos.z) > 0.25) {
            this.lastProgressPos.copy(this.position);
            this.stuckTimer = 0;
          } else {
            this.stuckTimer += delta;
            if (this.stuckTimer > 1.6) {
              this.stuckTimer = 0;
              if (this.state === 'search') this.pickSearchPoint(world);
              else this.pickPatrolPoint(world);
            }
          }
        } else {
          this.stuckTimer = 0;
          this.lastProgressPos.copy(this.position);
        }
      } else {
        if (len <= 0.08) this.pathTimer = 0; // reached the waypoint: plan the next one right away
        if (sees) this.turnToward(player.pos.x, player.pos.z, delta, 10);
      }
    }

    if (this.windupTimer > 0) {
      this.windupTimer -= delta;
      if (this.windupTimer <= 0) {
        this.attackCooldown = 1.15;
        // Backing off (or breaking line of sight) during the wind-up dodges the blow.
        if (this.state === 'chase' && sees && dist <= WINDUP_REACH) hooks.onAttack(this, this.profile.attackDamage);
      }
    } else if (this.state === 'chase' && sees && dist <= ATTACK_RANGE && this.attackCooldown <= 0) {
      this.windupTimer = WINDUP_TIME;
      this.voice?.playWindup(this.archetype);
    }

    if (moved && this.archetype !== 'smiler') {
      this.stepTimer -= delta;
      if (this.stepTimer <= 0) {
        this.stepTimer = speed > 3 ? 0.3 : 0.55;
        this.voice?.playStep(this.archetype === 'brute');
      }
    }
    this.idleTimer -= delta;
    if (this.idleTimer <= 0) {
      this.idleTimer = (this.state === 'chase' ? 2.5 : 4.5) + Math.random() * 4;
      this.voice?.playIdle(this.archetype);
    }

    this.animate(delta, lit);
    this.stateAtLastUpdate = this.state;
  }

  private updateDisguised(
    delta: number,
    dist: number,
    los: boolean,
    player: PlayerPerception,
    hooks: EntityHooks,
  ): void {
    this.twitchTimer -= delta;
    if (this.twitchTimer <= 0) {
      this.twitchTimer = 5 + Math.random() * 4;
      this.twitchLeft = 0.3;
    }
    if (this.disguiseGroup) {
      if (this.twitchLeft > 0) {
        this.twitchLeft -= delta;
        this.disguiseGroup.rotation.z = Math.sin(this.twitchLeft * 70) * 0.07;
      } else {
        this.disguiseGroup.rotation.z = 0;
      }
    }
    if (los && dist <= REVEAL_RANGE) {
      this.reveal();
      this.lastKnown.copy(player.pos);
      this.hasLastKnown = true;
      hooks.onScreech(this);
    }
  }

  private updateDying(delta: number, hooks: EntityHooks): void {
    if (this.hitFreeze > 0) {
      this.hitFreeze -= delta;
      return;
    }
    // VHS-glitch collapse: flicker, jitter sideways and sink into the carpet.
    this.dyingTimer -= delta;
    const t = 1 - Math.max(0, this.dyingTimer) / DYING_DURATION;
    this.group.scale.set(
      1 + (Math.random() - 0.5) * 0.35 * t,
      Math.max(0.02, 1 - t * 0.95),
      1 + (Math.random() - 0.5) * 0.35 * t,
    );
    this.group.visible = Math.random() > t * 0.6;
    if (this.dyingTimer <= 0) {
      this.group.visible = false;
      this.state = 'removed';
      hooks.onRemoved(this, this.removalReason);
    }
  }

  private enterSearch(world: EntityWorld): void {
    this.state = 'search';
    this.searchTimer = SEARCH_DURATION;
    this.pickSearchPoint(world);
  }

  private pickSearchPoint(world: EntityWorld): void {
    const center = this.hasLastKnown ? this.lastKnown : this.position;
    const p = world.randomPointNear(center, 2);
    this.patrolTarget.copy(p ?? center);
    this.pathTimer = 0;
  }

  private pickPatrolPoint(world: EntityWorld): void {
    const p = world.randomPatrolPoint(this.position);
    if (p) this.patrolTarget.copy(p);
    this.pathTimer = 0;
  }

  private distanceTo(p: THREE.Vector3): number {
    return Math.hypot(p.x - this.position.x, p.z - this.position.z);
  }

  private turnToward(x: number, z: number, delta: number, rate: number): void {
    const desiredYaw = Math.atan2(x - this.position.x, z - this.position.z);
    const diff = Math.atan2(
      Math.sin(desiredYaw - this.group.rotation.y),
      Math.cos(desiredYaw - this.group.rotation.y),
    );
    this.group.rotation.y += diff * Math.min(1, delta * rate);
  }

  private animate(delta: number, lit: boolean): void {
    const hunting = this.state === 'chase' || this.state === 'investigate';
    // Legs stop while staggered, so the hit reads as a hit rather than a stumble-walk.
    this.animPhase += delta * (this.state === 'stagger' ? 0 : hunting ? 11.5 : 4.2);

    if (this.archetype === 'howler') {
      const twitch = Math.sin(this.animPhase * 2.7) * 0.14;
      this.headRef.rotation.z = twitch + Math.cos(this.animPhase * 1.1) * 0.18;
      this.torsoRef.rotation.x = hunting ? 0.22 : 0.1;
      this.leftArmRef.rotation.x = Math.sin(this.animPhase) * 0.55 - (hunting ? 0.6 : 0.25);
      this.rightArmRef.rotation.x = -Math.sin(this.animPhase) * 0.55 - (hunting ? 0.6 : 0.25);
      if (this.leftLegRef && this.rightLegRef) {
        this.leftLegRef.rotation.x = Math.sin(this.animPhase) * 0.45;
        this.rightLegRef.rotation.x = -Math.sin(this.animPhase) * 0.45;
      }
    } else if (this.archetype === 'smiler') {
      this.torsoRef.position.y = 1.12 + Math.sin(this.animPhase * 0.45) * 0.12;
      this.torsoRef.rotation.x = 0;
      this.torsoRef.rotation.z = Math.sin(this.animPhase * 0.32) * 0.08;
      this.leftArmRef.rotation.z = Math.sin(this.animPhase * 0.7) * 0.18;
      this.rightArmRef.rotation.z = -Math.sin(this.animPhase * 0.7) * 0.18;
      if (this.smilerFaceMesh && this.smilerHaloMat) {
        // Caught in the beam (or shot): the grin stutters like a bad tape.
        const flicker = lit || this.hitFlashTimer > 0;
        this.smilerFaceMesh.visible = !flicker || Math.random() > 0.35;
        this.smilerHaloMat.opacity = flicker ? 0.15 + Math.random() * 0.5 : 0.48;
      }
    } else {
      const limp = Math.abs(Math.sin(this.animPhase * 0.75)) * 0.07;
      this.torsoRef.position.y = 0.96 + limp;
      this.torsoRef.rotation.x = 0;
      this.torsoRef.rotation.z = Math.sin(this.animPhase * 0.75) * 0.08;
      this.leftArmRef.rotation.x = Math.sin(this.animPhase * 0.75) * 0.42;
      this.rightArmRef.rotation.x = -Math.sin(this.animPhase * 0.75) * 0.25 - 0.3;
      if (this.leftLegRef && this.rightLegRef) {
        this.leftLegRef.rotation.x = Math.sin(this.animPhase * 0.75) * 0.38;
        this.rightLegRef.rotation.x = -Math.sin(this.animPhase * 0.75) * 0.38;
      }
    }

    // Eased flinch on top of the pose (instead of snapping the torso back and forth).
    this.flinch = THREE.MathUtils.damp(this.flinch, 0, 10, delta);
    this.torsoRef.rotation.x -= 0.35 * this.flinch;
    if (this.windupTimer > 0) {
      const raise = 1 - this.windupTimer / WINDUP_TIME;
      this.leftArmRef.rotation.x = -0.6 - 1.4 * raise;
      this.rightArmRef.rotation.x = -0.6 - 1.4 * raise;
    }
  }
}
