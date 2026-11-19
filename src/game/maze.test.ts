// Level generation invariants, checked over many seeds. Run with `npm test`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CELL_SIZE,
  MAZE_SIZE,
  MIN_TAPE_EXIT_STEPS,
  computeBfsDistances,
  findWeightedPath,
  generateBackroomsLevel,
  isWallCell,
  worldToGrid,
} from './maze';

const SEEDS = 300;
const far = MAZE_SIZE - 2;
const split = (MAZE_SIZE - 1) / 2;
let failures = 0;
const tapeLayouts = new Set<string>();
const spawnCorners = new Set<string>();
const exitSides = new Set<number>();
const nearestTapeToExit: number[] = [];
let landmarkCount = 0;
let signCount = 0;
let signsCorrect = 0;

function check(seed: number, name: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    failures++;
    console.error(`seed ${seed} · ${name}: ${(err as Error).message}`);
  }
}

for (let i = 0; i < SEEDS; i++) {
  const seed = 202611 + i * 7919;
  const level = generateBackroomsLevel(seed);
  const { grid, spawnCell, exitCell } = level;
  const dist = computeBfsDistances(grid, spawnCell.gx, spawnCell.gz);
  const reach = (x: number, z: number) => {
    const { gx, gz } = worldToGrid(x, z);
    return dist[gz * MAZE_SIZE + gx];
  };

  check(seed, 'same seed gives the same layout', () => {
    const again = generateBackroomsLevel(seed);
    assert.deepEqual(Array.from(again.grid), Array.from(grid));
    assert.deepEqual(again.pickups, level.pickups);
  });

  check(seed, 'outer ring is solid', () => {
    for (let k = 0; k < MAZE_SIZE; k++) {
      assert.ok(isWallCell(grid, k, 0) && isWallCell(grid, k, MAZE_SIZE - 1));
      assert.ok(isWallCell(grid, 0, k) && isWallCell(grid, MAZE_SIZE - 1, k));
    }
  });

  check(seed, 'spawn corridor is open and the camera looks down it', () => {
    const fx = Math.round(-Math.sin(level.spawnYaw));
    const fz = Math.round(-Math.cos(level.spawnYaw));
    for (let k = 0; k <= 2; k++) {
      assert.ok(!isWallCell(grid, spawnCell.gx + fx * k, spawnCell.gz + fz * k), `cell ${k} blocked`);
    }
  });

  check(seed, 'exit is on the boundary, reachable and far from spawn', () => {
    assert.ok(
      exitCell.gx === 1 || exitCell.gx === far || exitCell.gz === 1 || exitCell.gz === far,
      'exit cell not on the edge',
    );
    const d = dist[exitCell.gz * MAZE_SIZE + exitCell.gx];
    assert.ok(d > 0, 'exit unreachable');
    let maxDist = 0;
    for (const v of dist) maxDist = Math.max(maxDist, v);
    assert.ok(d >= maxDist * 0.7 - 1, `exit only ${d}/${maxDist} steps away`);
    // The door's back must be against the outer wall
    const behind = worldToGrid(
      level.exitPos.x - level.exitNormal.x * CELL_SIZE * 0.6,
      level.exitPos.z - level.exitNormal.z * CELL_SIZE * 0.6,
    );
    assert.ok(isWallCell(grid, behind.gx, behind.gz), 'exit door is not on a wall');
  });

  check(seed, 'four tapes, one per quadrant, all reachable and spread out', () => {
    const tapes = level.pickups.filter((p) => p.kind === 'tape').map((p) => worldToGrid(p.x, p.z));
    assert.equal(tapes.length, 4);
    const quadrants = new Set(tapes.map((t) => (t.gx > split ? 1 : 0) + (t.gz > split ? 2 : 0)));
    assert.equal(quadrants.size, 4, 'two tapes share a quadrant');
    for (const t of tapes) assert.ok(dist[t.gz * MAZE_SIZE + t.gx] >= 5, 'tape too close to spawn');
    tapeLayouts.add(tapes.map((t) => `${t.gx},${t.gz}`).join('|'));
  });

  check(seed, `every tape is at least ${MIN_TAPE_EXIT_STEPS} steps from the exit`, () => {
    const fromExit = computeBfsDistances(grid, exitCell.gx, exitCell.gz);
    const steps = level.pickups
      .filter((p) => p.kind === 'tape')
      .map((p) => {
        const g = worldToGrid(p.x, p.z);
        return fromExit[g.gz * MAZE_SIZE + g.gx];
      });
    for (const d of steps) assert.ok(d >= MIN_TAPE_EXIT_STEPS, `tape only ${d} steps from the exit`);
    nearestTapeToExit.push(Math.min(...steps));
  });

  check(seed, 'landmarks: distinct kinds, against a wall, never in a dead end', () => {
    const kinds = new Set(level.landmarks.map((l) => l.kind));
    assert.equal(kinds.size, level.landmarks.length, 'two landmarks of the same kind');
    assert.ok(level.landmarks.length >= 3, `only ${level.landmarks.length} landmarks`);
    const quadrants = new Set(level.landmarks.map((l) => (l.gx > split ? 1 : 0) + (l.gz > split ? 2 : 0)));
    assert.equal(quadrants.size, level.landmarks.length, 'two landmarks share a quadrant');
    for (const l of level.landmarks) {
      assert.ok(!isWallCell(grid, l.gx, l.gz), 'landmark inside a wall');
      // The wall behind it: one cell back along -front.
      const bx = l.gx + Math.round(-Math.sin(l.rotY));
      const bz = l.gz + Math.round(-Math.cos(l.rotY));
      assert.ok(isWallCell(grid, bx, bz), 'landmark not against a wall');
      const open = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => !isWallCell(grid, l.gx + dx, l.gz + dz));
      assert.ok(open.length >= 2, 'landmark blocks a dead end');
    }
    landmarkCount += level.landmarks.length;
  });

  check(seed, 'arrow signs: on corridor walls, honest ones point toward the exit', () => {
    const fromExit = computeBfsDistances(grid, exitCell.gx, exitCell.gz);
    for (const sign of level.signs) {
      const nx = Math.round(-Math.sin(sign.rotY));
      const nz = Math.round(-Math.cos(sign.rotY));
      assert.ok(!isWallCell(grid, sign.gx, sign.gz) && isWallCell(grid, sign.gx + nx, sign.gz + nz), 'sign not on a wall');
      // Direction the painted arrow points in the world.
      const ax = Math.round(Math.cos(sign.rotY) * sign.flip);
      const az = Math.round(-Math.sin(sign.rotY) * sign.flip);
      // Read from the junction it faces: an honest arrow points from there into this corridor, one step nearer.
      const here = fromExit[sign.gz * MAZE_SIZE + sign.gx];
      const behind = isWallCell(grid, sign.gx - ax, sign.gz - az) ? -1 : fromExit[(sign.gz - az) * MAZE_SIZE + sign.gx - ax];
      assert.ok(!isWallCell(grid, sign.gx + ax, sign.gz + az) || !isWallCell(grid, sign.gx - ax, sign.gz - az), 'arrow between walls');
      if (sign.correct) assert.ok(behind === here + 1, 'honest arrow points away from the exit');
      signsCorrect += sign.correct ? 1 : 0;
    }
    signCount += level.signs.length;
  });

  check(seed, 'every pickup, desk, door and entity spawn sits on a reachable open cell', () => {
    const spots = [...level.pickups, ...level.desks, ...level.doors, ...level.entitySpawns];
    for (const s of spots) assert.ok(reach(s.x, s.z) > 0, `unreachable spot at ${s.x},${s.z}`);
  });

  check(seed, 'no two things share a cell', () => {
    const keys = [...level.pickups, ...level.desks, ...level.doors, ...level.entitySpawns].map((s) => {
      const g = worldToGrid(s.x, s.z);
      return `${g.gx},${g.gz}`;
    });
    assert.equal(new Set(keys).size, keys.length);
  });

  check(seed, 'pillars sit on grid corners inside open halls', () => {
    for (const p of level.pillars) {
      const g = worldToGrid(p.x - CELL_SIZE / 2, p.z - CELL_SIZE / 2);
      for (const [dx, dz] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        assert.ok(!isWallCell(grid, g.gx + dx, g.gz + dz), 'pillar touches a wall cell');
      }
    }
  });

  check(seed, 'doors span straight one-cell corridors', () => {
    for (const d of level.doors) {
      const along = d.axis === 'x' ? [1, 0] : [0, 1];
      const across = d.axis === 'x' ? [0, 1] : [1, 0];
      assert.ok(!isWallCell(grid, d.gx + along[0], d.gz + along[1]));
      assert.ok(!isWallCell(grid, d.gx - along[0], d.gz - along[1]));
      assert.ok(isWallCell(grid, d.gx + across[0], d.gz + across[1]));
      assert.ok(isWallCell(grid, d.gx - across[0], d.gz - across[1]));
    }
  });

  check(seed, 'supply counts', () => {
    const count = (k: string) => level.pickups.filter((p) => p.kind === k).length;
    assert.equal(count('ammo'), 3);
    assert.equal(count('almond_water'), 4);
    assert.equal(count('battery'), 4);
    assert.ok(level.rooms.length >= 3, `only ${level.rooms.length} halls`);
    assert.ok(level.desks.length >= 3, `only ${level.desks.length} desks`);
    assert.ok(level.entitySpawns.length >= 6, `only ${level.entitySpawns.length} entity spawns`);
  });

  spawnCorners.add(`${spawnCell.gx},${spawnCell.gz}`);
  exitSides.add(level.exitRotY);
}

