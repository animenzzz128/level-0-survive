import assert from 'node:assert/strict';
import * as THREE from 'three';
import { hudChanged } from './hudDiff';
import { mergeStaticMeshes } from './meshMerge';
import { SampleRing } from './perf';
import { HudState } from './types';

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

check('sample ring: mean and p95 over the last N samples', () => {
  const ring = new SampleRing(100);
  for (let i = 1; i <= 100; i++) ring.push(i);
  assert.equal(ring.mean(), 50.5);
  assert.equal(ring.percentile(95), 95);
  for (let i = 0; i < 100; i++) ring.push(10); // old samples roll out
  assert.equal(ring.mean(), 10);
  assert.equal(ring.percentile(95), 10);
  assert.equal(new SampleRing().summary().p95, 0);
});

const base = {
  phase: 'playing',
  health: 80,
  elapsedSeconds: 12.2,
  damageFlash: 0,
  crosshairSpread: 0.08,
  exitBearingRad: 1,
  damageDirectionDeg: null,
  tip: null,
  tapeLog: null,
  notification: null,
} as unknown as HudState;
const withChanges = (changes: Partial<HudState>): HudState => ({ ...base, ...changes });

check('hud diff: no push when nothing visible changed', () => {
  assert.equal(hudChanged(null, base), true);
  assert.equal(hudChanged(base, withChanges({})), false);
  assert.equal(hudChanged(base, withChanges({ elapsedSeconds: 12.9 })), false, 'same whole second');
  assert.equal(hudChanged(base, withChanges({ crosshairSpread: 0.0801 })), false, 'sub-pixel spread drift');
  assert.equal(hudChanged(base, withChanges({ tip: null })), false);
});

check('hud diff: real changes always push', () => {
  assert.equal(hudChanged(base, withChanges({ elapsedSeconds: 13.01 })), true, 'timecode ticks');
  assert.equal(hudChanged(base, withChanges({ health: 79 })), true);
  assert.equal(hudChanged(base, withChanges({ phase: 'paused' })), true);
  assert.equal(hudChanged(base, withChanges({ damageFlash: 0.01 })), true, 'an effect starting');
  assert.equal(hudChanged(withChanges({ damageFlash: 0.01 }), base), true, 'an effect ending');
  assert.equal(hudChanged(base, withChanges({ exitBearingRad: 1.2 })), true);
  assert.equal(hudChanged(base, withChanges({ damageDirectionDeg: 90 })), true);
  const log = { index: 1, total: 4, text: 'abc', shownChars: 1 };
  assert.equal(hudChanged(withChanges({ tapeLog: log }), withChanges({ tapeLog: { ...log, shownChars: 2 } })), true);
  assert.equal(hudChanged(withChanges({ tapeLog: log }), withChanges({ tapeLog: { ...log } })), false);
});

check('mesh merge: one mesh per material per parent, same shape, moving pivots kept', () => {
  const red = new THREE.MeshStandardMaterial();
  const blue = new THREE.MeshStandardMaterial();
  const root = new THREE.Group();
  const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), red);
  a.position.set(2, 0, 0);
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.5), red);
  b.position.set(-2, 0, 0);
  b.scale.set(1, 3, 1);
  const c = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1), blue);
  const pivot = new THREE.Group();
  pivot.position.set(0, 5, 0);
  const d = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), red);
  const e = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), red);
  e.position.z = 3;
  const kept = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), red);
  pivot.add(d, e);
  root.add(a, b, c, pivot, kept);

  const before = new THREE.Box3().setFromObject(root);
  const removed = mergeStaticMeshes(root, new Set([kept]));
  const after = new THREE.Box3().setFromObject(root);

  assert.equal(removed, 2, 'a+b and d+e each became one mesh');
  assert.ok(root.children.includes(pivot), 'pivot group stays');
  assert.ok(root.children.includes(kept), 'kept mesh untouched');
  assert.ok(root.children.includes(c), 'single-use material untouched');
  assert.equal(pivot.children.length, 1);
  assert.ok(before.min.distanceTo(after.min) < 1e-6 && before.max.distanceTo(after.max) < 1e-6, 'same bounds');
});

if (failures > 0) {
  console.error(`${failures} perf check(s) failed`);
  process.exit(1);
}
