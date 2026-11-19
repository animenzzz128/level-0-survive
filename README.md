# Level 0: Survive

A first-person survival horror game in the Backrooms, in the browser (three.js, React, TypeScript).

**Play:** https://animenzzz128.github.io/level-0-survive/ (GitHub Pages, deployed from `main`). Desktop with keyboard and mouse.

Find the 4 VHS tapes by following their static, then reach the Sector 00 exit. Every tape you take makes Level 0 worse: lights fail and another entity wakes up. Your flashlight battery is limited, sprinting is loud, and ammo is scarce, so most of the time hiding beats fighting.

## Features

- Three entities (the Smiler, the Bacteria Howler and the Skin-Stealer) that notice you gradually, hunt by sight and sound, and come back after they die.
- A pacing director that alternates pressure with quieter stretches.
- Random layouts every run, plus a daily layout that is the same for everyone that day; best times kept per difficulty (Standard, Nightmare).
- Doors you can close behind you, desks to hide under, junction arrows that mostly point to the exit.
- New-player briefing and tips; settings for quality (Auto/Low/Medium/High), mouse sensitivity, field of view, screen shake, reduced motion and flashing, interface size, toggle aim/sprint/crouch, and fully rebindable keys.

## Controls

| Action | Default |
|---|---|
| Move | `W` `A` `S` `D` |
| Look | Mouse |
| Sprint | `Shift` |
| Crouch / hide | `C` |
| Open / close door | `E` |
| Flashlight | `F` |
| Fire | Left mouse / `Space` |
| Aim | Right mouse |
| Reload | `R` |
| Mute | `M` |
| Pause | `Esc` |

All keys can be changed in Settings.

## Local development

Working on the game, by hand or with an agent: start with [AGENTS.md](AGENTS.md) (commands, how PRs land, the playtest rule, debug hooks).

```bash
bun install          # or npm install
npm run dev          # http://localhost:3000
npm run lint         # typecheck
npm test             # maze, combat, storage, entities, perf, director and controls tests
npm run build
```

Reviews and audits of the game are in [docs/review](docs/review/README.md).

## Art & AI

- **Art and sound:** every texture and sound is generated in code (`src/game/textures.ts`, `src/game/audio.ts`); there are no image or audio files and no third-party assets. The game makes no AI calls at runtime.
- **Code:** the first build was generated in Google AI Studio. Later work (bug fixes, the survival-horror loop, layouts, onboarding, settings, performance, entity AI and pacing) was done with Claude Code (Claude Opus 5.5) as an AI pair programmer, under Jacky Yao's direction.
