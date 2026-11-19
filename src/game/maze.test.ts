// Level generation invariants, checked over many seeds. Run with `npm test`.
import assert from 'node:assert/strict';
import {
  CELL_SIZE,
  MAZE_SIZE,
  computeBfsDistances,
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

check(-1, 'layouts vary between seeds', () => {
  assert.ok(tapeLayouts.size > SEEDS * 0.9, `only ${tapeLayouts.size} distinct tape layouts`);
  assert.equal(spawnCorners.size, 4, 'not every spawn corner is used');
  assert.equal(exitSides.size, 4, 'not every exit wall is used');
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`maze: all checks passed over ${SEEDS} seeds (${tapeLayouts.size} distinct tape layouts)`);
