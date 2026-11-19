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
}

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

/**
 * Keeps pressure on the player for the whole run: removed entities come back out of sight after a delay,
 * and every recovered tape escalates the level (lights fail, a new entity wakes, the hum grows).
 */
export class ThreatDirector {
  public threatLevel = 0;
  private readonly queue: Array<{ entity: BackroomsEntity; timer: number }> = [];

  constructor(
    private readonly difficulty: DifficultyMode,
    private readonly actions: DirectorActions,
  ) {}

  private respawnDelay(archetype: EntityArchetype): number {
    const base = RESPAWN_SECONDS[archetype] * (this.difficulty === 'nightmare' ? 0.6 : 1);
    return base * Math.max(0.35, 1 - 0.12 * this.threatLevel);
  }

  /** An entity finished dying (or was banished by light): bring it back later, somewhere else. */
  public entityRemoved(entity: BackroomsEntity): void {
    this.queue.push({ entity, timer: this.respawnDelay(entity.archetype) });
  }

  /** Returns a one-line flavor text describing the escalation, for the HUD notification. */
  public tapeCollected(tapesCollected: number): string {
    this.threatLevel = tapesCollected;
    this.actions.setThreatLevel(this.threatLevel);
    const step = ESCALATION[Math.min(ESCALATION.length, tapesCollected) - 1];
    if (!step) return '';
    this.actions.failLights(step.lights);
    const spot = this.actions.findSpawnPoint(SPAWN_MIN_DISTANCE);
    if (spot) this.actions.spawnEntity(step.spawn, spot.x, spot.z, step.spawn === 'brute');
    if (step.alertAll) this.actions.alertAll();
    return step.flavor;
  }

  public update(delta: number): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const item = this.queue[i];
      item.timer -= delta;
      if (item.timer > 0) continue;
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
