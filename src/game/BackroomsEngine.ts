import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GameAssets, MODEL_FILES, findMesh, isAssetMesh, type ModelId } from './assets';
import { HorrorAudioEngine } from './audio';
import { DEFAULT_BINDINGS, GameAction, KeyBindings, KeyHints, actionForCode, keyHintsFor, normalizeCode } from './controls';
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
  findWeightedPath,
  generateBackroomsLevel,
  gridToWorld,
  hasLineOfSight,
  isWallCell,
  resolveCircleWallCollision,
  worldToGrid,
} from './maze';
import { hudChanged } from './hudDiff';
import { mergeStaticMeshes } from './meshMerge';
import { GpuTimer, SampleRing } from './perf';
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
import { BULLET_DAMAGE } from './combat';
import { aimFov, lookScale } from './aim';
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
const _jsCam = new THREE.Vector3();
const _jsLook = new THREE.Vector3();
const _jsSpark = new THREE.Vector3();
const _jsQuat = new THREE.Quaternion();
const BASE_EXPOSURE = 1.08;
const MODEL_COUNT = Object.keys(MODEL_FILES).length;
const HEMI_INTENSITY = 0.26;
const ENV_INTENSITY = 0.22;
/** How long "SIGNAL LOST" stays up before the results screen. */
const SIGNAL_LOST_SECONDS = 0.6;
/** The death scene can be skipped with any key or click after this long. */
const JUMPSCARE_SKIP_AFTER = 0.8;
/** The Blender model for each entity kind (the Skin-Stealer is 'brute' in code). */
const ENTITY_MODEL: Record<EntityArchetype, ModelId> = {
  howler: 'ent_howler',
  smiler: 'ent_smiler',
  brute: 'ent_skin_stealer',
};
const WATER_HEAL = 35;
const BATTERY_CHARGE = 45;
// Supplies are used on contact only when at least 60% of their value would land; otherwise they stay put
// (a battery walked over at 99% used to vanish for +1% while the message claimed +45%).
const AUTO_USE_FRACTION = 0.6;
const LOW_BATTERY_WARNINGS = [25, 10];
// Below this, a laboured-breathing layer and a pulsing vignette warn that one more hit may be the last.
const LOW_HEALTH = 35;
// Stamina % at which a winded player may sprint again (still holding Shift / after releasing it)
const WINDED_RECOVER_HOLDING = 18;
const WINDED_RECOVER_RELEASED = 6;

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
        director: { intensity: number; pace: string };
        entities: Array<{
          id: number;
          label: string;
          archetype: EntityArchetype;
          state: string;
          x: number;
          z: number;
          hp: number;
          awareness: number;
          alive: boolean;
        }>;
        tapes: Array<{ x: number; z: number; collected: boolean }>;
        pickups: Array<{ kind: PickupKind; x: number; z: number; collected: boolean }>;
        doors: Array<{ x: number; z: number; closed: boolean; broken: boolean }>;
        desks: Array<{ x: number; z: number }>;
        exitPos: { x: number; z: number };
        jumpscare: { archetype: EntityArchetype; time: number; duration: number; signalLost: boolean } | null;
        modelsLoaded: string[];
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
      /** Last frame's renderer counters and rolling frame/CPU/GPU timings (ms, mean and p95). */
      perf: () => PerfReport;
      /** Run `frames` simulated frames back to back, waiting for the GPU after each, and time them. */
      bench: (frames?: number) => BenchReport;
      /** Have the nearest living entity of this kind land a fatal blow (death scene QA). False if there is none. */
      killBy: (archetype: EntityArchetype) => boolean;
    };
  }
}

export interface PerfReport {
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  /** Point lights in the shader light count (visible, even at intensity 0). */
  pointLights: number;
  meshes: { level: number; entities: number; pickups: number; weapon: number; fx: number };
  frameMs: { mean: number; p95: number };
  cpuMs: { mean: number; p95: number };
  gpuMs: { mean: number; p95: number } | null;
  samples: number;
}

export interface BenchReport {
  frames: number;
  drawCalls: number;
  triangles: number;
  /** Simulation + render submission per frame (CPU side only). */
  cpuMs: { mean: number; p95: number };
  /** Simulation + render + GPU completion per frame. */
  ms: { mean: number; p95: number };
}

/** FogExp2 density 0.088 leaves 0.04% of a surface visible at 32 m: anything farther was drawn for nothing. */
const FOG_DENSITY = 0.088;
const FAR_PLANE = 32;

// Light pool sources (see updateLights): fixture index >= 0, or one of these.
const LIGHT_MUZZLE = -1;
const LIGHT_EXIT = -2;
const LIGHT_TAPE_BASE = -10; // tape at pickup index i is LIGHT_TAPE_BASE - i
/** Tapes and the exit count as this much closer (squared) so they keep a light slot near the player. */
const FEATURE_LIGHT_WEIGHT = 0.35;

/** A closed door on a hunter's route costs this many steps: about the time it takes to batter one down. */
const DOOR_PATH_COST = 6;
/** Extra cost per step on a route another hunter is already using, so pairs split up and close in from two sides. */
const SHARED_ROUTE_COST = 2;
/** Half-width kept clear when shortcutting a route (entity radius plus a margin). */
const WALK_CLEARANCE = 0.45;
/** Entities push each other apart to at least this distance (centre to centre). */
const ENTITY_SPACING = 1.1;
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const GLOW_HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const GLOW_ON = new THREE.Color(1, 1, 1);
const GLOW_OFF = new THREE.Color(0, 0, 0);

