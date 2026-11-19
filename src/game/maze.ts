import * as THREE from 'three';
import { PickupKind } from './types';

export const MAZE_SIZE = 23; // odd dimensions for clean maze walls
export const CELL_SIZE = 3.2;
export const WALL_HEIGHT = 3.1;

export interface LightFixtureSpec {
  gridX: number;
  gridZ: number;
  x: number;
  z: number;
  flickerMode: 'steady' | 'flicker' | 'dead';
  phaseOffset: number;
}

export interface PickupSpawn {
  kind: PickupKind;
  x: number;
  z: number;
  onTable: boolean;
}

export interface PillarSpec {
  x: number;
  z: number;
  halfWidth: number;
}

export interface GraffitiSpec {
  x: number;
  y: number;
  z: number;
  rotY: number;
  variant: number;
}

export interface BackroomsLevelData {
  grid: Uint8Array; // 1 = wall, 0 = walkable
  size: number;
  cellSize: number;
  wallHeight: number;
  spawnPos: THREE.Vector3;
  spawnYaw: number;
  exitCell: { gx: number; gz: number };
  exitPos: THREE.Vector3;
  exitNormal: THREE.Vector3;
  pillars: PillarSpec[];
  fixtures: LightFixtureSpec[];
  pickups: PickupSpawn[];
  entitySpawns: Array<{ x: number; z: number }>;
  graffiti: GraffitiSpec[];
}

function createRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function gridToWorld(gx: number, gz: number): THREE.Vector3 {
  const half = ((MAZE_SIZE - 1) * CELL_SIZE) / 2;
  return new THREE.Vector3(gx * CELL_SIZE - half, 0, gz * CELL_SIZE - half);
}

export function worldToGrid(x: number, z: number): { gx: number; gz: number } {
  const half = ((MAZE_SIZE - 1) * CELL_SIZE) / 2;
  return {
    gx: Math.round((x + half) / CELL_SIZE),
    gz: Math.round((z + half) / CELL_SIZE),
  };
}

export function isWallCell(grid: Uint8Array, gx: number, gz: number): boolean {
  if (gx < 0 || gz < 0 || gx >= MAZE_SIZE || gz >= MAZE_SIZE) return true;
  return grid[gz * MAZE_SIZE + gx] === 1;
}

