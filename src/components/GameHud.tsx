import React, { useEffect, useRef } from 'react';
import { Volume2, VolumeX, Flashlight, Crosshair } from 'lucide-react';
import { DifficultyMode, HudState } from '../game/types';
import { RunMode } from '../game/storage';
import { ENTITY_GUIDE } from '../game/entityGuide';

export interface RunSummary {
  mode: RunMode;
  dailyLabel: string;
  /** Best escape time for this difficulty (daily: for today's layout). */
  bestTime: number | null;
  isNewBest: boolean;
  escapes: number;
  deaths: number;
}

interface GameHudProps {
  hud: HudState;
  selectedDifficulty: DifficultyMode;
  onSelectDifficulty: (diff: DifficultyMode) => void;
  selectedMode: RunMode;
  onSelectMode: (mode: RunMode) => void;
  dailyLabel: string;
  /** Best escape times shown on the title screen. */
  bestTimes: { all: number | null; daily: number | null };
  /** Outcome of the run that just ended (results screen). */
  summary: RunSummary | null;
  onStart: () => void;
  onResume: () => void;
  onRestart: () => void;
  onRetryLayout: () => void;
  onReturnTitle: () => void;
  onToggleMute: () => void;
  onRequestLock: () => void;
  onOpenHowTo: () => void;
  onOpenSettings: () => void;
  /** A dialog is open on top: the HUD must not take focus or clicks (game-ui-ux: focus stays in the modal). */
  inert?: boolean;
}

function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  const hrs = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(hrs).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatBest(seconds: number | null): string {
  return seconds === null ? '--:--:--' : formatTimecode(seconds);
}

