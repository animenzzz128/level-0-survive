import type { BackroomsEntity } from './entities';
import { DifficultyMode, EntityArchetype } from './types';

/** What the director may ask the engine to do. */
export interface DirectorActions {
  /** A walkable spot out of the player's sight, at least `minDistance` metres of path away; null if none now. */
  findSpawnPoint(minDistance: number): { x: number; z: number } | null;
  spawnEntity(archetype: EntityArchetype, x: number, z: number, disguised: boolean): void;
  respawnEntity(entity: BackroomsEntity, x: number, z: number, disguised: boolean): void;
  /** Kill or start flickering this fraction of the still-working ceiling lights. */
  failLights(fraction: number): void;
  /** Every entity learns where the player is right now. */
  alertAll(): void;
  setThreatLevel(level: number): void;
  /** Relief: hunters that have lost the player give up and wander off. */
  easeOff(): void;
  /** Too quiet for too long: send a wandering entity to look near the player. False when none could go. */
  provoke(): boolean;
}

/** What the director senses each frame. */
export interface DirectorSense {
  /** Entities chasing the player right now. */
  hunting: number;
  /** Distance to the nearest threat (m), Infinity when none. */
  nearestThreat: number;
}

export type DirectorPace = 'build' | 'relax';

interface Escalation {
  lights: number;
  spawn: EntityArchetype;
  alertAll: boolean;
  flavor: string;
}

// One step per recovered tape. Taking tapes is how the player makes the level more dangerous.
const ESCALATION: Escalation[] = [
  { lights: 0.15, spawn: 'howler', alertAll: false, flavor: 'Somewhere, something starts listening.' },
  { lights: 0.15, spawn: 'smiler', alertAll: false, flavor: 'The lights are failing.' },
  { lights: 0.2, spawn: 'brute', alertAll: false, flavor: 'Not every bottle of Almond Water is what it seems.' },
  { lights: 0.3, spawn: 'howler', alertAll: true, flavor: 'They know where you are. Run.' },
];

const RESPAWN_SECONDS: Record<EntityArchetype, number> = {
  howler: 45,
  smiler: 25,
  brute: 60,
};

const SPAWN_MIN_DISTANCE = 16;
const RETRY_SECONDS = 3;

/** Intensity at which the director backs off for a while. */
export const PEAK_INTENSITY = 0.85;
/** Relief lasts this long (s), a random length in the range. */
export const RELAX_SECONDS: readonly [number, number] = [15, 20];
/** With nothing hunting the player for this long (s), the director makes something happen. */
export const QUIET_LIMIT: Record<DifficultyMode, number> = { standard: 50, nightmare: 32 };
/** Extra quiet allowed at the start of a run, before the first provoked encounter. */
const OPENING_GRACE = 20;
/** A new tape's entity arrives this long (s) after its log has finished playing. */
const SPAWN_AFTER_LOG = 1.5;

/**
 * Paces the run (game-ai skill: an AI director). Danger builds, then eases off, then builds again:
 *
 * - Intensity rises while entities hunt the player (faster when close) and when the player is hurt, and decays
 *   when nothing is hunting. At PEAK_INTENSITY the director enters a 15-20 s relief: hunters that lost the
 *   player give up, and no respawn or new entity arrives until it ends.
 * - When nothing has hunted the player for QUIET_LIMIT seconds, it sends a wandering entity to look nearby.
 * - Every recovered tape escalates the level (lights fail, the hum grows, an entity wakes). The new entity
 *   arrives after the tape's log has played, never while the player is reading it.
 * - Removed entities come back out of sight after a delay.
 */
export class ThreatDirector {
  public threatLevel = 0;
  public intensity = 0;
  public pace: DirectorPace = 'build';
  private relaxTimer = 0;
  private quietTimer = -OPENING_GRACE;
  private readonly queue: Array<{ entity: BackroomsEntity; timer: number }> = [];
  private readonly pendingSpawns: Array<{ archetype: EntityArchetype; timer: number }> = [];

  constructor(
    private readonly difficulty: DifficultyMode,
    private readonly actions: DirectorActions,
    private readonly random: () => number = Math.random,
  ) {}

