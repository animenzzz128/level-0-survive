// Entity fairness: a reaction window before a chase, a telegraphed first blow that can be dodged, and one
// stagger per burst of fire. Runs headless in Node (no rendering). Run with `npm test`.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BackroomsEntity, EntityHooks, EntityTextureBundle, EntityWorld, PlayerPerception } from './entities';
import { EntityArchetype } from './types';

const textures = {
  smilerFace: new THREE.MeshBasicMaterial(),
  smilerHaloTex: new THREE.Texture(),
  softShadowTex: new THREE.Texture(),
  howlerBodyTex: new THREE.Texture(),
  howlerNormalTex: new THREE.Texture(),
  bruteSkinTex: new THREE.Texture(),
  bruteNormalTex: new THREE.Texture(),
} as unknown as EntityTextureBundle;

// Open floor: always in sight, straight-line steps, no walls.
const world: EntityWorld = {
  lineOfSight: () => true,
  nextStepToward: (_from, to) => to.clone(),
  resolveCollision: () => {},
  randomPointNear: (center) => center.clone(),
  randomPatrolPoint: () => null,
};

const DT = 1 / 60;

function scenario(archetype: EntityArchetype, playerZ: number, opts: Partial<PlayerPerception> = {}) {
  const entity = new BackroomsEntity(1, archetype, 0, 0, textures, false);
  entity.faceWorldPoint(0, playerZ); // looking straight at the player
  const player: PlayerPerception = {
    pos: new THREE.Vector3(0, 1.68, playerZ),
    forwardX: 0,
    forwardZ: -1,
    flashlightOn: true,
    crouched: false,
    hidden: false,
    ...opts,
  };
  const log = { time: 0, attacks: [] as number[], firstChase: -1 };
  const hooks: EntityHooks = {
    onAttack: () => log.attacks.push(log.time),
    onScreech: () => {},
    onRemoved: () => {},
  };
  const step = (seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds; t += DT) {
      entity.update(DT, player, world, hooks);
      log.time += DT;
      if (log.firstChase < 0 && entity.state === 'chase') log.firstChase = log.time;
      each?.();
    }
  };
  return { entity, player, log, step };
}

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    failures++;
    console.error(`${name}: ${(err as Error).message}`);
  }
}

const timings: string[] = [];

check('no instant spot at range: a reaction window, then a chase', () => {
  const s = scenario('brute', 10);
  s.step(0.15);
  assert.notEqual(s.entity.state, 'chase', 'chased within 0.15 s at 10 m');
  s.step(3);
  assert.ok(s.log.firstChase > 0.15 && s.log.firstChase < 3, `first chase at ${s.log.firstChase.toFixed(2)} s`);
  timings.push(`Skin-Stealer at 10 m, standing: chase after ${s.log.firstChase.toFixed(2)} s`);
});

check('crouching makes detection slower', () => {
  const standing = scenario('brute', 8);
  standing.step(4);
  const crouched = scenario('brute', 8, { crouched: true });
  crouched.step(4);
  assert.ok(crouched.log.firstChase < 0 || crouched.log.firstChase > standing.log.firstChase);
  timings.push(
    `Skin-Stealer at 8 m: standing ${standing.log.firstChase.toFixed(2)} s, crouched ${
      crouched.log.firstChase < 0 ? 'not spotted in 4 s' : `${crouched.log.firstChase.toFixed(2)} s`
    }`,
  );
});

check('a Smiler in the dark gives a window before it hunts', () => {
  const s = scenario('smiler', 18, { flashlightOn: false });
  s.step(0.4);
  assert.notEqual(s.entity.state, 'chase', 'Smiler chased within 0.4 s at 18 m');
  s.step(4);
  assert.ok(s.log.firstChase > 0.4, 'Smiler never noticed the player');
  timings.push(`Smiler at 18 m, light off: chase after ${s.log.firstChase.toFixed(2)} s`);
});

check("arm's reach: chase at once, but the first blow waits for the delay plus a wind-up", () => {
  const s = scenario('howler', 1.5);
  s.step(DT);
  assert.equal(s.entity.state, 'chase');
  s.step(2);
  assert.ok(s.log.attacks.length > 0, 'never attacked');
  assert.ok(s.log.attacks[0] >= 0.45 + 0.3 - 0.02, `first blow at ${s.log.attacks[0].toFixed(2)} s`);
  timings.push(`Howler at 1.5 m: first blow at ${s.log.attacks[0].toFixed(2)} s (was the first frame)`);
});

check('backing off during the wind-up dodges the blow', () => {
  const s = scenario('howler', 1.5);
  let dodged = false;
  s.step(1.2, () => {
    if (!dodged && s.entity.isWindingUp) {
      s.player.pos.z += 2.5; // step back out of reach
      dodged = true;
    }
  });
  assert.ok(dodged, 'never wound up');
  assert.equal(s.log.attacks.length, 0, 'the blow landed anyway');
});

check('only the first hit in a burst staggers', () => {
  const s = scenario('brute', 6);
  s.step(0.1);
  s.entity.applyDamage(10, false);
  assert.equal(s.entity.state, 'stagger', 'first hit did not stagger');
  s.step(0.3);
  assert.notEqual(s.entity.state, 'stagger');
  s.entity.applyDamage(10, false);
  assert.notEqual(s.entity.state, 'stagger', 'second hit 0.3 s later staggered again');
  s.step(0.6);
  s.entity.applyDamage(10, false);
  assert.equal(s.entity.state, 'stagger', 'a hit after the cooldown should stagger');
});

console.log(timings.join('\n'));
if (failures > 0) {
  console.error(`\n${failures} entity check(s) failed`);
  process.exit(1);
}
console.log('entities: reaction window, telegraphed blows and stagger cooldown checks passed');
