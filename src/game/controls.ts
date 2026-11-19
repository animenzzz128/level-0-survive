/**
 * Rebindable keyboard actions (input-systems skill): the game reads actions, never raw keys, so every key can
 * be moved, and a key bound twice is caught as a conflict. Bindings are KeyboardEvent.code values, so they
 * follow the physical key whatever the layout (WASD stays in place on AZERTY), with '' meaning unbound.
 */

export type GameAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'sprint'
  | 'crouch'
  | 'interact'
  | 'flashlight'
  | 'fire'
  | 'aim'
  | 'reload'
  | 'mute';

export type KeyBindings = Record<GameAction, string>;

/** Display order and labels for the Settings panel. */
export const ACTIONS: ReadonlyArray<{ id: GameAction; label: string }> = [
  { id: 'forward', label: 'Move forward' },
  { id: 'back', label: 'Move back' },
  { id: 'left', label: 'Move left' },
  { id: 'right', label: 'Move right' },
  { id: 'sprint', label: 'Sprint' },
  { id: 'crouch', label: 'Crouch / hide' },
  { id: 'interact', label: 'Open / close door' },
  { id: 'flashlight', label: 'Flashlight' },
  { id: 'fire', label: 'Fire (also left mouse)' },
  { id: 'aim', label: 'Aim (also right mouse)' },
  { id: 'reload', label: 'Reload' },
  { id: 'mute', label: 'Mute' },
];

export const DEFAULT_BINDINGS: KeyBindings = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  sprint: 'ShiftLeft',
  crouch: 'KeyC',
  interact: 'KeyE',
  flashlight: 'KeyF',
  fire: 'Space',
  aim: '',
  reload: 'KeyR',
  mute: 'KeyM',
};

/** Keys the game or the browser keep for themselves: pause, arrow-key look, focus and browser shortcuts. */
const RESERVED = new Set([
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Tab',
  'F1',
  'F5',
  'F11',
  'F12',
  'MetaLeft',
  'ContextMenu',
]);

export function isReservedKey(code: string): boolean {
  return RESERVED.has(normalizeCode(code));
}

/** Left and right modifiers count as the same key (either Shift sprints). */
export function normalizeCode(code: string): string {
  return code.replace(/^(Shift|Control|Alt|Meta)Right$/, '$1Left');
}

const NAMED: Record<string, string> = {
  ShiftLeft: 'Shift',
  ControlLeft: 'Ctrl',
  AltLeft: 'Alt',
  Space: 'Space',
  Enter: 'Enter',
  Backspace: 'Backspace',
  CapsLock: 'Caps',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/** Short label for a key code: KeyW -> W, Digit1 -> 1, ShiftLeft -> Shift, '' -> —. */
export function keyLabel(code: string): string {
  if (!code) return '—';
  const c = normalizeCode(code);
  if (NAMED[c]) return NAMED[c];
  const key = /^Key([A-Z])$/.exec(c);
  if (key) return key[1];
  const digit = /^Digit(\d)$/.exec(c);
  if (digit) return digit[1];
  const pad = /^Numpad(.+)$/.exec(c);
  if (pad) return `Num ${pad[1]}`;
  return c;
}

/** Validate saved bindings: unknown or reserved keys fall back to the default; a key bound twice keeps the first. */
export function sanitizeBindings(raw: unknown): KeyBindings {
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_BINDINGS };
  const used = new Set<string>();
  for (const { id } of ACTIONS) {
    const value = r[id];
    let code =
      typeof value === 'string' && (value === '' || /^[A-Za-z0-9]{1,24}$/.test(value)) && !isReservedKey(value)
        ? normalizeCode(value)
        : DEFAULT_BINDINGS[id];
    if (code && used.has(code)) code = '';
    if (code) used.add(code);
    out[id] = code;
  }
  return out;
}

/** The action bound to a key, or null. */
export function actionForCode(bindings: KeyBindings, code: string): GameAction | null {
  const c = normalizeCode(code);
  if (!c) return null;
  for (const { id } of ACTIONS) if (bindings[id] === c) return id;
  return null;
}

/**
 * Bind `action` to `code`. A key already used by another action is a conflict: the two actions swap keys, so
 * nothing is ever left with a key that does two things. Reserved keys are refused (returns null).
 */
export function rebind(
  bindings: KeyBindings,
  action: GameAction,
  code: string,
): { bindings: KeyBindings; swappedWith: GameAction | null } | null {
  if (isReservedKey(code)) return null;
  const c = normalizeCode(code);
  const next = { ...bindings };
  const other = actionForCode(bindings, c);
  if (other && other !== action) next[other] = bindings[action];
  next[action] = c;
  return { bindings: next, swappedWith: other && other !== action ? other : null };
}

/** Key names shown in the HUD, prompts and tips. One stable object per bindings value. */
export interface KeyHints {
  move: string;
  sprint: string;
  crouch: string;
  interact: string;
  flashlight: string;
  fire: string;
  aim: string;
  reload: string;
}

export function keyHintsFor(b: KeyBindings): KeyHints {
  const moveKeys = [b.forward, b.left, b.back, b.right].map(keyLabel);
  return {
    move: moveKeys.every((k) => k.length === 1) ? moveKeys.join('') : moveKeys.join('/'),
    sprint: keyLabel(b.sprint),
    crouch: keyLabel(b.crouch),
    interact: keyLabel(b.interact),
    flashlight: keyLabel(b.flashlight),
    fire: b.fire ? `LMB / ${keyLabel(b.fire)}` : 'LMB',
    aim: b.aim ? `RMB / ${keyLabel(b.aim)}` : 'RMB',
    reload: keyLabel(b.reload),
  };
}
