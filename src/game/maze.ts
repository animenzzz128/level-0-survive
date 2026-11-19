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

/** A door placed across a one-cell corridor. */
export interface DoorSpec {
  gx: number;
  gz: number;
  x: number;
  z: number;
  /** World axis the corridor runs along; the door plane is perpendicular to it. */
  axis: 'x' | 'z';
}

/** Office desk the player can crouch under to hide. */
export interface DeskSpec {
  x: number;
  z: number;
  rotY: number;
}

/** Axis-aligned box obstacle (door panels, door-side wall stubs). Inactive boxes are ignored. */
export interface BoxCollider {
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  active: boolean;
}

export interface BackroomsLevelData {
  seed: number;
  grid: Uint8Array; // 1 = wall, 0 = walkable
  size: number;
  cellSize: number;
  wallHeight: number;
  spawnCell: { gx: number; gz: number };
  spawnPos: THREE.Vector3;
  spawnYaw: number;
  exitCell: { gx: number; gz: number };
  exitPos: THREE.Vector3;
  /** Unit vector from the exit door back into the exit cell. */
  exitNormal: THREE.Vector3;
  /** Y rotation for the exit door group (built facing -Z). */
  exitRotY: number;
  rooms: RoomSpec[];
  pillars: PillarSpec[];
  fixtures: LightFixtureSpec[];
  pickups: PickupSpawn[];
  entitySpawns: Array<{ x: number; z: number }>;
  graffiti: GraffitiSpec[];
  doors: DoorSpec[];
  desks: DeskSpec[];
}

const PICKUP_COUNTS: Array<[PickupKind, number]> = [
  ['ammo', 3],
  ['almond_water', 4],
  ['battery', 4],
];

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

/** Rectangular open office hall: cells cx±hw, cz±hh. */
export interface RoomSpec {
  cx: number;
  cz: number;
  hw: number;
  hh: number;
}

const QUADRANT_SPLIT = (MAZE_SIZE - 1) / 2;

