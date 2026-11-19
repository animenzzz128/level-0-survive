import { useEffect, useRef, useState } from 'react';
import { GameHud } from './components/GameHud';
import { BackroomsEngine } from './game/BackroomsEngine';
import { DifficultyMode, HudState } from './game/types';

const INITIAL_HUD: HudState = {
  phase: 'title',
  difficulty: 'standard',
  health: 100,
  maxHealth: 100,
  stamina: 100,
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
  hitmarkerState: 'none',
  crosshairSpread: 0,
  pointerLocked: false,
  pointerLockBlocked: false,
  crouched: false,
  hidden: false,
  threatLevel: 0,
  muted: false,
  notification: null,
  interactPrompt: null,
  webglError: null,
};

export default function App() {
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<BackroomsEngine | null>(null);
  const [hud, setHud] = useState<HudState>(INITIAL_HUD);
  const [difficulty, setDifficulty] = useState<DifficultyMode>('standard');

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

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#0d0c08]">
      {/* Dedicated empty mount container for Three.js WebGL canvas */}
      <div ref={canvasContainerRef} className="absolute inset-0 h-full w-full" />

      <GameHud
        hud={hud}
        selectedDifficulty={difficulty}
        onSelectDifficulty={setDifficulty}
        onStart={() => engineRef.current?.startNewGame(difficulty)}
        onResume={() => engineRef.current?.resumeGame()}
        onRestart={() => engineRef.current?.startNewGame(difficulty)}
        onReturnTitle={() => engineRef.current?.returnToTitle()}
        onToggleMute={() => engineRef.current?.toggleMute()}
        onRequestLock={() => engineRef.current?.requestLock()}
      />
    </main>
  );
}
