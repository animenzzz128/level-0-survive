import * as THREE from 'three';
import { EntityArchetype } from './types';
import {
  CELL_SIZE,
  MAZE_SIZE,
  PillarSpec,
  findNextStepToward,
  gridToWorld,
  hasLineOfSight,
  resolveCircleWallCollision,
} from './maze';

export interface EntityHitResult {
  hit: boolean;
  killed: boolean;
  headshot: boolean;
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

export class BackroomsEntity {
  public readonly id: number;
  public readonly archetype: EntityArchetype;
  public readonly label: string;
  public readonly group: THREE.Group;
  public readonly hitMeshes: THREE.Mesh[] = [];
  public position: THREE.Vector3;
  public health: number;
  public maxHealth: number;
  public alive = true;
  public state: 'patrol' | 'chase' | 'stagger' = 'patrol';

  private patrolTarget = new THREE.Vector3();
  private pathTimer = 0;
  private cachedNextWaypoint = new THREE.Vector3();
  private animPhase = Math.random() * 10;
  private attackCooldown = 0;
  private staggerTimer = 0;
  private hitFlashTimer = 0;
  private screechCooldown = 0;

  private readonly speedPatrol: number;
  private readonly speedChase: number;
  private readonly attackDamage: number;
  private readonly detectRange: number;
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
  ) {
    this.id = id;
    this.archetype = archetype;
    this.group = new THREE.Group();
    this.position = this.group.position;
    this.position.set(spawnX, 0, spawnZ);

    const hpMult = nightmare ? 1.35 : 1.0;
    const spdMult = nightmare ? 1.18 : 1.0;

    if (archetype === 'howler') {
      this.label = 'Bacteria Howler';
      this.maxHealth = Math.round(90 * hpMult);
      this.speedPatrol = 1.85 * spdMult;
      this.speedChase = 4.55 * spdMult;
      this.attackDamage = nightmare ? 28 : 20;
      this.detectRange = 17;
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
      this.label = 'Smiler';
      this.maxHealth = Math.round(70 * hpMult);
      this.speedPatrol = 2.1 * spdMult;
      this.speedChase = 4.95 * spdMult;
      this.attackDamage = nightmare ? 32 : 22;
      this.detectRange = 19;
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
      this.label = 'Skin-Stealer';
      this.maxHealth = Math.round(165 * hpMult);
      this.speedPatrol = 1.45 * spdMult;
      this.speedChase = 3.65 * spdMult;
      this.attackDamage = nightmare ? 38 : 28;
      this.detectRange = 15;
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

    this.health = this.maxHealth;
    this.cachedNextWaypoint.copy(this.position);
    this.patrolTarget.copy(this.position);
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
    this.hitMeshes.push(box);
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

    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });

    this.addHitbox(0.7, 1.35, 0.65, 0.95, false);
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
    this.torsoRef.add(this.headRef);

    this.group.add(this.torsoRef);

