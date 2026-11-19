// Small localStorage-backed persistence: settings, best runs, daily seed and the new-player guide.
// Every access is wrapped: private browsing or a full quota must never break the game.
import { DifficultyMode } from './types';

export type QualityLevel = 'auto' | 'low' | 'medium' | 'high';

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
}

export const DEFAULT_SETTINGS: GameSettings = {
  sensitivity: 1,
  invertY: false,
  volume: 0.8,
  fov: 72,
  quality: 'auto',
  tips: true,
};

export type RunMode = 'random' | 'daily';

export interface RunRecord {
  bestTime: number | null;
  escapes: number;
  deaths: number;
}

const KEY_SETTINGS = 'level0.settings.v1';
const KEY_RECORDS = 'level0.records.v1';
const KEY_TIPS = 'level0.tips-seen.v1';
const KEY_HOWTO = 'level0.howto-seen.v1';

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings simply won't persist */
  }
}

export function loadSettings(): GameSettings {
  const saved = readJson<Partial<GameSettings>>(KEY_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
}

export function saveSettings(settings: GameSettings): void {
  writeJson(KEY_SETTINGS, settings);
}

export function loadSeenTips(): Set<string> {
  return new Set(readJson<string[]>(KEY_TIPS) ?? []);
}

export function saveSeenTips(seen: Set<string>): void {
  writeJson(KEY_TIPS, [...seen]);
}

export function resetGuide(): void {
  writeJson(KEY_TIPS, []);
  writeJson(KEY_HOWTO, false);
}

export function hasSeenHowTo(): boolean {
  return readJson<boolean>(KEY_HOWTO) === true;
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

export function getRecord(difficulty: DifficultyMode, mode: RunMode, dateLabel = todayLabel()): RunRecord {
  const all = readJson<Record<string, RunRecord>>(KEY_RECORDS) ?? {};
  return all[recordKey(difficulty, mode, dateLabel)] ?? { bestTime: null, escapes: 0, deaths: 0 };
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
  const all = readJson<Record<string, RunRecord>>(KEY_RECORDS) ?? {};
  const keys = [recordKey(difficulty, 'random', dateLabel)];
  if (mode === 'daily') keys.push(recordKey(difficulty, 'daily', dateLabel));
  let isNewBest = false;
  for (const key of keys) {
    const rec = all[key] ?? { bestTime: null, escapes: 0, deaths: 0 };
    if (escaped) {
      rec.escapes++;
      if (rec.bestTime === null || seconds < rec.bestTime) {
        rec.bestTime = seconds;
        if (key === keys[keys.length - 1]) isNewBest = true;
      }
    } else {
      rec.deaths++;
    }
    all[key] = rec;
  }
  writeJson(KEY_RECORDS, all);
  return { isNewBest, record: all[keys[keys.length - 1]] };
}
