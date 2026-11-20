// Small localStorage-backed persistence: settings, best runs, daily seed and the new-player guide.
// Every access is wrapped: private browsing or a full quota must never break the game.
//
// Saved data is versioned (save-systems skill): settings and records are stored as { version, data },
// validated field by field on load, migrated forward from older formats, and never overwritten when a
// newer build has already written a newer version (e.g. an old tab left open after an update).
import { DEFAULT_BINDINGS, KeyBindings, sanitizeBindings } from './controls';
import { DifficultyMode } from './types';

export type QualityLevel = 'auto' | 'low' | 'medium' | 'high';
const QUALITY_LEVELS: readonly QualityLevel[] = ['auto', 'low', 'medium', 'high'];

export interface GameSettings {
  /** Multiplier on mouse look speed. */
  sensitivity: number;
  invertY: boolean;
  /** Master volume, 0..1. */
  volume: number;
  /** Hip-fire field of view in degrees (aiming zooms 16° tighter). */
  fov: number;
  quality: QualityLevel;
  /** Show contextual new-player tips. */
  tips: boolean;
  /** Camera shake strength, 0..1 (game-feel skill: shake must be adjustable). */
  shakeStrength: number;
  /** No head bob and no camera roll. */
  reduceMotion: boolean;
  /** Smooth light flicker, no flashlight stutter or muzzle light, softer damage flash. */
  reduceFlashing: boolean;
  /** The killer's death scene: full, reduced (no flashes or camera whip, quieter) or off. */
  jumpscares: JumpscareMode;
  /** Keyboard key per action (KeyboardEvent.code; '' = unbound). */
  bindings: KeyBindings;
  /** Press once to aim / sprint / crouch and again to stop, instead of holding the key. */
  aimToggle: boolean;
  sprintToggle: boolean;
  crouchToggle: boolean;
  /** Size of all interface text and panels (1 = 16 px base text). */
  uiScale: number;
}

/** Allowed ranges, shared with the Settings panel sliders. */
export const SETTINGS_LIMITS = {
  sensitivity: { min: 0.3, max: 3 },
  volume: { min: 0, max: 1 },
  fov: { min: 60, max: 95 },
  shakeStrength: { min: 0, max: 1 },
  uiScale: { min: 0.85, max: 1.5 },
} as const;

export const DEFAULT_SETTINGS: GameSettings = {
  sensitivity: 1,
  invertY: false,
  volume: 0.8,
  fov: 72,
  quality: 'auto',
  tips: true,
  shakeStrength: 0.75,
  reduceMotion: false,
  reduceFlashing: false,
  jumpscares: 'full',
  bindings: { ...DEFAULT_BINDINGS },
  aimToggle: false,
  sprintToggle: false,
  crouchToggle: true,
  uiScale: 1,
};

export type RunMode = 'random' | 'daily';

export type JumpscareMode = 'full' | 'reduced' | 'off';
export const JUMPSCARE_MODES: readonly JumpscareMode[] = ['full', 'reduced', 'off'];

export interface RunRecord {
  bestTime: number | null;
  escapes: number;
  deaths: number;
}

interface Envelope<T> {
  version: number;
  data: T;
}

const KEY_SETTINGS = 'level0.settings.v1';
const SETTINGS_VERSION = 1;
// Records moved to a new key when the level generator changed (seeded shuffle): daily layouts differ,
// so daily times from the old key are not carried over. Older builds keep their own key untouched.
const KEY_RECORDS_LEGACY = 'level0.records.v1';
const KEY_RECORDS = 'level0.records.v2';
// v3: the generator changed again (tapes keep their distance from the exit, landmarks, arrow signs), so daily
// layouts differ from the ones v2 dailies were set on. Best times per difficulty are kept.
const RECORDS_VERSION = 3;
const DAILY_RECORD_DAYS = 30;
const KEY_TIPS = 'level0.tips-seen.v1';
const KEY_HOWTO = 'level0.howto-seen.v1';

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: data simply won't persist */
  }
}