export const GameHud: React.FC<GameHudProps> = ({
  hud,
  selectedDifficulty,
  onSelectDifficulty,
  selectedMode,
  onSelectMode,
  dailyLabel,
  bestTimes,
  summary,
  onStart,
  onResume,
  onRestart,
  onRetryLayout,
  onReturnTitle,
  onToggleMute,
  onRequestLock,
  onOpenHowTo,
  onOpenSettings,
  inert = false,
}) => {
  const startRef = useRef<HTMLButtonElement>(null);
  const resumeRef = useRef<HTMLButtonElement>(null);
  const resultTitleRef = useRef<HTMLHeadingElement>(null);

  // Every screen puts keyboard focus somewhere sensible when it appears. The results screen focuses its
  // heading, not "Play Again": a player still holding Space from firing would otherwise restart on release.
  useEffect(() => {
    if (inert) return;
    const target =
      hud.phase === 'title'
        ? startRef.current
        : hud.phase === 'paused'
          ? resumeRef.current
          : hud.phase === 'victory' || hud.phase === 'gameover'
            ? resultTitleRef.current
            : null;
    target?.focus({ preventScroll: true });
  }, [hud.phase, inert]);

  const accuracy =
    hud.shotsFired > 0 ? Math.round((hud.shotsHit / hud.shotsFired) * 100) : 0;

  // Bearing arrow rotation in degrees for Exit compass when unlocked
  const exitDeg = Math.round((hud.exitBearingRad * 180) / Math.PI);

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between overflow-hidden" inert={inert}>
      {/* Subtle VHS scanline & dark vignette texture (no backdrop-filter!) */}
      <div className="vhs-scanlines pointer-events-none absolute inset-0 opacity-45" />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at center, rgba(0,0,0,0) 54%, rgba(6,5,3,0.72) 100%)',
        }}
      />

      {/* Low vitality: a slow pulsing edge (static with Reduce flashing), so the warning is not just a red number */}
      {hud.phase === 'playing' && hud.health <= 35 && (
        <div
          className={`pointer-events-none absolute inset-0 ${hud.reduceFlashing ? '' : 'animate-pulse'}`}
          style={{
            opacity: 0.25 + ((35 - hud.health) / 35) * 0.35,
            background:
              'radial-gradient(circle at center, rgba(120,10,10,0) 50%, rgba(120,10,10,0.75) 100%)',
          }}
        />
      )}

      {/* Damage flash, kept soft: the directional wedge says where the hit came from */}
      {hud.damageFlash > 0.02 && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            opacity: Math.min(hud.reduceFlashing ? 0.3 : 1, hud.damageFlash * 0.35),
            background:
              'radial-gradient(circle at center, rgba(160,18,18,0) 35%, rgba(160,18,18,0.85) 100%)',
          }}
        />
      )}

      {/* Hit direction: a red wedge on the screen edge facing the attacker (0deg = ahead, clockwise) */}
      {hud.phase === 'playing' && hud.damageDirectionDeg !== null && hud.damageDirectionAlpha > 0.02 && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            opacity: hud.damageDirectionAlpha,
            background: `conic-gradient(from ${hud.damageDirectionDeg - 30}deg at 50% 50%, rgba(190,24,24,0.9) 0deg 60deg, rgba(0,0,0,0) 60deg 360deg)`,
            WebkitMaskImage: 'radial-gradient(circle at center, transparent 42%, black 80%)',
            maskImage: 'radial-gradient(circle at center, transparent 42%, black 80%)',
          }}
        />
      )}

      {/* WebGL Error Fallback */}
      {hud.webglError && (
        <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-[#0d0c08] p-6">
          <div className="max-w-md border border-[#d4be74]/25 bg-[#17150e] p-6 text-center">
            <h2 className="font-display text-2xl font-semibold tracking-wide text-[#ebe3c5]">
              WebGL Renderer Unavailable
            </h2>
            <p className="mt-2 text-sm text-[#bfb693]">{hud.webglError}</p>
          </div>
        </div>
      )}

      {/* ACTIVE GAMEPLAY HUD */}
      {hud.phase === 'playing' && (
        <>
          {/* Subtle Camcorder Viewfinder Corner Brackets */}
          <div className="pointer-events-none absolute inset-4 z-0">
            <span className="absolute left-0 top-0 h-3.5 w-3.5 border-l border-t border-[#d4be74]/30" />
            <span className="absolute right-0 top-0 h-3.5 w-3.5 border-r border-t border-[#d4be74]/30" />
            <span className="absolute bottom-0 left-0 h-3.5 w-3.5 border-b border-l border-[#d4be74]/30" />
            <span className="absolute bottom-0 right-0 h-3.5 w-3.5 border-b border-r border-[#d4be74]/30" />
          </div>

          {/* Top Bar: VHS REC Left · Objective Center · Mute/Controls Right */}
          <div className="relative z-10 flex items-start justify-between px-6 pt-5">
            {/* Top-Left Camcorder Readout */}
            <div className="flex flex-col gap-1 text-[#ebe3c5]">
              <div className="flex items-center gap-2 font-mono-hud text-xs tracking-wider">
                <span className="inline-block h-2.5 w-2.5 bg-[#d93829]" />
                <span className="font-semibold text-[#f5efe0]">REC</span>
                <span className="text-[#a89e79]">·</span>
                <span className="text-[#d4be74]">CAM-04</span>
                <span className="text-[#a89e79]">·</span>
                <span className="text-[#cfc6a6]">{formatTimecode(hud.elapsedSeconds)}</span>
              </div>
              <div className="font-mono-hud text-[11px] text-[#9e9472]">
                LEVEL 0 · MONO-YELLOW SECTOR
              </div>
              <div
                className="flex items-center gap-1 font-mono-hud text-[11px] text-[#9e9472]"
                title="Rises with every tape you take"
              >
                <span className="mr-1">THREAT</span>
                {Array.from({ length: 5 }).map((_, idx) => (
                  <span
                    key={idx}
                    className={`h-1.5 w-3 ${idx <= hud.threatLevel ? 'bg-[#d93829]' : 'bg-[#363122]'}`}
                  />
                ))}
              </div>
            </div>

            {/* Top-Center Mission Objective */}
            <div className="flex flex-col items-center gap-1.5 border border-[#d4be74]/25 bg-[#0e0d09]/80 px-5 py-2">
              <div className="flex items-center gap-3 text-xs font-medium tracking-wide text-[#f2ead0]">
                <span>
                  {hud.exitUnlocked
                    ? 'Sector Exit Unlocked'
                    : `VHS Data Tapes: ${hud.tapesCollected} / ${hud.tapesTotal}`}
                </span>
                <span className="text-[#8a805f]">·</span>
                <span className="font-mono-hud text-[#d4be74]">
                  {hud.exitUnlocked
                    ? `Exit ${hud.exitDistanceMeters.toFixed(1)}m`
                    : `${hud.kills} Neutralized`}
                </span>
              </div>
              {/* Segmented tape indicator */}
              <div className="flex items-center gap-1.5">
                {Array.from({ length: hud.tapesTotal }).map((_, idx) => (
                  <span
                    key={idx}
                    className={`h-1.5 w-7 transition-colors ${
                      idx < hud.tapesCollected
                        ? 'bg-[#e8b838]'
                        : 'bg-[#363122]'
                    }`}
                  />
                ))}
                {hud.exitUnlocked && (
                  <span
                    className="ml-2 font-mono-hud text-[11px] text-[#5ce696]"
                    style={{
                      display: 'inline-block',
                      transform: `rotate(${exitDeg}deg)`,
                    }}
                    title="Exit Direction"
                  >
                    ▲
                  </span>
                )}
              </div>
            </div>

            {/* Top-Right Audio Toggle & Pointer Prompt */}
            <div className="pointer-events-auto flex items-center gap-2">
              {hud.pointerLockBlocked && (
                <span className="max-w-[220px] text-right text-[11px] leading-snug text-[#e8b838]">
                  This page blocks mouse capture. Open the game in its own browser tab for full mouse look.
                </span>
              )}
              {!hud.pointerLocked && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    onRequestLock();
                  }}
                  className="border border-[#d4be74]/35 bg-[#17150e]/90 px-3 py-1.5 text-xs font-medium text-[#ebe3c5] transition-colors hover:border-[#e8b838] hover:text-white"
                >
                  Lock Cursor
                </button>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  onToggleMute();
                }}
                aria-label={hud.muted ? 'Unmute audio' : 'Mute audio'}
                className="flex h-8 w-8 items-center justify-center border border-[#d4be74]/25 bg-[#17150e]/85 text-[#d4be74] transition-colors hover:border-[#e8b838] hover:text-white"
              >
                {hud.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* New-player tip (left) */}
          {hud.tip && (
            <div
              key={hud.tip.id}
              className="absolute left-6 top-56 z-10 max-w-xs border-l-2 border-[#e8b838] bg-[#0e0d09]/88 px-4 py-3"
              role="status"
            >
              <div className="font-mono-hud text-[11px] tracking-wider text-[#e8b838]">
                TIP · {hud.tip.title.toUpperCase()}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-[#ebe3c5]">{hud.tip.text}</div>
            </div>
          )}

          {/* Recovered tape playing back */}
          {hud.tapeLog && (
            <div className="absolute left-1/2 top-24 z-10 w-[min(560px,90vw)] -translate-x-1/2 border border-[#d4be74]/30 bg-[#0b0a07]/90 px-5 py-3">
              <div className="flex items-center justify-between font-mono-hud text-[11px] tracking-wider">
                <span className="text-[#e8b838]">▶ PLAY · VHS LOG {String(hud.tapeLog.index).padStart(2, '0')}/{String(hud.tapeLog.total).padStart(2, '0')}</span>
                <span className="text-[#786f50]">SP · TRACKING</span>
              </div>
              <p className="mt-2 min-h-[2.5rem] font-mono-hud text-xs leading-relaxed text-[#f2ead0]">
                {hud.tapeLog.text.slice(0, hud.tapeLog.shownChars)}
                {hud.tapeLog.shownChars < hud.tapeLog.text.length && <span className="animate-pulse">▌</span>}
              </p>
            </div>
          )}

          {/* Center Crosshair, Hitmarker & Contextual Prompts */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {/* Dynamic Crosshair */}
            {!hud.isAiming && (
              <div className="relative h-10 w-10">
                <span
                  className="absolute left-1/2 top-1/2 h-[2px] w-[2px] -translate-x-1/2 -translate-y-1/2 bg-[#f5efe0]/85"
                />
                {/* Top tick */}
                <span
                  className="absolute left-1/2 h-2 w-[1.5px] -translate-x-1/2 bg-[#f5efe0]/80"
                  style={{ top: `${10 - hud.crosshairSpread * 10}px` }}
                />
                {/* Bottom tick */}
                <span
                  className="absolute left-1/2 h-2 w-[1.5px] -translate-x-1/2 bg-[#f5efe0]/80"
                  style={{ bottom: `${10 - hud.crosshairSpread * 10}px` }}
                />
                {/* Left tick */}
                <span
                  className="absolute top-1/2 h-[1.5px] w-2 -translate-y-1/2 bg-[#f5efe0]/80"
                  style={{ left: `${10 - hud.crosshairSpread * 10}px` }}
                />
                {/* Right tick */}
                <span
                  className="absolute top-1/2 h-[1.5px] w-2 -translate-y-1/2 bg-[#f5efe0]/80"
                  style={{ right: `${10 - hud.crosshairSpread * 10}px` }}
                />
              </div>
            )}

            {/* Hitmarker */}
            {hud.hitmarkerState !== 'none' && (
              <div
                className={`absolute ${hud.hitmarkerState === 'head' ? 'h-8 w-8' : 'h-6 w-6'} ${
                  hud.hitmarkerState === 'kill'
                    ? 'text-[#ef4444]'
                    : hud.hitmarkerState === 'immune'
                      ? 'text-[#7d8fa3]'
                      : hud.hitmarkerState === 'head'
                        ? 'text-[#ffc861]'
                        : 'text-[#fff7d6]'
                }`}
              >
                <span
                  className={`absolute left-1/2 top-1/2 ${hud.hitmarkerState === 'head' ? 'h-4 w-[3px]' : 'h-3 w-[2px]'} -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current`}
                />
                <span
                  className={`absolute left-1/2 top-1/2 ${hud.hitmarkerState === 'head' ? 'h-4 w-[3px]' : 'h-3 w-[2px]'} -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-current`}
                />
              </div>
            )}

            {/* Notification & Interact Prompts in lower center so upper architecture stays clear */}
            {hud.notification && (
              <div
                className={`absolute bottom-24 border px-4 py-2 text-xs font-medium tracking-wide ${
                  hud.notification.tone === 'success'
                    ? 'border-[#5ce696]/45 bg-[#0f1d14]/92 text-[#b7f7cf]'
                    : hud.notification.tone === 'warning' || hud.notification.tone === 'danger'
                      ? 'border-[#ef4444]/50 bg-[#241010]/92 text-[#fecaca]'
                      : 'border-[#d4be74]/35 bg-[#14120c]/92 text-[#ebe3c5]'
                }`}
              >
                {hud.notification.text}
              </div>
            )}

            {hud.interactPrompt && (
              <div className="absolute bottom-36 border border-[#d4be74]/40 bg-[#12100b]/92 px-4 py-1.5 font-mono-hud text-xs tracking-wider text-[#f5efe0]">
                {hud.interactPrompt}
              </div>
            )}
          </div>

          {/* Bottom Bar: Vitality/Stamina/Battery Left · Weapon/Ammo Right */}
          <div className="relative z-10 flex items-end justify-between px-6 pb-5">
            {/* Bottom-Left Survivor Vitals */}
            <div className="flex flex-col gap-2.5 border border-[#d4be74]/20 bg-[#0e0d09]/82 px-4 py-3 min-w-[230px]">
              {(hud.crouched || hud.hidden) && (
                <div
                  className={`font-mono-hud text-[11px] tracking-wider ${
                    hud.hidden ? 'text-[#5ce696]' : 'text-[#e8b838]'
                  }`}
                >
                  {hud.hidden ? 'HIDDEN · they cannot see you here' : 'CROUCHED · silent, slow, harder to spot'}
                </div>
              )}
              {/* Health */}
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#bfb693]">Vitality</span>
                  <span
                    className={`font-mono-hud font-semibold ${
                      hud.health <= 30 ? 'text-[#f87171]' : 'text-[#f5efe0]'
                    }`}
                  >
                    {hud.health}%
                  </span>
                </div>
                <div className="h-1.5 w-full bg-[#292519]">
                  <div
                    className={`h-full transition-all duration-150 ${
                      hud.health <= 30 ? 'bg-[#dc2626]' : 'bg-[#d4be74]'
                    }`}
                    style={{ width: `${Math.max(0, Math.min(100, hud.health))}%` }}
                  />
                </div>
              </div>

              {/* Stamina & Flashlight Battery */}
              <div className="grid grid-cols-2 gap-3 pt-0.5">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[11px] text-[#9e9472]">
                    <span className={hud.winded ? 'text-[#f87171]' : undefined}>
                      {hud.winded ? 'Winded' : 'Stamina'}
                    </span>
                    <span className="font-mono-hud">{hud.stamina}%</span>
                  </div>
                  <div className="h-1 w-full bg-[#292519]">
                    <div
                      className={`h-full ${hud.winded ? 'bg-[#b45309]' : 'bg-[#a89f7c]'}`}
                      style={{ width: `${hud.stamina}%` }}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[11px] text-[#9e9472]">
                    <span className={`flex items-center gap-1 ${hud.battery <= 25 ? 'text-[#f87171]' : ''}`}>
                      <Flashlight className="h-3 w-3" />
                      {hud.battery <= 25 ? 'Light LOW' : 'Light'}
                    </span>
                    <span className="font-mono-hud">{hud.battery}%</span>
                  </div>
                  <div className="h-1 w-full bg-[#292519]">
                    <div
                      className={`h-full ${
                        hud.battery <= 25 ? 'bg-[#dc2626]' : hud.flashlightOn ? 'bg-[#f5d061]' : 'bg-[#5c553e]'
                      }`}
                      style={{ width: `${hud.battery}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom-Center Subtle Controls Hint */}
            <div className="hidden md:flex items-center gap-3 border border-[#d4be74]/15 bg-[#0e0d09]/78 px-3.5 py-1.5 font-mono-hud text-[11px] text-[#cfc6a6]">
              <span>WASD Move</span>
              <span className="text-[#786f50]">·</span>
              <span>Shift Sprint</span>
              <span className="text-[#786f50]">·</span>
              <span>C Crouch</span>
              <span className="text-[#786f50]">·</span>
              <span>E Door</span>
              <span className="text-[#786f50]">·</span>
              <span>LMB / Space Fire</span>
              <span className="text-[#786f50]">·</span>
              <span>RMB Aim</span>
              <span className="text-[#786f50]">·</span>
              <span>R Reload</span>
              <span className="text-[#786f50]">·</span>
              <span>F Light</span>
            </div>

            {/* Bottom-Right Weapon & Ammo */}
            <div className="flex flex-col items-end gap-1 border border-[#d4be74]/20 bg-[#0e0d09]/82 px-4 py-3 min-w-[180px]">
              <div className="flex items-center gap-2 text-[11px] text-[#9e9472]">
                <Crosshair className="h-3.5 w-3.5 text-[#d4be74]" />
                <span>Suppressed 9mm</span>
              </div>
              <div className="flex items-baseline gap-1.5 font-mono-hud">
                <span
                  className={`text-3xl font-semibold leading-none ${
                    hud.ammoInMag <= 3 ? 'text-[#f87171]' : 'text-[#f5efe0]'
                  }`}
                >
                  {String(hud.ammoInMag).padStart(2, '0')}
                </span>
                <span className="text-sm text-[#8a805f]">/</span>
                <span className="text-base text-[#bfb693]">{hud.ammoReserve}</span>
              </div>
              <div className="h-4 font-mono-hud text-[11px]">
                {hud.isReloading ? (
                  <span className="text-[#e8b838]">Reloading...</span>
                ) : hud.ammoInMag === 0 ? (
                  <span className="text-[#f87171]">
                    {hud.ammoReserve > 0 ? 'Press [R] to Reload' : 'Out of Ammo'}
                  </span>
                ) : (
                  <span className="text-[#8a805f]">
                    {hud.nearestEntityDist < 12
                      ? `Anomaly ${hud.nearestEntityDist.toFixed(1)}m`
                      : 'Signal Clear'}
                  </span>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* TITLE SCREEN OVERLAY (Over Live 3D Corridor) */}
      {hud.phase === 'title' && (
        <div className="pointer-events-auto relative z-20 flex h-full w-full flex-col justify-between p-8 md:p-12">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 font-mono-hud text-xs tracking-wider text-[#d4be74]">
              <span className="inline-block h-2 w-2 bg-[#d93829]" />
              <span>VHS ARCHIVE 04</span>
              <span className="text-[#786f50]">·</span>
              <span className="text-[#bfb693]">LEVEL 0 THRESHOLD</span>
            </div>
            <button
              type="button"
              onClick={onToggleMute}
              className="flex items-center gap-2 border border-[#d4be74]/25 bg-[#12100a]/85 px-3 py-1.5 text-xs font-medium text-[#ebe3c5] hover:border-[#e8b838]"
            >
              {hud.muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              <span>{hud.muted ? 'Audio Muted' : 'Audio On'}</span>
            </button>
          </div>

          <div className="max-w-xl border border-[#d4be74]/25 bg-[#0e0d09]/88 p-8">
            <div className="font-mono-hud text-xs tracking-wider text-[#d4be74]">
              600 MILLION SQUARE MILES · MONO-YELLOW CORRIDORS
            </div>
            <h1 className="font-display mt-2 text-5xl font-bold tracking-tight text-[#f7f1dc] md:text-6xl">
              LEVEL 0: THRESHOLD
            </h1>
            <p className="mt-4 text-sm leading-relaxed text-[#cfc6a6]">
              Trapped beneath endlessly humming fluorescent fixtures with a suppressed sidearm, one
              spare magazine and a dying flashlight. Recover all 4 VHS Data Tapes to unseal the
              Sector 00 Exit. Every tape you take wakes the level a little more, and what you kill
              does not stay dead.
            </p>

            {/* Layout mode */}
            <div className="mt-6 flex flex-col gap-2">
              <span className="text-xs font-medium text-[#bfb693]">Layout</span>
              <div className="inline-flex w-fit border border-[#d4be74]/25 bg-[#17150e] p-1">
                <button
                  type="button"
                  onClick={() => onSelectMode('random')}
                  aria-pressed={selectedMode === 'random'}
                  className={`px-4 py-1.5 text-xs font-medium transition-colors ${
                    selectedMode === 'random' ? 'bg-[#d4be74] text-[#0e0d09]' : 'text-[#bfb693] hover:text-white'
                  }`}
                >
                  New every run
                </button>
                <button
                  type="button"
                  onClick={() => onSelectMode('daily')}
                  aria-pressed={selectedMode === 'daily'}
                  className={`px-4 py-1.5 text-xs font-medium transition-colors ${
                    selectedMode === 'daily' ? 'bg-[#d4be74] text-[#0e0d09]' : 'text-[#bfb693] hover:text-white'
                  }`}
                >
                  Daily · {dailyLabel}
                </button>
              </div>
            </div>

            {/* Difficulty Selection */}
            <div className="mt-4 flex flex-col gap-2">
              <span className="text-xs font-medium text-[#bfb693]">Difficulty</span>
              <div className="inline-flex w-fit border border-[#d4be74]/25 bg-[#17150e] p-1">
                <button
                  type="button"
                  onClick={() => onSelectDifficulty('standard')}
                  aria-pressed={selectedDifficulty === 'standard'}
                  className={`px-4 py-1.5 text-xs font-medium transition-colors ${
                    selectedDifficulty === 'standard'
                      ? 'bg-[#d4be74] text-[#0e0d09]'
                      : 'text-[#bfb693] hover:text-white'
                  }`}
                >
                  Standard
                </button>
                <button
                  type="button"
                  onClick={() => onSelectDifficulty('nightmare')}
                  aria-pressed={selectedDifficulty === 'nightmare'}
                  className={`px-4 py-1.5 text-xs font-medium transition-colors ${
                    selectedDifficulty === 'nightmare'
                      ? 'bg-[#b91c1c] text-white'
                      : 'text-[#bfb693] hover:text-white'
                  }`}
                >
                  Nightmare
                </button>
              </div>
            </div>

            <div className="mt-7 flex flex-wrap items-center gap-4">
              <button
                type="button"
                ref={startRef}
                onClick={onStart}
                className="bg-[#e8b838] px-7 py-3 text-sm font-semibold tracking-wide text-[#0d0c08] transition-colors hover:bg-[#f5cb5c]"
              >
                Enter Level 0
              </button>
              <button
                type="button"
                onClick={onOpenHowTo}
                className="border border-[#d4be74]/35 px-4 py-3 text-sm font-medium text-[#ebe3c5] hover:border-[#e8b838] hover:text-white"
              >
                How to Play
              </button>
              <button
                type="button"
                onClick={onOpenSettings}
                className="border border-[#d4be74]/20 px-4 py-3 text-sm font-medium text-[#bfb693] hover:border-[#e8b838] hover:text-white"
              >
                Settings
              </button>
            </div>
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 font-mono-hud text-xs text-[#9e9472]">
              <span>
                Best escape ({selectedDifficulty}): <span className="text-[#f5efe0]">{formatBest(bestTimes.all)}</span>
              </span>
              <span>
                Today&apos;s daily: <span className="text-[#f5efe0]">{formatBest(bestTimes.daily)}</span>
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 font-mono-hud text-xs text-[#9e9472]">
            <span>Howler hunts by sound · Smiler fears your light · Skin-Stealer mimics supplies</span>
            <span>Close doors behind you · Hide under desks · Batteries do not recharge</span>
          </div>
        </div>
      )}

      {/* PAUSE OVERLAY */}
      {hud.phase === 'paused' && (
        <div className="pointer-events-auto relative z-20 flex h-full w-full items-center justify-center bg-[#090805]/75 p-6">
          <div className="w-full max-w-md border border-[#d4be74]/30 bg-[#12100a] p-7">
            <h2 className="font-display text-3xl font-semibold tracking-wide text-[#f7f1dc]">
              Paused
            </h2>
            <p className="mt-1 font-mono-hud text-xs text-[#bfb693]">
              Tapes {hud.tapesCollected}/{hud.tapesTotal} · Elapsed {formatTimecode(hud.elapsedSeconds)}
            </p>
            <div className="mt-6 flex flex-col gap-2.5">
              <button
                type="button"
                ref={resumeRef}
                onClick={onResume}
                className="w-full bg-[#e8b838] px-5 py-2.5 text-sm font-semibold text-[#0d0c08] hover:bg-[#f5cb5c]"
              >
                Resume
              </button>
              <button
                type="button"
                onClick={onOpenSettings}
                className="w-full border border-[#d4be74]/30 bg-[#1a1710] px-5 py-2.5 text-sm font-medium text-[#ebe3c5] hover:border-[#e8b838]"
              >
                Settings
              </button>
              <button
                type="button"
                onClick={onRestart}
                className="w-full border border-[#d4be74]/30 bg-[#1a1710] px-5 py-2.5 text-sm font-medium text-[#ebe3c5] hover:border-[#e8b838]"
              >
                Restart Sector
              </button>
              <button
                type="button"
                onClick={onReturnTitle}
                className="w-full border border-[#d4be74]/20 px-5 py-2.5 text-sm font-medium text-[#bfb693] hover:text-white"
              >
                Return to Menu
              </button>
            </div>
          </div>
        </div>
      )}

      {/* GAME OVER / VICTORY OVERLAY */}
      {(hud.phase === 'gameover' || hud.phase === 'victory') && (
        <div className="pointer-events-auto relative z-20 flex h-full w-full items-center justify-center bg-[#090805]/82 p-6">
          <div className="w-full max-w-lg border border-[#d4be74]/30 bg-[#12100a] p-8">
            <div
              className={`font-mono-hud text-xs tracking-wider ${
                hud.phase === 'victory' ? 'text-[#5ce696]' : 'text-[#f87171]'
              }`}
            >
              {hud.phase === 'victory' ? 'EXTRACTION CONFIRMED' : 'SIGNAL LOST // CAM-04'}
            </div>
            <h2
              ref={resultTitleRef}
              tabIndex={-1}
              className="font-display mt-1 text-4xl font-bold tracking-tight text-[#f7f1dc] outline-none"
            >
              {hud.phase === 'victory' ? 'Escaped Level 0' : 'Lost in the Maze'}
            </h2>
            <p className="mt-2 text-sm text-[#cfc6a6]">
              {hud.phase === 'victory'
                ? 'You unsealed the Sector 00 Threshold Door with all recovered VHS tapes.'
                : 'The fluorescent hum fades beneath damp carpet. Your recorder stopped transmitting.'}
            </p>

            {hud.phase === 'gameover' && hud.killedBy && (
              <div className="mt-4 border-l-2 border-[#f87171] bg-[#1a0f0f] px-4 py-3">
                <div className="font-mono-hud text-[11px] tracking-wider text-[#f87171]">
                  TAKEN BY THE {ENTITY_GUIDE[hud.killedBy].name.toUpperCase()}
                </div>
                <div className="mt-1 text-sm text-[#ebe3c5]">{ENTITY_GUIDE[hud.killedBy].counter}</div>
              </div>
            )}

            <div className="mt-6 grid grid-cols-2 gap-3 border-y border-[#d4be74]/20 py-4 font-mono-hud text-xs">
              <div>
                <div className="text-[#8a805f]">Survival Time</div>
                <div className="mt-0.5 text-lg font-semibold text-[#f5efe0]">
                  {formatTimecode(hud.elapsedSeconds)}
                </div>
              </div>
              <div>
                <div className="text-[#8a805f]">Tapes Recovered</div>
                <div className="mt-0.5 text-lg font-semibold text-[#f5efe0]">
                  {hud.tapesCollected} / {hud.tapesTotal}
                </div>
              </div>
              <div>
                <div className="text-[#8a805f]">Entities Neutralized</div>
                <div className="mt-0.5 text-lg font-semibold text-[#f5efe0]">
                  {hud.kills}
                </div>
              </div>
              <div>
                <div className="text-[#8a805f]">Shot Accuracy</div>
                <div className="mt-0.5 text-lg font-semibold text-[#f5efe0]">
                  {accuracy}%
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 font-mono-hud text-xs text-[#9e9472]">
              <span>
                {summary?.mode === 'daily' ? `DAILY ${summary.dailyLabel}` : 'LAYOUT'} · SEED{' '}
                <span className="select-text text-[#f5efe0]">{hud.seed}</span>
              </span>
              <span>
                {hud.phase === 'victory' && summary?.isNewBest ? (
                  <span className="text-[#5ce696]">NEW BEST ESCAPE</span>
                ) : (
                  <>
                    Best escape: <span className="text-[#f5efe0]">{formatBest(summary?.bestTime ?? null)}</span>
                    {summary && (
                      <span className="ml-2 text-[#8a805f]">
                        · {summary.escapes} escaped · {summary.deaths} lost
                      </span>
                    )}
                  </>
                )}
              </span>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onRestart}
                className="flex-1 bg-[#e8b838] px-5 py-3 text-sm font-semibold text-[#0d0c08] hover:bg-[#f5cb5c]"
              >
                {summary?.mode === 'daily' ? 'Play Again' : 'New Layout'}
              </button>
              <button
                type="button"
                onClick={onRetryLayout}
                className="border border-[#d4be74]/30 bg-[#1a1710] px-5 py-3 text-sm font-medium text-[#ebe3c5] hover:border-[#e8b838]"
              >
                Retry This Layout
              </button>
              <button
                type="button"
                onClick={onReturnTitle}
                className="border border-[#d4be74]/30 bg-[#1a1710] px-5 py-3 text-sm font-medium text-[#ebe3c5] hover:border-[#e8b838]"
              >
                Main Menu
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