  private respawnDelay(archetype: EntityArchetype): number {
    const base = RESPAWN_SECONDS[archetype] * (this.difficulty === 'nightmare' ? 0.6 : 1);
    return base * Math.max(0.35, 1 - 0.12 * this.threatLevel);
  }

  /** An entity finished dying (or was banished by light): bring it back later, somewhere else. */
  public entityRemoved(entity: BackroomsEntity): void {
    this.queue.push({ entity, timer: this.respawnDelay(entity.archetype) });
  }

  /** The player was hurt: that is the sharpest kind of intensity. */
  public noteDamage(amount: number): void {
    this.intensity = Math.min(1, this.intensity + amount / 45);
    this.quietTimer = 0;
  }

  /**
   * Returns a one-line flavor text describing the escalation, for the HUD notification. `logSeconds` is how
   * long the tape's log stays on screen; the new entity waits for it.
   */
  public tapeCollected(tapesCollected: number, logSeconds = 0): string {
    this.threatLevel = tapesCollected;
    this.actions.setThreatLevel(this.threatLevel);
    this.intensity = Math.min(1, this.intensity + 0.1);
    const step = ESCALATION[Math.min(ESCALATION.length, tapesCollected) - 1];
    if (!step) return '';
    this.actions.failLights(step.lights);
    this.pendingSpawns.push({ archetype: step.spawn, timer: logSeconds + SPAWN_AFTER_LOG });
    if (step.alertAll) this.actions.alertAll();
    return step.flavor;
  }

  public update(delta: number, sense: DirectorSense = { hunting: 0, nearestThreat: Infinity }): void {
    // Intensity: up while hunted (more when close), down when nothing hunts. Relief drains it faster.
    if (sense.hunting > 0) {
      const closeness = sense.nearestThreat < 6 ? 1 : sense.nearestThreat < 14 ? 0.5 : 0.2;
      this.intensity = Math.min(1, this.intensity + delta * 0.07 * closeness * Math.min(3, sense.hunting));
      this.quietTimer = 0;
    } else {
      this.intensity = Math.max(0, this.intensity - delta * (this.pace === 'relax' ? 0.08 : 0.03));
      this.quietTimer += delta;
    }

    if (this.pace === 'build') {
      if (this.intensity >= PEAK_INTENSITY) {
        this.pace = 'relax';
        const [lo, hi] = RELAX_SECONDS;
        this.relaxTimer = lo + (hi - lo) * this.random();
        this.actions.easeOff();
      } else if (this.quietTimer >= QUIET_LIMIT[this.difficulty]) {
        // Try again soon if nothing could be sent (everything already busy or disguised).
        this.quietTimer = this.actions.provoke() ? 0 : QUIET_LIMIT[this.difficulty] - RETRY_SECONDS;
      }
    } else {
      this.relaxTimer -= delta;
      if (this.relaxTimer <= 0) {
        this.pace = 'build';
        this.quietTimer = 0;
      }
    }

    // New threats (tape escalations, respawns) wait out the relief.
    const holding = this.pace === 'relax';
    for (let i = this.pendingSpawns.length - 1; i >= 0; i--) {
      const item = this.pendingSpawns[i];
      item.timer -= delta;
      if (item.timer > 0 || holding) continue;
      const spot = this.actions.findSpawnPoint(SPAWN_MIN_DISTANCE);
      if (!spot) {
        item.timer = RETRY_SECONDS;
        continue;
      }
      this.actions.spawnEntity(item.archetype, spot.x, spot.z, item.archetype === 'brute');
      this.pendingSpawns.splice(i, 1);
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const item = this.queue[i];
      item.timer -= delta;
      if (item.timer > 0 || holding) continue;
      const spot = this.actions.findSpawnPoint(SPAWN_MIN_DISTANCE);
      if (!spot) {
        item.timer = RETRY_SECONDS;
        continue;
      }
      this.actions.respawnEntity(item.entity, spot.x, spot.z, item.entity.archetype === 'brute');
      this.queue.splice(i, 1);
    }
  }
}
