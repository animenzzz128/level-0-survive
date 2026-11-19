import { HudState, HudTapeLog, HudTip } from './types';

/**
 * Values that drift every frame while something animates. Changes smaller than these steps are invisible on
 * screen, so they do not justify re-rendering the whole React HUD.
 */
const STEPS: Partial<Record<keyof HudState, number>> = {
  damageFlash: 0.02,
  damageDirectionAlpha: 0.02,
  crosshairSpread: 0.005,
  exitBearingRad: 0.004,
};

function near(a: number, b: number, step: number): boolean {
  if (a === b) return true;
  // Reaching or leaving zero always shows (an effect switching on or off).
  if (a === 0 || b === 0) return false;
  return Math.abs(a - b) < step;
}

function sameTip(a: HudTip | null, b: HudTip | null): boolean {
  return a === b || (a !== null && b !== null && a.id === b.id);
}

function sameTapeLog(a: HudTapeLog | null, b: HudTapeLog | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.index === b.index &&
      a.total === b.total &&
      a.shownChars === b.shownChars &&
      a.text === b.text)
  );
}

/** Would the HUD look any different with `next` than with the last state it was given? */
export function hudChanged(prev: HudState | null, next: HudState): boolean {
  if (!prev) return true;
  for (const key of Object.keys(next) as Array<keyof HudState>) {
    const a = prev[key];
    const b = next[key];
    if (a === b) continue;
    switch (key) {
      case 'elapsedSeconds':
        // The timecode shows whole seconds; phase changes carry the exact time with them.
        if (Math.floor(a as number) !== Math.floor(b as number)) return true;
        continue;
      case 'damageDirectionDeg':
        if (a === null || b === null || Math.round(a as number) !== Math.round(b as number)) return true;
        continue;
      case 'tip':
        if (!sameTip(a as HudTip | null, b as HudTip | null)) return true;
        continue;
      case 'tapeLog':
        if (!sameTapeLog(a as HudTapeLog | null, b as HudTapeLog | null)) return true;
        continue;
      default: {
        const step = STEPS[key];
        if (step !== undefined && typeof a === 'number' && typeof b === 'number' && near(a, b, step)) continue;
        return true;
      }
    }
  }
  return false;
}