/** Smooth pseudo-random shake signal: summed sines, never per-frame noise. */
function wobble(t: number, f1: number, f2: number, phase: number): number {
  return (Math.sin(t * f1 + phase) + 0.5 * Math.sin(t * f2 + phase * 1.7)) / 1.5;
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
  // Blender models (tools/blender). Each is optional: until it loads, the procedural placeholder is used.
  private readonly assets = new GameAssets(`${import.meta.env.BASE_URL}assets/models/`);
  /** Materials made for one level on top of shared model meshes; disposed with the level. */
  private levelMaterials: THREE.Material[] = [];
  private weapon!: TacticalWeaponViewmodel;

  private isSoftwareGl = false;
  private frameId = 0;
  private disposed = false;
  private lastTime = performance.now();
  // Frame measurement (debug API perf()).
  private readonly frameTimes = new SampleRing();
  private readonly cpuTimes = new SampleRing();
  private gpuTimer: GpuTimer | null = null;
  private lastDrawCalls = 0;
  private lastTriangles = 0;

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
  private hemiLight!: THREE.HemisphereLight;
  // The killer's death scene (phase 'jumpscare'); see startJumpscare.
  private jumpscare: {
    entity: BackroomsEntity;
    time: number;
    duration: number;
    reduced: boolean;
    fromPos: THREE.Vector3;
    fromQuat: THREE.Quaternion;
    /** Scene time when the static started; -1 while the clip plays. */
    signalLostAt: number;
  } | null = null;
  private signalLost = false;
  private modelsDone = 0;
  private flashlightTarget = new THREE.Object3D();
  private flashlightCone!: THREE.Mesh;
  private dustPoints!: THREE.Points;

  private exitBeaconMat!: THREE.MeshBasicMaterial;
  // The exit beacon's light is a pooled light slot; these describe it.
  private exitLightPos = new THREE.Vector3();
  private exitLightColor = 0xff3b30;
  private exitLightIntensity = 1.8;

  // Light pool selection, preallocated (no per-frame arrays or sorting).
  private readonly lightKey = new Float64Array(8);
  private readonly lightSource = new Int32Array(8);
  private lightCandidates = 0;
  private fixtureIntensity = new Float32Array(0);
  private readonly entityScratch: BackroomsEntity[] = [];

  // Render on demand outside live phases; HUD pushes only when something visible changed.
  private renderRequested = true;
  private renderedPhase: GamePhase | null = null;
  private lastHud: HudState | null = null;

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
  // Trauma-based camera shake (game-feel skill): events add trauma, it decays, shake = trauma^2.
  private trauma = 0;
  private shakeTime = 0;
  // Where the last blow came from (world position) and how visible its HUD indicator still is (0-1).
  private hitFromX = 0;
  private hitFromZ = 0;
  private hitIndicator = 0;
  private killedBy: EntityArchetype | null = null;
  // Per-fixture smoothed brightness, used when Reduce flashing is on.
  private fixtureLevels = new Float32Array(0);
  private lastLightTime = 0;
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
  private glowInstanced: THREE.InstancedMesh | null = null;
  private glowOn = new Uint8Array(0);
  private glowColorDirty = false;
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
    findPath: (from, to, throughDoors, hunterId) => this.findEntityPath(from, to, throughDoors, hunterId),
    resolveCollision: (pos, radius) =>
      resolveCircleWallCollision(pos, radius, this.level.grid, this.level.pillars, this.colliders),
    randomPointNear: (center, radiusCells) => this.randomWalkableNear(center, radiusCells),
    randomPatrolPoint: (from) => this.randomPatrolPoint(from),
  };

  private readonly entityHooks: EntityHooks = {
    onAttack: (entity, damage) => this.damagePlayer(damage, entity),
    onScreech: (entity) => entity.voice?.playScreech(entity.archetype),
    onRemoved: (entity, reason) => {
      this.director.entityRemoved(entity);
      if (reason === 'banished') {
        this.pushNotification(`${entity.label} banished by the beam. It will return.`, 'info');
      }
    },
  };

  private readonly directorActions: DirectorActions = {
    findSpawnPoint: (minDistance) => this.findSpawnPoint(minDistance),
    spawnEntity: (archetype, x, z, disguised) => {
      this.createEntity(archetype, x, z, disguised);
    },
    respawnEntity: (entity, x, z, disguised) => entity.respawn(x, z, disguised),
    failLights: (fraction) => this.failLights(fraction),
    alertAll: () => {
      for (const ent of this.entities) ent.alertTo(this.playerPos);
    },
    setThreatLevel: (level) => this.audio.setThreatLevel(level),
    easeOff: () => {
      for (const ent of this.entities) ent.calmDown();
    },
    provoke: () => {
      // The nearest wandering entity that is not already on top of the player goes to look nearby.
      let best: BackroomsEntity | null = null;
      let bestDist = Infinity;
      for (const ent of this.entities) {
        if (!ent.alive || ent.state !== 'patrol') continue;
        const d = Math.hypot(ent.position.x - this.playerPos.x, ent.position.z - this.playerPos.z);
        if (d >= 8 && d < bestDist) {
          best = ent;
          bestDist = d;
        }
      }
      const spot = best ? this.randomWalkableNear(this.playerPos, 2) : null;
      return Boolean(best && spot && best.investigatePoint(spot));
    },
  };

  // Hunters' current routes: another hunter pays a little extra to share one (see findEntityPath).
  private readonly hunterRoutes = new Map<number, { cells: number[]; time: number }>();
  private readonly pathCost = new Float32Array(MAZE_SIZE * MAZE_SIZE);
  /** Walking steps from every cell to the exit, for the HUD's exit arrow. */
  private exitField: Int16Array = new Int16Array(0);

  private notifCounter = 1;
  private notification: HudNotification | null = null;
  private notificationTimer = 0;
  private autoReloadTimer: number | null = null;
  /** Lowest low-battery warning already shown this run (100 = none yet). */
  private batteryWarnedAt = 100;
  // Camera recoil is an offset on top of the player's aim that decays back to zero (fps-shooter skill:
  // writing it into the look angle made every magazine drag the view 12 degrees up for good).
  private recoilKick = 0;
  // A click that lands in the last 0.1 s of the fire cooldown is kept and fired when the gun is ready.
  private fireQueued = false;
  // Right mouse held: aiming resumes by itself after a reload instead of needing a fresh click.
  private aimHeld = false;
  private lastNearestEntityDist = 99;
  private lastNearestEntityLabel: string | null = null;

  private keys: Record<string, boolean> = {};
  // Rebindable controls: the game reads actions (held('sprint')), never raw keys.
  private bindings: KeyBindings = { ...DEFAULT_BINDINGS };
  private keyHints: KeyHints = keyHintsFor(DEFAULT_BINDINGS);
  /** Toggle-sprint: on until pressed again or the player stops moving. */
  private sprintLatched = false;
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

    this.gpuTimer = GpuTimer.create(this.renderer.getContext());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = BASE_EXPOSURE;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2),
    );
    this.renderer.setSize(this.container.clientWidth || window.innerWidth, this.container.clientHeight || window.innerHeight);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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
    this.scene.fog = new THREE.FogExp2(0x171409, FOG_DENSITY);

    const aspect = (this.container.clientWidth || window.innerWidth) / (this.container.clientHeight || window.innerHeight);
    this.camera = new THREE.PerspectiveCamera(72, aspect, 0.04, FAR_PLANE);
    this.scene.add(this.camera);

    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = ENV_INTENSITY;
    pmremGenerator.dispose();

    this.materials = createBackroomsMaterialSet(this.renderer);
    for (const value of Object.values(this.materials)) {
      for (const m of Array.isArray(value) ? value : [value]) {
        if (m instanceof THREE.Material) this.sharedMaterials.add(m);
      }
    }

    // Deeper atmospheric fill for tense Backrooms contrast
    const hemi = new THREE.HemisphereLight(0xb8a564, 0x1a160c, HEMI_INTENSITY);
    this.scene.add(hemi);
    this.hemiLight = hemi;

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
    void this.assets
      .loadAll(() => {
        this.modelsDone++;
        this.emitHud();
      })
      .then(() => this.onAssetsLoaded());
  }

  /** Models arrived: the title backdrop is rebuilt with them; a run in progress picks them up on its next level. */
  private onAssetsLoaded(): void {
    if (this.disposed || this.assets.loadedIds.length === 0) return;
    const pistol = this.assets.instance('vm_pistol');
    if (pistol) this.weapon.setModel(pistol);
    if (this.phase === 'title') this.buildLevel(202611, this.difficulty);
    // Compile the skinned, morphing entity shaders now, so the first encounter in a run does not hitch.
    const warm = new THREE.Group();
    warm.position.y = -100; // out of sight under the floor while it waits for the compile
    for (const id of Object.values(ENTITY_MODEL)) {
      const inst = this.assets.instance(id);
      if (inst) warm.add(inst.root);
    }
    this.scene.add(warm);
    this.renderer
      .compileAsync(this.scene, this.camera)
      .catch(() => {})
      .finally(() => this.scene.remove(warm));
    this.renderRequested = true;
    this.emitHud();
  }

  /** A props.glb node (origin at its pivot), or null to keep the procedural placeholder. */
  private prop(name: string, castShadow = false): THREE.Object3D | null {
    const node = this.assets.prop(name);
    if (!node) return null;
    node.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        obj.castShadow = castShadow;
        obj.receiveShadow = true;
      }
    });
    return node;
  }

  /** Give the named meshes of a model copy their own material for this level. */
  private retexture(root: THREE.Object3D, meshName: string, material: THREE.Material): void {
    for (const mesh of findMesh(root, meshName)) mesh.material = material;
    this.levelMaterials.push(material);
  }

  private handleContextLost = (e: Event): void => {
    e.preventDefault();
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
  };

  private handleContextRestored = (): void => {
    this.lastTime = performance.now();
    this.renderRequested = true;
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
        // Model meshes share geometry (and, unless they were given their own copies, materials) with the asset cache.
        if (isAssetMesh(obj)) {
          if (obj.userData.ownMaterials) for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) queued.add(m);
          return;
        }
        if (obj instanceof THREE.InstancedMesh) queued.add(obj);
        queued.add(obj.geometry);
        for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
          if (!this.sharedMaterials.has(m)) queued.add(m);
        }
      });
    }
    for (const m of this.levelMaterials) queued.add(m);
    this.levelMaterials = [];
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
    this.lightPanelInstanced = null;
    this.doors = [];
    this.colliders = [];
    this.hideSpots = [];
    this.glowInstanced = null;
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
      // props.glb troffer (origin on the ceiling plane) when loaded, else boxes centred just under the ceiling.
      const modelFrame = this.assets.propGeometry('prop_troffer', 'troffer_frame');
      const modelLens = this.assets.propGeometry('prop_troffer', 'troffer_lens');
      const frameGeo = modelFrame ?? new THREE.BoxGeometry(0.76, 0.05, 1.38);
      const frameY = modelFrame ? WALL_HEIGHT : WALL_HEIGHT - 0.02;
      const lensY = modelLens ? WALL_HEIGHT : WALL_HEIGHT - 0.048;
      const frameInst = new THREE.InstancedMesh(frameGeo, this.materials.lightFixtureFrame, fixtures.length);
      frameInst.frustumCulled = false;

      const panelGeo = modelLens ?? new THREE.PlaneGeometry(0.66, 1.28).rotateX(Math.PI / 2);
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
      // One instanced draw for every ceiling glow (it was one mesh, and one draw call, per fixture).
      // Flicker switches an instance's colour to black (additive: adds nothing); dead fixtures collapse to a point.
      const glowInst = new THREE.InstancedMesh(glowGeo, glowMat, fixtures.length);
      glowInst.frustumCulled = false;
      this.glowOn = new Uint8Array(fixtures.length);

      fixtures.forEach((f, idx) => {
        dummy.position.set(f.x, frameY, f.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        frameInst.setMatrixAt(idx, dummy.matrix);

        dummy.position.set(f.x, lensY, f.z);
        dummy.updateMatrix();
        panelInst.setMatrixAt(idx, dummy.matrix);

        this.fixtureColorTemp.setHex(f.flickerMode === 'dead' ? 0x1d1a10 : 0xffffff);
        panelInst.setColorAt(idx, this.fixtureColorTemp);

        if (f.flickerMode === 'dead') {
          glowInst.setMatrixAt(idx, GLOW_HIDDEN);
        } else {
          dummy.position.set(f.x, WALL_HEIGHT - 0.075, f.z);
          dummy.updateMatrix();
          glowInst.setMatrixAt(idx, dummy.matrix);
        }
        glowInst.setColorAt(idx, GLOW_ON);
        this.glowOn[idx] = 1;
      });
      frameInst.instanceMatrix.needsUpdate = true;
      panelInst.instanceMatrix.needsUpdate = true;
      glowInst.instanceMatrix.needsUpdate = true;
      if (panelInst.instanceColor) panelInst.instanceColor.needsUpdate = true;
      if (glowInst.instanceColor) glowInst.instanceColor.needsUpdate = true;
      frameInst.computeBoundingSphere();
      panelInst.computeBoundingSphere();
      this.levelGroup.add(frameInst, panelInst, glowInst);
      this.lightPanelInstanced = panelInst;
      this.glowInstanced = glowInst;
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
    this.buildLandmarks();
    this.buildSigns();
    this.exitField = computeBfsDistances(this.level.grid, this.level.exitCell.gx, this.level.exitCell.gz);
    this.hunterRoutes.clear();

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
      const decor = this.prop(idx % 2 === 0 ? 'prop_fallen_tile' : 'prop_cone');
      if (decor) {
        decor.position.set(idx % 2 === 0 ? p.x + 0.65 : p.x - 0.62, 0, idx % 2 === 0 ? p.z + 0.25 : p.z + 0.52);
        decor.rotation.y = 0.35 * idx;
        this.levelGroup.add(decor);
      } else if (idx % 2 === 0) {
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

    const exitModel = this.prop('prop_exit_door', true);
    if (exitModel) {
      // Same colour switching as the procedural beacon: the model's beacon and keypad LED share exitBeaconMat.
      exitModel.rotation.y = Math.PI;
      this.exitBeaconMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
      this.levelMaterials.push(this.exitBeaconMat);
      exitModel.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (mats.some((m) => m.name === 'exit_beacon')) mesh.material = this.exitBeaconMat;
      });
      exitGroup.updateMatrix();
      this.exitLightPos.set(0, 2.5, -0.6).applyMatrix4(exitGroup.matrix);
      this.exitLightColor = 0xff3b30;
      this.exitLightIntensity = 1.8;
      exitGroup.add(exitModel);
      this.levelGroup.add(exitGroup);
      return;
    }

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


    // The beacon's light is a slot in the shared light pool (updateLights), placed here in world space.
    exitGroup.updateMatrix();
    this.exitLightPos.set(0, 2.5, -0.6).applyMatrix4(exitGroup.matrix);
    this.exitLightColor = 0xff3b30;
    this.exitLightIntensity = 1.8;

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
    );
    mergeStaticMeshes(exitGroup);
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

      const model = this.prop(
        p.kind === 'tape' ? 'prop_vhs' : p.kind === 'ammo' ? 'prop_ammo_can' : p.kind === 'battery' ? 'prop_battery' : 'prop_almond_water',
      );
      if (model && p.kind === 'tape') {
        grp.add(this.buildOfficeTable(propShadowMat, false));
        this.hideSpots.push({ x: p.x, z: p.z });
        const vhs = new THREE.Group();
        vhs.position.y = 0.92;
        this.retexture(model, 'vhs_label', new THREE.MeshStandardMaterial({
          map: this.materials.vhsLabelTex,
          emissive: new THREE.Color(0xffa020),
          emissiveIntensity: 0.32,
          roughness: 0.38,
        }));
        vhs.add(model);
        grp.add(vhs);
        rotTarget = vhs;
        baseY = 0.92;
      } else if (model) {
        const shadow = new THREE.Mesh(
          new THREE.PlaneGeometry(p.kind === 'ammo' ? 0.75 : 0.42, p.kind === 'ammo' ? 0.55 : 0.42).rotateX(-Math.PI / 2),
          propShadowMat,
        );
        shadow.position.y = 0.015;
        grp.add(shadow);
        const holder = new THREE.Group();
        holder.add(model);
        grp.add(holder);
        rotTarget = holder;
        baseY = 0;
      } else if (p.kind === 'tape') {
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

        vhs.add(shell, label, reelL, reelR);
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

    const model = this.prop(modestyPanel ? 'prop_desk_hide' : 'prop_office_table', true);
    if (model) {
      grp.add(model);
      return grp;
    }

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

  /** One distinctive prop per quadrant (vending machine, water cooler, CRT on a cart, neon sign). */
  private buildLandmarks(): void {
    const mat = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2, ...extra });
    for (const spec of this.level.landmarks) {
      const grp = new THREE.Group();
      // Footprint against the wall (m); halfWidth 0 means no collider (wall-mounted, above head height).
      let halfWidth = 0;
      let depth = 0.06;
      const model = this.prop(`lm_${spec.kind}`, spec.kind !== 'neon');
      if (model) {
        const size = { vending: [0.48, 0.8], cooler: [0.2, 0.4], crt: [0.4, 0.55], neon: [0, 0.06] }[spec.kind];
        halfWidth = size[0];
        depth = size[1];
        if (spec.kind === 'neon') {
          model.position.y = 2.25;
          this.retexture(model, 'neon_face', new THREE.MeshBasicMaterial({
            map: this.materials.neonSignTex,
            transparent: true,
            depthWrite: false,
            toneMapped: false,
          }));
        }
        grp.add(model);
      } else if (spec.kind === 'vending') {
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.9, 0.8), mat(0x6e1c18, { roughness: 0.45, metalness: 0.35 }));
        body.position.y = 0.95;
        const glass = new THREE.Mesh(
          new THREE.PlaneGeometry(0.62, 1.15),
          mat(0x1c2a30, { emissive: new THREE.Color(0x8fe3ff), emissiveIntensity: 0.85, roughness: 0.15 }),
        );
        glass.position.set(-0.08, 1.22, 0.401);
        const keypad = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.04), mat(0x2b2b2b));
        keypad.position.set(0.33, 1.2, 0.41);
        const tray = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.16, 0.05), mat(0x0d0d0d));
        tray.position.set(-0.08, 0.42, 0.41);
        grp.add(body, glass, keypad, tray);
        halfWidth = 0.48;
        depth = 0.8;
      } else if (spec.kind === 'cooler') {
        const base = new THREE.Mesh(new THREE.BoxGeometry(0.38, 1.0, 0.38), mat(0xd9d5c6, { roughness: 0.7, metalness: 0.05 }));
        base.position.y = 0.5;
        const bottle = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.16, 0.46, 18),
          mat(0x4a8fd0, {
            transparent: true,
            opacity: 0.75,
            emissive: new THREE.Color(0x2a78c8),
            emissiveIntensity: 0.55,
            roughness: 0.1,
          }),
        );
        bottle.position.y = 1.24;
        const tap = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), mat(0x2f6fb0));
        tap.position.set(0, 0.82, 0.2);
        grp.add(base, bottle, tap);
        halfWidth = 0.2;
        depth = 0.4;
      } else if (spec.kind === 'crt') {
        const cart = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.72, 0.55), mat(0x3b3a35, { metalness: 0.5, roughness: 0.5 }));
        cart.position.y = 0.36;
        const tv = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.5, 0.48), mat(0x24221d, { roughness: 0.7 }));
        tv.position.y = 0.97;
        const screen = new THREE.Mesh(
          new THREE.PlaneGeometry(0.46, 0.34),
          mat(0x0b1a10, { emissive: new THREE.Color(0x7dffa8), emissiveIntensity: 0.7, roughness: 0.2 }),
        );
        screen.position.set(0, 0.98, 0.241);
        grp.add(cart, tv, screen);
        halfWidth = 0.4;
        depth = 0.55;
      } else {
        const board = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.48, 0.06), mat(0x15120d, { roughness: 0.9 }));
        board.position.y = 2.25;
        const neon = new THREE.Mesh(
          new THREE.PlaneGeometry(1.08, 0.4),
          new THREE.MeshBasicMaterial({ map: this.materials.neonSignTex, transparent: true, depthWrite: false, toneMapped: false }),
        );
        neon.position.set(0, 2.25, 0.035);
        grp.add(board, neon);
      }
      // Flush against the wall behind it: the wall is one half-cell back along -front.
      const backX = -Math.sin(spec.rotY);
      const backZ = -Math.cos(spec.rotY);
      const cell = gridToWorld(spec.gx, spec.gz);
      const offset = CELL_SIZE / 2 - depth / 2 - 0.04;
      grp.position.set(cell.x + backX * offset, 0, cell.z + backZ * offset);
      grp.rotation.y = spec.rotY;
      // Model meshes are shared with the asset cache and must not be merged (merging disposes the originals).
      if (!model) mergeStaticMeshes(grp);
      grp.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = halfWidth > 0;
        mesh.receiveShadow = true;
        if (halfWidth > 0) this.wallRayMeshes.push(mesh);
      });
      this.levelGroup.add(grp);
      if (halfWidth > 0) {
        const wallOnZ = Math.abs(backX) < 0.5;
        this.colliders.push({
          x: grp.position.x,
          z: grp.position.z,
          halfX: wallOnZ ? halfWidth : depth / 2,
          halfZ: wallOnZ ? depth / 2 : halfWidth,
          active: true,
        });
      }
    }
  }

  /** Arrow graffiti at junctions, one draw call for all of them (mirrored ones use mirrored UVs, not scale). */
  private buildSigns(): void {
    if (this.level.signs.length === 0) return;
    const right = new THREE.PlaneGeometry(1.1, 0.55);
    const left = right.clone();
    const uv = left.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
    const grp = new THREE.Group();
    for (const s of this.level.signs) {
      const mesh = new THREE.Mesh(s.flip === 1 ? right : left, this.materials.arrowSign);
      mesh.position.set(s.x, s.y, s.z);
      mesh.rotation.y = s.rotY;
      grp.add(mesh);
    }
    mergeStaticMeshes(grp);
    right.dispose();
    left.dispose();
    this.levelGroup.add(grp);
  }

  /**
   * Point for the HUD exit arrow: the farthest cell along the walking route that is in plain sight, and the
   * distance along the route from here.
   */
  private exitRoute(): { x: number; z: number; distance: number } {
    const p = this.playerPos;
    const exit = this.level.exitPos;
    const field = this.exitField;
    let cell = worldToGrid(p.x, p.z);
    const at = (gx: number, gz: number) =>
      gx < 0 || gz < 0 || gx >= MAZE_SIZE || gz >= MAZE_SIZE ? -1 : field[gz * MAZE_SIZE + gx];
    let steps = at(cell.gx, cell.gz);
    if (steps <= 0) return { x: exit.x, z: exit.z, distance: Math.hypot(exit.x - p.x, exit.z - p.z) };
    let target: { x: number; z: number } | null = null;
    let targetSteps = steps;
    for (let k = 0; k < 8 && steps > 0; k++) {
      const next = NEIGHBOURS.find(([dx, dz]) => at(cell.gx + dx, cell.gz + dz) === steps - 1);
      if (!next) break;
      cell = { gx: cell.gx + next[0], gz: cell.gz + next[1] };
      steps--;
      const w = steps === 0 ? exit : gridToWorld(cell.gx, cell.gz);
      // Always take the first step; after that only as far as the player can see along the route.
      if (target && !hasLineOfSight(p, _vec3B.set(w.x, p.y, w.z), this.level.grid)) break;
      target = { x: w.x, z: w.z };
      targetSteps = steps;
    }
    if (!target) return { x: exit.x, z: exit.z, distance: Math.hypot(exit.x - p.x, exit.z - p.z) };
    return { x: target.x, z: target.z, distance: targetSteps * CELL_SIZE + Math.hypot(target.x - p.x, target.z - p.z) };
  }

  /**
   * Route for an entity (EntityWorld.findPath). Closed doors cost hunters DOOR_PATH_COST steps instead of being
   * walls, so a long detour is no longer always preferred over battering a door down; wanderers still treat
   * them as walls. Cells on another hunter's fresh route cost a little more, so a second hunter takes another
   * loop. The cell path is then shortcut wherever the way is clear, so entities cut across halls instead of
   * walking a staircase of cell centres.
   */
  private findEntityPath(
    from: THREE.Vector3,
    to: THREE.Vector3,
    throughDoors: boolean,
    hunterId?: number,
  ): THREE.Vector3[] | null {
    const start = worldToGrid(from.x, from.z);
    const goal = worldToGrid(to.x, to.z);
    if (start.gx === goal.gx && start.gz === goal.gz) return [new THREE.Vector3(to.x, 0, to.z)];
    const cost = this.pathCost;
    cost.fill(0);
    for (const door of this.doors) {
      if (!door.closed) continue;
      cost[door.spec.gz * MAZE_SIZE + door.spec.gx] = throughDoors ? DOOR_PATH_COST : Infinity;
    }
    if (hunterId !== undefined) {
      for (const [id, route] of this.hunterRoutes) {
        if (id === hunterId || this.elapsedSeconds - route.time > 2) continue;
        for (const c of route.cells) {
          const cx = c % MAZE_SIZE;
          const cz = (c - cx) / MAZE_SIZE;
          // Near the goal routes may meet again: that is where the player is.
          if (Math.max(Math.abs(cx - goal.gx), Math.abs(cz - goal.gz)) <= 2) continue;
          cost[c] += SHARED_ROUTE_COST;
        }
      }
    }
    const cells = findWeightedPath(this.level.grid, start.gx, start.gz, goal.gx, goal.gz, cost);
    if (!cells) return null;
    if (hunterId !== undefined) this.hunterRoutes.set(hunterId, { cells, time: this.elapsedSeconds });
    const points = cells.map((c) => {
      const cx = c % MAZE_SIZE;
      return gridToWorld(cx, (c - cx) / MAZE_SIZE);
    });
    points[points.length - 1].set(to.x, 0, to.z);
    return this.shortcutPath(from, points, throughDoors);
  }

  /** Skip waypoints while the straight walk to a later one is clear (looking at most 8 ahead). */
  private shortcutPath(from: THREE.Vector3, points: THREE.Vector3[], throughDoors: boolean): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    let anchor = from;
    let i = 0;
    while (i < points.length) {
      let j = Math.min(points.length - 1, i + 8);
      while (j > i && !this.clearWalk(anchor, points[j], throughDoors)) j--;
      out.push(points[j]);
      anchor = points[j];
      i = j + 1;
    }
    return out;
  }

  /** Is a body WALK_CLEARANCE wide free to walk straight from a to b (walls, pillars, doors, props)? */
  private clearWalk(a: THREE.Vector3, b: THREE.Vector3, throughDoors: boolean): boolean {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return true;
    const px = (-dz / len) * WALK_CLEARANCE;
    const pz = (dx / len) * WALK_CLEARANCE;
    const grid = throughDoors ? this.level.grid : this.navGrid;
    const steps = Math.ceil(len / 0.3);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      for (let o = -1; o <= 1; o++) {
        const c = worldToGrid(x + px * o, z + pz * o);
        if (isWallCell(grid, c.gx, c.gz)) return false;
      }
      for (const pillar of this.level.pillars) {
        const reach = pillar.halfWidth + WALK_CLEARANCE;
        if (Math.abs(x - pillar.x) < reach && Math.abs(z - pillar.z) < reach) return false;
      }
      for (const box of this.colliders) {
        if (!box.active) continue;
        if (Math.abs(x - box.x) < box.halfX + WALK_CLEARANCE && Math.abs(z - box.z) < box.halfZ + WALK_CLEARANCE) {
          return false;
        }
      }
    }
    return true;
  }

  /** Entities push each other apart, so a pack never merges into one body (game-ai skill: separation). */
  private separateEntities(): void {
    const list = this.entities;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive || a.isDisguised) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive || b.isDisguised) continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const d = Math.hypot(dx, dz);
        if (d >= ENTITY_SPACING) continue;
        const nx = d > 1e-4 ? dx / d : 1;
        const nz = d > 1e-4 ? dz / d : 0;
        const push = (ENTITY_SPACING - d) / 2;
        a.position.x -= nx * push;
        a.position.z -= nz * push;
        b.position.x += nx * push;
        b.position.z += nz * push;
        resolveCircleWallCollision(a.position, 0.44, this.level.grid, this.level.pillars, this.colliders);
        resolveCircleWallCollision(b.position, 0.44, this.level.grid, this.level.pillars, this.colliders);
      }
    }
  }

  private buildDoors(): void {
    const panelMat = new THREE.MeshStandardMaterial({
      color: 0x9c8e66,
      roughness: 0.7,
      metalness: 0.15,
    });
    for (const spec of this.level.doors) {
      const door = new DoorInstance(
        spec,
        { wall: this.materials.wallpaper, frame: this.materials.exitFrame, panel: panelMat },
        this.prop('prop_door', true),
      );
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
      this.assets.instance(ENTITY_MODEL[archetype]),
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
      if (cell.gx === this.level.exitCell.gx && cell.gz === this.level.exitCell.gz) continue;
      const wp = gridToWorld(cell.gx, cell.gz);
      if (this.hideSpots.some((h) => Math.hypot(h.x - wp.x, h.z - wp.z) < 1.5)) continue;
      if (this.pickups.some((pk) => !pk.collected && Math.hypot(pk.x - wp.x, pk.z - wp.z) < 1.5)) continue;
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
        if (this.glowInstanced) {
          this.glowInstanced.setMatrixAt(idx, GLOW_HIDDEN);
          this.glowInstanced.instanceMatrix.needsUpdate = true;
          this.glowOn[idx] = 0;
        }
        if (this.lightPanelInstanced) {
          this.fixtureColorTemp.setHex(0x1d1a10);
          this.lightPanelInstanced.setColorAt(idx, this.fixtureColorTemp);
          if (this.lightPanelInstanced.instanceColor) this.lightPanelInstanced.instanceColor.needsUpdate = true;
        }
      }
    }
  }

  private damagePlayer(damage: number, source?: BackroomsEntity): void {
    if (this.phase !== 'playing') return;
    this.health = Math.max(0, this.health - damage);
    this.damageTaken += damage;
    this.director.noteDamage(damage);
    this.damageFlash = 1.0;
    this.addTrauma(0.55);
    this.audio.playPlayerHurt();
    if (source) {
      // fps-shooter skill: the player must learn where damage comes from.
      this.hitFromX = source.position.x;
      this.hitFromZ = source.position.z;
      this.hitIndicator = 1;
      this.audio.playAt('claw', source.position.x, 1.3, source.position.z);
    }
    if (this.health <= 0) {
      this.killedBy = source?.archetype ?? null;
      this.clearTransientInputs();
      if (!(source && this.startJumpscare(source))) {
        this.audio.playDeathSting();
        this.finishDeath();
      }
    }
  }

  /** The results screen, after the death scene or straight away. */
  private finishDeath(): void {
    this.resetJumpscareEffects();
    this.phase = 'gameover';
    this.clearTransientInputs();
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.emitHud();
  }

  private resetJumpscareEffects(): void {
    this.jumpscare = null;
    this.signalLost = false;
    this.renderer.toneMappingExposure = BASE_EXPOSURE;
    this.hemiLight.intensity = HEMI_INTENSITY;
    this.scene.environmentIntensity = ENV_INTENSITY;
    if (this.glowInstanced) this.glowInstanced.visible = true;
    if (this.lightPanelInstanced) this.lightPanelInstanced.visible = true;
    this.audio.setJumpscare('none');
  }

  /**
   * The killer's death scene (art bible section 5). It is moved so its JS_CAM socket sits at the player's eye and
   * plays its `jumpscare` clip while the camera is handed over to that socket. False when the setting is off or
   * the killer has no model (the caller then goes straight to the results).
   */
  private startJumpscare(entity: BackroomsEntity): boolean {
    const setting = this.settings.jumpscares;
    if (setting === 'off' || !entity.hasModel) return false;
    entity.faceWorldPoint(this.camera.position.x, this.camera.position.z);
    const duration = entity.beginJumpscare();
    if (duration <= 0) return false;
    if (entity.socketWorld('JS_CAM', _jsCam)) {
      entity.position.x += this.camera.position.x - _jsCam.x;
      entity.position.z += this.camera.position.z - _jsCam.z;
    }
    this.jumpscare = {
      entity,
      time: 0,
      duration,
      reduced: setting === 'reduced',
      fromPos: this.camera.position.clone(),
      fromQuat: this.camera.quaternion.clone(),
      signalLostAt: -1,
    };
    this.phase = 'jumpscare';
    this.weapon.root.visible = false;
    this.damageFlash = 0;
    this.hitIndicator = 0;
    this.audio.setJumpscare(entity.archetype === 'smiler' ? 'silence' : 'duck');
    this.audio.playJumpscare(entity.archetype, setting === 'reduced' ? 0.5 : 1);
    this.emitHud();
    return true;
  }

  /** Any key or click after the first moments skips to the end of the death scene. */
  private skipJumpscare(): void {
    const js = this.jumpscare;
    if (js && js.signalLostAt < 0 && js.time >= JUMPSCARE_SKIP_AFTER) js.time = js.duration;
  }

  private updateJumpscare(delta: number, timeSec: number): void {
    this.audio.updateAmbient(delta, 99, false);
    const js = this.jumpscare;
    if (!js) return;
    if (js.signalLostAt >= 0) {
      if (js.time - js.signalLostAt >= SIGNAL_LOST_SECONDS) this.finishDeath();
      else js.time += delta;
      return;
    }
    if (js.time >= js.duration) {
      // The tape tears: static and SIGNAL LOST, then the results.
      js.signalLostAt = js.time;
      this.signalLost = true;
      this.audio.playDeathSting();
      this.emitHud();
      return;
    }
    js.time += delta;
    const t = js.time;
    const kind = js.entity.archetype;
    const calm = js.reduced || this.settings.reduceMotion; // no camera whip, tilt or jolt
    const noFlash = js.reduced || this.settings.reduceFlashing;
    js.entity.updateJumpscare(delta);

    // Camera: from where the player was looking to the killer's JS_CAM, aimed at its mouth.
    if (!js.entity.socketWorld('JS_CAM', _jsCam)) _jsCam.copy(js.fromPos);
    if (!js.entity.socketWorld('SOCKET_mouth', _jsLook)) js.entity.socketWorld('HIT_head', _jsLook);
    if (kind === 'smiler') _jsCam.lerp(_jsLook, 0.35 * THREE.MathUtils.smoothstep(t, 0.5, 1.2));
    // Skin-Stealer: pulled into the hole in its face at the end.
    if (kind === 'brute') _jsCam.lerp(_jsLook, 0.8 * THREE.MathUtils.smoothstep(t, js.duration - 0.5, js.duration));
    const whip = calm ? 1 : THREE.MathUtils.smoothstep(t, 0, 0.13);
    this.camera.position.lerpVectors(js.fromPos, _jsCam, whip);
    this.camera.lookAt(_jsLook);
    _jsQuat.copy(this.camera.quaternion);
    this.camera.quaternion.slerpQuaternions(js.fromQuat, _jsQuat, whip);
    if (!calm) {
      const shake = this.settings.shakeStrength;
      if (kind === 'brute') this.camera.rotateZ(THREE.MathUtils.degToRad(8) * THREE.MathUtils.smoothstep(t, 0, 0.15));
      if (kind === 'howler') {
        // The claws hit either side of the lens; the camera jolts back.
        this.camera.translateZ(0.06 * shake * Math.max(0, 1 - Math.abs(t - 0.17) / 0.08));
        if (t > 0.33 && t < 0.8) this.camera.translateX((Math.random() - 0.5) * 0.02 * shake);
      }
    }

    // Lights.
    let exposure = BASE_EXPOSURE;
    if (kind === 'smiler') {
      // Lights out: every lamp and the flashlight die at once; only its face still glows.
      const on = 1 - THREE.MathUtils.smoothstep(t, 0, 0.12);
      this.flashlight.intensity = this.flashlightOn ? 6.2 * on : 0;
      this.hemiLight.intensity = HEMI_INTENSITY * on;
      this.scene.environmentIntensity = ENV_INTENSITY * on;
      this.updateLights(timeSec);
      for (const pl of this.pooledLights) pl.intensity *= on;
      if (this.glowInstanced) this.glowInstanced.visible = on > 0;
      if (this.lightPanelInstanced) this.lightPanelInstanced.visible = on > 0;
      // Teeth fill the screen: a white flash, or a fade to black with reduced flashing.
      const end = THREE.MathUtils.smoothstep(t, js.duration - 0.15, js.duration);
      exposure = noFlash ? BASE_EXPOSURE * (1 - end) : BASE_EXPOSURE * (1 + 3 * end);
    } else {
      this.updateLights(timeSec);
      if (kind === 'howler' && js.entity.socketWorld('SOCKET_mouth', _jsSpark)) {
        // The starter deep in its throat fires twice (a steady dim glow with reduced flashing).
        const power = noFlash
          ? t > 0.33 && t < 0.8
            ? 0.8
            : 0
          : (t > 0.42 && t < 0.49) || (t > 0.58 && t < 0.65)
            ? 6
            : 0;
        if (power > 0) {
          const pl = this.pooledLights[this.pooledLights.length - 1];
          pl.position.copy(_jsSpark);
          this.setPooledLight(pl, 0xe4d4ff, power, 4, 2);
        }
      }
      if (kind === 'brute') exposure = BASE_EXPOSURE * (1 - THREE.MathUtils.smoothstep(t, js.duration - 0.3, js.duration));
    }
    this.renderer.toneMappingExposure = exposure;
  }


  private addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
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
    if (this.phase !== 'playing') return;
    const door = this.findInteractableDoor();
    if (!door) return;
    if (door.broken) {
      this.pushNotification('This door was torn off its hinges.', 'warning');
      this.emitHud();
      return;
    }
    if (!door.closed) {
      const blocked =
        door.panelOverlaps(this.playerPos.x, this.playerPos.z, 0.42) ||
        this.entities.some((e) => e.alive && door.panelOverlaps(e.position.x, e.position.z, 0.44));
      if (blocked) {
        this.pushNotification('Something is in the doorway.', 'warning');
        this.emitHud();
        return;
      }
    }
    door.toggle();
    this.onDoorChanged(door);
    this.audio.playAt(door.closed ? 'door_close' : 'door_open', door.x, 1.2, door.z);
    this.emitNoise(_vec3A.set(door.x, 0, door.z), 5);
    this.emitHud();
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
        door.bashSoundTimer = 0;
        continue;
      }
      door.bashTimer += delta;
      door.bashSoundTimer -= delta;
      if (door.bashSoundTimer <= 0) {
        door.bashSoundTimer = 0.55;
        this.audio.playAt('door_bash', door.x, 1.2, door.z, this.doorOccluded(door));
      }
      if (door.bashTimer >= (heavy ? 1.4 : 2.6)) {
        door.burstOpen();
        if (Math.hypot(door.x - this.playerPos.x, door.z - this.playerPos.z) < 8) this.addTrauma(0.3);
        this.onDoorChanged(door);
        this.audio.playAt('door_break', door.x, 1.2, door.z, this.doorOccluded(door));
        this.emitNoise(_vec3A.set(door.x, 0, door.z), 12);
      }
    }
  }

  /** A wall stands between the listener and this door (its sounds are muffled and quieter). */
  private doorOccluded(door: DoorInstance): boolean {
    return !hasLineOfSight(this.camera.position, _vec3A.set(door.x, 1.2, door.z), this.level.grid);
  }

  private clearTransientInputs(): void {
    this.keys = {};
    this.isAiming = false;
    this.aimHeld = false;
    this.sprintLatched = false;
    // A held crouch whose key-up was lost (pause, focus change) must not leave the player stuck crouching.
    if (!this.settings.crouchToggle) this.crouched = false;
    this.fireQueued = false;
    this.isDraggingLook = false;
    if (this.autoReloadTimer !== null) {
      window.clearTimeout(this.autoReloadTimer);
      this.autoReloadTimer = null;
    }
  }

  private blurFocusedControl(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }

  /** Start a run. Pass a seed to replay a layout (daily runs, "retry this layout"); omit for a fresh one. */
  public startNewGame(difficulty: DifficultyMode, seed?: number): void {
    this.audio.init();
    this.clearTransientInputs();
    this.blurFocusedControl();
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
    this.batteryWarnedAt = 100;
    this.flashlightOn = true;

    // Survival, not a shooting gallery: one spare magazine (half on Nightmare) and three small crates.
    this.ammoInMag = this.magCapacity;
    this.ammoReserve = difficulty === 'nightmare' ? 6 : 12;
    this.isReloading = false;
    this.reloadTimer = 0;
    this.fireCooldown = 0;
    this.isAiming = false;
    this.recoilKick = 0;

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
    this.crosshairSpread = 0;
    this.trauma = 0;
    this.hitIndicator = 0;
    this.killedBy = null;
    this.resetJumpscareEffects();
    this.audio.setLowHealth(0);
    this.swayX = 0;
    this.swayY = 0;
    this.footstepTimer = 0;
    this.hudEmitTimer = 0;
    this.lastNearestEntityDist = 99;
    this.lastNearestEntityLabel = null;

    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();
    this.weapon.reset();

    this.phase = 'playing';
    this.audio.setPaused(false);
    this.weapon.root.visible = true;
    this.weapon.update(0.016, false, false, false, 0, 0);
    this.updateLights(performance.now() * 0.001);
    this.renderer.render(this.scene, this.camera);
    this.pushNotification('Locate 4 VHS Data Tapes to unlock the Sector Exit.', 'info');
    this.requestLock();
    this.emitHud();
  }

  public resumeGame(): void {
    if (this.phase !== 'paused') return;
    this.audio.init();
    this.clearTransientInputs();
    this.blurFocusedControl();
    this.phase = 'playing';
    this.audio.setPaused(false);
    this.requestLock();
    this.emitHud();
  }

  public pauseGame(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    this.audio.setPaused(true);
    this.pausedAtMs = performance.now();
    this.clearTransientInputs();
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.emitHud();
  }

  public returnToTitle(): void {
    this.phase = 'title';
    this.audio.setPaused(false);
    this.clearTransientInputs();
    this.weapon.reset();
    this.weapon.root.visible = false;
    this.audio.setThreatLevel(0);
    this.notification = null;
    this.notificationTimer = 0;
    this.lastNearestEntityDist = 99;
    this.lastNearestEntityLabel = null;
    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();
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
    const requestPlain = () => {
      this.rawMouseInput = false;
      try {
        const plain: Promise<void> | undefined = el.requestPointerLock();
        plain?.catch(onFail);
      } catch {
        onFail();
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
            requestPlain();
          } else {
            onFail();
          }
        },
      );
    } catch {
      // Some browsers throw synchronously when passed an options dictionary: fall back to plain lock.
      requestPlain();
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
    // Resizing clears the canvas, so a paused frame has to be drawn again.
    this.renderRequested = true;
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
    this.clearTransientInputs();
    this.pauseGame();
  };

  private updateHiddenState(): void {
    this.hidden =
      this.crouched &&
      this.hideSpots.some((s) => Math.hypot(s.x - this.playerPos.x, s.z - this.playerPos.z) < 0.95);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.phase === 'jumpscare') {
      this.skipJumpscare();
      return;
    }
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
    const code = normalizeCode(e.code);
    this.keys[code] = true;
    const action = actionForCode(this.bindings, code);
    // Space would scroll the page; Ctrl+W-style shortcuts are why crouch defaults to C, not Ctrl.
    if (action === 'fire' || action === 'sprint') e.preventDefault();
    // Auto-repeat only keeps the key held: the pistol stays semi-automatic, toggles do not flicker.
    if (e.repeat || !action) return;
    switch (action) {
      case 'flashlight':
        this.toggleFlashlightAction();
        break;
      case 'reload':
        this.startReload();
        break;
      case 'mute':
        this.toggleMute();
        break;
      case 'crouch':
        this.setCrouched(this.settings.crouchToggle ? !this.crouched : true);
        break;
      case 'interact':
        this.interactDoor();
        break;
      case 'fire':
        this.fireWeapon();
        break;
      case 'aim':
        this.pressAim();
        break;
      case 'sprint':
        if (this.settings.sprintToggle) this.sprintLatched = !this.sprintLatched;
        break;
      default:
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const code = normalizeCode(e.code);
    this.keys[code] = false;
    if (this.phase !== 'playing') return;
    const action = actionForCode(this.bindings, code);
    if (action === 'crouch' && !this.settings.crouchToggle) this.setCrouched(false);
    if (action === 'aim' && !this.settings.aimToggle) this.releaseAim();
  };

  /** Is the key bound to this action held down right now? */
  private held(action: GameAction): boolean {
    const code = this.bindings[action];
    return code !== '' && Boolean(this.keys[code]);
  }

  private setCrouched(on: boolean): void {
    if (this.crouched === on) return;
    this.crouched = on;
    this.updateHiddenState();
    this.emitHud();
  }

  /** Aim pressed (right mouse or the aim key): hold to aim, or press to switch with Aim toggle on. */
  private pressAim(): void {
    if (this.settings.aimToggle && this.aimHeld) {
      this.releaseAim();
      return;
    }
    this.aimHeld = true;
    if (!this.isReloading) this.isAiming = true;
  }

  private releaseAim(): void {
    this.aimHeld = false;
    this.isAiming = false;
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (this.phase === 'jumpscare') {
      this.skipJumpscare();
      return;
    }
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
      this.pressAim();
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.isDraggingLook = false;
    } else if (e.button === 2 && !this.settings.aimToggle) {
      this.releaseAim();
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.phase !== 'playing') return;
    // Matched to the current zoom (fps-shooter skill), so aiming is neither faster nor slower on screen.
    const sens = 0.0022 * this.settings.sensitivity * lookScale(this.camera.fov, this.settings.fov);
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
    if (this.battery <= 0 && !this.flashlightOn) {
      this.audio.playFlashlightClick();
      this.pushNotification('Flashlight battery dead. Find batteries.', 'warning');
      this.emitHud();
      return;
    }
    this.flashlightOn = !this.flashlightOn;
    this.audio.playFlashlightClick();
    this.emitHud();
  }

  private startReload(): void {
    if (this.isReloading || this.ammoInMag >= this.magCapacity || this.ammoReserve <= 0) return;
    this.isReloading = true;
    this.reloadTimer = 1.25;
    this.isAiming = false;
    this.fireQueued = false;
    this.weapon.triggerReload(1.25);
    this.audio.playReload();
    this.emitHud();
  }

  private fireWeapon(): void {
    if (this.phase !== 'playing' || this.isReloading) return;
    if (this.fireCooldown > 0) {
      // Pressed a moment early: remember it instead of silently eating the click.
      if (this.fireCooldown <= 0.1) this.fireQueued = true;
      return;
    }
    this.fireQueued = false;

    if (this.ammoInMag <= 0) {
      this.fireCooldown = 0.2;
      this.audio.playEmptyClick();
      this.weapon.triggerEmpty();
      if (this.ammoReserve > 0) {
        this.startReload();
      } else {
        this.pushNotification('Magazine empty — find ammunition crates!', 'warning');
        this.emitHud();
      }
      return;
    }

    this.ammoInMag--;
    this.shotsFired++;
    this.fireCooldown = 0.21;
    this.crosshairSpread = Math.min(1, this.crosshairSpread + 0.55);
    this.addTrauma(0.1);
    // The shot goes where the crosshair was when the trigger was pulled: look + current recoil, without shake.
    const shotPitch = THREE.MathUtils.clamp(this.pitch + this.recoilKick, -1.45, 1.45);
    this.recoilKick = Math.min(0.08, this.recoilKick + (this.isAiming ? 0.012 : 0.018));

    this.weapon.triggerFire(this.camera);
    this.audio.playGunshot();

    // A gunshot is the loudest thing in Level 0: everything that can hear within 26 m comes to look.
    this.emitNoise(this.playerPos, 26);

    // Hitscan from the eye along the aim direction
    _dir.set(
      -Math.sin(this.yaw) * Math.cos(shotPitch),
      Math.sin(shotPitch),
      -Math.cos(this.yaw) * Math.cos(shotPitch),
    );
    this.raycaster.set(this.camera.position, _dir);
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
        const res = targetEntity.applyDamage(BULLET_DAMAGE, isHead);
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
          // Headshots get their own marker and sound; before, they only showed up in the kill message.
          const marker = res.killed ? 'kill' : res.headshot ? 'head' : 'hit';
          this.hitmarkerState = marker;
          this.hitmarkerTimer = marker === 'head' ? 0.3 : 0.22;
          this.audio.playHitmarker(marker);
          this.spawnImpactParticles(hit.point, 0x991b1b, res.headshot ? 18 : 10);
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
      if (this.autoReloadTimer !== null) window.clearTimeout(this.autoReloadTimer);
      this.autoReloadTimer = window.setTimeout(() => {
        this.autoReloadTimer = null;
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
    // Paused and results screens show a still frame: draw it once, not 60 times a second.
    const live = this.phase === 'playing' || this.phase === 'title' || this.phase === 'jumpscare';
    if (live || this.renderRequested || this.phase !== this.renderedPhase) {
      this.renderFrame();
      this.renderRequested = false;
      this.renderedPhase = this.phase;
      if (this.pendingDisposal.length > 0) {
        for (const resource of this.pendingDisposal) resource.dispose();
        this.pendingDisposal = [];
      }
    }
    this.cpuTimes.push(performance.now() - now);
    this.frameTimes.push(rawDelta * 1000);
    this.scheduleNextTick();
  }

  /** Render the scene and record its counters (and GPU time where the browser exposes timer queries). */
  private renderFrame(): void {
    this.gpuTimer?.poll();
    this.gpuTimer?.begin();
    this.renderer.render(this.scene, this.camera);
    this.gpuTimer?.end();
    this.lastDrawCalls = this.renderer.info.render.calls;
    this.lastTriangles = this.renderer.info.render.triangles;
  }

  private countVisibleMeshes(root: THREE.Object3D): number {
    let n = 0;
    root.traverseVisible((obj) => {
      if ((obj as THREE.Mesh).isMesh) n++;
    });
    return n;
  }

  private perfReport(): PerfReport {
    const info = this.renderer.info;
    let pointLights = 0;
    this.scene.traverseVisible((obj) => {
      if ((obj as THREE.PointLight).isPointLight) pointLights++;
    });
    return {
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      pointLights,
      meshes: {
        level: this.countVisibleMeshes(this.levelGroup),
        entities: this.countVisibleMeshes(this.entityGroup),
        pickups: this.countVisibleMeshes(this.pickupGroup),
        weapon: this.countVisibleMeshes(this.weapon.root),
        fx: this.countVisibleMeshes(this.fxGroup),
      },
      frameMs: this.frameTimes.summary(),
      cpuMs: this.cpuTimes.summary(),
      gpuMs: this.gpuTimer && this.gpuTimer.samples.size > 0 ? this.gpuTimer.samples.summary() : null,
      samples: this.frameTimes.size,
    };
  }

  private runBench(frames: number): BenchReport {
    const gl = this.renderer.getContext();
    const pixel = new Uint8Array(4);
    const times = new SampleRing(Math.max(1, frames));
    const cpu = new SampleRing(Math.max(1, frames));
    const dt = 1 / 60;
    let t = performance.now() * 0.001;
    for (let i = 0; i < frames; i++) {
      const start = performance.now();
      t += dt;
      this.updateScene(dt, t);
      this.renderer.render(this.scene, this.camera);
      cpu.push(performance.now() - start);
      // Reading one pixel waits for the GPU, so each sample covers simulation, submission and drawing.
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      times.push(performance.now() - start);
    }
    return {
      frames,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      cpuMs: cpu.summary(),
      ms: times.summary(),
    };
  }

  private updateScene(delta: number, timeSec: number): void {
    if (this.phase === 'title') {
      if (this.dustPoints) {
        this.dustPoints.rotation.y += delta * 0.015;
      }
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
      this.updateLights(timeSec);
      this.audio.updateAmbient(delta, 99, false);
      return;
    }

    if (this.phase === 'jumpscare') {
      this.updateJumpscare(delta, timeSec);
      return;
    }

    if (this.phase !== 'playing') {
      this.audio.updateAmbient(delta, 99, false);
      return;
    }

    // Animate dust motes subtly
    if (this.dustPoints) {
      this.dustPoints.rotation.y += delta * 0.015;
    }

    // Update impact particles (only while actively playing, frozen while paused)
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

    this.elapsedSeconds += delta;

    // Keyboard turn fallback (arrow keys; E is now the door key)
    const turnSpeed = 2.0;
    if (this.keys['ArrowLeft']) this.targetYaw += turnSpeed * delta;
    if (this.keys['ArrowRight']) this.targetYaw -= turnSpeed * delta;
    if (this.keys['ArrowUp']) this.targetPitch = Math.min(1.38, this.targetPitch + 1.4 * delta);
    if (this.keys['ArrowDown']) this.targetPitch = Math.max(-1.38, this.targetPitch - 1.4 * delta);

    // Apply look input directly: the old damping applied only ~55% of each mouse movement on the first frame,
    // which read as laggy, floaty aim.
    this.yaw = this.targetYaw;
    this.pitch = this.targetPitch;
    this.swayX = THREE.MathUtils.damp(this.swayX, 0, 10, delta);
    this.swayY = THREE.MathUtils.damp(this.swayY, 0, 10, delta);

    // Aim FOV interpolation
    const targetFov = this.isAiming ? aimFov(this.settings.fov) : this.settings.fov;
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = THREE.MathUtils.damp(this.camera.fov, targetFov, 14, delta);
      this.camera.updateProjectionMatrix();
    }

    // Player movement
    const forwardInput = (this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0);
    const strafeInput = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    const isMoving = forwardInput !== 0 || strafeInput !== 0;
    // Toggle-sprint ends when the player stops moving, like most shooters.
    if (!isMoving) this.sprintLatched = false;
    const sprintInput = this.settings.sprintToggle ? this.sprintLatched : this.held('sprint');
    const wantsSprint = sprintInput && isMoving && !this.isAiming;
    if (wantsSprint && this.crouched) this.crouched = false;
    // Hysteresis: once stamina is spent the player is winded and cannot sprint until it recovers to
    // WINDED_RECOVER_HOLDING (or WINDED_RECOVER_RELEASED after letting go of Shift). Without it, holding
    // Shift on an empty bar flipped sprint on and off every frame.
    if (
      this.winded &&
      (this.stamina >= WINDED_RECOVER_HOLDING || (!wantsSprint && this.stamina >= WINDED_RECOVER_RELEASED))
    ) {
      this.winded = false;
    }
    const isSprinting = wantsSprint && !this.winded && this.stamina > 0;

    if (isSprinting) {
      this.stamina = Math.max(0, this.stamina - 22 * delta);
      if (this.stamina <= 0) this.winded = true;
    } else {
      this.stamina = Math.min(100, this.stamina + 14 * delta);
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

    this.updateHiddenState();
    const targetEye = this.hidden ? 0.62 : this.crouched ? 1.05 : 1.68;
    this.eyeHeight = THREE.MathUtils.damp(this.eyeHeight, targetEye, 10, delta);

    // Timers & cooldowns
    if (this.fireCooldown > 0) this.fireCooldown -= delta;
    if (this.fireQueued && this.fireCooldown <= 0) this.fireWeapon();
    if (this.aimHeld && !this.isReloading && !this.isAiming) this.isAiming = true;
    // ~95% of the kick is gone after 0.43 s; 23% is still there at the next shot (0.21 s later).
    this.recoilKick = THREE.MathUtils.damp(this.recoilKick, 0, 7, delta);
    if (this.damageFlash > 0) this.damageFlash = Math.max(0, this.damageFlash - delta * 2.2);
    this.trauma = Math.max(0, this.trauma - 1.3 * delta);
    if (this.hitIndicator > 0) this.hitIndicator = Math.max(0, this.hitIndicator - delta * 0.8);
    this.audio.setLowHealth(this.health < LOW_HEALTH ? (LOW_HEALTH - this.health) / LOW_HEALTH : 0);
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
    const targetBobAmp =
      !isMoving || this.settings.reduceMotion ? 0 : this.crouched ? 0.018 : isSprinting ? 0.042 : 0.032;
    this.bobAmp = THREE.MathUtils.damp(this.bobAmp, targetBobAmp, 8, delta);
    const headBobY = Math.sin(this.bobPhase) * this.bobAmp;
    // Shake as smooth rotation (summed sines, not per-frame random jitter), scaled by the comfort setting.
    this.shakeTime += delta;
    const shake = this.trauma * this.trauma * this.settings.shakeStrength;
    const shakePitch = 0.03 * shake * wobble(this.shakeTime, 13.1, 29.3, 0.4);
    const shakeYaw = 0.03 * shake * wobble(this.shakeTime, 11.7, 23.9, 2.1);
    const shakeRoll = this.settings.reduceMotion ? 0 : 0.04 * shake * wobble(this.shakeTime, 9.3, 19.7, 4.2);
    this.camera.position.set(this.playerPos.x, this.eyeHeight + headBobY, this.playerPos.z);
    _euler.set(
      THREE.MathUtils.clamp(this.pitch + this.recoilKick + shakePitch, -1.5, 1.5),
      this.yaw + shakeYaw,
      shakeRoll,
      'YXZ',
    );
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
    let hunting = 0;
    // Iterate over a snapshot (a reused array): the director may add entities during this frame.
    const snapshot = this.entityScratch;
    snapshot.length = 0;
    for (const ent of this.entities) snapshot.push(ent);
    for (const ent of snapshot) {
      if (ent.isRemoved) continue;
      if (!ent.voice) ent.voice = this.audio.createVoice();
      ent.update(delta, this.perception, this.entityWorld, this.entityHooks);
      if (this.phase !== 'playing') return;

      // A disguised Skin-Stealer must not trip the heartbeat or the HUD readout.
      if (!ent.isThreat) continue;
      if (ent.state === 'chase') hunting++;
      const d = Math.hypot(ent.position.x - this.playerPos.x, ent.position.z - this.playerPos.z);
      if (d < nearestDist) {
        nearestDist = d;
        nearestLabel = ent.label;
      }
    }
    this.lastNearestEntityDist = nearestDist;
    this.lastNearestEntityLabel = nearestLabel;

    this.separateEntities();
    this.updateDoors(delta);
    this.director.update(delta, { hunting, nearestThreat: nearestDist });

    // Flashlight battery & eerie proximity flicker. No passive recharge: batteries are a resource.
    if (this.flashlightOn) {
      this.battery = Math.max(0, this.battery - 0.75 * delta);
      for (const level of LOW_BATTERY_WARNINGS) {
        if (this.battery <= level && this.batteryWarnedAt > level) {
          this.batteryWarnedAt = level;
          this.pushNotification(
            level <= 10
              ? `Light at ${level}%. Switch it off and find a battery.`
              : `Light at ${level}%. Spare cells have a yellow band.`,
            level <= 10 ? 'danger' : 'warning',
          );
        }
      }
      if (this.battery <= 0) {
        this.flashlightOn = false;
        this.audio.playFlashlightClick();
        this.pushNotification('Flashlight battery dead. Find batteries.', 'warning');
      }
    }

    let flashPower = this.flashlightOn ? 6.2 : 0;
    if (this.flashlightOn && nearestDist < 10.5) {
      if (this.settings.reduceFlashing) {
        flashPower *= 0.8 + 0.2 * Math.sin(timeSec * 3);
      } else {
        const flickerGate = Math.sin(timeSec * 37) * Math.cos(timeSec * 23);
        if (flickerGate > 0.45) {
          flashPower *= 0.28;
        }
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
          // Hide only the cassette so the office table remains visible as a hiding spot.
          p.rotTarget.visible = false;
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
          // The new entity arrives after the log has played, not while the player is reading it.
          const flavor = this.director.tapeCollected(this.tapesCollected, this.tapeLog?.duration ?? 0);
          if (this.tapesCollected >= this.tapesTotal) {
            this.exitUnlocked = true;
            this.exitBeaconMat.color.setHex(0x3dff88);
            this.exitLightColor = 0x3dff88;
            this.exitLightIntensity = 3.2;
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
        } else if (p.kind === 'almond_water' && this.supplyIsUseful('almond_water')) {
          p.collected = true;
          p.group.visible = false;
          const before = this.health;
          this.health = Math.min(this.maxHealth, this.health + WATER_HEAL);
          this.audio.playPickup('almond_water');
          this.pushNotification(`Almond Water consumed (+${Math.round(this.health - before)} Vitality).`, 'success');
        } else if (p.kind === 'battery' && this.supplyIsUseful('battery')) {
          p.collected = true;
          p.group.visible = false;
          const before = this.battery;
          this.battery = Math.min(100, this.battery + BATTERY_CHARGE);
          this.batteryWarnedAt = this.battery > 25 ? 100 : this.batteryWarnedAt;
          this.audio.playPickup('battery');
          this.pushNotification(`Battery swapped in (+${Math.round(this.battery - before)}% Light).`, 'success');
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
      this.clearTransientInputs();
      if (document.pointerLockElement === this.renderer.domElement) {
        document.exitPointerLock();
      }
      this.emitHud();
      return;
    }

    this.updateLights(timeSec);
    this.audio.updateAmbient(delta, nearestDist, true);

    this.hudEmitTimer -= delta;
    if (this.hudEmitTimer <= 0) {
      this.hudEmitTimer = 0.06;
      this.emitHud(null, nearestDist, nearestLabel);
    }
  }

  /**
   * Point lights are one fixed pool: ceiling fixtures, uncollected tapes, the exit beacon and the muzzle flash
   * compete for the same slots, nearest first. The number of lights never changes, so no lit shader is
   * recompiled at runtime, and every pixel pays for at most activeLightCount point lights.
   */
  private updateLights(timeSec: number): void {
    const fixtures = this.level.fixtures;
    const camPos = this.camera.position;
    const dt = Math.min(0.1, Math.max(0, timeSec - this.lastLightTime));
    this.lastLightTime = timeSec;
    if (this.fixtureLevels.length !== fixtures.length) {
      this.fixtureLevels = new Float32Array(fixtures.length).fill(1);
      this.fixtureIntensity = new Float32Array(fixtures.length);
    }
    this.lightCandidates = 0;

    // Fixture flicker brightness, panels and glows; nearby working fixtures are offered a light slot.
    let panelDirty = false;
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
        let factor = wave > 0.28 ? 0.14 : wave < -0.55 ? 0.35 : 1.0;
        if (this.settings.reduceFlashing) {
          factor = THREE.MathUtils.damp(this.fixtureLevels[i], factor, 4, dt);
          this.fixtureLevels[i] = factor;
        }
        intensity *= factor;

        if (this.lightPanelInstanced) {
          const b = 0.25 + factor * 0.75;
          this.fixtureColorTemp.setRGB(b, b * 0.96, b * 0.82);
          this.lightPanelInstanced.setColorAt(i, this.fixtureColorTemp);
          panelDirty = true;
        }
        this.setGlow(i, factor > 0.3);
      }
      this.fixtureIntensity[i] = intensity;

      const dx = f.x - camPos.x;
      const dz = f.z - camPos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < 256) this.offerLight(distSq, i);
    }
    if (panelDirty && this.lightPanelInstanced?.instanceColor) {
      this.lightPanelInstanced.instanceColor.needsUpdate = true;
    }
    if (this.glowColorDirty && this.glowInstanced?.instanceColor) {
      this.glowInstanced.instanceColor.needsUpdate = true;
      this.glowColorDirty = false;
    }

    for (let i = 0; i < this.pickups.length; i++) {
      const p = this.pickups[i];
      if (p.kind !== 'tape' || p.collected) continue;
      const distSq = (p.x - camPos.x) ** 2 + (p.z - camPos.z) ** 2;
      if (distSq < 196) this.offerLight(distSq * FEATURE_LIGHT_WEIGHT, LIGHT_TAPE_BASE - i);
    }
    const exitDistSq = (this.exitLightPos.x - camPos.x) ** 2 + (this.exitLightPos.z - camPos.z) ** 2;
    if (exitDistSq < 256) this.offerLight(exitDistSq * FEATURE_LIGHT_WEIGHT, LIGHT_EXIT);
    if (this.weapon.muzzleLightIntensity > 0) this.offerLight(-1, LIGHT_MUZZLE);

    for (let s = 0; s < this.pooledLights.length; s++) {
      const pl = this.pooledLights[s];
      if (s >= this.lightCandidates) {
        pl.intensity = 0;
        continue;
      }
      const src = this.lightSource[s];
      if (src >= 0) {
        const f = fixtures[src];
        pl.position.set(f.x, WALL_HEIGHT - 0.25, f.z);
        this.setPooledLight(pl, 0xfff0b8, this.fixtureIntensity[src], 11.5, 1.85);
      } else if (src === LIGHT_MUZZLE) {
        this.weapon.getMuzzleWorldPosition(pl.position);
        this.setPooledLight(pl, 0xffb84d, this.weapon.muzzleLightIntensity, 8, 2);
      } else if (src === LIGHT_EXIT) {
        pl.position.copy(this.exitLightPos);
        this.setPooledLight(pl, this.exitLightColor, this.exitLightIntensity, 9, 1.8);
      } else {
        const p = this.pickups[LIGHT_TAPE_BASE - src];
        pl.position.set(p.x, 1.2, p.z);
        this.setPooledLight(pl, 0xffa726, 1.35, 5.2, 1.8);
      }
    }
  }

  /** Keep the activeLightCount lowest keys, sorted, by insertion (at most 8 entries). */
  private offerLight(key: number, source: number): void {
    const n = this.activeLightCount;
    let i: number;
    if (this.lightCandidates < n) {
      i = this.lightCandidates++;
    } else {
      if (key >= this.lightKey[n - 1]) return;
      i = n - 1;
    }
    while (i > 0 && this.lightKey[i - 1] > key) {
      this.lightKey[i] = this.lightKey[i - 1];
      this.lightSource[i] = this.lightSource[i - 1];
      i--;
    }
    this.lightKey[i] = key;
    this.lightSource[i] = source;
  }

  private setPooledLight(pl: THREE.PointLight, color: number, intensity: number, distance: number, decay: number): void {
    pl.color.setHex(color);
    pl.intensity = intensity;
    pl.distance = distance;
    pl.decay = decay;
  }

  private setGlow(idx: number, on: boolean): void {
    if (!this.glowInstanced || (this.glowOn[idx] === 1) === on) return;
    this.glowOn[idx] = on ? 1 : 0;
    this.glowInstanced.setColorAt(idx, on ? GLOW_ON : GLOW_OFF);
    this.glowColorDirty = true;
  }

  /** Bearing of the last attacker relative to the view: 0 ahead, +90 right, +-180 behind (CSS-clockwise). */
  private hitBearingDeg(): number {
    const angleTo = Math.atan2(-(this.hitFromX - this.playerPos.x), -(this.hitFromZ - this.playerPos.z));
    return (Math.atan2(Math.sin(this.yaw - angleTo), Math.cos(this.yaw - angleTo)) * 180) / Math.PI;
  }

  /** Would picking this supply up now deliver most of its value? */
  private supplyIsUseful(kind: 'battery' | 'almond_water'): boolean {
    return kind === 'battery'
      ? 100 - this.battery >= BATTERY_CHARGE * AUTO_USE_FRACTION
      : this.maxHealth - this.health >= WATER_HEAL * AUTO_USE_FRACTION;
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
    if (JSON.stringify(settings.bindings) !== JSON.stringify(this.bindings)) {
      this.bindings = { ...settings.bindings };
      // One object per bindings value: the HUD diff compares it by reference.
      this.keyHints = keyHintsFor(this.bindings);
      this.guide.keyHints = this.keyHints;
    }
    this.settings = { ...settings };
    this.settingsApplied = true;
    this.audio.setVolume(settings.volume);
    this.weapon?.setMuzzleLightEnabled(!settings.reduceFlashing);
    this.guide.enabled = settings.tips;
    if (this.phase !== 'playing' && this.camera) {
      this.camera.fov = settings.fov;
      this.camera.updateProjectionMatrix();
    }
    if (qualityChanged) this.applyQuality(this.resolveQuality(settings.quality));
    this.renderRequested = true;
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
    // The light count and shadow setting are part of every lit shader's key: warm the new variants now,
    // in the background, instead of compiling them the first time each entity or prop comes into view.
    this.renderer.compileAsync(this.scene, this.camera).catch(() => {});
  }

  private buildHudSnapshot(
    webglError: string | null = null,
    nearestEntityDist = this.lastNearestEntityDist,
    nearestEntityLabel: string | null = this.lastNearestEntityLabel,
  ): HudState {
    const exitStraight = Math.hypot(this.level.exitPos.x - this.playerPos.x, this.level.exitPos.z - this.playerPos.z);
    // The arrow follows the walking route (it used to point straight through the walls at the door).
    const route = this.exitRoute();
    const exitDistanceMeters = Math.round(route.distance * 10) / 10;
    const angleToExit = Math.atan2(-(route.x - this.playerPos.x), -(route.z - this.playerPos.z));
    // Clockwise-positive relative bearing (0 ahead, +PI/2 right, -PI/2 left) to match CSS rotate().
    const exitBearingRad = Math.atan2(
      Math.sin(this.yaw - angleToExit),
      Math.cos(this.yaw - angleToExit),
    );

    let interactPrompt: string | null = null;
    if (this.phase === 'playing') {
      if (exitStraight < 3.4) {
        const remaining = this.tapesTotal - this.tapesCollected;
        interactPrompt = this.exitUnlocked
          ? 'SECTOR EXIT UNLOCKED — STEP INTO THRESHOLD'
          : `EXIT LOCKED — RECOVER ${remaining} MORE VHS ${remaining === 1 ? 'TAPE' : 'TAPES'}`;
      } else {
        const door = this.findInteractableDoor();
        if (door) {
          const key = this.keyHints.interact;
          interactPrompt = door.broken ? 'DOOR TORN OFF ITS HINGES' : door.closed ? `[${key}] OPEN DOOR` : `[${key}] CLOSE DOOR`;
        } else if (
          !this.crouched &&
          this.hideSpots.some((s) => Math.hypot(s.x - this.playerPos.x, s.z - this.playerPos.z) < 0.95)
        ) {
          interactPrompt = `[${this.keyHints.crouch}] CROUCH UNDER THE DESK TO HIDE`;
        }
        const savedSupply = this.pickups.find(
          (pk) =>
            !pk.collected &&
            (pk.kind === 'battery' || pk.kind === 'almond_water') &&
            !this.supplyIsUseful(pk.kind) &&
            Math.hypot(pk.x - this.playerPos.x, pk.z - this.playerPos.z) < 1.35,
        );
        if (!interactPrompt && savedSupply) {
          interactPrompt =
            savedSupply.kind === 'battery'
              ? `SPARE BATTERY · SAVED UNTIL LIGHT ≤ ${100 - Math.ceil(BATTERY_CHARGE * AUTO_USE_FRACTION)}%`
              : `ALMOND WATER · SAVED UNTIL VITALITY ≤ ${this.maxHealth - Math.ceil(WATER_HEAL * AUTO_USE_FRACTION)}`;
        }
      }
    }

    return {
      keyHints: this.keyHints,
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
      damageDirectionDeg: this.hitIndicator > 0 ? this.hitBearingDeg() : null,
      damageDirectionAlpha: this.hitIndicator,
      killedBy: this.killedBy,
      signalLost: this.signalLost,
      reduceFlashing: this.settings.reduceFlashing,
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
      modelsDone: this.modelsDone,
      modelsTotal: MODEL_COUNT,
      interactPrompt,
      webglError,
    };
  }

  private emitHud(
    webglError: string | null = null,
    nearestEntityDist = this.lastNearestEntityDist,
    nearestEntityLabel: string | null = this.lastNearestEntityLabel,
  ): void {
    const next = this.buildHudSnapshot(webglError, nearestEntityDist, nearestEntityLabel);
    // React re-renders the whole HUD on every push, so push only when something on screen would change.
    if (!hudChanged(this.lastHud, next)) return;
    this.lastHud = next;
    this.onHudUpdate(next);
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
        director: { intensity: this.director.intensity, pace: this.director.pace },
        entities: this.entities.map((e) => ({
          id: e.id,
          label: e.label,
          archetype: e.archetype,
          state: e.state,
          x: e.position.x,
          z: e.position.z,
          hp: e.health,
          awareness: e.awarenessLevel,
          alive: e.alive,
        })),
        tapes: this.pickups
          .filter((p) => p.kind === 'tape')
          .map((p) => ({ x: p.x, z: p.z, collected: p.collected })),
        pickups: this.pickups.map((p) => ({ kind: p.kind, x: p.x, z: p.z, collected: p.collected })),
        doors: this.doors.map((d) => ({ x: d.x, z: d.z, closed: d.closed, broken: d.broken })),
        desks: this.level.desks.map((d) => ({ x: d.x, z: d.z })),
        exitPos: { x: this.level.exitPos.x, z: this.level.exitPos.z },
        jumpscare: this.jumpscare
          ? {
              archetype: this.jumpscare.entity.archetype,
              time: this.jumpscare.time,
              duration: this.jumpscare.duration,
              signalLost: this.signalLost,
            }
          : null,
        modelsLoaded: this.assets.loadedIds,
      }),
      killBy: (archetype: EntityArchetype) => {
        if (this.phase !== 'playing') return false;
        let best: BackroomsEntity | null = null;
        let bestDist = Infinity;
        for (const e of this.entities) {
          if (e.archetype !== archetype || !e.alive) continue;
          const d = Math.hypot(e.position.x - this.playerPos.x, e.position.z - this.playerPos.z);
          if (d < bestDist) {
            best = e;
            bestDist = d;
          }
        }
        if (!best) return false;
        this.damagePlayer(this.health + 1, best);
        return true;
      },
      step: (frames: number, dt = 1 / 30) => {
        let t = performance.now() * 0.001;
        for (let i = 0; i < frames; i++) {
          t += dt;
          this.updateScene(dt, t);
        }
        this.renderer.render(this.scene, this.camera);
        if (this.pendingDisposal.length > 0) {
          for (const resource of this.pendingDisposal) resource.dispose();
          this.pendingDisposal = [];
        }
        this.emitHud();
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
        this.updateHiddenState();
        this.emitHud();
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
          resolveCircleWallCollision(cand, 0.45, this.level.grid, this.level.pillars, this.colliders);
          if (this.lineOfSight(cand, alive.position)) {
            this.hitmarkerState = 'none';
            this.hitmarkerTimer = 0;
            this.playerPos.copy(cand);
            alive.faceWorldPoint(cand.x, cand.z);
            window.__BACKROOMS_DEBUG__?.lookAtWorld(alive.position.x, 1.35, alive.position.z);
            this.updateLights(performance.now() * 0.001);
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
        resolveCircleWallCollision(cand, 0.45, this.level.grid, this.level.pillars, this.colliders);
        this.playerPos.copy(cand);
        window.__BACKROOMS_DEBUG__?.lookAtWorld(tape.x, 0.95, tape.z);
        this.updateLights(performance.now() * 0.001);
        this.renderer.render(this.scene, this.camera);
        return true;
      },
      teleportToExitUnlocked: () => {
        this.tapesCollected = this.tapesTotal;
        this.exitUnlocked = true;
        this.exitBeaconMat.color.setHex(0x3dff88);
        this.exitLightColor = 0x3dff88;
        this.exitLightIntensity = 3.6;
        this.pushNotification('All 4 VHS Tapes recovered! Sector 00 Exit is now UNLOCKED.', 'success');
        const n = this.level.exitNormal;
        this.playerPos.set(this.level.exitPos.x + n.x * 3.0, 1.68, this.level.exitPos.z + n.z * 3.0);
        window.__BACKROOMS_DEBUG__?.lookAtWorld(
          this.level.exitPos.x,
          1.4,
          this.level.exitPos.z,
        );
        this.updateLights(performance.now() * 0.001);
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
        this.camera.fov = aim ? aimFov(this.settings.fov) : this.settings.fov;
        this.camera.updateProjectionMatrix();
        this.renderer.render(this.scene, this.camera);
        this.emitHud();
      },
      triggerReload: () => {
        this.startReload();
      },
      perf: () => this.perfReport(),
      bench: (frames = 120) => this.runBench(frames),
    };
  }

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    this.clearTransientInputs();

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

    this.clearGroups();
    for (const resource of this.pendingDisposal) resource.dispose();
    this.pendingDisposal = [];

    this.weapon?.dispose();
    if (this.dustPoints) {
      this.dustPoints.geometry.dispose();
      (this.dustPoints.material as THREE.Material).dispose();
    }
    if (this.flashlightCone) {
      this.flashlightCone.geometry.dispose();
      (this.flashlightCone.material as THREE.Material).dispose();
    }
    if (this.scene?.environment) {
      this.scene.environment.dispose();
      this.scene.environment = null;
    }

    this.gpuTimer?.dispose();
    this.gpuTimer = null;
    this.audio.dispose();
    this.particleGeo.dispose();
    this.particleMats.forEach((m) => m.dispose());
    this.particleMats.clear();
    this.materials?.dispose();
    this.renderer?.dispose();
    delete window.__BACKROOMS_DEBUG__;
  }
}