function isEnvelope(value: unknown): value is Envelope<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { version?: unknown }).version === 'number' &&
    'data' in value
  );
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Validate every field; anything missing, mistyped or out of range falls back to the default. */
export function sanitizeSettings(raw: unknown): GameSettings {
  const r = asObject(raw);
  const L = SETTINGS_LIMITS;
  return {
    sensitivity: clampNumber(r.sensitivity, L.sensitivity.min, L.sensitivity.max, DEFAULT_SETTINGS.sensitivity),
    invertY: typeof r.invertY === 'boolean' ? r.invertY : DEFAULT_SETTINGS.invertY,
    volume: clampNumber(r.volume, L.volume.min, L.volume.max, DEFAULT_SETTINGS.volume),
    fov: clampNumber(r.fov, L.fov.min, L.fov.max, DEFAULT_SETTINGS.fov),
    quality: QUALITY_LEVELS.includes(r.quality as QualityLevel) ? (r.quality as QualityLevel) : DEFAULT_SETTINGS.quality,
    tips: typeof r.tips === 'boolean' ? r.tips : DEFAULT_SETTINGS.tips,
    shakeStrength: clampNumber(r.shakeStrength, L.shakeStrength.min, L.shakeStrength.max, DEFAULT_SETTINGS.shakeStrength),
    reduceMotion: typeof r.reduceMotion === 'boolean' ? r.reduceMotion : DEFAULT_SETTINGS.reduceMotion,
    reduceFlashing: typeof r.reduceFlashing === 'boolean' ? r.reduceFlashing : DEFAULT_SETTINGS.reduceFlashing,
    jumpscares: JUMPSCARE_MODES.includes(r.jumpscares as JumpscareMode)
      ? (r.jumpscares as JumpscareMode)
      : DEFAULT_SETTINGS.jumpscares,
    bindings: sanitizeBindings(r.bindings),
    aimToggle: typeof r.aimToggle === 'boolean' ? r.aimToggle : DEFAULT_SETTINGS.aimToggle,
    sprintToggle: typeof r.sprintToggle === 'boolean' ? r.sprintToggle : DEFAULT_SETTINGS.sprintToggle,
    crouchToggle: typeof r.crouchToggle === 'boolean' ? r.crouchToggle : DEFAULT_SETTINGS.crouchToggle,
    uiScale: clampNumber(r.uiScale, L.uiScale.min, L.uiScale.max, DEFAULT_SETTINGS.uiScale),
  };
}

export function loadSettings(): GameSettings {
  const stored = readJson(KEY_SETTINGS);
  if (stored === null) return { ...DEFAULT_SETTINGS };
  if (!isEnvelope(stored)) return sanitizeSettings(stored); // v0: the plain object earlier builds wrote
  if (stored.version > SETTINGS_VERSION) return { ...DEFAULT_SETTINGS }; // written by a newer build
  return sanitizeSettings(stored.data);
}

export function saveSettings(settings: GameSettings): void {
  const stored = readJson(KEY_SETTINGS);
  if (isEnvelope(stored) && stored.version > SETTINGS_VERSION) return; // never clobber newer data
  writeJson(KEY_SETTINGS, { version: SETTINGS_VERSION, data: sanitizeSettings(settings) });
}

export function loadSeenTips(): Set<string> {
  const stored = readJson(KEY_TIPS);
  return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
}

export function saveSeenTips(seen: Set<string>): void {
  writeJson(KEY_TIPS, [...seen]);
}

export function resetGuide(): void {
  writeJson(KEY_TIPS, []);
  writeJson(KEY_HOWTO, false);
}

export function hasSeenHowTo(): boolean {
  return readJson(KEY_HOWTO) === true;
}

export function markHowToSeen(): void {
  writeJson(KEY_HOWTO, true);
}

