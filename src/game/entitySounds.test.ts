// Monster footsteps and the "spotted" sting: footfalls keep time with the stride, each creature sounds like itself,
// far sounds are duller and more reverberant than near ones, and the sting can't stack. Run with `npm test`.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BackroomsEntity, EntityHooks, EntityTextureBundle, EntityVoice, EntityWorld, PlayerPerception } from './entities';
import {
  Cooldown,
  distanceCues,
  dryLevel,
  FOOTFALL_SPACING,
  FootfallTracker,
  footfallSound,
  gaitFor,
  SPOTTED_COOLDOWN,
  spottedLevel,
  type Footfall,
} from './entitySounds';
import { EntityArchetype } from './types';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    failures++;
    console.error(`${name}: ${(err as Error).message}`);
  }
}

/** Walk `metres` in steps of `perFrame` m and collect the footfalls. */
function walk(archetype: EntityArchetype, gait: 'walk' | 'stalk' | 'run', metres: number, perFrame = 0.05): Footfall[] {
  const t = new FootfallTracker(archetype);
  const out: Footfall[] = [];
  for (let d = 0; d < metres - 1e-9; d += perFrame) {
    const f = t.advance(perFrame, gait);
    if (f) out.push(f.sound);
  }
  return out;
}

check('footfalls are spaced by the stride, whatever the frame rate', () => {
  for (const archetype of ['howler', 'smiler', 'brute'] as const) {
    for (const gait of ['walk', 'stalk', 'run'] as const) {
      const spacing = FOOTFALL_SPACING[archetype][gait];
      for (const perFrame of [0.02, 0.07]) {
        const n = walk(archetype, gait, 20, perFrame).length;
        const expected = 20 / spacing;
        assert.ok(Math.abs(n - expected) <= 1.01, `${archetype} ${gait} at ${perFrame} m/frame: ${n} footfalls, expected ~${expected.toFixed(1)}`);
      }
    }
  }
});

check('standing still is silent, and a long frame never fires a burst', () => {
  const t = new FootfallTracker('howler');
  for (let i = 0; i < 100; i++) assert.equal(t.advance(0, 'walk'), null);
  // a 3 m hitch (a stalled frame) gives one footfall, not four
  let n = 0;
  if (t.advance(3, 'walk')) n++;
  for (let i = 0; i < 3; i++) if (t.advance(0.01, 'walk')) n++;
  assert.equal(n, 1);
});

check('each creature has its own footfalls: claws and a gallop, a wet drag, a stamp and a dragged foot', () => {
  assert.deepEqual([...new Set(walk('howler', 'walk', 10))], ['howler_step']);
  assert.deepEqual([...new Set(walk('howler', 'run', 10))], ['howler_gallop']);
  assert.deepEqual([...new Set(walk('smiler', 'stalk', 10))], ['smiler_drag']);
  assert.deepEqual(walk('brute', 'walk', 4 * FOOTFALL_SPACING.brute.walk + 0.01), ['brute_thud', 'brute_drag', 'brute_thud', 'brute_drag']);
  assert.deepEqual([...new Set(walk('brute', 'run', 10))], ['brute_thud']);
  assert.equal(footfallSound('brute', 'stalk', 1), 'brute_drag');
});

check('gait follows the requested speed', () => {
  assert.equal(gaitFor(1.85, 1.85, 4.55), 'walk');
  assert.equal(gaitFor(3.2, 1.85, 4.55), 'stalk');
  assert.equal(gaitFor(4.55, 1.85, 4.55), 'run');
  assert.equal(gaitFor(4.55 * 0.8, 1.85, 4.55), 'run'); // chasing a remembered spot: still running
  assert.equal(gaitFor(4.55 * 0.7, 1.85, 4.55), 'stalk'); // investigating a noise
});