export function generateBackroomsLevel(seed = 202611): BackroomsLevelData {
  const rng = createRng(seed);
  const pick = <T,>(items: T[]): T => items[Math.floor(rng() * items.length)];
  const grid = new Uint8Array(MAZE_SIZE * MAZE_SIZE);
  grid.fill(1);

  const setOpen = (gx: number, gz: number) => {
    if (gx > 0 && gz > 0 && gx < MAZE_SIZE - 1 && gz < MAZE_SIZE - 1) {
      grid[gz * MAZE_SIZE + gx] = 0;
    }
  };
  const key = (gx: number, gz: number) => `${gx},${gz}`;
  const far = MAZE_SIZE - 2;

  // Spawn in a random corner; layout, exit and tapes all hang off this choice.
  const spawnCell = pick([
    { gx: 1, gz: 1 },
    { gx: far, gz: 1 },
    { gx: 1, gz: far },
    { gx: far, gz: far },
  ]);

  // Recursive backtracker maze grown from the spawn corner
  const visited = new Uint8Array(MAZE_SIZE * MAZE_SIZE);
  const stack: Array<[number, number]> = [[spawnCell.gx, spawnCell.gz]];
  setOpen(spawnCell.gx, spawnCell.gz);
  visited[spawnCell.gz * MAZE_SIZE + spawnCell.gx] = 1;

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

  // Braid the maze so there are loops to flank and escape through instead of long dead ends
  for (let gz = 2; gz < MAZE_SIZE - 2; gz++) {
    for (let gx = 2; gx < MAZE_SIZE - 2; gx++) {
      if (grid[gz * MAZE_SIZE + gx] === 1 && rng() < 0.2) {
        const horiz = !isWallCell(grid, gx - 1, gz) && !isWallCell(grid, gx + 1, gz);
        const vert = !isWallCell(grid, gx, gz - 1) && !isWallCell(grid, gx, gz + 1);
        if (horiz || vert) {
          grid[gz * MAZE_SIZE + gx] = 0;
        }
      }
    }
  }

  // Open office halls of random size and position (3x3 to 5x5 cells), kept apart and away from spawn
  const rooms: RoomSpec[] = [];
  for (let attempts = 0; rooms.length < 6 && attempts < 300; attempts++) {
    const hw = rng() < 0.45 ? 2 : 1;
    const hh = rng() < 0.45 ? 2 : 1;
    const cx = 2 + hw + Math.floor(rng() * (MAZE_SIZE - 5 - 2 * hw + 1));
    const cz = 2 + hh + Math.floor(rng() * (MAZE_SIZE - 5 - 2 * hh + 1));
    const gapToSpawn = Math.max(
      Math.max(0, Math.abs(cx - spawnCell.gx) - hw),
      Math.max(0, Math.abs(cz - spawnCell.gz) - hh),
    );
    if (gapToSpawn < 3) continue;
    const overlaps = rooms.some(
      (r) => Math.abs(cx - r.cx) <= hw + r.hw + 2 && Math.abs(cz - r.cz) <= hh + r.hh + 2,
    );
    if (overlaps) continue;
    rooms.push({ cx, cz, hw, hh });
  }
  const inRoom = (gx: number, gz: number) =>
    rooms.some((r) => Math.abs(gx - r.cx) <= r.hw && Math.abs(gz - r.cz) <= r.hh);

  // Carve the halls; support pillars stand on interior grid corners, never on cell centres where paths run
  const pillars: PillarSpec[] = [];
  for (const r of rooms) {
    for (let gz = r.cz - r.hh; gz <= r.cz + r.hh; gz++) {
      for (let gx = r.cx - r.hw; gx <= r.cx + r.hw; gx++) setOpen(gx, gz);
    }
    for (let gz = r.cz - r.hh; gz < r.cz + r.hh; gz++) {
      for (let gx = r.cx - r.hw; gx < r.cx + r.hw; gx++) {
        if (rng() < 0.3) {
          const corner = gridToWorld(gx, gz);
          pillars.push({ x: corner.x + CELL_SIZE / 2, z: corner.z + CELL_SIZE / 2, halfWidth: 0.28 });
        }
      }
    }
  }

  // Straight opening corridor out of the spawn corner; the camera starts looking down it
  const inward = pick([
    { dx: spawnCell.gx === 1 ? 1 : -1, dz: 0 },
    { dx: 0, dz: spawnCell.gz === 1 ? 1 : -1 },
  ]);
  for (let k = 0; k <= 2; k++) setOpen(spawnCell.gx + inward.dx * k, spawnCell.gz + inward.dz * k);
  const spawnPos = gridToWorld(spawnCell.gx, spawnCell.gz);
  spawnPos.y = 1.68;
  // Camera forward is (-sin(yaw), -cos(yaw))
  const spawnYaw = Math.atan2(-inward.dx, -inward.dz);

  // Exit door on a boundary wall far from spawn by walking distance
  const spawnDist = computeBfsDistances(grid, spawnCell.gx, spawnCell.gz);
  let maxDist = 0;
  for (let i = 0; i < spawnDist.length; i++) maxDist = Math.max(maxDist, spawnDist[i]);
  const exitCandidates: Array<{ gx: number; gz: number }> = [];
  for (let gz = 1; gz <= far; gz++) {
    for (let gx = 1; gx <= far; gx++) {
      const onEdge = gx === 1 || gx === far || gz === 1 || gz === far;
      if (onEdge && spawnDist[gz * MAZE_SIZE + gx] >= maxDist * 0.7) exitCandidates.push({ gx, gz });
    }
  }
  const exitCell = exitCandidates.length > 0 ? pick(exitCandidates) : { gx: far, gz: far };
  const sides: Array<{ nx: number; nz: number; rotY: number }> = [];
  if (exitCell.gz === far) sides.push({ nx: 0, nz: 1, rotY: 0 });
  if (exitCell.gz === 1) sides.push({ nx: 0, nz: -1, rotY: Math.PI });
  if (exitCell.gx === far) sides.push({ nx: 1, nz: 0, rotY: Math.PI / 2 });
  if (exitCell.gx === 1) sides.push({ nx: -1, nz: 0, rotY: -Math.PI / 2 });
  const exitSide = sides.length > 0 ? pick(sides) : { nx: 0, nz: 1, rotY: 0 };
  const exitWorld = gridToWorld(exitCell.gx, exitCell.gz);
  // The door sits flush on the boundary wall with its front facing back into the exit cell
  const exitPos = new THREE.Vector3(
    exitWorld.x + exitSide.nx * (CELL_SIZE * 0.5 - 0.08),
    0,
    exitWorld.z + exitSide.nz * (CELL_SIZE * 0.5 - 0.08),
  );
  const exitNormal = new THREE.Vector3(-exitSide.nx, 0, -exitSide.nz);
  const exitRotY = exitSide.rotY;

  // BFS distance field from spawn to place tapes, pickups, and enemies meaningfully
  const distField = computeBfsDistances(grid, spawnCell.gx, spawnCell.gz);
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

  // One VHS tape per quadrant, at least 5 steps from spawn, preferring open halls, spaced apart
  const usedKeys = new Set<string>([key(spawnCell.gx, spawnCell.gz), key(exitCell.gx, exitCell.gz)]);
  const pickups: PickupSpawn[] = [];
  const tapeCells: Array<{ gx: number; gz: number }> = [];
  const quadrantOf = (gx: number, gz: number) => (gx > QUADRANT_SPLIT ? 1 : 0) + (gz > QUADRANT_SPLIT ? 2 : 0);
  for (let q = 0; q < 4; q++) {
    const pool = walkableCells.filter(
      (c) =>
        quadrantOf(c.gx, c.gz) === q &&
        c.dist >= 5 &&
        !usedKeys.has(key(c.gx, c.gz)) &&
        Math.max(Math.abs(c.gx - exitCell.gx), Math.abs(c.gz - exitCell.gz)) >= 3 &&
        tapeCells.every((t) => Math.abs(t.gx - c.gx) + Math.abs(t.gz - c.gz) >= 5),
    );
    const roomPool = pool.filter((c) => inRoom(c.gx, c.gz));
    let choice = roomPool.length > 0 && rng() < 0.6 ? pick(roomPool) : pool.length > 0 ? pick(pool) : null;
    if (!choice) {
      // Degenerate quadrant: fall back to the farthest unused cell anywhere
      choice = walkableCells
        .filter((c) => !usedKeys.has(key(c.gx, c.gz)))
        .reduce((a, b) => (b.dist > a.dist ? b : a));
    }
    usedKeys.add(key(choice.gx, choice.gz));
    tapeCells.push(choice);
    const wp = gridToWorld(choice.gx, choice.gz);
    pickups.push({ kind: 'tape', x: wp.x, z: wp.z, onTable: true });
  }

  // Hide-under office desks in hall corners (two in the big halls)
  const desks: DeskSpec[] = [];
  for (const r of rooms) {
    const corners = [
      [r.cx + r.hw, r.cz - r.hh],
      [r.cx - r.hw, r.cz + r.hh],
      [r.cx - r.hw, r.cz - r.hh],
      [r.cx + r.hw, r.cz + r.hh],
    ];
    const wanted = r.hw * r.hh >= 4 ? 2 : 1;
    let placed = 0;
    for (const [gx, gz] of corners) {
      if (placed >= wanted) break;
      if (usedKeys.has(key(gx, gz)) || isWallCell(grid, gx, gz)) continue;
      usedKeys.add(key(gx, gz));
      const wp = gridToWorld(gx, gz);
      desks.push({ x: wp.x, z: wp.z, rotY: rng() < 0.5 ? 0 : Math.PI / 2 });
      placed++;
    }
  }

  // Scarce supplies spread across walkable cells: ammo, Almond Water (health) and flashlight batteries
  const shuffled = [...walkableCells].sort(() => rng() - 0.5);
  let supplyCursor = 0;
  for (const [kind, count] of PICKUP_COUNTS) {
    let placed = 0;
    while (placed < count && supplyCursor < shuffled.length) {
      const c = shuffled[supplyCursor++];
      const k = key(c.gx, c.gz);
      if (usedKeys.has(k)) continue;
      usedKeys.add(k);
      const wp = gridToWorld(c.gx, c.gz);
      pickups.push({ kind, x: wp.x, z: wp.z, onTable: false });
      placed++;
    }
  }

  // Closable doors across straight one-cell corridors, spaced out and away from spawn and exit
  const doors: DoorSpec[] = [];
  for (const c of shuffled) {
    if (doors.length >= 8) break;
    const k = key(c.gx, c.gz);
    if (usedKeys.has(k) || c.dist < 4 || inRoom(c.gx, c.gz)) continue;
    if (Math.abs(c.gx - exitCell.gx) + Math.abs(c.gz - exitCell.gz) <= 2) continue;
    const openW = !isWallCell(grid, c.gx - 1, c.gz);
    const openE = !isWallCell(grid, c.gx + 1, c.gz);
    const openN = !isWallCell(grid, c.gx, c.gz - 1);
    const openS = !isWallCell(grid, c.gx, c.gz + 1);
    let axis: DoorSpec['axis'] | null = null;
    if (openW && openE && !openN && !openS) axis = 'x';
    else if (openN && openS && !openW && !openE) axis = 'z';
    if (!axis) continue;
    if (doors.some((d) => Math.max(Math.abs(d.gx - c.gx), Math.abs(d.gz - c.gz)) < 3)) continue;
    usedKeys.add(k);
    const wp = gridToWorld(c.gx, c.gz);
    doors.push({ gx: c.gx, gz: c.gz, x: wp.x, z: wp.z, axis });
  }
  const doorKeys = new Set(doors.map((d) => key(d.gx, d.gz)));

  // Entity spawns at medium/far distance from player spawn
  const entitySpawns: Array<{ x: number; z: number }> = [];
  const farCells = walkableCells.filter((c) => c.dist >= 8).sort(() => rng() - 0.5);
  for (const c of farCells) {
    const k = key(c.gx, c.gz);
    if (usedKeys.has(k)) continue;
    // Keep entities slightly spaced out
    const wp = gridToWorld(c.gx, c.gz);
    const tooClose = entitySpawns.some((e) => Math.hypot(e.x - wp.x, e.z - wp.z) < CELL_SIZE * 3.5);
    if (!tooClose) {
      usedKeys.add(k);
      entitySpawns.push({ x: wp.x, z: wp.z });
      if (entitySpawns.length >= 6) break;
    }
  }

  // Fluorescent ceiling fixtures on an organic commercial grid
  const fixtures: LightFixtureSpec[] = [];
  const startFlicker = { gx: spawnCell.gx + inward.dx * 2, gz: spawnCell.gz + inward.dz * 2 };
  for (let gz = 1; gz < MAZE_SIZE - 1; gz += 2) {
    for (let gx = 1; gx < MAZE_SIZE - 1; gx += 2) {
      if (grid[gz * MAZE_SIZE + gx] === 0) {
        const wp = gridToWorld(gx, gz);
        const roll = rng();
        const isStartArea = Math.max(Math.abs(gx - spawnCell.gx), Math.abs(gz - spawnCell.gz)) <= 2;
        let flickerMode: LightFixtureSpec['flickerMode'] = 'steady';
        if (gx === startFlicker.gx && gz === startFlicker.gz) {
          flickerMode = 'flicker';
        } else if (!isStartArea) {
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
    if (c.dist < 3 || doorKeys.has(key(c.gx, c.gz))) continue;
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
    seed,
    grid,
    size: MAZE_SIZE,
    cellSize: CELL_SIZE,
    wallHeight: WALL_HEIGHT,
    spawnCell,
    spawnPos,
    spawnYaw,
    exitCell,
    exitPos,
    exitNormal,
    exitRotY,
    rooms,
    pillars,
    fixtures,
    pickups,
    entitySpawns,
    graffiti,
    doors,
    desks,
  };
}

export function computeBfsDistances(
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
  boxes: ReadonlyArray<BoxCollider> = [],
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
    if (distSq >= radius * radius) continue;
    if (distSq > 1e-8) {
      const dist = Math.sqrt(distSq);
      const push = radius - dist;
      pos.x += (dx / dist) * push;
      pos.z += (dz / dist) * push;
    } else {
      const penX = Math.min(pos.x - minX, maxX - pos.x);
      const penZ = Math.min(pos.z - minZ, maxZ - pos.z);
      if (penX < penZ) pos.x = pos.x - minX < maxX - pos.x ? minX - radius : maxX + radius;
      else pos.z = pos.z - minZ < maxZ - pos.z ? minZ - radius : maxZ + radius;
    }
  }

  for (const b of boxes) {
    if (!b.active) continue;
    const minX = b.x - b.halfX;
    const maxX = b.x + b.halfX;
    const minZ = b.z - b.halfZ;
    const maxZ = b.z + b.halfZ;
    const dx = pos.x - THREE.MathUtils.clamp(pos.x, minX, maxX);
    const dz = pos.z - THREE.MathUtils.clamp(pos.z, minZ, maxZ);
    const distSq = dx * dx + dz * dz;
    if (distSq >= radius * radius) continue;
    if (distSq > 1e-8) {
      const dist = Math.sqrt(distSq);
      const push = radius - dist;
      pos.x += (dx / dist) * push;
      pos.z += (dz / dist) * push;
    } else {
      // Centre inside the box (thin door panels): leave along the shallowest axis.
      const penX = Math.min(pos.x - minX, maxX - pos.x);
      const penZ = Math.min(pos.z - minZ, maxZ - pos.z);
      if (penX < penZ) pos.x = pos.x - minX < maxX - pos.x ? minX - radius : maxX + radius;
      else pos.z = pos.z - minZ < maxZ - pos.z ? minZ - radius : maxZ + radius;
    }
  }
}

/** True when the 2D segments p1–p2 and q1–q2 properly intersect. */
export function segmentsIntersect(
  p1x: number,
  p1z: number,
  p2x: number,
  p2z: number,
  q1x: number,
  q1z: number,
  q2x: number,
  q2z: number,
): boolean {
  const cross = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) =>
    (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d1 = cross(q1x, q1z, q2x, q2z, p1x, p1z);
  const d2 = cross(q1x, q1z, q2x, q2z, p2x, p2z);
  const d3 = cross(p1x, p1z, p2x, p2z, q1x, q1z);
  const d4 = cross(p1x, p1z, p2x, p2z, q2x, q2z);
  return d1 * d2 < 0 && d3 * d4 < 0;
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

/** Next cell-centre waypoint on a BFS path from `from` to `target`, or null when `target` is unreachable. */
export function findNextStepToward(
  from: THREE.Vector3,
  target: THREE.Vector3,
  grid: Uint8Array,
): THREE.Vector3 | null {
  const start = worldToGrid(from.x, from.z);
  const goal = worldToGrid(target.x, target.z);

  if (start.gx === goal.gx && start.gz === goal.gz) {
    return target.clone();
  }
  if (
    start.gx < 0 || start.gz < 0 || start.gx >= MAZE_SIZE || start.gz >= MAZE_SIZE ||
    goal.gx < 0 || goal.gz < 0 || goal.gx >= MAZE_SIZE || goal.gz >= MAZE_SIZE
  ) {
    return null;
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

  if (!found) return null;

  let step = goalIdx;
  while (parent[step] !== -1 && parent[step] !== startIdx) {
    step = parent[step];
  }

  const sx = step % MAZE_SIZE;
  const sz = Math.floor(step / MAZE_SIZE);
  return gridToWorld(sx, sz);
}
