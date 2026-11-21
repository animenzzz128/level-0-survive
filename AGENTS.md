# AGENTS.md: Level 0: Survive

Short on purpose. Read this before changing anything; details are in the linked files.

## Run and verify

| What | Command | Notes |
|---|---|---|
| Install | `bun install --frozen-lockfile` | CI installs with bun; keep `bun.lock` in sync (a stale lockfile broke a deploy once) |
| Play locally | `npm run dev` | http://localhost:3000 |
| Typecheck | `npm run lint` | |
| Tests | `npm test` | maze (300 seeds), combat, storage, entities, monster sounds, perf, director, controls |
| Build | `npm run build` | |

CI: `.github/workflows/pages.yml`, job `build`, runs install, lint, test and build on every PR and deploys `main` to Pages.

## How changes land

- `main` is protected: no direct pushes (AI Studio included). Everything goes through a PR, and `build` and `playtest-gate` must pass.
- One writer per branch. Another tool or Claude/Codex session working on the game uses its own branch or `git worktree`, never a shared working tree.
- Commit each finished step on the branch. One PR per phase or batch.
- Evaluations, audits and design drafts are committed to `docs/review/` or `docs/design/`, not left in a session folder. Index: [docs/review/README.md](docs/review/README.md).

## Playtesting a PR

- The PR description needs a `Playtest:` line (see the PR template). Rules: `.github/scripts/playtest-gate.mjs`.
  - Any change under `src/` (except `*.test.ts`), `public/`, `index.html` or `vite.config.ts` needs `Playtest: done — <device, how long, what you saw>`.
  - `Playtest: n/a — <why>` is only accepted when no game file changed.
- **Agents write `needs-playtest` (or `n/a`). Never `done`.** Only the person who played writes it.
  - Why this is a written rule and not a check: agents and Jacky push with the same GitHub account, so the gate can't tell who edited the line.
- An agent's own checks are not a playtest:
  - The Claude preview pane throttles frames and has no real pointer lock, so it can't judge mouse feel or frame rate.
  - Earlier "fixed" camera bugs (view snapping on fast turns, sprint shake) were only caught by a person playing.
  - Say what was checked, and on what machine, in "How it was checked".
- To play a branch: `gh pr checkout <n> && bun install && npm run dev`, in a normal Chrome or Edge tab.
- A 10-minute route:
  1. Standard run.
  2. Fast 180° turns while sprinting.
  3. Close a door on a chaser.
  4. Hide under a desk.
  5. Pick up one tape.
  6. Die once.
  7. On Auto quality, run `__BACKROOMS_DEBUG__.perf()` in the console for frame times.

## Debug hooks

`window.__BACKROOMS_DEBUG__` (`installDebugApi` in `src/game/BackroomsEngine.ts`) drives the game without a mouse. It is installed in every build, the live site included. Prefer it to ad-hoc scripts.

| Call | What it does |
|---|---|
| `startGame(diff, seed?)` | Start a run (`'standard'` or `'nightmare'`), optionally with a fixed seed |
| `getState()` | HUD snapshot, position, yaw/pitch, director intensity, entities, tapes, pickups, doors |
| `step(frames, dt)` | Advance the simulation |
| `teleport(x, z)`, `teleportToDoor(i)`, `teleportNearEntityByType(type)`, `teleportNearTape()`, `teleportToExitUnlocked()` | Jump to a situation |
| `lookAtWorld(x, y, z)`, `setCrouch(on)`, `interact()` | Act |
| `perf()` | Frame measurement |
| `killBy(type)` | The nearest entity of that type lands a fatal blow (death scene QA); `getState().jumpscare` follows it |
| `audioEvents()` | The last 60 monster footfalls, calls and "spotted" stings, with distance and level (sound QA without listening) |

## Feature map

| Feature | Code |
|---|---|
| Engine, render loop, player, weapon fire, pickups | `src/game/BackroomsEngine.ts`, `weapon.ts`, `combat.ts`, `aim.ts` |
| Entities: perception, awareness, chase, attacks | `src/game/entities.ts` |
| Pacing (intensity, rest windows, respawns) | `src/game/director.ts` |
| Layouts, daily seed, desks, arrows | `src/game/maze.ts` |
| Doors | `src/game/doors.ts` |
| Key bindings and rebinding | `src/game/controls.ts`, `components/SettingsPanel.tsx` |
| HUD, death warning, damage direction | `src/components/GameHud.tsx`, `src/game/hudDiff.ts` |
| Tips and briefing | `src/game/guide.ts`, `components/HowToPlay.tsx` |
| Saves, settings, records | `src/game/storage.ts` |
| Textures and sound (all generated in code) | `src/game/textures.ts`, `src/game/audio.ts`; monster footfalls, distance cues and the "spotted" sting: `entitySounds.ts` |
| Quality levels, light pool, measurement | `src/game/perf.ts`, `meshMerge.ts` |
| 3D models: loading, props, entity clips, death scenes, pistol | `src/game/assets.ts` (loader), `entities.ts` (`useModel`, `animateModel`), `BackroomsEngine.ts` (`startJumpscare`), `weapon.ts` (`setModel`) |
| Model sources (Blender scripts, reports, previews) | `tools/blender/`, interface in [docs/design/art/model-contract.md](docs/design/art/model-contract.md) |

## Known traps

- `metadata.json` and the `GEMINI_API_KEY` in `.env.example` are AI Studio leftovers; the game makes no Gemini calls.
- Never toggle a light's `visible` during a run. three.js recompiles every lit shader when the light count changes (the old tape-pickup hitch). Change `intensity` instead.
- Recoil is an offset that decays, not a change to the look angle; keep it that way.
- The `.glb` files in `public/assets/models/` are build output of `tools/blender/build_*.py`. Change the script and
  re-run it; never edit a `.glb` by hand. Every model is optional: the procedural placeholder stays as the fallback.
- Never run `mergeStaticMeshes` on model meshes: it disposes geometry the asset cache still shares.
