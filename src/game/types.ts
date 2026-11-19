export type GamePhase = 'title' | 'playing' | 'paused' | 'victory' | 'gameover';

export type DifficultyMode = 'standard' | 'nightmare';

export type EntityArchetype = 'howler' | 'smiler' | 'brute';

export type PickupKind = 'tape' | 'ammo' | 'almond_water';

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
  hitmarkerState: 'none' | 'hit' | 'kill';
  crosshairSpread: number;
  pointerLocked: boolean;
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