check(-1, 'weighted paths: a closed door costs time, not a wall', () => {
  // A ring corridor: the short way passes a door cell, the long way goes around.
  const grid = new Uint8Array(MAZE_SIZE * MAZE_SIZE).fill(1);
  const open = (gx: number, gz: number) => (grid[gz * MAZE_SIZE + gx] = 0);
  for (let gx = 2; gx <= 8; gx++) {
    open(gx, 2);
    open(gx, 6);
  }
  for (let gz = 2; gz <= 6; gz++) {
    open(2, gz);
    open(8, gz);
  }
  const door = 2 * MAZE_SIZE + 5;
  const cost = new Float32Array(MAZE_SIZE * MAZE_SIZE);
  const direct = findWeightedPath(grid, 3, 2, 7, 2, cost)!;
  assert.equal(direct.length, 4, 'open door: straight through');
  cost[door] = 4;
  assert.ok(findWeightedPath(grid, 3, 2, 7, 2, cost)!.includes(door), 'cheap door: batter through');
  cost[door] = 40;
  const around = findWeightedPath(grid, 3, 2, 7, 2, cost)!;
  assert.ok(!around.includes(door) && around.length === 16, `expensive door: go around (${around.length} steps)`);
  cost[door] = Infinity;
  assert.ok(!findWeightedPath(grid, 3, 2, 7, 2, cost)!.includes(door), 'blocked cell never used');
  assert.equal(findWeightedPath(grid, 3, 2, 3, 2, cost)!.length, 0);
  assert.equal(findWeightedPath(grid, 3, 2, 0, 0, cost), null, 'wall goal');
});