/** Local calendar date, e.g. "2026-11-19". */
export function todayLabel(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Everyone gets the same layout on the same day. FNV-1a hash of the date label. */
export function dailySeed(label = todayLabel()): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function recordKey(difficulty: DifficultyMode, mode: RunMode, dateLabel: string): string {
  return mode === 'daily' ? `daily:${dateLabel}:${difficulty}` : `all:${difficulty}`;
}

function sanitizeRecord(raw: unknown): RunRecord {
  const r = asObject(raw);
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    bestTime:
      typeof r.bestTime === 'number' && Number.isFinite(r.bestTime) && r.bestTime > 0 ? r.bestTime : null,
    escapes: count(r.escapes),
    deaths: count(r.deaths),
  };
}

function sanitizeRecords(raw: unknown): Record<string, RunRecord> {
  const out: Record<string, RunRecord> = {};
  for (const [key, value] of Object.entries(asObject(raw))) {
    if (/^(all|daily:\d{4}-\d{2}-\d{2}):[a-z]+$/.test(key)) out[key] = sanitizeRecord(value);
  }
  return out;
}

/** Records plus whether this build may write them back (false when a newer build owns the data). */
function loadRecords(): { records: Record<string, RunRecord>; writable: boolean } {
  const stored = readJson(KEY_RECORDS);
  if (isEnvelope(stored)) {
    const records = sanitizeRecords(stored.data);
    if (stored.version < 3) {
      for (const key of Object.keys(records)) if (!key.startsWith('all:')) delete records[key];
    }
    return { records, writable: stored.version <= RECORDS_VERSION };
  }
  // Migrate v1: keep best times across all layouts; drop dailies, whose layouts the generator fix changed.
  const legacy = sanitizeRecords(readJson(KEY_RECORDS_LEGACY));
  const records: Record<string, RunRecord> = {};
  for (const [key, value] of Object.entries(legacy)) {
    if (key.startsWith('all:')) records[key] = value;
  }
  return { records, writable: true };
}

function saveRecords(records: Record<string, RunRecord>): void {
  const cutoff = todayLabel(new Date(Date.now() - DAILY_RECORD_DAYS * 24 * 60 * 60 * 1000));
  const kept: Record<string, RunRecord> = {};
  for (const [key, value] of Object.entries(records)) {
    const day = /^daily:(\d{4}-\d{2}-\d{2}):/.exec(key)?.[1];
    if (!day || day >= cutoff) kept[key] = value;
  }
  writeJson(KEY_RECORDS, { version: RECORDS_VERSION, data: kept });
}

export function getRecord(difficulty: DifficultyMode, mode: RunMode, dateLabel = todayLabel()): RunRecord {
  const { records } = loadRecords();
  return records[recordKey(difficulty, mode, dateLabel)] ?? { bestTime: null, escapes: 0, deaths: 0 };
}

/**
 * Store the outcome of a finished run. Escapes count toward the best time for the difficulty
 * (all modes) and, for daily runs, toward that day's board too.
 */
export function recordRun(
  difficulty: DifficultyMode,
  mode: RunMode,
  escaped: boolean,
  seconds: number,
  dateLabel = todayLabel(),
): { isNewBest: boolean; record: RunRecord } {
  const { records, writable } = loadRecords();
  const keys = [recordKey(difficulty, 'random', dateLabel)];
  if (mode === 'daily') keys.push(recordKey(difficulty, 'daily', dateLabel));
  let isNewBest = false;
  for (const key of keys) {
    const rec = records[key] ?? { bestTime: null, escapes: 0, deaths: 0 };
    if (escaped) {
      rec.escapes++;
      if (rec.bestTime === null || seconds < rec.bestTime) {
        rec.bestTime = seconds;
        if (key === keys[keys.length - 1]) isNewBest = true;
      }
    } else {
      rec.deaths++;
    }
    records[key] = rec;
  }
  if (writable) saveRecords(records);
  return { isNewBest, record: records[keys[keys.length - 1]] };
}
