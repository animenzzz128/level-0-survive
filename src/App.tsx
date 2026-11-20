import { useEffect, useMemo, useRef, useState } from 'react';
import { GameHud, RunSummary } from './components/GameHud';
import { CreditsPanel } from './components/CreditsPanel';
import { HowToPlay } from './components/HowToPlay';
import { SettingsPanel } from './components/SettingsPanel';
import { BackroomsEngine } from './game/BackroomsEngine';
import { DEFAULT_BINDINGS, keyHintsFor } from './game/controls';
import {
  GameSettings,
  RunMode,
  dailySeed,
  getRecord,
  hasSeenHowTo,
  loadSettings,
  markHowToSeen,
  recordRun,
  resetGuide,
  saveSettings,
  todayLabel,
} from './game/storage';
import { DifficultyMode, HudState } from './game/types';

const INITIAL_HUD: HudState = {
  keyHints: keyHintsFor(DEFAULT_BINDINGS),
  phase: 'title',
  difficulty: 'standard',
  health: 100,
  maxHealth: 100,
  stamina: 100,
  winded: false,
  battery: 100,
  flashlightOn: true,
  ammoInMag: 12,
  magCapacity: 12,
  ammoReserve: 12,
  isReloading: false,
  isAiming: false,
  tapesCollected: 0,
  tapesTotal: 4,
  exitUnlocked: false,
  exitDistanceMeters: 0,
  exitBearingRad: 0,
  nearestEntityDist: 99,
  nearestEntityLabel: null,
  elapsedSeconds: 0,
  kills: 0,
  shotsFired: 0,
  shotsHit: 0,
  damageTaken: 0,
  damageFlash: 0,
  damageDirectionDeg: null,
  damageDirectionAlpha: 0,
  killedBy: null,
  signalLost: false,
  reduceFlashing: false,
  hitmarkerState: 'none',
  crosshairSpread: 0,
  pointerLocked: false,
  pointerLockBlocked: false,
  crouched: false,
  hidden: false,
  threatLevel: 0,
  muted: false,
  notification: null,
  tip: null,
  tapeLog: null,
  seed: 0,
  interactPrompt: null,
  webglError: null,
};

export default function App() {
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<BackroomsEngine | null>(null);
  const [hud, setHud] = useState<HudState>(INITIAL_HUD);
  const [difficulty, setDifficulty] = useState<DifficultyMode>('standard');
  const [mode, setMode] = useState<RunMode>('random');
  const [settings, setSettings] = useState<GameSettings>(() => loadSettings());
  // First visit opens the briefing automatically; afterwards it lives behind "How to Play".
  const [panel, setPanel] = useState<'none' | 'howto' | 'settings' | 'credits'>(() => (hasSeenHowTo() ? 'none' : 'howto'));
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [recordsVersion, setRecordsVersion] = useState(0);
  const runRef = useRef<{ difficulty: DifficultyMode; mode: RunMode; dailyLabel: string; recorded: boolean } | null>(
    null,
  );
  const dailyLabel = todayLabel();
  // The control that opened a dialog gets focus back when it closes.
  const panelOpenerRef = useRef<HTMLElement | null>(null);
  const openPanel = (next: 'howto' | 'settings' | 'credits') => {
    const active = document.activeElement;
    panelOpenerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setPanel(next);
  };
  const closePanel = () => {
    setPanel('none');
    const opener = panelOpenerRef.current;
    panelOpenerRef.current = null;
    // After the HUD becomes interactive again (its own focus effect runs first).
    if (opener) window.setTimeout(() => opener.focus({ preventScroll: true }), 0);
  };

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const engine = new BackroomsEngine(container, (nextHud) => {
      setHud(nextHud);
    });
    engineRef.current = engine;

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.applySettings(settings);
    saveSettings(settings);
  }, [settings]);

  // Interface scale: every rem-based size (text, spacing, panels) follows the root font size.
  useEffect(() => {
    document.documentElement.style.fontSize = `${16 * settings.uiScale}px`;
  }, [settings.uiScale]);

  useEffect(() => {
    if (engineRef.current) engineRef.current.uiOverlayOpen = panel !== 'none';
  }, [panel]);

  // Record each finished run exactly once
  useEffect(() => {
    const run = runRef.current;
    if (!run || run.recorded) return;
    if (hud.phase !== 'victory' && hud.phase !== 'gameover') return;
    run.recorded = true;
    const { isNewBest, record } = recordRun(
      run.difficulty,
      run.mode,
      hud.phase === 'victory',
      hud.elapsedSeconds,
      run.dailyLabel,
    );
    setSummary({
      mode: run.mode,
      dailyLabel: run.dailyLabel,
      bestTime: record.bestTime,
      isNewBest,
      escapes: record.escapes,
      deaths: record.deaths,
    });
    setRecordsVersion((v) => v + 1);
  }, [hud.phase, hud.elapsedSeconds]);

  const bestTimes = useMemo(
    () => ({
      all: getRecord(difficulty, 'random', dailyLabel).bestTime,
      daily: getRecord(difficulty, 'daily', dailyLabel).bestTime,
    }),
    // recordsVersion: re-read after a run is recorded
    [difficulty, dailyLabel, recordsVersion],
  );

  /** Daily runs always use today's seed; otherwise a given seed replays a layout, none rolls a new one. */
  const startRun = (runMode: RunMode, seed?: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    const label = todayLabel();
    runRef.current = { difficulty, mode: runMode, dailyLabel: label, recorded: false };
    setSummary(null);
    engine.startNewGame(difficulty, runMode === 'daily' ? dailySeed(label) : seed);
  };
  const currentMode = runRef.current?.mode ?? mode;

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#0d0c08]">
      {/* Dedicated empty mount container for Three.js WebGL canvas */}
      <div ref={canvasContainerRef} className="absolute inset-0 h-full w-full" />

      <GameHud
        hud={hud}
        selectedDifficulty={difficulty}
        onSelectDifficulty={setDifficulty}
        selectedMode={mode}
        onSelectMode={setMode}
        dailyLabel={dailyLabel}
        bestTimes={bestTimes}
        summary={summary}
        onStart={() => startRun(mode)}
        onResume={() => engineRef.current?.resumeGame()}
        onRestart={() => startRun(currentMode)}
        onRetryLayout={() => startRun(currentMode, hud.seed)}
        onReturnTitle={() => engineRef.current?.returnToTitle()}
        onToggleMute={() => engineRef.current?.toggleMute()}
        onRequestLock={() => engineRef.current?.requestLock()}
        onOpenHowTo={() => openPanel('howto')}
        onOpenSettings={() => openPanel('settings')}
        onOpenCredits={() => openPanel('credits')}
        inert={panel !== 'none'}
      />

      {panel === 'howto' && (
        <HowToPlay
          keyHints={hud.keyHints}
          onClose={() => {
            markHowToSeen();
            closePanel();
          }}
        />
      )}
      {panel === 'settings' && (
        <SettingsPanel
          settings={settings}
          autoQuality={engineRef.current?.resolveQuality('auto') ?? 'high'}
          onChange={setSettings}
          onResetTips={() => {
            resetGuide();
            engineRef.current?.resetTips();
          }}
          onClose={closePanel}
        />
      )}
      {panel === 'credits' && <CreditsPanel onClose={closePanel} />}
    </main>
  );
}
