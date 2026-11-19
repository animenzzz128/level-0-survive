import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HorrorAudioEngine } from './audio';
import { BackroomsEntity } from './entities';
import {
  BackroomsLevelData,
  CELL_SIZE,
  MAZE_SIZE,
  WALL_HEIGHT,
  generateBackroomsLevel,
  gridToWorld,
  hasLineOfSight,
  isWallCell,
  resolveCircleWallCollision,
} from './maze';
import { BackroomsMaterialSet, createBackroomsMaterialSet } from './textures';
import {
  DifficultyMode,
  EntityArchetype,
  GamePhase,
  HudNotification,
  HudState,
  PickupKind,
} from './types';
import { TacticalWeaponViewmodel } from './weapon';

interface PickupInstance {
  id: number;
  kind: PickupKind;
  group: THREE.Group;
  rotTarget: THREE.Object3D;
  x: number;
  z: number;
  baseY: number;
  collected: boolean;
}

interface ImpactParticle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
}

declare global {
  interface Window {
    __BACKROOMS_DEBUG__?: {
      getState: () => HudState & {
        playerPos: { x: number; y: number; z: number };
        yaw: number;
        pitch: number;
        entities: Array<{ id: number; label: string; x: number; z: number; hp: number; alive: boolean }>;
        tapes: Array<{ x: number; z: number; collected: boolean }>;
        exitPos: { x: number; z: number };
      };
      startGame: (difficulty?: DifficultyMode) => void;
      lookAtWorld: (x: number, y: number, z: number) => void;
      teleportNearEntity: () => boolean;
      teleportNearEntityByType: (archetype: EntityArchetype) => boolean;
      teleportNearTape: () => boolean;
      teleportToExitUnlocked: () => void;
      fireShot: () => void;
      toggleFlashlight: () => void;
      setAim: (aim: boolean) => void;
      triggerReload: () => void;
    };
  }
}

const _vec3A = new THREE.Vector3();
const _vec3B = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

export class BackroomsEngine {
  private readonly container: HTMLElement;
  private readonly onHudUpdate: (hud: HudState) => void;

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private materials!: BackroomsMaterialSet;
  private audio = new HorrorAudioEngine();
  private weapon!: TacticalWeaponViewmodel;

  private isSoftwareGl = false;
  private frameId = 0;
  private disposed = false;
  private lastTime = performance.now();

  private level!: BackroomsLevelData;
  private levelGroup = new THREE.Group();
  private entityGroup = new THREE.Group();
  private pickupGroup = new THREE.Group();
  private fxGroup = new THREE.Group();

  private entities: BackroomsEntity[] = [];
  private pickups: PickupInstance[] = [];
  private particles: ImpactParticle[] = [];
  private wallRayMeshes: THREE.Object3D[] = [];

  private lightPanelInstanced: THREE.InstancedMesh | null = null;
  private fixtureColorTemp = new THREE.Color();
  private pooledLights: THREE.PointLight[] = [];

  private flashlight!: THREE.SpotLight;
  private flashlightTarget = new THREE.Object3D();
  private flashlightCone!: THREE.Mesh;
  private dustPoints!: THREE.Points;

  private exitBeaconMat!: THREE.MeshBasicMaterial;
  private exitLight!: THREE.PointLight;

  // Player state
  private phase: GamePhase = 'title';
  private difficulty: DifficultyMode = 'standard';
  private playerPos = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  private swayX = 0;
  private swayY = 0;

  private health = 100;
  private maxHealth = 100;
  private stamina = 100;
  private battery = 100;
  private flashlightOn = true;

  private ammoInMag = 12;
  private readonly magCapacity = 12;
  private ammoReserve = 48;
  private isReloading = false;
  private reloadTimer = 0;
  private fireCooldown = 0;
  private isAiming = false;

  private tapesCollected = 0;
  private readonly tapesTotal = 4;
  private exitUnlocked = false;
  private elapsedSeconds = 0;
  private kills = 0;
  private shotsFired = 0;
  private shotsHit = 0;
  private damageTaken = 0;
  private damageFlash = 0;
  private hitmarkerState: 'none' | 'hit' | 'kill' = 'none';
  private hitmarkerTimer = 0;
  private crosshairSpread = 0;
  private screenShake = 0;
  private footstepTimer = 0;
  private titleOrbitTime = 0;
  private hudEmitTimer = 0;

  private notifCounter = 1;
  private notification: HudNotification | null = null;
  private notificationTimer = 0;

  private keys: Record<string, boolean> = {};
  private pointerLocked = false;
  private isDraggingLook = false;
  private lastDragX = 0;
  private lastDragY = 0;
  private raycaster = new THREE.Raycaster();
  private wallBoxPool: THREE.Mesh[] = [];

  constructor(container: HTMLElement, onHudUpdate: (hud: HudState) => void) {
    this.container = container;
    this.onHudUpdate = onHudUpdate;
    this.init();
  }

  private detectSoftwareGl(): boolean {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  }

