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

export interface HudState {
  phase: GamePhase;
  difficulty: DifficultyMode;
  health: number;
  maxHealth: number;
  stamina: number;
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
  hitmarkerState: 'none' | 'hit' | 'kill' | 'immune';
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
  interactPrompt: string | null;
  webglError: string | null;
}

export interface GameConfig {
  difficulty: DifficultyMode;
  sensitivity: number;
  muted: boolean;
}
