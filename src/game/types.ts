export type GamePhase = 'title' | 'playing' | 'paused' | 'victory' | 'gameover';

export type DifficultyMode = 'standard' | 'nightmare';

export type EntityArchetype = 'howler' | 'smiler' | 'brute';

export type PickupKind = 'tape' | 'ammo' | 'almond_water' | 'battery';

export type EntityState =
  | 'patrol'
  | 'investigate'
  | 'chase'
  | 'search'
  | 'stagger'
  | 'retreat'
  | 'disguised'
  | 'dying'
  | 'removed';

export interface HudNotification {
  id: number;
  text: string;
  tone: 'info' | 'warning' | 'success' | 'danger';
}

/** A contextual new-player tip. */
export interface HudTip {
  id: string;
  title: string;
  text: string;
}

/** A recovered VHS tape playing back its log, typed out over a few seconds. */
export interface HudTapeLog {
  index: number;
  total: number;
  text: string;
  shownChars: number;
}

export interface HudState {
  phase: GamePhase;
  difficulty: DifficultyMode;
  health: number;
  maxHealth: number;
  stamina: number;
  /** Stamina ran out: no sprinting until it recovers to 35%. */
  winded: boolean;
  battery: number;
  flashlightOn: boolean;
  ammoInMag: number;
  magCapacity: number;
  ammoReserve: number;
  isReloading: boolean;
  isAiming: boolean;
  tapesCollected: number;
  tapesTotal: number;
  exitUnlocked: boolean;
  exitDistanceMeters: number;
  exitBearingRad: number;
  nearestEntityDist: number;
  nearestEntityLabel: string | null;
  elapsedSeconds: number;
  kills: number;
  shotsFired: number;
  shotsHit: number;
  damageTaken: number;
  damageFlash: number;
  /** Direction of the last blow relative to the view (0 ahead, +90 right, +-180 behind); null when faded. */
  damageDirectionDeg: number | null;
  damageDirectionAlpha: number;
  /** What ended the run (results screen). */
  killedBy: EntityArchetype | null;
  reduceFlashing: boolean;
  hitmarkerState: 'none' | 'hit' | 'head' | 'kill' | 'immune';
  crosshairSpread: number;
  pointerLocked: boolean;
  /** Pointer lock was refused and has never worked in this page (e.g. sandboxed iframe). */
  pointerLockBlocked: boolean;
  crouched: boolean;
  /** Crouched under a desk: entities cannot see the player unless right next to them. */
  hidden: boolean;
  /** Director escalation level, 0 at start, +1 per recovered tape. */
  threatLevel: number;
  muted: boolean;
  notification: HudNotification | null;
  tip: HudTip | null;
  tapeLog: HudTapeLog | null;
  /** Layout seed of the current run (shown on the results screen; replayable). */
  seed: number;
  interactPrompt: string | null;
  webglError: string | null;
}

export interface GameConfig {
  difficulty: DifficultyMode;
  sensitivity: number;
  muted: boolean;
}
