import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HorrorAudioEngine } from './audio';
import { DirectorActions, ThreatDirector } from './director';
import { DoorInstance } from './doors';
import { BackroomsEntity, EntityHooks, EntityWorld, PlayerPerception } from './entities';
import {
  BackroomsLevelData,
  BoxCollider,
  CELL_SIZE,
  MAZE_SIZE,
  WALL_HEIGHT,
  computeBfsDistances,
  findNextStepToward,
  generateBackroomsLevel,
  gridToWorld,
  hasLineOfSight,
  isWallCell,
  resolveCircleWallCollision,
  worldToGrid,
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
import { GuideContext, GuideDirector } from './guide';
import { DEFAULT_SETTINGS, GameSettings, QualityLevel, loadSeenTips, saveSeenTips } from './storage';

// Recovered tapes play back one log each, in pickup order: a previous wanderer's notes that
// double as in-world hints about the systems that just escalated.
const TAPE_LOGS = [
  'DAY 3. The hum never stops. Every time I take one of these tapes, more lights go out. Something wants them back.',
  'The tall pale one cannot see. It listens. I took my shoes off. Walk. Do not run. Never shoot unless you have to.',
  'Bullets go through the grin. Light makes it back away, so the batteries are worth more than the gun.',
  'If you are hearing this, the door is open, and they know. Do not stop for the water. Not all of it is water.',
];
const TAPE_LOG_CPS = 40;

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
        entities: Array<{
          id: number;
          label: string;
          archetype: EntityArchetype;
          state: string;
          x: number;
          z: number;
          hp: number;
          alive: boolean;
        }>;
        tapes: Array<{ x: number; z: number; collected: boolean }>;
        pickups: Array<{ kind: PickupKind; x: number; z: number; collected: boolean }>;
        doors: Array<{ x: number; z: number; closed: boolean; broken: boolean }>;
        desks: Array<{ x: number; z: number }>;
        exitPos: { x: number; z: number };
      };
      /** Advance the simulation by `frames` fixed steps (for QA when the page is not animating). */
      step: (frames: number, dt?: number) => void;
      teleport: (x: number, z: number) => void;
      teleportToDoor: (index: number) => boolean;
      setCrouch: (on: boolean) => void;
      interact: () => void;
      startGame: (difficulty?: DifficultyMode, seed?: number) => void;
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

  // Materials owned by this.materials outlive every level and must never be disposed on rebuild.
  private sharedMaterials = new Set<THREE.Material>();
  // GPU resources of the previous level, released only after the new level has rendered once so the
  // new level's materials can reuse the cached shader programs instead of recompiling them.
  private pendingDisposal: Array<{ dispose: () => void }> = [];
  private readonly particleGeo = new THREE.BoxGeometry(0.045, 0.045, 0.045);
  private readonly particleMats = new Map<number, THREE.MeshBasicMaterial>();

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
  private hitmarkerState: HudState['hitmarkerState'] = 'none';
  private hitmarkerTimer = 0;
  private crosshairSpread = 0;
  private screenShake = 0;
  private footstepTimer = 0;
  private winded = false;
  private bobPhase = 0;
  private bobAmp = 0;
  private titleOrbitTime = 0;
  private hudEmitTimer = 0;

  // Stealth: crouching is quiet and harder to see; crouching under a desk hides you.
  private crouched = false;
  private hidden = false;
  private eyeHeight = 1.68;
  private smilerHintShown = false;

  // Level state added on top of the static maze
  private doors: DoorInstance[] = [];
  /** Door stubs (always) and closed door panels, for player and entity collision. */
  private colliders: BoxCollider[] = [];
  /** Copy of the grid with closed-door cells blocked, so entities route around closed doors. */
  private navGrid = new Uint8Array(0);
  private walkableCells: Array<{ gx: number; gz: number }> = [];
  private hideSpots: Array<{ x: number; z: number }> = [];
  private fixtureModes: Array<'steady' | 'flicker' | 'dead'> = [];
  private fixtureGlows: Array<THREE.Mesh | null> = [];
  private director!: ThreatDirector;
  private entityIdCounter = 0;

  // Player settings, onboarding and run flavour
  private gpuName = '';
  private settings: GameSettings = { ...DEFAULT_SETTINGS };
  private settingsApplied = false;
  private activeLightCount = 8;
  private readonly guide = new GuideDirector(loadSeenTips(), (seen) => saveSeenTips(seen));
  private tapeBeacons = new Map<number, { dispose: () => void }>();
  private tapeLog: { index: number; text: string; elapsed: number; duration: number } | null = null;

  private readonly perception: PlayerPerception = {
    pos: this.playerPos,
    forwardX: 0,
    forwardZ: -1,
    flashlightOn: true,
    crouched: false,
    hidden: false,
  };

  private readonly entityWorld: EntityWorld = {
    lineOfSight: (a, b) => this.lineOfSight(a, b),
    nextStepToward: (from, to) =>
      findNextStepToward(from, to, this.navGrid) ??
      // No way around a closed door: head straight for it (and batter it open).
      findNextStepToward(from, to, this.level.grid) ??
      to.clone(),
    resolveCollision: (pos, radius) =>
      resolveCircleWallCollision(pos, radius, this.level.grid, this.level.pillars, this.colliders),
    randomPointNear: (center, radiusCells) => this.randomWalkableNear(center, radiusCells),
    randomPatrolPoint: (from) => this.randomPatrolPoint(from),
  };

  private readonly entityHooks: EntityHooks = {
    onAttack: (_entity, damage) => this.damagePlayer(damage),
    onScreech: (entity) => entity.voice?.playScreech(entity.archetype),
    onRemoved: (entity) => this.director.entityRemoved(entity),
  };

  private readonly directorActions: DirectorActions = {
    findSpawnPoint: (minDistance) => this.findSpawnPoint(minDistance),
    spawnEntity: (archetype, x, z, disguised) => {
      this.createEntity(archetype, x, z, disguised);
    },
    respawnEntity: (entity, x, z, disguised) => entity.respawn(x, z, disguised),
    failLights: (fraction) => this.failLights(fraction),
    alertAll: () => this.emitNoise(this.playerPos, 1e6),
    setThreatLevel: (level) => this.audio.setThreatLevel(level),
  };

  private notifCounter = 1;
  private notification: HudNotification | null = null;
  private notificationTimer = 0;

  private keys: Record<string, boolean> = {};
  private pointerLocked = false;
  // Set once pointer lock has succeeded; where it never does (e.g. sandboxed iframe) clicks keep drag-look + fire.
  private pointerLockEverWorked = false;
  // A lock request failed and lock has never worked here: the HUD suggests opening the game in its own tab.
  private pointerLockBlocked = false;
  // True while the lock was granted with unadjustedMovement (raw input), which never produces warp spikes.
  private rawMouseInput = false;
  private pausedAtMs = 0;
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
    this.gpuName = gpu;
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
    for (const value of Object.values(this.materials)) {
      for (const m of Array.isArray(value) ? value : [value]) {
        if (m instanceof THREE.Material) this.sharedMaterials.add(m);
      }
    }

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
    // Every level builds its own geometries, materials and instance buffers. Removing them from the scene
    // is not enough to free them on the GPU, so queue them for disposal (textures all belong to this.materials).
    const queued = new Set<{ dispose: () => void }>();
    for (const grp of [this.levelGroup, this.entityGroup, this.pickupGroup]) {
      grp.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        if (obj instanceof THREE.InstancedMesh) queued.add(obj);
        queued.add(obj.geometry);
        for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
          if (!this.sharedMaterials.has(m)) queued.add(m);
        }
      });
    }
    this.pendingDisposal.push(...queued);

    // fxGroup only holds impact particles, which share particleGeo/particleMats.
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
    for (const ent of this.entities) ent.voice?.dispose();
    for (const beacon of this.tapeBeacons.values()) beacon.dispose();
    this.tapeBeacons.clear();
    this.entities = [];
    this.pickups = [];
    this.particles = [];
    this.wallRayMeshes = [];
    this.wallBoxPool = [];
    this.lightPanelInstanced = null;
    this.doors = [];
    this.colliders = [];
    this.hideSpots = [];
    this.fixtureGlows = [];
  }

  private buildLevel(seed: number, difficulty: DifficultyMode): void {
    this.clearGroups();
    this.difficulty = difficulty;
    this.level = generateBackroomsLevel(seed);
    this.navGrid = new Uint8Array(this.level.grid);
    this.walkableCells = [];
    for (let gz = 1; gz < MAZE_SIZE - 1; gz++) {
      for (let gx = 1; gx < MAZE_SIZE - 1; gx++) {
        if (!isWallCell(this.level.grid, gx, gz)) this.walkableCells.push({ gx, gz });
      }
    }
    this.fixtureModes = this.level.fixtures.map((f) => f.flickerMode);

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
          this.fixtureGlows[idx] = glow;
        } else {
          this.fixtureGlows[idx] = null;
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
    this.buildDoors();
    this.buildDesks();

    // 9. Spawn Entities and the director that keeps them coming
    this.director = new ThreatDirector(difficulty, this.directorActions);
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
    exitGroup.rotation.y = this.level.exitRotY;

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
    const batteryMat = new THREE.MeshStandardMaterial({
      color: 0x1b1c1f,
      roughness: 0.4,
      metalness: 0.3,
    });
    const batteryBandMat = new THREE.MeshStandardMaterial({
      color: 0xc99a2e,
      roughness: 0.35,
      metalness: 0.6,
      emissive: new THREE.Color(0x6b4a10),
      emissiveIntensity: 0.6,
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
        // Tape tables double as hiding spots once the tape is taken.
        grp.add(this.buildOfficeTable(propShadowMat, false));
        this.hideSpots.push({ x: p.x, z: p.z });

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
      } else if (p.kind === 'battery') {
        const shadow = new THREE.Mesh(
          new THREE.PlaneGeometry(0.4, 0.4).rotateX(-Math.PI / 2),
          propShadowMat,
        );
        shadow.position.y = 0.015;
        grp.add(shadow);
        // Chunky D-cell with a faintly glowing band so it can be spotted in the dark
        const cell = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.26, 14), batteryMat);
        body.position.y = 0.13;
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.072, 0.1, 14), batteryBandMat);
        band.position.y = 0.2;
        const terminal = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.03, 10), brassMat);
        terminal.position.y = 0.275;
        cell.add(body, band, terminal);
        grp.add(cell);
        rotTarget = cell;
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

  /** Metal office table on its soft contact shadow; desks get a modesty panel to hide behind. */
  private buildOfficeTable(shadowMat: THREE.Material, modestyPanel: boolean): THREE.Group {
    const grp = new THREE.Group();
    const tableShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.65, 1.15).rotateX(-Math.PI / 2),
      shadowMat,
    );
    tableShadow.position.y = 0.015;
    grp.add(tableShadow);

    const top = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.055, 0.72), this.materials.tableTop);
    top.position.y = 0.78;
    top.castShadow = true;
    top.receiveShadow = true;
    grp.add(top);
    for (const [lx, lz] of [
      [-0.5, -0.3],
      [0.5, -0.3],
      [-0.5, 0.3],
      [0.5, 0.3],
    ]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.76, 0.05), this.materials.tableMetal);
      leg.position.set(lx, 0.38, lz);
      grp.add(leg);
    }
    if (modestyPanel) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.5, 0.03), this.materials.tableMetal);
      panel.position.set(0, 0.5, -0.32);
      panel.castShadow = true;
      grp.add(panel);
    }
    return grp;
  }

  private buildDesks(): void {
    const shadowMat = new THREE.MeshBasicMaterial({
      map: this.materials.softShadowTex,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    for (const desk of this.level.desks) {
      const grp = this.buildOfficeTable(shadowMat, true);
      grp.position.set(desk.x, 0, desk.z);
      grp.rotation.y = desk.rotY;
      this.levelGroup.add(grp);
      this.hideSpots.push({ x: desk.x, z: desk.z });
    }
  }

  private buildDoors(): void {
    const panelMat = new THREE.MeshStandardMaterial({
      color: 0x9c8e66,
      roughness: 0.7,
      metalness: 0.15,
    });
    for (const spec of this.level.doors) {
      const door = new DoorInstance(spec, {
        wall: this.materials.wallpaper,
        frame: this.materials.exitFrame,
        panel: panelMat,
      });
      this.levelGroup.add(door.group);
      this.wallRayMeshes.push(...door.rayMeshes);
      this.colliders.push(...door.colliders);
      this.doors.push(door);
    }
  }

  private spawnEntities(difficulty: DifficultyMode): void {
    // The director adds one more entity per recovered tape, so the run starts lighter than it ends.
    const roster: EntityArchetype[] =
      difficulty === 'nightmare'
        ? ['howler', 'brute', 'smiler', 'howler', 'brute', 'smiler']
        : ['howler', 'brute', 'smiler', 'howler'];
    const count = Math.min(roster.length, this.level.entitySpawns.length);
    for (let i = 0; i < count; i++) {
      const sp = this.level.entitySpawns[i];
      this.createEntity(roster[i], sp.x, sp.z, roster[i] === 'brute');
    }
  }

  private createEntity(archetype: EntityArchetype, x: number, z: number, disguised: boolean): BackroomsEntity {
    const entity = new BackroomsEntity(
      ++this.entityIdCounter,
      archetype,
      x,
      z,
      {
        smilerFace: this.materials.smilerFace,
        smilerHaloTex: this.materials.smilerHaloTex,
        softShadowTex: this.materials.softShadowTex,
        howlerBodyTex: this.materials.howlerBodyTex,
        howlerNormalTex: this.materials.howlerNormalTex,
        bruteSkinTex: this.materials.bruteSkinTex,
        bruteNormalTex: this.materials.bruteNormalTex,
      },
      this.difficulty === 'nightmare',
      disguised,
    );
    this.entities.push(entity);
    this.entityGroup.add(entity.group);
    return entity;
  }

  /** Grid line of sight that also stops at door stubs and closed doors. */
  private lineOfSight(a: THREE.Vector3, b: THREE.Vector3): boolean {
    for (const door of this.doors) {
      if (door.blocksSegment(a.x, a.z, b.x, b.z)) return false;
    }
    return hasLineOfSight(a, b, this.level.grid);
  }

  /** Every entity within `radius` (scaled by its hearing) learns that something happened at `pos`. */
  private emitNoise(pos: THREE.Vector3, radius: number): void {
    if (radius <= 0) return;
    for (const ent of this.entities) ent.hearNoise(pos, radius);
  }

  private isDoorCell(gx: number, gz: number): boolean {
    return this.level.doors.some((d) => d.gx === gx && d.gz === gz);
  }

  private randomWalkableNear(center: THREE.Vector3, radiusCells: number): THREE.Vector3 | null {
    const c = worldToGrid(center.x, center.z);
    for (let tries = 0; tries < 12; tries++) {
      const gx = c.gx + Math.round((Math.random() * 2 - 1) * radiusCells);
      const gz = c.gz + Math.round((Math.random() * 2 - 1) * radiusCells);
      if (!isWallCell(this.level.grid, gx, gz)) return gridToWorld(gx, gz);
    }
    return null;
  }

  private randomPatrolPoint(from: THREE.Vector3): THREE.Vector3 | null {
    for (let tries = 0; tries < 25; tries++) {
      const cell = this.walkableCells[Math.floor(Math.random() * this.walkableCells.length)];
      if (!cell) return null;
      const wp = gridToWorld(cell.gx, cell.gz);
      if (Math.hypot(wp.x - from.x, wp.z - from.z) > CELL_SIZE * 2) return wp;
    }
    return null;
  }

  /** A walkable cell far from the player by path, out of their sight and away from other entities. */
  private findSpawnPoint(minDistance: number): { x: number; z: number } | null {
    const p = worldToGrid(this.playerPos.x, this.playerPos.z);
    const dist = computeBfsDistances(this.level.grid, p.gx, p.gz);
    const minSteps = Math.ceil(minDistance / CELL_SIZE);
    const candidates: Array<{ x: number; z: number }> = [];
    for (const cell of this.walkableCells) {
      const d = dist[cell.gz * MAZE_SIZE + cell.gx];
      if (d < minSteps || this.isDoorCell(cell.gx, cell.gz)) continue;
      const wp = gridToWorld(cell.gx, cell.gz);
      if (this.entities.some((e) => !e.isRemoved && Math.hypot(e.position.x - wp.x, e.position.z - wp.z) < 6)) {
        continue;
      }
      if (this.lineOfSight(wp, this.playerPos)) continue;
      candidates.push({ x: wp.x, z: wp.z });
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /** Director escalation: working lights start flickering, flickering ones die. */
  private failLights(fraction: number): void {
    const working: number[] = [];
    this.fixtureModes.forEach((mode, idx) => {
      if (mode !== 'dead') working.push(idx);
    });
    working.sort(() => Math.random() - 0.5);
    const count = Math.ceil(working.length * fraction);
    for (const idx of working.slice(0, count)) {
      if (this.fixtureModes[idx] === 'steady') {
        this.fixtureModes[idx] = 'flicker';
      } else {
        this.fixtureModes[idx] = 'dead';
        const glow = this.fixtureGlows[idx];
        if (glow) glow.visible = false;
        if (this.lightPanelInstanced) {
          this.fixtureColorTemp.setHex(0x1d1a10);
          this.lightPanelInstanced.setColorAt(idx, this.fixtureColorTemp);
          if (this.lightPanelInstanced.instanceColor) this.lightPanelInstanced.instanceColor.needsUpdate = true;
        }
      }
    }
  }

  private damagePlayer(damage: number): void {
    if (this.phase !== 'playing') return;
    this.health = Math.max(0, this.health - damage);
    this.damageTaken += damage;
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
  }

  /** Nearest door within reach that the player is facing (or standing in). */
  private findInteractableDoor(): DoorInstance | null {
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    let best: DoorInstance | null = null;
    let bestDist = 2.2;
    for (const door of this.doors) {
      const dx = door.x - this.playerPos.x;
      const dz = door.z - this.playerPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > bestDist) continue;
      if (dist > 0.6 && (dx * fx + dz * fz) / dist < 0.35) continue;
      best = door;
      bestDist = dist;
    }
    return best;
  }

  private interactDoor(): void {
    const door = this.findInteractableDoor();
    if (!door) return;
    if (door.broken) {
      this.pushNotification('This door was torn off its hinges.', 'warning');
      return;
    }
    if (!door.closed) {
      const blocked =
        door.panelOverlaps(this.playerPos.x, this.playerPos.z, 0.42) ||
        this.entities.some((e) => e.alive && door.panelOverlaps(e.position.x, e.position.z, 0.44));
      if (blocked) {
        this.pushNotification('Something is in the doorway.', 'warning');
        return;
      }
    }
    door.toggle();
    this.onDoorChanged(door);
    this.audio.playAt(door.closed ? 'door_close' : 'door_open', door.x, 1.2, door.z);
    this.emitNoise(_vec3A.set(door.x, 0, door.z), 5);
  }

  private onDoorChanged(door: DoorInstance): void {
    const idx = door.spec.gz * MAZE_SIZE + door.spec.gx;
    this.navGrid[idx] = door.closed ? 1 : this.level.grid[idx];
  }

  private updateDoors(delta: number): void {
    for (const door of this.doors) {
      door.update(delta);
      if (!door.closed) continue;
      let bashing = false;
      let heavy = false;
      for (const ent of this.entities) {
        if (!ent.isEngaged) continue;
        if (Math.hypot(ent.position.x - door.x, ent.position.z - door.z) < 1.35) {
          bashing = true;
          if (ent.archetype === 'brute') heavy = true;
        }
      }
      if (!bashing) {
        door.bashTimer = Math.max(0, door.bashTimer - delta);
        continue;
      }
      door.bashTimer += delta;
      door.bashSoundTimer -= delta;
      if (door.bashSoundTimer <= 0) {
        door.bashSoundTimer = 0.55;
        this.audio.playAt('door_bash', door.x, 1.2, door.z);
      }
      if (door.bashTimer >= (heavy ? 1.4 : 2.6)) {
        door.burstOpen();
        this.onDoorChanged(door);
        this.audio.playAt('door_break', door.x, 1.2, door.z);
        this.emitNoise(_vec3A.set(door.x, 0, door.z), 12);
      }
    }
  }

  /** Start a run. Pass a seed to replay a layout (daily runs, "retry this layout"); omit for a fresh one. */
  public startNewGame(difficulty: DifficultyMode, seed?: number): void {
    this.audio.init();
    this.difficulty = difficulty;
    const layoutSeed = seed ?? Math.floor(Math.random() * 2 ** 31);
    this.buildLevel(layoutSeed, difficulty);
    this.tapeLog = null;
    this.guide.reset();

    this.maxHealth = 100;
    this.health = 100;
    this.stamina = 100;
    this.winded = false;
    this.battery = 100;
    this.flashlightOn = true;

    // Survival, not a shooting gallery: one spare magazine (half on Nightmare) and three small crates.
    this.ammoInMag = this.magCapacity;
    this.ammoReserve = difficulty === 'nightmare' ? 6 : 12;
    this.isReloading = false;
    this.reloadTimer = 0;
    this.fireCooldown = 0;
    this.isAiming = false;

    this.crouched = false;
    this.hidden = false;
    this.eyeHeight = 1.68;
    this.smilerHintShown = false;
    this.audio.setThreatLevel(0);

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
    this.pausedAtMs = performance.now();
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
    const el = this.renderer.domElement;
    const onFail = () => {
      if (!this.pointerLockEverWorked) {
        this.pointerLockBlocked = true;
        this.emitHud();
      }
    };
    if (typeof el.requestPointerLock !== 'function') {
      onFail();
      return;
    }
    try {
      // Raw (unadjusted) input avoids the Chromium-on-Windows bug where the hidden cursor reaching the window
      // edge is warped back and reported as one huge opposite movement, snapping the view the other way.
      // It also bypasses OS mouse acceleration, which is what FPS players expect.
      const raw: Promise<void> | undefined = el.requestPointerLock({ unadjustedMovement: true });
      if (!raw) return; // Older engines: no promise and no raw input; onMouseMove filters spikes instead.
      raw.then(
        () => {
          this.rawMouseInput = true;
        },
        (err: unknown) => {
          if (err instanceof DOMException && err.name === 'NotSupportedError') {
            this.rawMouseInput = false;
            const plain: Promise<void> | undefined = el.requestPointerLock();
            plain?.catch(onFail);
          } else {
            onFail();
          }
        },
      );
    } catch {
      /* Fallback drag/keyboard look remains active */
      onFail();
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
    window.addEventListener('blur', this.onWindowBlur);
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
    const wasLocked = this.pointerLocked;
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
    if (this.pointerLocked) {
      this.pointerLockEverWorked = true;
      this.pointerLockBlocked = false;
    } else if (wasLocked && this.phase === 'playing') {
      // Losing the cursor (Esc, Alt-Tab, clicking outside) must not leave the player defenceless mid-fight.
      this.pauseGame();
    }
    this.emitHud();
  };

  private onWindowBlur = (): void => {
    // keyup never arrives for keys held while the window loses focus, which left the player walking on their own.
    this.keys = {};
    this.isAiming = false;
    this.isDraggingLook = false;
    this.pauseGame();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys[e.code] = true;
    if (e.code === 'Escape') {
      if (this.phase === 'playing') {
        this.pauseGame();
      } else if (this.phase === 'paused' && !this.uiOverlayOpen && performance.now() - this.pausedAtMs > 300) {
        // Some browsers deliver the Esc keydown right after Esc already released the pointer lock (and paused);
        // ignore that echo so one press does not pause and immediately resume.
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
    } else if (e.code === 'KeyC' && !e.repeat) {
      // C, not Ctrl: Ctrl+W would close the browser tab mid-crouch-walk.
      this.crouched = !this.crouched;
      this.emitHud();
    } else if (e.code === 'KeyE' && !e.repeat) {
      this.interactDoor();
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
        // Once pointer lock has worked, a click on the unlocked canvas only re-grabs the cursor: firing here
        // woke every entity within 26 m just because the player wanted to resume. Where lock never works
        // (e.g. sandboxed iframe), keep the drag-look mode in which clicks still shoot.
        if (this.pointerLockEverWorked) return;
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
    const sens = (this.isAiming ? 0.0014 : 0.0022) * this.settings.sensitivity;
    const ySign = this.settings.invertY ? -1 : 1;
    if (this.pointerLocked) {
      if (!this.rawMouseInput) {
        // Without raw input, Chromium on Windows occasionally reports the cursor re-centre warp as a single
        // movement of roughly half the window; drop those spikes instead of snapping the camera.
        const limit = Math.max(220, Math.max(window.innerWidth, window.innerHeight) * 0.3);
        if (Math.abs(e.movementX) > limit || Math.abs(e.movementY) > limit) return;
      }
      this.targetYaw -= e.movementX * sens;
      this.targetPitch = THREE.MathUtils.clamp(
        this.targetPitch - e.movementY * sens * ySign,
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
        this.targetPitch - dy * sens * 1.4 * ySign,
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

    // A gunshot is the loudest thing in Level 0: everything that can hear within 26 m comes to look.
    this.emitNoise(this.playerPos, 26);

    // Raycast shot from camera center
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.raycaster.far = 42;

    const wallHits = this.raycaster.intersectObjects(this.wallRayMeshes, false);
    const wallDist = wallHits.length > 0 ? wallHits[0].distance : Infinity;

    const entityHitMeshes: THREE.Mesh[] = [];
    for (const ent of this.entities) entityHitMeshes.push(...ent.activeHitMeshes());

    const entHits = this.raycaster.intersectObjects(entityHitMeshes, false);
    if (entHits.length > 0 && entHits[0].distance < wallDist) {
      const hit = entHits[0];
      const entityId = hit.object.userData.entityId as number;
      const isHead = Boolean(hit.object.userData.isHead);
      const targetEntity = this.entities.find((e) => e.id === entityId);

      if (targetEntity) {
        const res = targetEntity.applyDamage(34, isHead);
        if (res.immune) {
          this.hitmarkerState = 'immune';
          this.hitmarkerTimer = 0.3;
          this.audio.playHitmarker('immune');
          if (!this.smilerHintShown) {
            this.smilerHintShown = true;
            this.pushNotification('Bullets pass straight through the Smiler. Hold your light on it.', 'warning');
          }
        } else if (res.hit) {
          this.shotsHit++;
          this.hitmarkerState = res.killed ? 'kill' : 'hit';
          this.hitmarkerTimer = 0.22;
          this.audio.playHitmarker(res.killed ? 'kill' : 'hit');
          this.spawnImpactParticles(hit.point, 0x991b1b, 10);
          if (res.revealed) targetEntity.voice?.playScreech(targetEntity.archetype);

          if (res.killed) {
            this.kills++;
            _vec3B.set(targetEntity.position.x, 1.1, targetEntity.position.z);
            this.spawnImpactParticles(_vec3B, 0x16130c, 24);
            // Skin-Stealers carry a few rounds taken from earlier victims
            const bonus = targetEntity.archetype === 'brute' ? 6 : 0;
            this.ammoReserve += bonus;
            this.pushNotification(
              `${res.entityName} neutralized${res.headshot ? ' (Headshot)' : ''}` +
                (bonus > 0 ? ` · +${bonus} rounds` : '') +
                '. It will not stay gone.',
              'info',
            );
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
    // Shared geometry + one material per colour: creating them per shot leaked GPU buffers on every hit.
    let mat = this.particleMats.get(colorHex);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({ color: colorHex });
      this.particleMats.set(colorHex, mat);
    }
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.particleGeo, mat);
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
    if (this.pendingDisposal.length > 0) {
      for (const resource of this.pendingDisposal) resource.dispose();
      this.pendingDisposal = [];
    }
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

    // Keyboard turn fallback (arrow keys; E is now the door key)
    const turnSpeed = 2.0;
    if (this.keys['ArrowLeft']) this.targetYaw += turnSpeed * delta;
    if (this.keys['ArrowRight']) this.targetYaw -= turnSpeed * delta;
    if (this.keys['ArrowUp']) this.targetPitch = Math.min(1.2, this.targetPitch + 1.4 * delta);
    if (this.keys['ArrowDown']) this.targetPitch = Math.max(-1.2, this.targetPitch - 1.4 * delta);

    // Apply look input directly: the old damping applied only ~55% of each mouse movement on the first frame,
    // which read as laggy, floaty aim.
    this.yaw = this.targetYaw;
    this.pitch = this.targetPitch;
    this.swayX = THREE.MathUtils.damp(this.swayX, 0, 10, delta);
    this.swayY = THREE.MathUtils.damp(this.swayY, 0, 10, delta);

    // Aim FOV interpolation
    const targetFov = this.isAiming ? this.settings.fov - 16 : this.settings.fov;
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = THREE.MathUtils.damp(this.camera.fov, targetFov, 14, delta);
      this.camera.updateProjectionMatrix();
    }

    // Player movement
    const forwardInput = (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0);
    const strafeInput = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0);
    const isMoving = forwardInput !== 0 || strafeInput !== 0;
    const wantsSprint = Boolean(this.keys['ShiftLeft'] || this.keys['ShiftRight']) && isMoving && !this.isAiming;
    if (wantsSprint && this.crouched) this.crouched = false;
    // Hysteresis: once stamina is spent the player is winded until it recovers to 35%. Without it, holding
    // Shift on an empty bar flipped sprint on and off every frame (speed and head bob stuttering).
    const isSprinting = wantsSprint && !this.winded && this.stamina > 0;

    if (isSprinting) {
      this.stamina = Math.max(0, this.stamina - 22 * delta);
      if (this.stamina <= 0) this.winded = true;
    } else {
      this.stamina = Math.min(100, this.stamina + 14 * delta);
      if (this.winded && this.stamina >= 35) this.winded = false;
    }

    const moveSpeed = isSprinting ? 5.65 : this.crouched ? 1.9 : this.isAiming ? 2.3 : 3.65;
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
      resolveCircleWallCollision(this.playerPos, 0.42, this.level.grid, this.level.pillars, this.colliders);

      // Footsteps are noise: sprinting carries 11 m (Howlers hear 1.6x), walking 2.5 m, crouching nothing.
      this.footstepTimer -= delta;
      if (this.footstepTimer <= 0) {
        this.footstepTimer = isSprinting ? 0.31 : this.crouched ? 0.62 : 0.48;
        if (!this.crouched) this.audio.playFootstep(isSprinting);
        this.emitNoise(this.playerPos, isSprinting ? 11 : this.crouched ? 0 : 2.5);
      }
    }

    this.hidden =
      this.crouched && this.hideSpots.some((s) => Math.hypot(s.x - this.playerPos.x, s.z - this.playerPos.z) < 0.85);
    const targetEye = this.hidden ? 0.62 : this.crouched ? 1.05 : 1.68;
    this.eyeHeight = THREE.MathUtils.damp(this.eyeHeight, targetEye, 10, delta);

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
    // Head bob: accumulate phase (so changing pace never jumps the camera) and ease the amplitude in and out.
    this.bobPhase += delta * (isSprinting ? 14 : this.crouched ? 7 : 9);
    const targetBobAmp = !isMoving ? 0 : this.crouched ? 0.018 : isSprinting ? 0.042 : 0.032;
    this.bobAmp = THREE.MathUtils.damp(this.bobAmp, targetBobAmp, 8, delta);
    const headBobY = Math.sin(this.bobPhase) * this.bobAmp;
    const shakeX = (Math.random() - 0.5) * this.screenShake;
    const shakeY = (Math.random() - 0.5) * this.screenShake;
    this.camera.position.set(
      this.playerPos.x + shakeX,
      this.eyeHeight + headBobY + shakeY,
      this.playerPos.z,
    );
    _euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(_euler);

    // Weapon update
    this.weapon.update(delta, isMoving, isSprinting, this.isAiming, this.swayX, this.swayY);

    // Spatial audio listener follows the camera
    const cosPitch = Math.cos(this.pitch);
    this.audio.updateListener(
      this.camera.position.x,
      this.camera.position.y,
      this.camera.position.z,
      -Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cosPitch,
    );

    // Update entities & proximity horror cues
    this.perception.forwardX = -Math.sin(this.yaw);
    this.perception.forwardZ = -Math.cos(this.yaw);
    this.perception.flashlightOn = this.flashlightOn;
    this.perception.crouched = this.crouched;
    this.perception.hidden = this.hidden;

    let nearestDist = Infinity;
    let nearestLabel: string | null = null;
    // Iterate over a snapshot: the director may add entities during this frame.
    for (const ent of [...this.entities]) {
      if (ent.isRemoved) continue;
      if (!ent.voice) ent.voice = this.audio.createVoice();
      ent.update(delta, this.perception, this.entityWorld, this.entityHooks);
      if (this.phase !== 'playing') return;

      // A disguised Skin-Stealer must not trip the heartbeat or the HUD readout.
      if (!ent.isThreat) continue;
      const d = Math.hypot(ent.position.x - this.playerPos.x, ent.position.z - this.playerPos.z);
      if (d < nearestDist) {
        nearestDist = d;
        nearestLabel = ent.label;
      }
    }

    this.updateDoors(delta);
    this.director.update(delta);

    // Flashlight battery & eerie proximity flicker. No passive recharge: batteries are a resource.
    if (this.flashlightOn) {
      this.battery = Math.max(0, this.battery - 0.75 * delta);
      if (this.battery <= 0) {
        this.flashlightOn = false;
        this.audio.playFlashlightClick();
        this.pushNotification('Flashlight battery dead. Find batteries.', 'warning');
      }
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
          this.tapeBeacons.get(p.id)?.dispose();
          this.tapeBeacons.delete(p.id);
          const logText = TAPE_LOGS[Math.min(TAPE_LOGS.length, this.tapesCollected) - 1];
          this.tapeLog = {
            index: this.tapesCollected,
            text: logText,
            elapsed: 0,
            duration: logText.length / TAPE_LOG_CPS + 4.5,
          };
          this.audio.playTapeLog();
          // Every tape makes Level 0 more dangerous (lights fail, another entity wakes, the hum grows).
          const flavor = this.director.tapeCollected(this.tapesCollected);
          if (this.tapesCollected >= this.tapesTotal) {
            this.exitUnlocked = true;
            this.exitBeaconMat.color.setHex(0x3dff88);
            this.exitLight.color.setHex(0x3dff88);
            this.exitLight.intensity = 3.2;
            this.audio.playExitUnlocked();
            this.pushNotification(`All 4 VHS Tapes recovered. Exit UNLOCKED. ${flavor}`, 'danger');
          } else {
            this.pushNotification(
              `VHS Tape ${this.tapesCollected}/${this.tapesTotal} recovered. ${flavor}`,
              'success',
            );
          }
        } else if (p.kind === 'ammo') {
          p.collected = true;
          p.group.visible = false;
          this.ammoReserve += 8;
          this.audio.playPickup('ammo');
          this.pushNotification('+8 Rounds collected.', 'info');
        } else if (p.kind === 'almond_water' && this.health < this.maxHealth) {
          p.collected = true;
          p.group.visible = false;
          this.health = Math.min(this.maxHealth, this.health + 35);
          this.audio.playPickup('almond_water');
          this.pushNotification('Almond Water consumed (+35 Vitality).', 'success');
        } else if (p.kind === 'battery' && this.battery < 100) {
          p.collected = true;
          p.group.visible = false;
          this.battery = Math.min(100, this.battery + 45);
          this.audio.playPickup('battery');
          this.pushNotification('Battery swapped in (+45% Light).', 'success');
        }
      }
    }

    // Uncollected tapes hiss through positional audio so they can be found by ear
    for (const p of this.pickups) {
      if (p.kind !== 'tape' || p.collected || this.tapeBeacons.has(p.id)) continue;
      const beacon = this.audio.createTapeBeacon(p.x, 1.0, p.z);
      if (beacon) this.tapeBeacons.set(p.id, beacon);
    }
    if (this.tapeLog) {
      this.tapeLog.elapsed += delta;
      if (this.tapeLog.elapsed > this.tapeLog.duration) this.tapeLog = null;
    }
    this.guide.update(delta, this.buildGuideContext(nearestDist));

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
      // Modes change at runtime as the director fails lights.
      const mode = this.fixtureModes[i] ?? f.flickerMode;
      if (mode === 'dead') continue;

      let intensity = 2.4;
      if (mode === 'flicker') {
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
      if (i < this.activeLightCount && i < candidates.length && candidates[i].distSq < 256) {
        const c = candidates[i];
        const f = fixtures[c.idx];
        pl.position.set(f.x, WALL_HEIGHT - 0.25, f.z);
        pl.intensity = c.intensity;
      } else {
        pl.intensity = 0;
      }
    }
  }

  private buildGuideContext(nearestThreatDist: number): GuideContext {
    let howlerNear = false;
    let smilerNear = false;
    let skinStealerRevealed = false;
    let hunting = false;
    for (const e of this.entities) {
      if (!e.isThreat) continue;
      const d = Math.hypot(e.position.x - this.playerPos.x, e.position.z - this.playerPos.z);
      const inSight = e.hasLineOfSightToPlayer;
      if (e.archetype === 'howler' && ((inSight && d < 14) || (e.state === 'chase' && d < 20))) howlerNear = true;
      if (e.archetype === 'smiler' && inSight && d < 16) smilerNear = true;
      if (e.archetype === 'brute' && e.state === 'chase' && d < 16) skinStealerRevealed = true;
      if (e.state === 'chase' || e.state === 'investigate') hunting = true;
    }
    return {
      elapsed: this.elapsedSeconds,
      battery: this.battery,
      flashlightOn: this.flashlightOn,
      ammoTotal: this.ammoInMag + this.ammoReserve,
      winded: this.winded,
      crouched: this.crouched,
      tapesCollected: this.tapesCollected,
      exitUnlocked: this.exitUnlocked,
      nearDoor: this.findInteractableDoor() !== null,
      nearDesk: this.hideSpots.some((s) => Math.hypot(s.x - this.playerPos.x, s.z - this.playerPos.z) < 1.4),
      somethingNear: nearestThreatDist < 18 || hunting,
      howlerNear,
      smilerNear,
      skinStealerRevealed,
    };
  }

  /** Settings / How-to-play overlay is open: Esc must not resume the game underneath it. */
  public uiOverlayOpen = false;

  public resetTips(): void {
    this.guide.clearSeen();
  }

  /** Apply player settings (Settings panel / localStorage). Safe to call at any time. */
  public applySettings(settings: GameSettings): void {
    const qualityChanged = !this.settingsApplied || settings.quality !== this.settings.quality;
    this.settings = { ...settings };
    this.settingsApplied = true;
    this.audio.setVolume(settings.volume);
    this.guide.enabled = settings.tips;
    if (this.phase !== 'playing' && this.camera) {
      this.camera.fov = settings.fov;
      this.camera.updateProjectionMatrix();
    }
    if (qualityChanged) this.applyQuality(this.resolveQuality(settings.quality));
    this.emitHud();
  }

  /** 'auto' picks Medium on integrated / mobile GPUs and High elsewhere. */
  public resolveQuality(quality: QualityLevel): 'low' | 'medium' | 'high' {
    if (quality !== 'auto') return quality;
    if (this.isSoftwareGl) return 'low';
    return /Intel|Iris|UHD|Radeon\(TM\) Graphics|Mali|Adreno|PowerVR|Apple GPU/i.test(this.gpuName)
      ? 'medium'
      : 'high';
  }

  private applyQuality(quality: 'low' | 'medium' | 'high'): void {
    if (!this.renderer) return;
    const dpr = window.devicePixelRatio || 1;
    const ratio = this.isSoftwareGl
      ? 1
      : quality === 'high'
        ? Math.min(dpr, 2)
        : quality === 'medium'
          ? Math.min(dpr, 1.25)
          : Math.min(dpr, 1) * 0.85;
    this.renderer.setPixelRatio(ratio);
    this.onResize();

    const shadows = !this.isSoftwareGl && quality !== 'low';
    const mapSize = quality === 'high' ? 1024 : 512;
    if (this.renderer.shadowMap.enabled !== shadows || this.flashlight.shadow.mapSize.x !== mapSize) {
      this.renderer.shadowMap.enabled = shadows;
      this.flashlight.castShadow = shadows;
      this.flashlight.shadow.mapSize.set(mapSize, mapSize);
      this.flashlight.shadow.map?.dispose();
      this.flashlight.shadow.map = null;
      // Shadow on/off changes every lit shader: rebuild programs on the next frame.
      this.scene.traverse((obj) => {
        const mat = (obj as THREE.Mesh).material;
        if (!mat) return;
        for (const m of Array.isArray(mat) ? mat : [mat]) m.needsUpdate = true;
      });
    }

    // Fewer per-pixel ceiling lights on lower settings (invisible lights leave the shader entirely)
    this.activeLightCount = quality === 'high' ? 8 : quality === 'medium' ? 6 : 4;
    this.pooledLights.forEach((light, i) => {
      light.visible = i < this.activeLightCount;
    });
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
      } else {
        const door = this.findInteractableDoor();
        if (door) {
          interactPrompt = door.broken ? 'DOOR TORN OFF ITS HINGES' : door.closed ? '[E] OPEN DOOR' : '[E] CLOSE DOOR';
        } else if (
          !this.crouched &&
          this.hideSpots.some((s) => Math.hypot(s.x - this.playerPos.x, s.z - this.playerPos.z) < 1.2)
        ) {
          interactPrompt = '[C] CROUCH UNDER THE DESK TO HIDE';
        }
      }
    }

    return {
      phase: this.phase,
      difficulty: this.difficulty,
      health: Math.round(this.health),
      maxHealth: this.maxHealth,
      stamina: Math.round(this.stamina),
      winded: this.winded,
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
      pointerLockBlocked: this.pointerLockBlocked,
      crouched: this.crouched,
      hidden: this.hidden,
      threatLevel: this.director?.threatLevel ?? 0,
      muted: this.audio.isMuted(),
      notification: this.notification,
      tip: this.phase === 'playing' ? this.guide.tip : null,
      tapeLog: this.tapeLog
        ? {
            index: this.tapeLog.index,
            total: this.tapesTotal,
            text: this.tapeLog.text,
            shownChars: Math.min(this.tapeLog.text.length, Math.floor(this.tapeLog.elapsed * TAPE_LOG_CPS)),
          }
        : null,
      seed: this.level.seed,
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
          archetype: e.archetype,
          state: e.state,
          x: e.position.x,
          z: e.position.z,
          hp: e.health,
          alive: e.alive,
        })),
        tapes: this.pickups
          .filter((p) => p.kind === 'tape')
          .map((p) => ({ x: p.x, z: p.z, collected: p.collected })),
        pickups: this.pickups.map((p) => ({ kind: p.kind, x: p.x, z: p.z, collected: p.collected })),
        doors: this.doors.map((d) => ({ x: d.x, z: d.z, closed: d.closed, broken: d.broken })),
        desks: this.level.desks.map((d) => ({ x: d.x, z: d.z })),
        exitPos: { x: this.level.exitPos.x, z: this.level.exitPos.z },
      }),
      step: (frames: number, dt = 1 / 30) => {
        let t = performance.now() * 0.001;
        for (let i = 0; i < frames; i++) {
          t += dt;
          this.updateScene(dt, t);
          this.renderer.render(this.scene, this.camera);
          for (const resource of this.pendingDisposal) resource.dispose();
          this.pendingDisposal = [];
        }
      },
      teleport: (x: number, z: number) => {
        this.playerPos.set(x, this.playerPos.y, z);
        resolveCircleWallCollision(this.playerPos, 0.42, this.level.grid, this.level.pillars, this.colliders);
      },
      teleportToDoor: (index: number) => {
        const door = this.doors[index];
        if (!door) return false;
        // Stand one metre back along the corridor, facing the door.
        const alongX = door.spec.axis === 'x';
        this.playerPos.set(door.x - (alongX ? 1.2 : 0), this.playerPos.y, door.z - (alongX ? 0 : 1.2));
        window.__BACKROOMS_DEBUG__?.lookAtWorld(door.x, 1.2, door.z);
        return true;
      },
      setCrouch: (on: boolean) => {
        this.crouched = on;
      },
      interact: () => this.interactDoor(),
      startGame: (diff = 'standard', seed?: number) => {
        this.startNewGame(diff, seed);
      },
      lookAtWorld: (x: number, y: number, z: number) => {
        const dx = x - this.playerPos.x;
        const dy = y - this.eyeHeight;
        const dz = z - this.playerPos.z;
        const horiz = Math.hypot(dx, dz) || 0.001;
        this.targetYaw = Math.atan2(-dx, -dz);
        this.yaw = this.targetYaw;
        this.targetPitch = THREE.MathUtils.clamp(Math.atan2(dy, horiz), -1.3, 1.3);
        this.pitch = this.targetPitch;
        this.camera.position.set(this.playerPos.x, this.eyeHeight, this.playerPos.z);
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
        const n = this.level.exitNormal;
        this.playerPos.set(this.level.exitPos.x + n.x * 3.0, 1.68, this.level.exitPos.z + n.z * 3.0);
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
    window.removeEventListener('blur', this.onWindowBlur);
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
    this.particleGeo.dispose();
    this.particleMats.forEach((m) => m.dispose());
    this.materials?.dispose();
    this.renderer?.dispose();
    delete window.__BACKROOMS_DEBUG__;
  }
}
