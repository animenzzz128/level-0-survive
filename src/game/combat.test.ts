// Time-to-kill table: every extra headshot must save a shot until all-headshots is reached
// (fps-shooter skill: "tune the table, not individual numbers"). Run with `npm test`.
import assert from 'node:assert/strict';
import { shotDamage, shotsToKill } from './combat';
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

console.log(rows.join('\n'));
if (failures > 0) {
  console.error(`\n${failures} breakpoint check(s) failed`);
  process.exit(1);
}
console.log('combat: no dead headshot breakpoints');
