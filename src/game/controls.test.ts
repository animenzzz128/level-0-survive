// Rebindable controls: labels, conflicts, reserved keys and saved-data validation. Run with `npm test`.
import assert from 'node:assert/strict';
import {
  DEFAULT_BINDINGS,
  actionForCode,
  keyHintsFor,
  keyLabel,
  normalizeCode,
  rebind,
  sanitizeBindings,
} from './controls';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${(err as Error).message}`);
  }
}

check('key labels', () => {
  assert.equal(keyLabel('KeyW'), 'W');
  assert.equal(keyLabel('Digit3'), '3');
  assert.equal(keyLabel('ShiftRight'), 'Shift');
  assert.equal(keyLabel('ControlLeft'), 'Ctrl');
  assert.equal(keyLabel('Numpad5'), 'Num 5');
  assert.equal(keyLabel(''), '—');
  assert.equal(normalizeCode('AltRight'), 'AltLeft');
});

check('either Shift sprints; unbound keys do nothing', () => {
  assert.equal(actionForCode(DEFAULT_BINDINGS, 'ShiftRight'), 'sprint');
  assert.equal(actionForCode(DEFAULT_BINDINGS, 'KeyQ'), null);
  assert.equal(actionForCode(DEFAULT_BINDINGS, ''), null);
});

check('binding a key that is already used swaps the two actions', () => {
  const result = rebind(DEFAULT_BINDINGS, 'reload', 'KeyF')!;
  assert.equal(result.swappedWith, 'flashlight');
  assert.equal(result.bindings.reload, 'KeyF');
  assert.equal(result.bindings.flashlight, 'KeyR');
  const values = Object.values(result.bindings).filter(Boolean);
  assert.equal(new Set(values).size, values.length, 'a key is bound twice');
});

check('reserved keys are refused', () => {
  assert.equal(rebind(DEFAULT_BINDINGS, 'fire', 'Escape'), null);
  assert.equal(rebind(DEFAULT_BINDINGS, 'forward', 'ArrowUp'), null);
});

check('saved bindings are validated: junk falls back, duplicates are dropped', () => {
  const b = sanitizeBindings({ forward: 'KeyZ', back: 'KeyZ', fire: 'Escape', reload: 42, aim: 'KeyQ', left: 'ShiftRight' });
  assert.equal(b.forward, 'KeyZ');
  assert.equal(b.back, '', 'second use of Z unbound');
  assert.equal(b.fire, DEFAULT_BINDINGS.fire, 'reserved key replaced by the default');
  assert.equal(b.reload, DEFAULT_BINDINGS.reload);
  assert.equal(b.aim, 'KeyQ');
  assert.equal(b.left, 'ShiftLeft');
  assert.equal(b.sprint, '', 'Shift already taken by move left');
  assert.deepEqual(sanitizeBindings(null), DEFAULT_BINDINGS);
});

check('HUD key hints follow the bindings (AZERTY players get ZQSD)', () => {
  assert.equal(keyHintsFor(DEFAULT_BINDINGS).move, 'WASD');
  const azerty = { ...DEFAULT_BINDINGS, forward: 'KeyZ', left: 'KeyQ' };
  assert.equal(keyHintsFor(azerty).move, 'ZQSD');
  assert.equal(keyHintsFor(DEFAULT_BINDINGS).fire, 'LMB / Space');
  assert.equal(keyHintsFor(DEFAULT_BINDINGS).aim, 'RMB');
  assert.equal(keyHintsFor({ ...DEFAULT_BINDINGS, aim: 'KeyQ' }).aim, 'RMB / Q');
});

if (failures > 0) {
  console.error(`${failures} controls check(s) failed`);
  process.exit(1);
}
console.log('controls: rebinding checks passed');
