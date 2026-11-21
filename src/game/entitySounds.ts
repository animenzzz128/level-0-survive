// Monster footsteps and the "spotted" sting: when to play what, and how a sound changes with distance.
// Pure logic (no Web Audio), so it runs in Node tests; audio.ts does the synthesis.
import type { EntityArchetype } from './types';

/** One footfall sound. The Smiler has no feet: its "step" is a wet drag of its tendrils. */
export type Footfall = 'howler_step' | 'howler_gallop' | 'smiler_drag' | 'brute_thud' | 'brute_drag';
export type Gait = 'walk' | 'stalk' | 'run';

/**
 * Metres between two footfalls, from the model clips (authored speed × cycle length ÷ footfalls per cycle), so the
 * sound lands with the feet: Howler walk 1.85 m/s × 26 frames = 1.6 m per stride, two footfalls; its lope is a
 * gallop, one double hit per pair of legs; the Skin-Stealer's limp is 1.45 m/s × 27 frames, a stamp and a drag.
 */
export const FOOTFALL_SPACING: Record<EntityArchetype, Record<Gait, number>> = {
  howler: { walk: 0.8, stalk: 1.17, run: 1.29 },
  smiler: { walk: 1.2, stalk: 1.5, run: 1.8 },
  brute: { walk: 0.65, stalk: 1.02, run: 1.1 },
};

/** How loud a footfall is for each gait (running is heavier). */
export const GAIT_LOUDNESS: Record<Gait, number> = { walk: 0.6, stalk: 0.8, run: 1 };

/**
 * Gait from the speed the AI asked for, relative to the archetype's own patrol and chase speeds. Chasing a
 * remembered spot (0.8 of chase speed, the Howler's `run_search` clip) is still a run; investigating (0.7) is not.
 */
export function gaitFor(speed: number, patrolSpeed: number, chaseSpeed: number): Gait {
  if (speed >= chaseSpeed * 0.75) return 'run';
  if (speed >= patrolSpeed * 1.3) return 'stalk';
  return 'walk';
}

/** Which sound the n-th footfall makes. The Skin-Stealer limps: stamp, drag, stamp, drag; it lurches on both feet. */
export function footfallSound(archetype: EntityArchetype, gait: Gait, index: number): Footfall {
  if (archetype === 'howler') return gait === 'run' ? 'howler_gallop' : 'howler_step';
  if (archetype === 'smiler') return 'smiler_drag';
  if (gait === 'run') return 'brute_thud';
  return index % 2 === 0 ? 'brute_thud' : 'brute_drag';
}

/** Counts the distance an entity covers and says when a foot lands. Standing still keeps the phase. */
export class FootfallTracker {
  private travelled = 0;
  private count = 0;

  constructor(private readonly archetype: EntityArchetype) {}

  /** `distance` moved this frame (m). Returns the footfall to play now, or null. At most one per call. */
  public advance(distance: number, gait: Gait): { sound: Footfall; loudness: number } | null {
    if (!(distance > 0)) return null;
    const spacing = FOOTFALL_SPACING[this.archetype][gait];
    this.travelled += distance;
    if (this.travelled < spacing) return null;
    // Keep the remainder, but never more than half a step: a long frame must not fire a burst of steps.
    this.travelled = Math.min(this.travelled - spacing, spacing * 0.5);
    const sound = footfallSound(this.archetype, gait, this.count++);
    return { sound, loudness: GAIT_LOUDNESS[gait] };
  }

  public reset(): void {
    this.travelled = 0;
    this.count = 0;
  }
}

/**
 * Distance cues for entity sounds, on top of the panner's level drop (inverse law, VOICE_REF_DISTANCE and
 * VOICE_ROLLOFF): far away a sound loses its treble and is mostly room, close up it is bright and dry.
 */
export const VOICE_REF_DISTANCE = 2;
export const VOICE_ROLLOFF = 1;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Level the panner leaves at distance d (Web Audio's 'inverse' model). */
export function dryLevel(d: number): number {
  const r = Math.max(d, VOICE_REF_DISTANCE);
  return VOICE_REF_DISTANCE / (VOICE_REF_DISTANCE + VOICE_ROLLOFF * (r - VOICE_REF_DISTANCE));
}

/** Low-pass cut-off (Hz) and reverb send for a source d metres away. */
export function distanceCues(d: number): { lowpass: number; wet: number } {
  const t = smoothstep(3, 28, d);
  return { lowpass: 12000 * (1 - t) + 1400 * t, wet: 0.5 / (1 + d / 9) };
}

/** The "spotted" sting is quieter when the one who spotted you is far away (you still hear it). */
export function spottedLevel(d: number): number {
  return 1 - 0.45 * smoothstep(10, 30, d);
}

/** A sound that may play at most once every `seconds`. */
export class Cooldown {
  private readyAt = -Infinity;

  constructor(private readonly seconds: number) {}

  /** True (and starts the cooldown) if the sound may play at time `now` (s). */
  public take(now: number): boolean {
    if (now < this.readyAt) return false;
    this.readyAt = now + this.seconds;
    return true;
  }

  public reset(): void {
    this.readyAt = -Infinity;
  }
}

/** Seconds between two "spotted" stings, whoever spots you (the director's "they all know" makes four at once). */
export const SPOTTED_COOLDOWN = 9;
