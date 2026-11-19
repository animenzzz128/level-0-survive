// Director pacing: build, relief, provoked encounters and tape spawns. Run with `npm test`.
import assert from 'node:assert/strict';
import type { BackroomsEntity } from './entities';
import { DirectorActions, PEAK_INTENSITY, QUIET_LIMIT, ThreatDirector } from './director';

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

function harness() {
  const log: string[] = [];
  const actions: DirectorActions = {
    findSpawnPoint: () => ({ x: 0, z: 0 }),
    spawnEntity: (archetype) => log.push(`spawn:${archetype}`),
    respawnEntity: (entity) => log.push(`respawn:${entity.archetype}`),
    failLights: () => log.push('lights'),
    alertAll: () => log.push('alert'),
    setThreatLevel: () => {},
    easeOff: () => log.push('easeOff'),
    provoke: () => {
      log.push('provoke');
      return true;
    },
  };
  // Relief length: always the shortest (15 s) so timings are exact.
  const director = new ThreatDirector('standard', actions, () => 0);
  const run = (seconds: number, hunting = 0, nearestThreat = Infinity) => {
    for (let t = 0; t < seconds; t += 0.1) director.update(0.1, { hunting, nearestThreat });
  };
  return { director, log, run };
}

check('a close chase builds to a peak, then 15-20 s of relief with no new threats', () => {
  const { director, log, run } = harness();
  director.entityRemoved({ archetype: 'howler' } as BackroomsEntity);
  let t = 0;
  while (director.pace === 'build' && t < 60) {
    run(0.1, 1, 4);
    t += 0.1;
  }
  assert.equal(director.pace, 'relax', 'never peaked');
  assert.ok(director.intensity >= PEAK_INTENSITY);
  assert.ok(t > 8 && t < 20, `peaked after ${t.toFixed(1)} s of close chase`);
  assert.ok(log.includes('easeOff'));
  run(16);
  assert.equal(director.pace, 'build', 'relief did not end');
  run(30);
  assert.ok(log.includes('respawn:howler'), 'respawn never happened');
});

check('respawns are held during relief', () => {
  const { director, log, run } = harness();
  director.entityRemoved({ archetype: 'smiler' } as BackroomsEntity); // due after 25 s
  while (director.pace === 'build') run(0.1, 2, 3);
  const relaxStart = log.length;
  run(14.5);
  assert.equal(director.pace, 'relax');
  assert.ok(!log.slice(relaxStart).some((e) => e.startsWith('respawn')), 'respawned during relief');
  run(15);
  assert.ok(log.includes('respawn:smiler'));
});

check(`too quiet for ${QUIET_LIMIT.standard} s (after a short opening grace) provokes an encounter`, () => {
  const { log, run } = harness();
  run(QUIET_LIMIT.standard + 10);
  assert.ok(!log.includes('provoke'), 'provoked during the opening grace');
  run(15);
  assert.equal(log.filter((e) => e === 'provoke').length, 1);
  run(QUIET_LIMIT.standard);
  assert.equal(log.filter((e) => e === 'provoke').length, 2);
});

check('being hunted keeps the quiet timer at zero', () => {
  const { log, run } = harness();
  for (let i = 0; i < 20; i++) {
    run(4.5);
    run(0.5, 1, 30);
  }
  assert.ok(!log.includes('provoke'));
});

check("a tape's entity arrives after its log, not with it", () => {
  const { director, log, run } = harness();
  director.tapeCollected(1, 12);
  assert.deepEqual(log, ['lights']);
  run(13);
  assert.ok(!log.includes('spawn:howler'), 'spawned while the log was still playing');
  run(1);
  assert.ok(log.includes('spawn:howler'));
});

check('the final tape alerts everything at once', () => {
  const { director, log } = harness();
  director.tapeCollected(4, 10);
  assert.ok(log.includes('alert'));
});

if (failures > 0) {
  console.error(`${failures} director check(s) failed`);
  process.exit(1);
}
console.log('director: pacing checks passed');