check('far away a sound is quieter, duller and more reverberant; close up it is loud, bright and dry', () => {
  const near = distanceCues(2);
  const mid = distanceCues(12);
  const far = distanceCues(28);
  assert.ok(near.lowpass > 11000 && far.lowpass < 1600 && mid.lowpass < near.lowpass && mid.lowpass > far.lowpass);
  const ratio = (d: number) => distanceCues(d).wet / dryLevel(d);
  assert.ok(ratio(2) < ratio(12) && ratio(12) < ratio(28), 'reverb share grows with distance');
  // still audible down a long corridor: about -20 dB at 20 m (it was -24 dB with the door panner's roll-off)
  assert.ok(dryLevel(20) >= 0.09, `level at 20 m ${dryLevel(20).toFixed(3)}`);
  assert.ok(dryLevel(1) === 1 && dryLevel(4) < 1);
});

check('the spotted sting: once per cooldown, quieter for a far hunter but never gone', () => {
  const c = new Cooldown(SPOTTED_COOLDOWN);
  assert.equal(c.take(0), true);
  assert.equal(c.take(0.1), false, 'four entities alerted at once give one sting');
  assert.equal(c.take(SPOTTED_COOLDOWN - 0.01), false);
  assert.equal(c.take(SPOTTED_COOLDOWN), true);
  c.reset();
  assert.equal(c.take(SPOTTED_COOLDOWN + 0.5), true);
  assert.equal(spottedLevel(5), 1);
  assert.ok(spottedLevel(30) > 0.5 && spottedLevel(30) < spottedLevel(15));
});

// ---- in the entity: a chasing Howler, footfalls on its voice, one call when it spots you --------------------
const textures = {
  smilerFace: new THREE.MeshBasicMaterial(),
  smilerHaloTex: new THREE.Texture(),
  softShadowTex: new THREE.Texture(),
  howlerBodyTex: new THREE.Texture(),
  howlerNormalTex: new THREE.Texture(),
  bruteSkinTex: new THREE.Texture(),
  bruteNormalTex: new THREE.Texture(),
} as unknown as EntityTextureBundle;
const world: EntityWorld = {
  lineOfSight: () => true,
  findPath: (_from, to) => [to.clone()],
  resolveCollision: () => {},
  randomPointNear: (center) => center.clone(),
  randomPatrolPoint: () => null,
};

check('a hunting entity: one call when it spots you, then footfalls that quicken as it closes in', () => {
  const entity = new BackroomsEntity(1, 'howler', 0, 0, textures, false);
  entity.faceWorldPoint(0, 22);
  const steps: { t: number; sound: Footfall; z: number }[] = [];
  let time = 0;
  const voice: EntityVoice = {
    setPosition: () => {},
    setOccluded: () => {},
    playFootfall: (sound) => steps.push({ t: time, sound, z: entity.position.z }),
    playScreech: () => {},
    playIdle: () => {},
    playWindup: () => {},
    playDeath: () => {},
    dispose: () => {},
  };
  entity.voice = voice;
  const player: PlayerPerception = {
    pos: new THREE.Vector3(0, 1.68, 22),
    forwardX: 0,
    forwardZ: -1,
    flashlightOn: true,
    crouched: false,
    hidden: false,
  };
  let spotted = 0;
  const hooks: EntityHooks = { onAttack: () => {}, onScreech: () => spotted++, onRemoved: () => {} };
  const dt = 1 / 60;
  const startZ = entity.position.z;
  entity.alertTo(player.pos); // the Howler is nearly blind: it hunts by ear (a gunshot, a sprint)
  for (; time < 5; time += dt) entity.update(dt, player, world, hooks);
  assert.equal(spotted, 1, `spotted hook fired ${spotted} times`);
  assert.ok(steps.length >= 6, `only ${steps.length} footfalls in 5 s`);
  const covered = entity.position.z - startZ;
  assert.ok(steps.length <= covered / FOOTFALL_SPACING.howler.walk + 1, `${steps.length} footfalls over ${covered.toFixed(1)} m`);
  assert.ok(steps.some((s) => s.sound === 'howler_gallop'), 'it breaks into a gallop once it hunts');
});

if (failures > 0) {
  console.error(`${failures} monster sound check(s) failed`);
  process.exit(1);
}
console.log('monster sounds: footfall, distance and spotted checks passed');