export function generateBackroomsLevel(seed = 202611): BackroomsLevelData {
  const rng = createRng(seed);
  const grid = new Uint8Array(MAZE_SIZE * MAZE_SIZE);
  grid.fill(1);

  const setOpen = (gx: number, gz: number) => {
    if (gx > 0 && gz > 0 && gx < MAZE_SIZE - 1 && gz < MAZE_SIZE - 1) {
      grid[gz * MAZE_SIZE + gx] = 0;
    }
  };

  // Recursive backtracker maze
  const visited = new Uint8Array(MAZE_SIZE * MAZE_SIZE);
  const stack: Array<[number, number]> = [[1, 1]];
  setOpen(1, 1);
  visited[1 * MAZE_SIZE + 1] = 1;

  const dirs: Array<[number, number]> = [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
  ];

  while (stack.length > 0) {
    const [cx, cz] = stack[stack.length - 1];
    const neighbors: Array<[number, number, number, number]> = [];
    for (const [dx, dz] of dirs) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx > 0 && nz > 0 && nx < MAZE_SIZE - 1 && nz < MAZE_SIZE - 1) {
        if (!visited[nz * MAZE_SIZE + nx]) {
          neighbors.push([nx, nz, cx + dx / 2, cz + dz / 2]);
        }
      }
    }
    if (neighbors.length === 0) {
      stack.pop();
    } else {
      const [nx, nz, mx, mz] = neighbors[Math.floor(rng() * neighbors.length)];
      setOpen(mx, mz);
      setOpen(nx, nz);
      visited[nz * MAZE_SIZE + nx] = 1;
      stack.push([nx, nz]);
    }
  }

  // Braid maze slightly so players can flank entities instead of getting trapped
  for (let gz = 2; gz < MAZE_SIZE - 2; gz++) {
    for (let gx = 2; gx < MAZE_SIZE - 2; gx++) {
      if (grid[gz * MAZE_SIZE + gx] === 1 && rng() < 0.14) {
        const horiz =
          !isWallCell(grid, gx - 1, gz) && !isWallCell(grid, gx + 1, gz);
        const vert =
          !isWallCell(grid, gx, gz - 1) && !isWallCell(grid, gx, gz + 1);
        if (horiz || vert) {
          grid[gz * MAZE_SIZE + gx] = 0;
        }
      }
    }
  }

  // Carve 4 iconic Level 0 open office halls with support pillars
  const hallCenters: Array<[number, number]> = [
    [5, 5],
    [17, 5],
    [11, 11],
    [5, 17],
    [17, 15],
  ];
  const pillars: PillarSpec[] = [];

  for (const [hx, hz] of hallCenters) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        setOpen(hx + dx, hz + dz);
      }
    }
    const worldCenter = gridToWorld(hx, hz);
    // Add 2 asymmetric architectural columns inside open halls
    pillars.push({
      x: worldCenter.x - CELL_SIZE * 0.72,
      z: worldCenter.z - CELL_SIZE * 0.72,
      halfWidth: 0.28,
    });
    pillars.push({
      x: worldCenter.x + CELL_SIZE * 0.72,
      z: worldCenter.z + CELL_SIZE * 0.72,
      halfWidth: 0.28,
    });
  }

  // Ensure straight starting sightline corridor at spawn (1,1) -> (1,2) -> (1,3) -> (2,3) -> (3,3)
  setOpen(1, 1);
  setOpen(1, 2);
  setOpen(1, 3);
  setOpen(2, 1);
  const spawnPos = gridToWorld(1, 1);
  spawnPos.y = 1.68;
  // Look toward +Z corridor where a flickering fluorescent light + hallway stretches out
  const spawnYaw = Math.PI;

  // Exit placed on far boundary wall at (MAZE_SIZE - 2, MAZE_SIZE - 2)
  const exitCell = { gx: MAZE_SIZE - 2, gz: MAZE_SIZE - 2 };
  setOpen(exitCell.gx, exitCell.gz);
  setOpen(exitCell.gx - 1, exitCell.gz);
  setOpen(exitCell.gx, exitCell.gz - 1);

  const exitWorld = gridToWorld(exitCell.gx, exitCell.gz);
  // Door sits flush on the +Z outer wall of exitCell
  const exitPos = new THREE.Vector3(
    exitWorld.x,
    0,
    exitWorld.z + CELL_SIZE * 0.5 - 0.08,
  );
  const exitNormal = new THREE.Vector3(0, 0, -1);

  // Build BFS distance field from spawn to place tapes, pickups, and enemies meaningfully
  const distField = computeBfsDistances(grid, 1, 1);
  const walkableCells: Array<{ gx: number; gz: number; dist: number }> = [];
  for (let gz = 1; gz < MAZE_SIZE - 1; gz++) {
    for (let gx = 1; gx < MAZE_SIZE - 1; gx++) {
      if (grid[gz * MAZE_SIZE + gx] === 0) {
        const d = distField[gz * MAZE_SIZE + gx];
        if (d > 2 && !(gx === exitCell.gx && gz === exitCell.gz)) {
          walkableCells.push({ gx, gz, dist: d });
        }
      }
    }
  }

  // Pick 4 well-separated quadrant cells for VHS Tapes
  const tapeTargets: Array<[number, number]> = [
    [5, 17],
    [17, 5],
    [11, 11],
    [17, 17],
  ];
  const usedKeys = new Set<string>(['1,1', `${exitCell.gx},${exitCell.gz}`]);
  const pickups: PickupSpawn[] = [];

  for (const [tx, tz] of tapeTargets) {
    let best = walkableCells[0];
    let bestScore = Infinity;
    for (const c of walkableCells) {
      const k = `${c.gx},${c.gz}`;
      if (usedKeys.has(k)) continue;
      const d = Math.hypot(c.gx - tx, c.gz - tz);
      if (d < bestScore) {
        bestScore = d;
        best = c;
      }
    }
    usedKeys.add(`${best.gx},${best.gz}`);
    const wp = gridToWorld(best.gx, best.gz);
    pickups.push({ kind: 'tape', x: wp.x, z: wp.z, onTable: true });
  }

  // Ammo crates & Almond Water spread across walkable cells
  const shuffled = [...walkableCells].sort(() => rng() - 0.5);
  let ammoCount = 0;
  let waterCount = 0;
  for (const c of shuffled) {
    const k = `${c.gx},${c.gz}`;
    if (usedKeys.has(k)) continue;
    const wp = gridToWorld(c.gx, c.gz);
    if (ammoCount < 6) {
      usedKeys.add(k);
      pickups.push({ kind: 'ammo', x: wp.x, z: wp.z, onTable: false });
      ammoCount++;
    } else if (waterCount < 5) {
      usedKeys.add(k);
      pickups.push({ kind: 'almond_water', x: wp.x, z: wp.z, onTable: false });
      waterCount++;
    } else {
      break;
    }
  }

  // Entity spawns at medium/far distance from player spawn
  const entitySpawns: Array<{ x: number; z: number }> = [];
  const farCells = walkableCells
    .filter((c) => c.dist >= 8)
    .sort(() => rng() - 0.5);
  for (const c of farCells) {
    const k = `${c.gx},${c.gz}`;
    if (usedKeys.has(k)) continue;
    // Keep entities slightly spaced out
    const wp = gridToWorld(c.gx, c.gz);
    const tooClose = entitySpawns.some(
      (e) => Math.hypot(e.x - wp.x, e.z - wp.z) < CELL_SIZE * 3.5,
    );
    if (!tooClose) {
      usedKeys.add(k);
      entitySpawns.push({ x: wp.x, z: wp.z });
      if (entitySpawns.length >= 6) break;
    }
  }

  // Fluorescent ceiling fixtures on an organic commercial grid
  const fixtures: LightFixtureSpec[] = [];
  for (let gz = 1; gz < MAZE_SIZE - 1; gz += 2) {
    for (let gx = 1; gx < MAZE_SIZE - 1; gx += 2) {
      if (grid[gz * MAZE_SIZE + gx] === 0) {
        const wp = gridToWorld(gx, gz);
        const roll = rng();
        const isStartCorridor = gx <= 2 && gz <= 4;
        let flickerMode: LightFixtureSpec['flickerMode'] = 'steady';
        if (isStartCorridor && gz === 3) {
          flickerMode = 'flicker';
        } else if (!isStartCorridor) {
          if (roll < 0.18) flickerMode = 'dead';
          else if (roll < 0.34) flickerMode = 'flicker';
        }
        fixtures.push({
          gridX: gx,
          gridZ: gz,
          x: wp.x,
          z: wp.z,
          flickerMode,
          phaseOffset: rng() * 100,
        });
      }
    }
  }

  // Wall graffiti decals placed on wall faces adjoining open cells
  const graffiti: GraffitiSpec[] = [];
  let variantIdx = 0;
  for (const c of shuffled) {
    if (graffiti.length >= 7) break;
    if (c.dist < 3) continue;
    const wp = gridToWorld(c.gx, c.gz);
    if (isWallCell(grid, c.gx, c.gz + 1)) {
      graffiti.push({
        x: wp.x,
        y: 1.55,
        z: wp.z + CELL_SIZE * 0.5 - 0.02,
        rotY: Math.PI,
        variant: variantIdx++ % 3,
      });
    } else if (isWallCell(grid, c.gx + 1, c.gz)) {
      graffiti.push({
        x: wp.x + CELL_SIZE * 0.5 - 0.02,
        y: 1.55,
        z: wp.z,
        rotY: -Math.PI / 2,
        variant: variantIdx++ % 3,
      });
    }
  }

  return {
    grid,
    size: MAZE_SIZE,
    cellSize: CELL_SIZE,
    wallHeight: WALL_HEIGHT,
    spawnPos,
    spawnYaw,
    exitCell,
    exitPos,
    exitNormal,
    pillars,
    fixtures,
    pickups,
    entitySpawns,
    graffiti,
  };
}