    this.addHitbox(0.85, 1.35, 0.75, 0.85, false);
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

    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });

    this.addHitbox(0.95, 1.3, 0.75, 0.95, false);
    this.addHitbox(0.55, 0.5, 0.55, 2.02, true);
  }

  public faceWorldPoint(x: number, z: number): void {
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    if (dx * dx + dz * dz > 1e-4) {
      this.group.rotation.y = Math.atan2(dx, dz);
    }
  }

  public applyDamage(baseDamage: number, isHead: boolean): EntityHitResult {
    if (!this.alive) {
      return { hit: false, killed: false, headshot: false, damage: 0, entityName: this.label };
    }
    const finalDamage = Math.round(baseDamage * (isHead ? 1.85 : 1.0));
    this.health = Math.max(0, this.health - finalDamage);
    this.hitFlashTimer = 0.07;
    this.state = 'stagger';
    this.staggerTimer = 0.18;

    // Subtle whole-body impact tint (never cartoonish red boots/gloves)
    this.bodyMat.emissive.setHex(0x3a0c08);
    this.bodyMat.emissiveIntensity = 0.28;

    if (this.health <= 0) {
      this.alive = false;
      this.group.visible = false;
      return {
        hit: true,
        killed: true,
        headshot: isHead,
        damage: finalDamage,
        entityName: this.label,
      };
    }

    return {
      hit: true,
      killed: false,
      headshot: isHead,
      damage: finalDamage,
      entityName: this.label,
    };
  }

  public alertToPosition(pos: THREE.Vector3): void {
    if (!this.alive) return;
    if (this.position.distanceTo(pos) < 26) {
      this.state = 'chase';
      this.patrolTarget.copy(pos);
      this.pathTimer = 0;
    }
  }

  public update(
    delta: number,
    playerPos: THREE.Vector3,
    flashlightOn: boolean,
    grid: Uint8Array,
    pillars: PillarSpec[],
    onAttackPlayer: (damage: number) => void,
    onScreech: (dist: number) => void,
  ): void {
    if (!this.alive) return;

    if (this.hitFlashTimer > 0) {
      this.hitFlashTimer -= delta;
      if (this.hitFlashTimer <= 0) {
        this.bodyMat.emissive.setHex(0x000000);
        this.bodyMat.emissiveIntensity = 0;
      }
    }

    if (this.attackCooldown > 0) this.attackCooldown -= delta;
    if (this.screechCooldown > 0) this.screechCooldown -= delta;

    const distToPlayer = Math.hypot(playerPos.x - this.position.x, playerPos.z - this.position.z);
    const hasLOS =
      distToPlayer < this.detectRange + (flashlightOn ? 4 : 0) &&
      hasLineOfSight(this.position, playerPos, grid);

    if (this.state === 'stagger') {
      this.staggerTimer -= delta;
      this.torsoRef.rotation.x = -0.18;
      if (this.staggerTimer <= 0) {
        this.state = 'chase';
      }
    } else if (hasLOS || distToPlayer < 7.5) {
      if (this.state !== 'chase' && this.screechCooldown <= 0) {
        this.screechCooldown = 5.5;
        onScreech(distToPlayer);
      }
      this.state = 'chase';
    } else if (this.state === 'chase' && distToPlayer > 26) {
      this.state = 'patrol';
      this.pickRandomPatrolCell(grid);
    }

    if (this.state !== 'stagger') {
      const targetPos = this.state === 'chase' ? playerPos : this.patrolTarget;
      this.pathTimer -= delta;
      if (this.pathTimer <= 0) {
        this.pathTimer = this.state === 'chase' ? 0.35 : 0.8;
        if (hasLOS && this.state === 'chase') {
          this.cachedNextWaypoint.copy(playerPos);
        } else {
          this.cachedNextWaypoint.copy(findNextStepToward(this.position, targetPos, grid));
        }
      }

      if (this.state === 'patrol' && this.position.distanceTo(this.patrolTarget) < 1.2) {
        this.pickRandomPatrolCell(grid);
      }

      const dx = this.cachedNextWaypoint.x - this.position.x;
      const dz = this.cachedNextWaypoint.z - this.position.z;
      const len = Math.hypot(dx, dz);
      const speed = this.state === 'chase' ? this.speedChase : this.speedPatrol;

      if (len > 0.08 && distToPlayer > 1.25) {
        const vx = (dx / len) * speed * delta;
        const vz = (dz / len) * speed * delta;
        this.position.x += vx;
        this.position.z += vz;
        resolveCircleWallCollision(this.position, 0.44, grid, pillars);

        const desiredYaw = Math.atan2(dx, dz);
        const diff = Math.atan2(
          Math.sin(desiredYaw - this.group.rotation.y),
          Math.cos(desiredYaw - this.group.rotation.y),
        );
        this.group.rotation.y += diff * Math.min(1, delta * 9);
      } else if (hasLOS) {
        // Face player directly when nearby or in line of sight
        const desiredYaw = Math.atan2(playerPos.x - this.position.x, playerPos.z - this.position.z);
        const diff = Math.atan2(
          Math.sin(desiredYaw - this.group.rotation.y),
          Math.cos(desiredYaw - this.group.rotation.y),
        );
        this.group.rotation.y += diff * Math.min(1, delta * 10);
      }

      if (distToPlayer <= 1.65 && this.attackCooldown <= 0) {
        this.attackCooldown = 1.15;
        onAttackPlayer(this.attackDamage);
      }
    }

    const speedFactor = this.state === 'chase' ? 11.5 : 4.2;
    this.animPhase += delta * speedFactor;

    if (this.archetype === 'howler') {
      const twitch = Math.sin(this.animPhase * 2.7) * 0.14;
      this.headRef.rotation.z = twitch + Math.cos(this.animPhase * 1.1) * 0.18;
      if (this.state !== 'stagger') {
        this.torsoRef.rotation.x = this.state === 'chase' ? 0.22 : 0.1;
      }
      this.leftArmRef.rotation.x = Math.sin(this.animPhase) * 0.55 - (this.state === 'chase' ? 0.6 : 0.25);
      this.rightArmRef.rotation.x = -Math.sin(this.animPhase) * 0.55 - (this.state === 'chase' ? 0.6 : 0.25);
      if (this.leftLegRef && this.rightLegRef) {
        this.leftLegRef.rotation.x = Math.sin(this.animPhase) * 0.45;
        this.rightLegRef.rotation.x = -Math.sin(this.animPhase) * 0.45;
      }
    } else if (this.archetype === 'smiler') {
      this.torsoRef.position.y = 1.12 + Math.sin(this.animPhase * 0.45) * 0.12;
      this.torsoRef.rotation.z = Math.sin(this.animPhase * 0.32) * 0.08;
      this.leftArmRef.rotation.z = Math.sin(this.animPhase * 0.7) * 0.18;
      this.rightArmRef.rotation.z = -Math.sin(this.animPhase * 0.7) * 0.18;
    } else {
      const limp = Math.abs(Math.sin(this.animPhase * 0.75)) * 0.07;
      this.torsoRef.position.y = 0.96 + limp;
      this.torsoRef.rotation.z = Math.sin(this.animPhase * 0.75) * 0.08;
      this.leftArmRef.rotation.x = Math.sin(this.animPhase * 0.75) * 0.42;
      this.rightArmRef.rotation.x = -Math.sin(this.animPhase * 0.75) * 0.25 - 0.3;
      if (this.leftLegRef && this.rightLegRef) {
        this.leftLegRef.rotation.x = Math.sin(this.animPhase * 0.75) * 0.38;
        this.rightLegRef.rotation.x = -Math.sin(this.animPhase * 0.75) * 0.38;
      }
    }
  }

  private pickRandomPatrolCell(grid: Uint8Array): void {
    for (let tries = 0; tries < 25; tries++) {
      const gx = 1 + Math.floor(Math.random() * (MAZE_SIZE - 2));
      const gz = 1 + Math.floor(Math.random() * (MAZE_SIZE - 2));
      if (grid[gz * MAZE_SIZE + gx] === 0) {
        const wp = gridToWorld(gx, gz);
        if (Math.hypot(wp.x - this.position.x, wp.z - this.position.z) > CELL_SIZE * 2) {
          this.patrolTarget.copy(wp);
          return;
        }
      }
    }
  }
}