  private init(): void {
    this.isSoftwareGl = this.detectSoftwareGl();

    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: !this.isSoftwareGl,
        powerPreference: 'high-performance',
      });
    } catch (err) {
      this.emitHud('WebGL initialization failed. Please enable hardware acceleration.');
      void err;
      return;
    }

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2),
    );
    this.renderer.setSize(this.container.clientWidth || window.innerWidth, this.container.clientHeight || window.innerHeight);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';

    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestored);

    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    const fogColor = new THREE.Color(0x171409);
    this.scene.background = fogColor;
    this.scene.fog = new THREE.FogExp2(0x171409, 0.088);

    const aspect = (this.container.clientWidth || window.innerWidth) / (this.container.clientHeight || window.innerHeight);
    this.camera = new THREE.PerspectiveCamera(72, aspect, 0.04, 55);
    this.scene.add(this.camera);

    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.22;
    pmremGenerator.dispose();

    this.materials = createBackroomsMaterialSet(this.renderer);

    // Deeper atmospheric fill for tense Backrooms contrast
    const hemi = new THREE.HemisphereLight(0xb8a564, 0x1a160c, 0.26);
    this.scene.add(hemi);

    // Pooled ceiling point lights (closest 8 fixtures to camera)
    const lightCount = 8;
    for (let i = 0; i < lightCount; i++) {
      const pl = new THREE.PointLight(0xfff0b8, 0, 11.5, 1.85);
      this.scene.add(pl);
      this.pooledLights.push(pl);
    }

    // Player tactical flashlight attached to camera (no hard polygon cone mesh)
    this.flashlight = new THREE.SpotLight(0xfff5d6, 6.2, 24, Math.PI / 5.4, 0.65, 1.35);
    this.flashlight.position.set(0.08, -0.06, -0.1);
    this.flashlight.castShadow = !this.isSoftwareGl;
    this.flashlight.shadow.mapSize.set(1024, 1024);
    this.flashlight.shadow.camera.near = 0.2;
    this.flashlight.shadow.camera.far = 24;
    this.flashlight.shadow.bias = -0.0005;
    this.flashlight.shadow.normalBias = 0.02;

    this.flashlightTarget.position.set(0, -0.04, -6);
    this.camera.add(this.flashlight);
    this.camera.add(this.flashlightTarget);
    this.flashlight.target = this.flashlightTarget;

    // Invisible dummy cone object kept only as null-safe toggle placeholder
    this.flashlightCone = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.flashlightCone.visible = false;

    // Tactical weapon viewmodel
    this.weapon = new TacticalWeaponViewmodel(this.scene, this.materials.muzzleFlashTex);
    this.camera.add(this.weapon.root);

    this.scene.add(this.levelGroup, this.entityGroup, this.pickupGroup, this.fxGroup);

    // Floating dust particles
    this.buildDustField();

    // Generate initial Level 0 scene for live title screen backdrop
    this.buildLevel(202611, 'standard');
    this.phase = 'title';
    this.weapon.root.visible = false;

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.bindEvents();
    this.installDebugApi();
    this.emitHud();

    this.lastTime = performance.now();
    this.scheduleNextTick();
  }

  private handleContextLost = (e: Event): void => {
    e.preventDefault();
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
  };

  private handleContextRestored = (): void => {
    this.lastTime = performance.now();
    this.scheduleNextTick();
  };

  private buildDustField(): void {
    const count = 420;
    const positions = new Float32Array(count * 3);
    const span = MAZE_SIZE * CELL_SIZE;
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * span;
      positions[i * 3 + 1] = 0.25 + Math.random() * (WALL_HEIGHT - 0.5);
      positions[i * 3 + 2] = (Math.random() - 0.5) * span;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.075,
      map: this.materials.dustTex,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.dustPoints = new THREE.Points(geo, mat);
    this.scene.add(this.dustPoints);
  }

  private clearGroups(): void {
    const clearGroup = (grp: THREE.Group) => {
      while (grp.children.length > 0) {
        const child = grp.children[0];
        grp.remove(child);
      }
    };
    clearGroup(this.levelGroup);
    clearGroup(this.entityGroup);
    clearGroup(this.pickupGroup);
    clearGroup(this.fxGroup);
    this.entities = [];
    this.pickups = [];
    this.particles = [];
    this.wallRayMeshes = [];
    this.wallBoxPool = [];
    this.lightPanelInstanced = null;
  }

  private buildLevel(seed: number, difficulty: DifficultyMode): void {
    this.clearGroups();
    this.difficulty = difficulty;
    this.level = generateBackroomsLevel(seed);

    const worldSize = MAZE_SIZE * CELL_SIZE;

    // 1. Damp Carpet Floor
    const floorMat = this.materials.carpet;
    floorMat.map?.repeat.set(MAZE_SIZE * 1.4, MAZE_SIZE * 1.4);
    floorMat.normalMap?.repeat.set(MAZE_SIZE * 1.4, MAZE_SIZE * 1.4);
    floorMat.roughnessMap?.repeat.set(MAZE_SIZE * 1.4, MAZE_SIZE * 1.4);

    const floorGeo = new THREE.PlaneGeometry(worldSize, worldSize);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.receiveShadow = true;
    this.levelGroup.add(floorMesh);
    this.wallRayMeshes.push(floorMesh);

    // 2. Drop-Ceiling Acoustic Tiles
    const ceilMat = this.materials.ceiling;
    ceilMat.map?.repeat.set(MAZE_SIZE * 1.5, MAZE_SIZE * 1.5);
    ceilMat.normalMap?.repeat.set(MAZE_SIZE * 1.5, MAZE_SIZE * 1.5);
    const ceilGeo = new THREE.PlaneGeometry(worldSize, worldSize);
    ceilGeo.rotateX(Math.PI / 2);
    const ceilMesh = new THREE.Mesh(ceilGeo, ceilMat);
    ceilMesh.position.y = WALL_HEIGHT;
    this.levelGroup.add(ceilMesh);
    this.wallRayMeshes.push(ceilMesh);

    // 3. Instanced Walls & Baseboards
    const wallCells: Array<{ x: number; z: number }> = [];
    for (let gz = 0; gz < MAZE_SIZE; gz++) {
      for (let gx = 0; gx < MAZE_SIZE; gx++) {
        if (isWallCell(this.level.grid, gx, gz)) {
          const wp = gridToWorld(gx, gz);
          wallCells.push({ x: wp.x, z: wp.z });
        }
      }
    }

    const wallGeo = new THREE.BoxGeometry(CELL_SIZE, WALL_HEIGHT, CELL_SIZE);
    const wallInstanced = new THREE.InstancedMesh(wallGeo, this.materials.wallpaper, wallCells.length);
    wallInstanced.castShadow = true;
    wallInstanced.receiveShadow = true;
    wallInstanced.frustumCulled = false;

    const baseGeo = new THREE.BoxGeometry(CELL_SIZE + 0.03, 0.14, CELL_SIZE + 0.03);
    const baseInstanced = new THREE.InstancedMesh(baseGeo, this.materials.baseboard, wallCells.length);
    baseInstanced.receiveShadow = true;
    baseInstanced.frustumCulled = false;

    const dummy = new THREE.Object3D();
    wallCells.forEach((wc, idx) => {
      dummy.position.set(wc.x, WALL_HEIGHT * 0.5, wc.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      wallInstanced.setMatrixAt(idx, dummy.matrix);

      dummy.position.set(wc.x, 0.07, wc.z);
      dummy.updateMatrix();
      baseInstanced.setMatrixAt(idx, dummy.matrix);
    });
    wallInstanced.instanceMatrix.needsUpdate = true;
    baseInstanced.instanceMatrix.needsUpdate = true;
    wallInstanced.computeBoundingSphere();
    baseInstanced.computeBoundingSphere();
    this.levelGroup.add(wallInstanced, baseInstanced);
    this.wallRayMeshes.push(wallInstanced);

    // 4. Open-Hall Support Pillars (with baseboard collars)
    if (this.level.pillars.length > 0) {
      const pGeo = new THREE.BoxGeometry(0.56, WALL_HEIGHT, 0.56);
      const pInst = new THREE.InstancedMesh(pGeo, this.materials.pillar, this.level.pillars.length);
      pInst.castShadow = true;
      pInst.receiveShadow = true;
      pInst.frustumCulled = false;

      const pBaseGeo = new THREE.BoxGeometry(0.6, 0.14, 0.6);
      const pBaseInst = new THREE.InstancedMesh(pBaseGeo, this.materials.baseboard, this.level.pillars.length);
      pBaseInst.frustumCulled = false;

      this.level.pillars.forEach((p, idx) => {
        dummy.position.set(p.x, WALL_HEIGHT * 0.5, p.z);
        dummy.updateMatrix();
        pInst.setMatrixAt(idx, dummy.matrix);

        dummy.position.set(p.x, 0.07, p.z);
        dummy.updateMatrix();
        pBaseInst.setMatrixAt(idx, dummy.matrix);
      });
      pInst.instanceMatrix.needsUpdate = true;
      pBaseInst.instanceMatrix.needsUpdate = true;
      pInst.computeBoundingSphere();
      pBaseInst.computeBoundingSphere();
      this.levelGroup.add(pInst, pBaseInst);
      this.wallRayMeshes.push(pInst);
    }

    // 5. Recessed Fluorescent Light Troffers (Instanced frames + emissive diffusers)
    const fixtures = this.level.fixtures;
    if (fixtures.length > 0) {
      const frameGeo = new THREE.BoxGeometry(0.76, 0.05, 1.38);
      const frameInst = new THREE.InstancedMesh(frameGeo, this.materials.lightFixtureFrame, fixtures.length);
      frameInst.frustumCulled = false;

      const panelGeo = new THREE.PlaneGeometry(0.66, 1.28);
      panelGeo.rotateX(Math.PI / 2);
      const panelInst = new THREE.InstancedMesh(panelGeo, this.materials.lightPanelOn, fixtures.length);
      panelInst.frustumCulled = false;

      const glowMat = new THREE.MeshBasicMaterial({
        map: this.materials.lightGlowTex,
        transparent: true,
        opacity: 0.28,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const glowGeo = new THREE.PlaneGeometry(1.75, 2.35);
      glowGeo.rotateX(Math.PI / 2);

      fixtures.forEach((f, idx) => {
        dummy.position.set(f.x, WALL_HEIGHT - 0.02, f.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        frameInst.setMatrixAt(idx, dummy.matrix);

        dummy.position.set(f.x, WALL_HEIGHT - 0.048, f.z);
        dummy.updateMatrix();
        panelInst.setMatrixAt(idx, dummy.matrix);

        this.fixtureColorTemp.setHex(f.flickerMode === 'dead' ? 0x1d1a10 : 0xffffff);
        panelInst.setColorAt(idx, this.fixtureColorTemp);

        if (f.flickerMode !== 'dead') {
          const glow = new THREE.Mesh(glowGeo, glowMat);
          glow.position.set(f.x, WALL_HEIGHT - 0.075, f.z);
          this.levelGroup.add(glow);
        }
      });
      frameInst.instanceMatrix.needsUpdate = true;
      panelInst.instanceMatrix.needsUpdate = true;
      if (panelInst.instanceColor) panelInst.instanceColor.needsUpdate = true;
      frameInst.computeBoundingSphere();
      panelInst.computeBoundingSphere();
      this.levelGroup.add(frameInst, panelInst);
      this.lightPanelInstanced = panelInst;
    }

    // 6. Scratched Wall Graffiti & Warning Decals
    this.level.graffiti.forEach((g) => {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(1.35, 1.35),
        this.materials.graffitiMaterials[g.variant],
      );
      plane.position.set(g.x, g.y, g.z);
      plane.rotation.y = g.rotY;
      this.levelGroup.add(plane);
    });

    // 7. Sector 00 Threshold Exit Bulkhead Door
    this.buildExitDoor();

    // 8. Pickups, Grounded Office Props & Utility Tables
    this.buildPickups();
    this.buildEnvironmentalProps();

    // 9. Spawn Entities
    this.spawnEntities(difficulty);

    // 10. Reset player transform
    this.playerPos.copy(this.level.spawnPos);
    this.yaw = this.level.spawnYaw;
    this.pitch = 0;
    this.targetYaw = this.yaw;
    this.targetPitch = 0;
    this.camera.position.copy(this.playerPos);
    _euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(_euler);
  }

  private buildEnvironmentalProps(): void {
    // Fallen ceiling tiles & damp caution cones inside open halls for liminal realism
    const fallenTileMat = new THREE.MeshStandardMaterial({
      color: 0xb0aa8e,
      roughness: 0.92,
      metalness: 0.02,
    });
    const coneMat = new THREE.MeshStandardMaterial({
      color: 0xc97b18,
      roughness: 0.55,
      metalness: 0.05,
    });
    const coneBaseMat = new THREE.MeshStandardMaterial({
      color: 0x1e1d19,
      roughness: 0.8,
    });

    this.level.pillars.forEach((p, idx) => {
      if (idx % 2 === 0) {
        // Fallen broken acoustic tile near pillar base
        const tile = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.025, 0.68), fallenTileMat);
        tile.position.set(p.x + 0.65, 0.015, p.z + 0.25);
        tile.rotation.y = 0.35 * idx;
        tile.receiveShadow = true;
        this.levelGroup.add(tile);
      } else {
        // Grounded wet-floor safety cone + soft shadow
        const coneGrp = new THREE.Group();
        coneGrp.position.set(p.x - 0.62, 0, p.z + 0.52);
        const coneShadow = new THREE.Mesh(
          new THREE.PlaneGeometry(0.65, 0.65).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({
            map: this.materials.softShadowTex,
            transparent: true,
            opacity: 0.72,
            depthWrite: false,
          }),
        );
        coneShadow.position.y = 0.015;
        const base = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.04, 0.32), coneBaseMat);
        base.position.y = 0.02;
        const body = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.54, 12), coneMat);
        body.position.y = 0.29;
        coneGrp.add(coneShadow, base, body);
        this.levelGroup.add(coneGrp);
      }
    });

    // Subtle wall-mounted electrical switch plates near graffiti walls
    const plateMat = new THREE.MeshStandardMaterial({
      color: 0xbcb394,
      roughness: 0.45,
      metalness: 0.1,
    });
    this.level.graffiti.forEach((g) => {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.13, 0.02), plateMat);
      plate.position.set(g.x + (Math.abs(Math.sin(g.rotY)) < 0.5 ? 1.05 : 0), 1.18, g.z + (Math.abs(Math.sin(g.rotY)) > 0.5 ? 1.05 : 0));
      plate.rotation.y = g.rotY;
      this.levelGroup.add(plate);
    });
  }

  private buildExitDoor(): void {
    const exitGroup = new THREE.Group();
    exitGroup.position.copy(this.level.exitPos);

    // Heavy metal door frame
    const frameL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.55, 0.2), this.materials.exitFrame);
    frameL.position.set(-0.92, 1.275, 0);
    const frameR = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.55, 0.2), this.materials.exitFrame);
    frameR.position.set(0.92, 1.275, 0);
    const header = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.22, 0.22), this.materials.exitFrame);
    header.position.set(0, 2.52, 0);

    const doorPanel = new THREE.Mesh(new THREE.BoxGeometry(1.68, 2.4, 0.1), this.materials.exitDoor);
    doorPanel.position.set(0, 1.2, 0);

    // Overhead caged status beacon & wall keypad
    this.exitBeaconMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
    const beaconHousing = new THREE.Mesh(
      new THREE.BoxGeometry(0.54, 0.19, 0.12),
      this.materials.exitFrame,
    );
    beaconHousing.position.set(0, 2.74, -0.07);
    const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.11, 0.13), this.exitBeaconMat);
    beacon.position.set(0, 2.74, -0.08);
    const ribL = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.14, 0.145), this.materials.exitFrame);
    ribL.position.set(-0.1, 2.74, -0.085);
    const ribR = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.14, 0.145), this.materials.exitFrame);
    ribR.position.set(0.1, 2.74, -0.085);

    const keypad = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.28, 0.08), this.materials.exitFrame);
    keypad.position.set(-1.12, 1.38, -0.06);
    const keypadLed = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.08), this.exitBeaconMat);
    keypadLed.position.set(-1.12, 1.43, -0.105);
    keypadLed.rotation.y = Math.PI;

    this.exitLight = new THREE.PointLight(0xff3b30, 1.8, 9, 1.8);
    this.exitLight.position.set(0, 2.5, -0.6);

    exitGroup.add(
      frameL,
      frameR,
      header,
      doorPanel,
      beaconHousing,
      beacon,
      ribL,
      ribR,
      keypad,
      keypadLed,
      this.exitLight,
    );
    this.levelGroup.add(exitGroup);
  }

  private buildPickups(): void {
    const tapeMat = new THREE.MeshStandardMaterial({
      color: 0x191a1e,
      roughness: 0.45,
      metalness: 0.2,
    });
    const tapeLabelMat = new THREE.MeshStandardMaterial({
      map: this.materials.vhsLabelTex,
      emissive: new THREE.Color(0xffa020),
      emissiveIntensity: 0.32,
      roughness: 0.38,
    });
    const ammoMat = new THREE.MeshStandardMaterial({
      color: 0x3b4730,
      roughness: 0.52,
      metalness: 0.45,
    });
    const brassMat = new THREE.MeshStandardMaterial({
      color: 0xd4a63a,
      roughness: 0.26,
      metalness: 0.85,
    });
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x5ea2b0,
      roughness: 0.24,
      metalness: 0.65,
      emissive: new THREE.Color(0x215863),
      emissiveIntensity: 0.45,
    });
    const propShadowMat = new THREE.MeshBasicMaterial({
      map: this.materials.softShadowTex,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });

    this.level.pickups.forEach((p, idx) => {
      const grp = new THREE.Group();
      grp.position.set(p.x, 0, p.z);

      let rotTarget: THREE.Object3D = grp;
      let baseY = 0;

      if (p.kind === 'tape') {
        const tableShadow = new THREE.Mesh(
          new THREE.PlaneGeometry(1.65, 1.15).rotateX(-Math.PI / 2),
          propShadowMat,
        );
        tableShadow.position.y = 0.015;
        grp.add(tableShadow);

        // Metal office utility table grounded on carpet (4 legs + crossbrace + tabletop)
        const table = new THREE.Group();
        const top = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.055, 0.72), this.materials.tableTop);
        top.position.y = 0.78;
        top.castShadow = true;
        top.receiveShadow = true;
        table.add(top);

        const legOffsets = [
          [-0.5, -0.3],
          [0.5, -0.3],
          [-0.5, 0.3],
          [0.5, 0.3],
        ];
        for (const [lx, lz] of legOffsets) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.76, 0.05), this.materials.tableMetal);
          leg.position.set(lx, 0.38, lz);
          table.add(leg);
        }
        grp.add(table);

        // Multi-part VHS cassette resting cleanly above tabletop
        const vhs = new THREE.Group();
        vhs.position.y = 0.92;
        const shell = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.055, 0.22), tapeMat);
        const label = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.058, 0.11), tapeLabelMat);
        label.position.z = 0.02;
        const reelL = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.044, 0.06, 12), brassMat);
        reelL.position.set(-0.085, 0, -0.025);
        const reelR = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.044, 0.06, 12), brassMat);
        reelR.position.set(0.085, 0, -0.025);

        const beacon = new THREE.PointLight(0xffa726, 1.35, 5.2, 1.8);
        beacon.position.y = 0.28;
        vhs.add(shell, label, reelL, reelR, beacon);
        grp.add(vhs);
        rotTarget = vhs;
        baseY = 0.92;
      } else if (p.kind === 'ammo') {
        const shadow = new THREE.Mesh(
          new THREE.PlaneGeometry(0.75, 0.55).rotateX(-Math.PI / 2),
          propShadowMat,
        );
        shadow.position.y = 0.015;
        grp.add(shadow);
        const crate = new THREE.Group();
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.24, 0.24), ammoMat);
        box.position.y = 0.12;
        const lid = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.05, 0.26), ammoMat);
        lid.position.y = 0.25;
        const latch = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.27), brassMat);
        latch.position.y = 0.21;
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.04, 0.245), brassMat);
        stripe.position.y = 0.14;
        crate.add(box, lid, latch, stripe);
        grp.add(crate);
        rotTarget = crate;
        baseY = 0;
      } else {
        const shadow = new THREE.Mesh(
          new THREE.PlaneGeometry(0.42, 0.42).rotateX(-Math.PI / 2),
          propShadowMat,
        );
        shadow.position.y = 0.015;
        grp.add(shadow);
        const bottle = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.3, 12), waterMat);
        body.position.y = 0.15;
        const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.09, 0.07, 12), waterMat);
        shoulder.position.y = 0.335;
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 10), brassMat);
        cap.position.y = 0.39;
        bottle.add(body, shoulder, cap);
        grp.add(bottle);
        rotTarget = bottle;
        baseY = 0;
      }

      this.pickupGroup.add(grp);
      this.pickups.push({
        id: idx,
        kind: p.kind,
        group: grp,
        rotTarget,
        x: p.x,
        z: p.z,
        baseY,
        collected: false,
      });
    });
  }

  private spawnEntities(difficulty: DifficultyMode): void {
    const archetypes: EntityArchetype[] = ['howler', 'smiler', 'brute', 'howler', 'smiler', 'howler'];
    const nightmare = difficulty === 'nightmare';
    const count = nightmare ? this.level.entitySpawns.length : Math.min(5, this.level.entitySpawns.length);

    for (let i = 0; i < count; i++) {
      const sp = this.level.entitySpawns[i];
      const entity = new BackroomsEntity(
        i + 1,
        archetypes[i % archetypes.length],
        sp.x,
        sp.z,
        {
          smilerFace: this.materials.smilerFace,
          smilerHaloTex: this.materials.smilerHaloTex,
          softShadowTex: this.materials.softShadowTex,
          howlerBodyTex: this.materials.howlerBodyTex,
          howlerNormalTex: this.materials.howlerNormalTex,
          bruteSkinTex: this.materials.bruteSkinTex,
          bruteNormalTex: this.materials.bruteNormalTex,
        },
        nightmare,
      );
      this.entities.push(entity);
      this.entityGroup.add(entity.group);
    }
  }

  public startNewGame(difficulty: DifficultyMode): void {
    this.audio.init();
    this.difficulty = difficulty;
    const seed = Math.floor(202611 + Math.random() * 10000);
    this.buildLevel(seed, difficulty);

    this.maxHealth = 100;
    this.health = 100;
    this.stamina = 100;
    this.battery = 100;
    this.flashlightOn = true;

    this.ammoInMag = this.magCapacity;
    this.ammoReserve = difficulty === 'nightmare' ? 36 : 60;
    this.isReloading = false;
    this.reloadTimer = 0;
    this.fireCooldown = 0;
    this.isAiming = false;

    this.tapesCollected = 0;
    this.exitUnlocked = false;
    this.elapsedSeconds = 0;
    this.kills = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.damageTaken = 0;
    this.damageFlash = 0;
    this.hitmarkerState = 'none';
    this.hitmarkerTimer = 0;

    this.phase = 'playing';
    this.weapon.root.visible = true;
    this.weapon.update(0.016, false, false, false, 0, 0);
    this.updateCeilingLights(performance.now() * 0.001);
    this.renderer.render(this.scene, this.camera);
    this.pushNotification('Locate 4 VHS Data Tapes to unlock the Sector Exit.', 'info');
    this.requestLock();
    this.emitHud();
  }

  public resumeGame(): void {
    if (this.phase !== 'paused') return;
    this.audio.init();
    this.phase = 'playing';
    this.requestLock();
    this.emitHud();
  }

  public pauseGame(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    this.isAiming = false;
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.emitHud();
  }

  public returnToTitle(): void {
    this.phase = 'title';
    this.weapon.root.visible = false;
    this.isAiming = false;
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.buildLevel(202611, this.difficulty);
    this.emitHud();
  }

  public toggleMute(): void {
    this.audio.init();
    this.audio.setMuted(!this.audio.isMuted());
    this.emitHud();
  }

  public requestLock(): void {
    try {
      this.renderer.domElement.requestPointerLock?.();
    } catch {
      /* Fallback drag/keyboard look remains active */
    }
  }

  private pushNotification(text: string, tone: HudNotification['tone']): void {
    this.notification = { id: this.notifCounter++, text, tone };
    this.notificationTimer = 3.4;
  }

  private bindEvents(): void {
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);

    const dom = this.renderer.domElement;
    dom.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    dom.addEventListener('contextmenu', this.onContextMenu);
  }

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private onResize = (): void => {
    if (this.disposed) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
    this.emitHud();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys[e.code] = true;
    if (e.code === 'Escape') {
      if (this.phase === 'playing') {
        this.pauseGame();
      } else if (this.phase === 'paused') {
        this.resumeGame();
      }
      return;
    }

    if (this.phase !== 'playing') return;

    if (e.code === 'KeyF') {
      this.toggleFlashlightAction();
    } else if (e.code === 'KeyR') {
      this.startReload();
    } else if (e.code === 'KeyM') {
      this.toggleMute();
    } else if (e.code === 'Space') {
      e.preventDefault();
      this.fireWeapon();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys[e.code] = false;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (this.phase !== 'playing') return;
    this.audio.init();

    if (e.button === 0) {
      if (!this.pointerLocked) {
        this.requestLock();
        this.isDraggingLook = true;
        this.lastDragX = e.clientX;
        this.lastDragY = e.clientY;
      }
      this.fireWeapon();
    } else if (e.button === 2) {
      this.isAiming = true;
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.isDraggingLook = false;
    } else if (e.button === 2) {
      this.isAiming = false;
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.phase !== 'playing') return;
    const sens = this.isAiming ? 0.0014 : 0.0022;
    if (this.pointerLocked) {
      this.targetYaw -= e.movementX * sens;
      this.targetPitch = THREE.MathUtils.clamp(
        this.targetPitch - e.movementY * sens,
        -1.38,
        1.38,
      );
      this.swayX = THREE.MathUtils.clamp(-e.movementX * 0.04, -1, 1);
      this.swayY = THREE.MathUtils.clamp(e.movementY * 0.04, -1, 1);
    } else if (this.isDraggingLook) {
      const dx = e.clientX - this.lastDragX;
      const dy = e.clientY - this.lastDragY;
      this.lastDragX = e.clientX;
      this.lastDragY = e.clientY;
      this.targetYaw -= dx * sens * 1.4;
      this.targetPitch = THREE.MathUtils.clamp(
        this.targetPitch - dy * sens * 1.4,
        -1.38,
        1.38,
      );
    }
  };

  private toggleFlashlightAction(): void {
    if (this.battery <= 0 && !this.flashlightOn) return;
    this.flashlightOn = !this.flashlightOn;
    this.audio.playFlashlightClick();
    this.emitHud();
  }

  private startReload(): void {
    if (this.isReloading || this.ammoInMag >= this.magCapacity || this.ammoReserve <= 0) return;
    this.isReloading = true;
    this.reloadTimer = 1.25;
    this.isAiming = false;
    this.weapon.triggerReload(1.25);
    this.audio.playReload();
    this.emitHud();
  }

  private fireWeapon(): void {
    if (this.phase !== 'playing' || this.isReloading || this.fireCooldown > 0) return;

    if (this.ammoInMag <= 0) {
      this.fireCooldown = 0.2;
      this.audio.playEmptyClick();
      if (this.ammoReserve > 0) {
        this.startReload();
      } else {
        this.pushNotification('Magazine empty — find ammunition crates!', 'warning');
      }
      return;
    }

    this.ammoInMag--;
    this.shotsFired++;
    this.fireCooldown = 0.21;
    this.crosshairSpread = Math.min(1, this.crosshairSpread + 0.55);
    this.screenShake = Math.max(this.screenShake, 0.012);
    this.targetPitch = THREE.MathUtils.clamp(this.targetPitch + 0.018, -1.38, 1.38);

    this.weapon.triggerFire(this.camera);
    this.audio.playGunshot();

    // Alert nearby entities to gunshot sound
    for (const ent of this.entities) {
      ent.alertToPosition(this.playerPos);
    }

    // Raycast shot from camera center
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.raycaster.far = 42;

    const wallHits = this.raycaster.intersectObjects(this.wallRayMeshes, false);
    const wallDist = wallHits.length > 0 ? wallHits[0].distance : Infinity;

    const entityHitMeshes: THREE.Mesh[] = [];
    for (const ent of this.entities) {
      if (ent.alive) entityHitMeshes.push(...ent.hitMeshes);
    }

    const entHits = this.raycaster.intersectObjects(entityHitMeshes, false);
    if (entHits.length > 0 && entHits[0].distance < wallDist) {
      const hit = entHits[0];
      const entityId = hit.object.userData.entityId as number;
      const isHead = Boolean(hit.object.userData.isHead);
      const targetEntity = this.entities.find((e) => e.id === entityId);

      if (targetEntity) {
        const res = targetEntity.applyDamage(34, isHead);
        if (res.hit) {
          this.shotsHit++;
          this.hitmarkerState = res.killed ? 'kill' : 'hit';
          this.hitmarkerTimer = 0.22;
          this.audio.playHitmarker(res.killed);
          this.spawnImpactParticles(hit.point, 0x991b1b, 10);

          if (res.killed) {
            this.kills++;
            this.pushNotification(
              `${res.entityName} neutralized${res.headshot ? ' (Headshot)' : ''}.`,
              'info',
            );
            // Drop emergency ammo boost for Brute kills
            if (targetEntity.archetype === 'brute') {
              this.ammoReserve += 12;
            }
          }
        }
      }
    } else if (wallHits.length > 0) {
      this.spawnImpactParticles(wallHits[0].point, 0xffe29a, 6);
    }

    if (this.ammoInMag === 0 && this.ammoReserve > 0) {
      setTimeout(() => {
        if (!this.disposed && this.phase === 'playing') this.startReload();
      }, 180);
    }

    this.emitHud();
  }

  private spawnImpactParticles(point: THREE.Vector3, colorHex: number, count: number): void {
    const geo = new THREE.BoxGeometry(0.045, 0.045, 0.045);
    const mat = new THREE.MeshBasicMaterial({ color: colorHex });
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(point);
      this.fxGroup.add(mesh);
      this.particles.push({
        mesh,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 3.8,
          1.2 + Math.random() * 2.5,
          (Math.random() - 0.5) * 3.8,
        ),
        life: 0.35 + Math.random() * 0.2,
        maxLife: 0.55,
      });
    }
  }

  private scheduleNextTick(): void {
    if (this.disposed) return;
    if (this.isSoftwareGl) {
      this.afterDraw(() => this.tick());
    } else {
      this.frameId = requestAnimationFrame(() => this.tick());
    }
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || !gl.fenceSync) {
      this.frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    let polls = 0;
    const poll = () => {
      if (this.disposed) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const state = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
      if (state === gl.UNSIGNALED && polls < 300) {
        polls++;
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private tick(): void {
    if (this.disposed) return;
    const now = performance.now();
    const rawDelta = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const delta = Math.min(rawDelta, 0.05);

    this.updateScene(delta, now * 0.001);
    this.renderer.render(this.scene, this.camera);
    this.scheduleNextTick();
  }

  private updateScene(delta: number, timeSec: number): void {
    // Animate dust motes subtly
    if (this.dustPoints) {
      this.dustPoints.rotation.y += delta * 0.015;
    }

    // Update impact particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= delta;
      p.vel.y -= 9.5 * delta;
      p.mesh.position.addScaledVector(p.vel, delta);
      const s = Math.max(0.01, p.life / p.maxLife);
      p.mesh.scale.setScalar(s);
      if (p.life <= 0) {
        this.fxGroup.remove(p.mesh);
        this.particles.splice(i, 1);
      }
    }

    if (this.phase === 'title') {
      // Live atmospheric Backrooms camera pan down the starting corridor
      this.titleOrbitTime += delta;
      this.camera.position.set(
        this.level.spawnPos.x + Math.sin(this.titleOrbitTime * 0.35) * 0.25,
        1.64 + Math.sin(this.titleOrbitTime * 0.8) * 0.04,
        this.level.spawnPos.z + Math.cos(this.titleOrbitTime * 0.25) * 0.4,
      );
      _euler.set(
        Math.sin(this.titleOrbitTime * 0.4) * 0.03,
        this.level.spawnYaw + Math.sin(this.titleOrbitTime * 0.22) * 0.14,
        0,
        'YXZ',
      );
      this.camera.quaternion.setFromEuler(_euler);
      this.flashlight.intensity = 4.6;
      this.flashlightCone.visible = false;
      this.updateCeilingLights(timeSec);
      this.audio.updateAmbient(delta, 99, false);
      return;
    }

    if (this.phase !== 'playing') {
      this.audio.updateAmbient(delta, 99, false);
      return;
    }

    this.elapsedSeconds += delta;

    // Keyboard turn fallback (ArrowLeft / ArrowRight / Q / E)
    const turnSpeed = 2.0;
    if (this.keys['ArrowLeft'] || this.keys['KeyQ']) this.targetYaw += turnSpeed * delta;
    if (this.keys['ArrowRight'] || this.keys['KeyE']) this.targetYaw -= turnSpeed * delta;
    if (this.keys['ArrowUp']) this.targetPitch = Math.min(1.2, this.targetPitch + 1.4 * delta);
    if (this.keys['ArrowDown']) this.targetPitch = Math.max(-1.2, this.targetPitch - 1.4 * delta);

    // Smooth camera look damping
    this.yaw = THREE.MathUtils.damp(this.yaw, this.targetYaw, 24, delta);
    this.pitch = THREE.MathUtils.damp(this.pitch, this.targetPitch, 24, delta);
    this.swayX = THREE.MathUtils.damp(this.swayX, 0, 10, delta);
    this.swayY = THREE.MathUtils.damp(this.swayY, 0, 10, delta);

    // Aim FOV interpolation
    const targetFov = this.isAiming ? 56 : 72;
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = THREE.MathUtils.damp(this.camera.fov, targetFov, 14, delta);
      this.camera.updateProjectionMatrix();
    }

    // Player movement
    const forwardInput = (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0);
    const strafeInput = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0);
    const isMoving = forwardInput !== 0 || strafeInput !== 0;
    const wantsSprint = Boolean(this.keys['ShiftLeft'] || this.keys['ShiftRight']) && isMoving && !this.isAiming;
    const isSprinting = wantsSprint && this.stamina > 2;

    if (isSprinting) {
      this.stamina = Math.max(0, this.stamina - 22 * delta);
    } else {
      this.stamina = Math.min(100, this.stamina + 14 * delta);
    }

    const moveSpeed = isSprinting ? 5.65 : this.isAiming ? 2.3 : 3.65;
    if (isMoving) {
      _dir.set(0, 0, 0);
      const fwdX = -Math.sin(this.yaw);
      const fwdZ = -Math.cos(this.yaw);
      const rightX = Math.cos(this.yaw);
      const rightZ = -Math.sin(this.yaw);

      _dir.x = fwdX * forwardInput + rightX * strafeInput;
      _dir.z = fwdZ * forwardInput + rightZ * strafeInput;
      _dir.normalize();

      this.playerPos.x += _dir.x * moveSpeed * delta;
      this.playerPos.z += _dir.z * moveSpeed * delta;
      resolveCircleWallCollision(this.playerPos, 0.42, this.level.grid, this.level.pillars);

      this.footstepTimer -= delta;
      if (this.footstepTimer <= 0) {
        this.footstepTimer = isSprinting ? 0.31 : 0.48;
        this.audio.playFootstep(isSprinting);
      }
    }

    // Timers & cooldowns
    if (this.fireCooldown > 0) this.fireCooldown -= delta;
    if (this.damageFlash > 0) this.damageFlash = Math.max(0, this.damageFlash - delta * 2.2);
    if (this.screenShake > 0) this.screenShake = Math.max(0, this.screenShake - delta * 0.08);
    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer -= delta;
      if (this.hitmarkerTimer <= 0) this.hitmarkerState = 'none';
    }
    if (this.notificationTimer > 0) {
      this.notificationTimer -= delta;
      if (this.notificationTimer <= 0) this.notification = null;
    }

    if (this.isReloading) {
      this.reloadTimer -= delta;
      if (this.reloadTimer <= 0) {
        const needed = this.magCapacity - this.ammoInMag;
        const loaded = Math.min(needed, this.ammoReserve);
        this.ammoInMag += loaded;
        this.ammoReserve -= loaded;
        this.isReloading = false;
      }
    }

    this.crosshairSpread = THREE.MathUtils.damp(
      this.crosshairSpread,
      isMoving ? (isSprinting ? 0.45 : 0.22) : this.isAiming ? 0.02 : 0.08,
      12,
      delta,
    );

    // Apply camera position + headbob + shake
    const headBobY = isMoving ? Math.sin(this.elapsedSeconds * (isSprinting ? 14 : 9)) * 0.042 : 0;
    const shakeX = (Math.random() - 0.5) * this.screenShake;
    const shakeY = (Math.random() - 0.5) * this.screenShake;
    this.camera.position.set(
      this.playerPos.x + shakeX,
      this.playerPos.y + headBobY + shakeY,
      this.playerPos.z,
    );
    _euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(_euler);

    // Weapon update
    this.weapon.update(delta, isMoving, isSprinting, this.isAiming, this.swayX, this.swayY);

    // Update entities & proximity horror cues
    let nearestDist = Infinity;
    let nearestLabel: string | null = null;

    for (const ent of this.entities) {
      if (!ent.alive) continue;
      ent.update(
        delta,
        this.playerPos,
        this.flashlightOn,
        this.level.grid,
        this.level.pillars,
        (dmg) => {
          this.health = Math.max(0, this.health - dmg);
          this.damageTaken += dmg;
          this.damageFlash = 1.0;
          this.screenShake = 0.045;
          this.audio.playPlayerHurt();
          if (this.health <= 0) {
            this.phase = 'gameover';
            if (document.pointerLockElement === this.renderer.domElement) {
              document.exitPointerLock();
            }
            this.emitHud();
          }
        },
        () => {
          this.audio.playEntityScreech(0.32);
        },
      );

      const d = Math.hypot(ent.position.x - this.playerPos.x, ent.position.z - this.playerPos.z);
      if (d < nearestDist) {
        nearestDist = d;
        nearestLabel = ent.label;
      }
    }

    // Flashlight battery & eerie proximity flicker
    if (this.flashlightOn) {
      this.battery = Math.max(0, this.battery - 0.55 * delta);
      if (this.battery <= 0) {
        this.flashlightOn = false;
        this.audio.playFlashlightClick();
        this.pushNotification('Flashlight battery depleted!', 'warning');
      }
    } else {
      this.battery = Math.min(100, this.battery + 1.8 * delta);
    }

    let flashPower = this.flashlightOn ? 6.2 : 0;
    if (this.flashlightOn && nearestDist < 10.5) {
      const flickerGate = Math.sin(timeSec * 37) * Math.cos(timeSec * 23);
      if (flickerGate > 0.45) {
        flashPower *= 0.28;
      }
    }
    this.flashlight.intensity = flashPower;
    this.flashlightCone.visible = false;

    // Pickups animation & collection
    for (const p of this.pickups) {
      if (p.collected) continue;
      p.rotTarget.rotation.y += delta * (p.kind === 'tape' ? 1.5 : 0.7);
      if (p.kind === 'tape') {
        p.rotTarget.position.y = p.baseY + Math.sin(timeSec * 2.5 + p.id) * 0.035;
      }

      const d = Math.hypot(p.x - this.playerPos.x, p.z - this.playerPos.z);
      if (d < 1.35) {
        if (p.kind === 'tape') {
          p.collected = true;
          p.group.visible = false;
          this.tapesCollected++;
          this.audio.playPickup('tape');
          if (this.tapesCollected >= this.tapesTotal) {
            this.exitUnlocked = true;
            this.exitBeaconMat.color.setHex(0x3dff88);
            this.exitLight.color.setHex(0x3dff88);
            this.exitLight.intensity = 3.2;
            this.audio.playExitUnlocked();
            this.pushNotification(
              'All 4 VHS Tapes recovered! Sector 00 Exit is now UNLOCKED.',
              'success',
            );
          } else {
            this.pushNotification(
              `VHS Tape ${this.tapesCollected}/${this.tapesTotal} recovered.`,
              'success',
            );
          }
        } else if (p.kind === 'ammo') {
          p.collected = true;
          p.group.visible = false;
          this.ammoReserve += 24;
          this.audio.playPickup('ammo');
          this.pushNotification('+24 Rounds collected.', 'info');
        } else if (p.kind === 'almond_water' && this.health < this.maxHealth) {
          p.collected = true;
          p.group.visible = false;
          this.health = Math.min(this.maxHealth, this.health + 38);
          this.battery = Math.min(100, this.battery + 35);
          this.audio.playPickup('almond_water');
          this.pushNotification('Almond Water consumed (+38 Vitality, +35% Battery).', 'success');
        }
      }
    }

    // Check Sector Exit extraction
    const exitDist = Math.hypot(
      this.level.exitPos.x - this.playerPos.x,
      this.level.exitPos.z - this.playerPos.z,
    );
    if (this.exitUnlocked && exitDist < 1.75) {
      this.phase = 'victory';
      if (document.pointerLockElement === this.renderer.domElement) {
        document.exitPointerLock();
      }
      this.emitHud();
      return;
    }

    this.updateCeilingLights(timeSec);
    this.audio.updateAmbient(delta, nearestDist, true);

    this.hudEmitTimer -= delta;
    if (this.hudEmitTimer <= 0) {
      this.hudEmitTimer = 0.06;
      this.emitHud(null, nearestDist, nearestLabel);
    }
  }

  private updateCeilingLights(timeSec: number): void {
    const fixtures = this.level.fixtures;
    if (fixtures.length === 0) return;

    const camPos = this.camera.position;

    // Update fixture flicker brightness & find 8 nearest active fixtures
    const candidates: Array<{ idx: number; distSq: number; intensity: number }> = [];

    for (let i = 0; i < fixtures.length; i++) {
      const f = fixtures[i];
      if (f.flickerMode === 'dead') continue;

      let intensity = 2.4;
      if (f.flickerMode === 'flicker') {
        const wave =
          Math.sin(timeSec * 19 + f.phaseOffset) *
          Math.sin(timeSec * 7.3 + f.phaseOffset * 1.7);
        const factor = wave > 0.28 ? 0.14 : wave < -0.55 ? 0.35 : 1.0;
        intensity *= factor;

        if (this.lightPanelInstanced) {
          const b = 0.25 + factor * 0.75;
          this.fixtureColorTemp.setRGB(b, b * 0.96, b * 0.82);
          this.lightPanelInstanced.setColorAt(i, this.fixtureColorTemp);
        }
      }

      const dx = f.x - camPos.x;
      const dz = f.z - camPos.z;
      candidates.push({ idx: i, distSq: dx * dx + dz * dz, intensity });
    }

    if (this.lightPanelInstanced?.instanceColor) {
      this.lightPanelInstanced.instanceColor.needsUpdate = true;
    }

    candidates.sort((a, b) => a.distSq - b.distSq);

    for (let i = 0; i < this.pooledLights.length; i++) {
      const pl = this.pooledLights[i];
      if (i < candidates.length && candidates[i].distSq < 256) {
        const c = candidates[i];
        const f = fixtures[c.idx];
        pl.position.set(f.x, WALL_HEIGHT - 0.25, f.z);
        pl.intensity = c.intensity;
      } else {
        pl.intensity = 0;
      }
    }
  }

  private buildHudSnapshot(
    webglError: string | null = null,
    nearestEntityDist = 99,
    nearestEntityLabel: string | null = null,
  ): HudState {
    const exitDx = this.level.exitPos.x - this.playerPos.x;
    const exitDz = this.level.exitPos.z - this.playerPos.z;
    const exitDistanceMeters = Math.round(Math.hypot(exitDx, exitDz) * 10) / 10;
    const angleToExit = Math.atan2(-exitDx, -exitDz);
    const exitBearingRad = Math.atan2(
      Math.sin(angleToExit - this.yaw),
      Math.cos(angleToExit - this.yaw),
    );

    let interactPrompt: string | null = null;
    if (this.phase === 'playing') {
      if (exitDistanceMeters < 3.4) {
        interactPrompt = this.exitUnlocked
          ? 'SECTOR EXIT UNLOCKED — STEP INTO THRESHOLD'
          : `EXIT LOCKED — RECOVER ${this.tapesTotal - this.tapesCollected} MORE VHS TAPES`;
      }
    }

    return {
      phase: this.phase,
      difficulty: this.difficulty,
      health: Math.round(this.health),
      maxHealth: this.maxHealth,
      stamina: Math.round(this.stamina),
      battery: Math.round(this.battery),
      flashlightOn: this.flashlightOn,
      ammoInMag: this.ammoInMag,
      magCapacity: this.magCapacity,
      ammoReserve: this.ammoReserve,
      isReloading: this.isReloading,
      isAiming: this.isAiming,
      tapesCollected: this.tapesCollected,
      tapesTotal: this.tapesTotal,
      exitUnlocked: this.exitUnlocked,
      exitDistanceMeters,
      exitBearingRad,
      nearestEntityDist: Math.round(nearestEntityDist * 10) / 10,
      nearestEntityLabel,
      elapsedSeconds: this.elapsedSeconds,
      kills: this.kills,
      shotsFired: this.shotsFired,
      shotsHit: this.shotsHit,
      damageTaken: Math.round(this.damageTaken),
      damageFlash: this.damageFlash,
      hitmarkerState: this.hitmarkerState,
      crosshairSpread: this.crosshairSpread,
      pointerLocked: this.pointerLocked,
      muted: this.audio.isMuted(),
      notification: this.notification,
      interactPrompt,
      webglError,
    };
  }

  private emitHud(
    webglError: string | null = null,
    nearestEntityDist = 99,
    nearestEntityLabel: string | null = null,
  ): void {
    this.onHudUpdate(this.buildHudSnapshot(webglError, nearestEntityDist, nearestEntityLabel));
  }

  private installDebugApi(): void {
    window.__BACKROOMS_DEBUG__ = {
      getState: () => ({
        ...this.buildHudSnapshot(),
        playerPos: {
          x: this.playerPos.x,
          y: this.playerPos.y,
          z: this.playerPos.z,
        },
        yaw: this.yaw,
        pitch: this.pitch,
        entities: this.entities.map((e) => ({
          id: e.id,
          label: e.label,
          x: e.position.x,
          z: e.position.z,
          hp: e.health,
          alive: e.alive,
        })),
        tapes: this.pickups
          .filter((p) => p.kind === 'tape')
          .map((p) => ({ x: p.x, z: p.z, collected: p.collected })),
        exitPos: { x: this.level.exitPos.x, z: this.level.exitPos.z },
      }),
      startGame: (diff = 'standard') => {
        this.startNewGame(diff);
      },
      lookAtWorld: (x: number, y: number, z: number) => {
        const dx = x - this.playerPos.x;
        const dy = y - this.playerPos.y;
        const dz = z - this.playerPos.z;
        const horiz = Math.hypot(dx, dz) || 0.001;
        this.targetYaw = Math.atan2(-dx, -dz);
        this.yaw = this.targetYaw;
        this.targetPitch = THREE.MathUtils.clamp(Math.atan2(dy, horiz), -1.3, 1.3);
        this.pitch = this.targetPitch;
        this.camera.position.copy(this.playerPos);
        _euler.set(this.pitch, this.yaw, 0, 'YXZ');
        this.camera.quaternion.setFromEuler(_euler);
        this.camera.updateMatrixWorld(true);
      },
      teleportNearEntity: () => {
        return window.__BACKROOMS_DEBUG__!.teleportNearEntityByType('howler');
      },
      teleportNearEntityByType: (archetype: EntityArchetype) => {
        const alive = this.entities.find((e) => e.alive && e.archetype === archetype) || this.entities.find((e) => e.alive);
        if (!alive) return false;
        const offsets: Array<[number, number]> = [
          [0, 3.8],
          [0, -3.8],
          [3.8, 0],
          [-3.8, 0],
          [2.8, 2.8],
          [-2.8, -2.8],
        ];
        for (const [ox, oz] of offsets) {
          const cand = new THREE.Vector3(alive.position.x + ox, 1.68, alive.position.z + oz);
          resolveCircleWallCollision(cand, 0.45, this.level.grid, this.level.pillars);
          if (hasLineOfSight(cand, alive.position, this.level.grid)) {
            this.hitmarkerState = 'none';
            this.hitmarkerTimer = 0;
            this.playerPos.copy(cand);
            alive.faceWorldPoint(cand.x, cand.z);
            window.__BACKROOMS_DEBUG__?.lookAtWorld(alive.position.x, 1.35, alive.position.z);
            this.updateCeilingLights(performance.now() * 0.001);
            this.renderer.render(this.scene, this.camera);
            this.emitHud(null, Math.hypot(alive.position.x - cand.x, alive.position.z - cand.z), alive.label);
            return true;
          }
        }
        return false;
      },
      teleportNearTape: () => {
        const tape = this.pickups.find((p) => p.kind === 'tape' && !p.collected);
        if (!tape) return false;
        const cand = new THREE.Vector3(tape.x, 1.68, tape.z - 2.3);
        resolveCircleWallCollision(cand, 0.45, this.level.grid, this.level.pillars);
        this.playerPos.copy(cand);
        window.__BACKROOMS_DEBUG__?.lookAtWorld(tape.x, 0.95, tape.z);
        this.updateCeilingLights(performance.now() * 0.001);
        this.renderer.render(this.scene, this.camera);
        return true;
      },
      teleportToExitUnlocked: () => {
        this.tapesCollected = this.tapesTotal;
        this.exitUnlocked = true;
        this.exitBeaconMat.color.setHex(0x3dff88);
        this.exitLight.color.setHex(0x3dff88);
        this.exitLight.intensity = 3.6;
        this.pushNotification('All 4 VHS Tapes recovered! Sector 00 Exit is now UNLOCKED.', 'success');
        this.playerPos.set(this.level.exitPos.x, 1.68, this.level.exitPos.z - 3.0);
        window.__BACKROOMS_DEBUG__?.lookAtWorld(
          this.level.exitPos.x,
          1.4,
          this.level.exitPos.z,
        );
        this.updateCeilingLights(performance.now() * 0.001);
        this.renderer.render(this.scene, this.camera);
        this.emitHud();
      },
      fireShot: () => {
        this.fireCooldown = 0;
        this.fireWeapon();
        this.renderer.render(this.scene, this.camera);
      },
      toggleFlashlight: () => {
        this.toggleFlashlightAction();
      },
      setAim: (aim: boolean) => {
        this.isAiming = aim;
        this.weapon.snapAim(aim);
        this.camera.fov = aim ? 56 : 72;
        this.camera.updateProjectionMatrix();
        this.renderer.render(this.scene, this.camera);
        this.emitHud();
      },
      triggerReload: () => {
        this.startReload();
      },
    };
  }

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);

    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);

    if (this.renderer?.domElement) {
      this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);
      this.renderer.domElement.removeEventListener('webglcontextrestored', this.handleContextRestored);
      this.renderer.domElement.removeEventListener('mousedown', this.onMouseDown);
      this.renderer.domElement.removeEventListener('contextmenu', this.onContextMenu);
    }

    this.audio.dispose();
    this.materials?.dispose();
    this.renderer?.dispose();
    delete window.__BACKROOMS_DEBUG__;
  }
}