function computeBfsDistances(
  grid: Uint8Array,
  startGx: number,
  startGz: number,
): Int16Array {
  const dist = new Int16Array(MAZE_SIZE * MAZE_SIZE).fill(-1);
  const queue: Array<[number, number]> = [[startGx, startGz]];
  dist[startGz * MAZE_SIZE + startGx] = 0;
  let head = 0;
  const dirs: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (head < queue.length) {
    const [gx, gz] = queue[head++];
    const d = dist[gz * MAZE_SIZE + gx];
    for (const [dx, dz] of dirs) {
      const nx = gx + dx;
      const nz = gz + dz;
      if (nx < 0 || nz < 0 || nx >= MAZE_SIZE || nz >= MAZE_SIZE) continue;
      const idx = nz * MAZE_SIZE + nx;
      if (grid[idx] === 0 && dist[idx] === -1) {
        dist[idx] = d + 1;
        queue.push([nx, nz]);
      }
    }
  }
  return dist;
}

export function resolveCircleWallCollision(
  pos: THREE.Vector3,
  radius: number,
  grid: Uint8Array,
  pillars: PillarSpec[],
): void {
  const halfWorld = ((MAZE_SIZE - 1) * CELL_SIZE) / 2;
  const { gx, gz } = worldToGrid(pos.x, pos.z);

  for (let oz = -1; oz <= 1; oz++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cgx = gx + ox;
      const cgz = gz + oz;
      if (!isWallCell(grid, cgx, cgz)) continue;

      const cx = cgx * CELL_SIZE - halfWorld;
      const cz = cgz * CELL_SIZE - halfWorld;
      const half = CELL_SIZE * 0.5;

      const minX = cx - half;
      const maxX = cx + half;
      const minZ = cz - half;
      const maxZ = cz + half;

      const closestX = THREE.MathUtils.clamp(pos.x, minX, maxX);
      const closestZ = THREE.MathUtils.clamp(pos.z, minZ, maxZ);

      const dx = pos.x - closestX;
      const dz = pos.z - closestZ;
      const distSq = dx * dx + dz * dz;

      if (distSq < radius * radius) {
        const dist = Math.sqrt(distSq);
        if (dist > 0.0001) {
          const push = radius - dist;
          pos.x += (dx / dist) * push;
          pos.z += (dz / dist) * push;
        } else {
          // Inside AABB fallback: push out along shallowest axis
          const penLeft = pos.x - minX;
          const penRight = maxX - pos.x;
          const penTop = pos.z - minZ;
          const penBot = maxZ - pos.z;
          const m = Math.min(penLeft, penRight, penTop, penBot);
          if (m === penLeft) pos.x = minX - radius;
          else if (m === penRight) pos.x = maxX + radius;
          else if (m === penTop) pos.z = minZ - radius;
          else pos.z = maxZ + radius;
        }
      }
    }
  }

  for (const p of pillars) {
    const minX = p.x - p.halfWidth;
    const maxX = p.x + p.halfWidth;
    const minZ = p.z - p.halfWidth;
    const maxZ = p.z + p.halfWidth;
    const closestX = THREE.MathUtils.clamp(pos.x, minX, maxX);
    const closestZ = THREE.MathUtils.clamp(pos.z, minZ, maxZ);
    const dx = pos.x - closestX;
    const dz = pos.z - closestZ;
    const distSq = dx * dx + dz * dz;
    if (distSq < radius * radius && distSq > 1e-6) {
      const dist = Math.sqrt(distSq);
      const push = radius - dist;
      pos.x += (dx / dist) * push;
      pos.z += (dz / dist) * push;
    }
  }
}

