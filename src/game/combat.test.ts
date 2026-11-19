// Time-to-kill table: every extra headshot must save a shot until all-headshots is reached
// (fps-shooter skill: "tune the table, not individual numbers"). Run with `npm test`.
import assert from 'node:assert/strict';
import { shotDamage, shotsToKill } from './combat';
import { aimFov, horizontalFov, lookScale } from './aim';
import { entityMaxHealth, isBulletImmune } from './entities';
import { EntityArchetype } from './types';

const ARCHETYPES: EntityArchetype[] = ['howler', 'smiler', 'brute'];
let failures = 0;
const rows: string[] = [];

for (const nightmare of [false, true]) {
  for (const archetype of ARCHETYPES) {
    if (isBulletImmune(archetype)) continue;
    const hp = entityMaxHealth(archetype, nightmare);
    const floor = Math.ceil(hp / shotDamage(true));
    const shots: number[] = [];
    for (let heads = 0; ; heads++) {
      shots.push(shotsToKill(hp, heads));
      if (shots[heads] <= floor) break;
    }
    rows.push(`${nightmare ? 'nightmare' : 'standard '} ${archetype.padEnd(7)} ${String(hp).padStart(3)} HP  shots by headshots: ${shots.join(' / ')}`);
    try {
      for (let k = 1; k < shots.length; k++) {
        assert.ok(
          shots[k] < shots[k - 1],
          `${archetype} (${hp} HP): headshot #${k} saves no shot (${shots[k - 1]} -> ${shots[k]})`,
        );
      }
    } catch (err) {
      failures++;
      console.error((err as Error).message);
    }
  }
}

// Aim: matched sensitivity (fps-shooter skill) - a small mouse movement sweeps the same fraction of the
// screen whether aiming or not, at every FOV the settings allow.
for (const hip of [60, 72, 95]) {
  const aim = aimFov(hip);
  const hipTurn = 0.0022 * 10; // radians for a 10 px movement at hip
  const aimTurn = hipTurn * lookScale(aim, hip);
  const deg = Math.PI / 180;
  const hipSweep = Math.tan(hipTurn) / Math.tan((hip * deg) / 2);
  const aimSweep = Math.tan(aimTurn) / Math.tan((aim * deg) / 2);
  try {
    assert.ok(aim < hip && aim > hip * 0.6, `aim FOV ${aim.toFixed(1)} for hip ${hip}`);
    assert.ok(Math.abs(aimSweep / hipSweep - 1) < 0.01, `aim sweep differs by ${((aimSweep / hipSweep - 1) * 100).toFixed(2)}%`);
  } catch (err) {
    failures++;
    console.error(`aim @${hip}: ${(err as Error).message}`);
  }
  rows.push(`FOV ${hip}° (${Math.round(horizontalFov(hip))}° horizontal) -> aiming ${aim.toFixed(1)}°, look speed x${lookScale(aim, hip).toFixed(3)}`);
}

console.log(rows.join('\n'));
if (failures > 0) {
  console.error(`\n${failures} breakpoint check(s) failed`);
  process.exit(1);
}
console.log('combat: no dead headshot breakpoints');