check(-1, 'layouts vary between seeds', () => {
  assert.ok(tapeLayouts.size > SEEDS * 0.9, `only ${tapeLayouts.size} distinct tape layouts`);
  assert.equal(spawnCorners.size, 4, 'not every spawn corner is used');
  assert.equal(exitSides.size, 4, 'not every exit wall is used');
});

// Seeds must build the same level in every browser and every build. Pin a few layouts so that any change
// to generation is deliberate (and comes with a records migration, since daily layouts change too).
function layoutHash(seed: number): string {
  const l = generateBackroomsLevel(seed);
  const parts = [
    Array.from(l.grid).join(''),
    l.pickups.map((p) => `${p.kind}:${p.x.toFixed(2)},${p.z.toFixed(2)}`).join(';'),
    l.doors.map((d) => `${d.gx},${d.gz},${d.axis}`).join(';'),
    l.desks.map((d) => `${d.x.toFixed(2)},${d.z.toFixed(2)}`).join(';'),
    l.entitySpawns.map((e) => `${e.x.toFixed(2)},${e.z.toFixed(2)}`).join(';'),
    `${l.spawnCell.gx},${l.spawnCell.gz}|${l.exitCell.gx},${l.exitCell.gz}|${l.exitRotY.toFixed(3)}`,
    l.fixtures.map((f) => f.flickerMode[0]).join(''),
    l.landmarks.map((m) => `${m.kind}:${m.gx},${m.gz},${m.rotY.toFixed(3)}`).join(';'),
    l.signs.map((g) => `${g.gx},${g.gz},${g.rotY.toFixed(3)},${g.flip}`).join(';'),
  ].join('#');
  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// HASH_DUMP=1 npx tsx src/game/maze.test.ts prints the current hashes after a deliberate generator change.
if (process.env.HASH_DUMP) for (const seed of [1, 202611, 1947985822]) console.log(`hash ${seed} ${layoutHash(seed)}`);

check(-1, 'pinned layouts are unchanged', () => {
  // Re-pinned for records v3: tapes keep their distance from the exit, landmarks and arrow signs were added.
  const pinned: Record<number, string> = { 1: 'bd87d3f8', 202611: 'c8816272', 1947985822: '2f9b165a' };
  for (const [seed, hash] of Object.entries(pinned)) {
    assert.equal(layoutHash(Number(seed)), hash, `layout for seed ${seed} changed`);
  }
});

check(-1, 'generation never shuffles with Array.sort and a random comparator', () => {
  const source = readFileSync(new URL('./maze.ts', import.meta.url), 'utf8');
  assert.ok(!/\.sort\(\s*\(\)\s*=>/.test(source), 'engine-dependent shuffle found in maze.ts');
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
const sorted = [...nearestTapeToExit].sort((a, b) => a - b);
console.log(
  `nearest tape to exit (steps): min ${sorted[0]}, median ${sorted[Math.floor(sorted.length / 2)]}, ` +
    `max ${sorted[sorted.length - 1]}; landmarks ${(landmarkCount / SEEDS).toFixed(2)}/level; ` +
    `arrow signs ${(signCount / SEEDS).toFixed(1)}/level, ${Math.round((signsCorrect / Math.max(1, signCount)) * 100)}% honest`,
);
console.log(`maze: all checks passed over ${SEEDS} seeds (${tapeLayouts.size} distinct tape layouts)`);