export function hasLineOfSight(
  from: THREE.Vector3,
  to: THREE.Vector3,
  grid: Uint8Array,
): boolean {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.05) return true;
  const steps = Math.ceil(dist / 0.35);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const sx = from.x + dx * t;
    const sz = from.z + dz * t;
    const { gx, gz } = worldToGrid(sx, sz);
    if (isWallCell(grid, gx, gz)) return false;
  }
  return true;
}

export function findNextStepToward(
  from: THREE.Vector3,
  target: THREE.Vector3,
  grid: Uint8Array,
): THREE.Vector3 {
  const start = worldToGrid(from.x, from.z);
  const goal = worldToGrid(target.x, target.z);

  if (start.gx === goal.gx && start.gz === goal.gz) {
    return target.clone();
  }

  const parent = new Int16Array(MAZE_SIZE * MAZE_SIZE).fill(-1);
  const visited = new Uint8Array(MAZE_SIZE * MAZE_SIZE);
  const startIdx = start.gz * MAZE_SIZE + start.gx;
  const goalIdx = goal.gz * MAZE_SIZE + goal.gx;

  const queue: number[] = [startIdx];
  visited[startIdx] = 1;
  let head = 0;
  let found = false;

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (head < queue.length) {
    const cur = queue[head++];
    if (cur === goalIdx) {
      found = true;
      break;
    }
    const cx = cur % MAZE_SIZE;
    const cz = Math.floor(cur / MAZE_SIZE);
    for (const [dx, dz] of dirs) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= MAZE_SIZE || nz >= MAZE_SIZE) continue;
      const nIdx = nz * MAZE_SIZE + nx;
      if (!visited[nIdx] && grid[nIdx] === 0) {
        visited[nIdx] = 1;
        parent[nIdx] = cur;
        queue.push(nIdx);
      }
    }
  }

  if (!found) return target.clone();

  let step = goalIdx;
  while (parent[step] !== -1 && parent[step] !== startIdx) {
    step = parent[step];
  }

  const sx = step % MAZE_SIZE;
  const sz = Math.floor(step / MAZE_SIZE);
  return gridToWorld(sx, sz);
}
