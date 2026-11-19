import type { EntityVoice } from './entities';
import type { EntityArchetype } from './types';

export type WorldSound = 'door_open' | 'door_close' | 'door_bash' | 'door_break' | 'claw';

/** Sounds farther than this (m) from the listener are not played at all (they would be inaudible anyway). */
const CULL_DISTANCE = 30;

/** Random variation of `amount` (fraction) around `value`, so repeated sounds are never identical. */
function vary(value: number, amount: number): number {
  return value * (1 + (Math.random() * 2 - 1) * amount);
}

interface Point3 {
  x: number;
  y: number;
  z: number;
}

function placePanner(panner: PannerNode, x: number, y: number, z: number): void {
  if (panner.positionX) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else {
    panner.setPosition(x, y, z);
  }
}

function createWorldPanner(ctx: AudioContext): PannerNode {
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 1.6;
  panner.maxDistance = 40;
  panner.rolloffFactor = 1.3;
  return panner;
}

/** HRTF-positioned sound source that follows one entity; muffled when a wall is in the way. */
class SpatialVoice implements EntityVoice {
  private readonly input: GainNode;
  private readonly occlusion: BiquadFilterNode;
  private readonly occlusionGain: GainNode;
  private readonly panner: PannerNode;
  private readonly reverbSend: GainNode;
  private readonly pos: Point3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: AudioContext,
    dry: AudioNode,
    reverb: AudioNode,
    private readonly noise: AudioBuffer,
    private readonly listener: Point3,
  ) {
    this.input = ctx.createGain();
    this.occlusion = ctx.createBiquadFilter();
    this.occlusion.type = 'lowpass';
    this.occlusion.frequency.value = 9000;
    this.occlusionGain = ctx.createGain();
    this.panner = createWorldPanner(ctx);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.5;
    this.input.connect(this.occlusion);
    this.occlusion.connect(this.occlusionGain);
    this.occlusionGain.connect(this.panner);
    this.panner.connect(dry);
    this.panner.connect(this.reverbSend);
    this.reverbSend.connect(reverb);
  }

  setPosition(x: number, y: number, z: number): void {
    if (this.ctx.state === 'closed') return;
    this.pos.x = x;
    this.pos.y = y;
    this.pos.z = z;
    placePanner(this.panner, x, y, z);
  }

  /** Behind a wall: muffled and quieter (a wall takes level away, not just treble). */
  setOccluded(occluded: boolean): void {
    if (this.ctx.state === 'closed') return;
    this.occlusion.frequency.setTargetAtTime(occluded ? 650 : 9000, this.ctx.currentTime, 0.08);
    this.occlusionGain.gain.setTargetAtTime(occluded ? 0.45 : 1, this.ctx.currentTime, 0.08);
  }

  /** Closed context or too far away to matter: skip the sound entirely. */
  private silent(): boolean {
    if (this.ctx.state === 'closed') return true;
    const dx = this.pos.x - this.listener.x;
    const dz = this.pos.z - this.listener.z;
    return dx * dx + dz * dz > CULL_DISTANCE * CULL_DISTANCE;
  }

  private noiseBurst(
    start: number,
    duration: number,
    type: BiquadFilterType,
    freq: number,
    peak: number,
    q = 0.8,
  ): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(peak, start + Math.min(0.02, duration * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.input);
    src.start(start, Math.random() * 1.2, duration + 0.05);
  }

  private tone(
    start: number,
    duration: number,
    type: OscillatorType,
    fromHz: number,
    toHz: number,
    peak: number,
    lowpass = 2000,
  ): void {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(fromHz, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), start + duration);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lowpass;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(peak, start + Math.min(0.04, duration * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(filter);
    filter.connect(g);
    g.connect(this.input);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  }

  playStep(heavy: boolean): void {
    if (this.silent()) return;
    const now = this.ctx.currentTime;
    this.noiseBurst(now, heavy ? 0.16 : 0.1, 'lowpass', vary(heavy ? 170 : 260, 0.12), vary(heavy ? 0.9 : 0.55, 0.15));
    if (heavy) this.tone(now, 0.18, 'sine', vary(70, 0.08), 38, 0.6, 400);
  }

  playScreech(archetype: EntityArchetype): void {
    if (this.silent()) return;
    const now = this.ctx.currentTime;
    if (archetype === 'howler') {
      // Ragged, warbling shriek
      const osc = this.ctx.createOscillator();
      const mod = this.ctx.createOscillator();
      const modGain = this.ctx.createGain();
      const band = this.ctx.createBiquadFilter();
      const g = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(380, now);
      osc.frequency.linearRampToValueAtTime(190, now + 0.55);
      mod.type = 'square';
      mod.frequency.value = 37;
      modGain.gain.value = 120;
      band.type = 'bandpass';
      band.frequency.value = 900;
      band.Q.value = 2.2;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(0.9, now + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
      mod.connect(modGain);
      modGain.connect(osc.frequency);
      osc.connect(band);
      band.connect(g);
      g.connect(this.input);
      osc.start(now);
      mod.start(now);
      osc.stop(now + 0.65);
      mod.stop(now + 0.65);
    } else if (archetype === 'smiler') {
      // Thin, detuned chord that rises like a held breath
      for (const [f, d] of [
        [880, 1.0],
        [932, 1.02],
        [1318, 0.98],
      ] as const) {
        this.tone(now, 0.9, 'sine', f * 0.9, f * d * 1.08, 0.22, 4000);
      }
      this.noiseBurst(now, 0.7, 'bandpass', 2600, 0.25, 3);
    } else {
      // Wet, low bellow
      this.tone(now, 0.75, 'sawtooth', 210, 85, 0.85, 700);
      this.noiseBurst(now, 0.6, 'lowpass', 500, 0.5);
    }
  }

  playIdle(archetype: EntityArchetype): void {
    if (this.silent()) return;
    const now = this.ctx.currentTime;
    if (archetype === 'howler') {
      // Clicking echolocation chirps
      for (let i = 0; i < 3; i++) {
        this.noiseBurst(now + i * 0.11, 0.035, 'bandpass', 2600 + Math.random() * 600, 0.7, 6);
      }
    } else if (archetype === 'smiler') {
      // Breathy whisper
      this.noiseBurst(now, 1.1, 'bandpass', 1300 + Math.random() * 300, 0.35, 2.5);
    } else {
      // Low, wet groan
      this.tone(now, 0.9, 'sawtooth', 78, 56, 0.4, 320);
    }
  }

  playWindup(archetype: EntityArchetype): void {
    if (this.silent()) return;
    const now = this.ctx.currentTime;
    // A short rising rasp: audible, directional warning that a blow lands in ~0.3 s.
    const base = archetype === 'brute' ? 90 : archetype === 'smiler' ? 520 : 200;
    this.tone(now, 0.32, 'sawtooth', base, base * 2.2, 0.55, archetype === 'smiler' ? 3000 : 1400);
    this.noiseBurst(now, 0.3, 'bandpass', archetype === 'brute' ? 500 : 1400, 0.4, 1.5);
  }

  playDeath(): void {
    if (this.silent()) return;
    const now = this.ctx.currentTime;
    this.tone(now, 0.7, 'sawtooth', 320, 40, 0.6, 1200);
    this.noiseBurst(now, 0.5, 'highpass', 3000, 0.45);
    for (let i = 0; i < 5; i++) {
      this.noiseBurst(now + 0.1 + i * 0.09, 0.03, 'bandpass', 4000, 0.4, 4);
    }
  }

  dispose(): void {
    try {
      this.input.disconnect();
      this.occlusion.disconnect();
      this.panner.disconnect();
      this.reverbSend.disconnect();
    } catch {
      /* ignore if context already closed */
    }
  }
}

const BUS_LEVELS = { ambient: 0.85, sfx: 0.75, world: 0.85, ui: 0.85 } as const;

export class HorrorAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  // Mix buses (audio-design skill): each has its own level and ducks on its own; the master only limits.
  private ambientBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private worldBus: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private paused = false;
  private readonly listenerPos: Point3 = { x: 0, y: 0, z: 0 };
  private reverbNode: ConvolverNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private humOsc1: OscillatorNode | null = null;
  private humOsc2: OscillatorNode | null = null;
  private humGain: GainNode | null = null;
  private droneOsc: OscillatorNode | null = null;
  private droneWobbleOsc: OscillatorNode | null = null;
  private droneGain: GainNode | null = null;
  private readonly pendingCleanupTimers = new Set<number>();
  private threatLevel = 0;
  private heartbeatTimer = 0;
  /** 0 = healthy, 1 = nearly dead: drives a laboured-breathing layer (a warning that is not colour-only). */
  private lowHealth = 0;
  private breathTimer = 0;
  private muted = false;
  private volume = 0.8;
  private started = false;

  public init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    this.ctx = new AudioCtx();
    // The master only limits peaks. The old master compressor (-16 dB, 6:1) pumped the whole mix, so the
    // ambience dipped after every gunshot.
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : this.outputLevel();

    const ctx = this.ctx;
    const master = this.masterGain;
    const makeBus = (level: number) => {
      const bus = ctx.createGain();
      bus.gain.value = level;
      bus.connect(master);
      return bus;
    };
    this.ambientBus = makeBus(BUS_LEVELS.ambient);
    this.sfxBus = makeBus(BUS_LEVELS.sfx);
    this.worldBus = makeBus(BUS_LEVELS.world);
    this.uiBus = makeBus(BUS_LEVELS.ui);

    this.reverbNode = this.ctx.createConvolver();
    this.reverbNode.buffer = this.buildCorridorImpulse(1.5, 2.8);

    const wetGain = this.ctx.createGain();
    wetGain.gain.value = 0.34;

    this.reverbNode.connect(wetGain);
    wetGain.connect(master);
    master.connect(limiter);
    limiter.connect(this.ctx.destination);
    this.applyBusLevels();

    this.noiseBuffer = this.buildNoiseBuffer(2.0);
    this.startFluorescentHum();
    this.started = true;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyOutputLevel();
  }

  /** Master volume from Settings, 0..1. */
  public setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.applyOutputLevel();
  }

  /** Squared, so the slider feels even: linear gain makes the top half of the range sound almost the same. */
  private outputLevel(): number {
    return 0.9 * this.volume * this.volume;
  }

  /** Paused: the world and the player's own sounds go quiet (tape hiss too), a little hum stays; UI unchanged. */
  public setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.applyBusLevels();
  }

  private applyBusLevels(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const set = (bus: GainNode | null, level: number) => bus?.gain.setTargetAtTime(level, now, 0.08);
    set(this.ambientBus, BUS_LEVELS.ambient * (this.paused ? 0.3 : 1));
    set(this.sfxBus, this.paused ? 0 : BUS_LEVELS.sfx);
    set(this.worldBus, this.paused ? 0 : BUS_LEVELS.world);
    set(this.uiBus, BUS_LEVELS.ui);
  }

  private applyOutputLevel(): void {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.outputLevel(), this.ctx.currentTime, 0.04);
    }
  }

  /**
   * Looping positional hiss-and-warble marking an uncollected VHS tape, so the player can find tapes
   * by ear. Linear falloff: silent beyond ~22 m. Returns null until audio is unlocked.
   */
  public createTapeBeacon(x: number, y: number, z: number): { dispose: () => void } | null {
    if (!this.ctx || this.ctx.state === 'closed' || !this.worldBus || !this.noiseBuffer) return null;
    const ctx = this.ctx;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'linear';
    panner.refDistance = 1.5;
    panner.maxDistance = 22;
    panner.rolloffFactor = 1;
    placePanner(panner, x, y, z);
    panner.connect(this.worldBus);

    const out = ctx.createGain();
    out.gain.value = 0.55;
    out.connect(panner);

    // Tape hiss, pulsing slowly
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noiseBuffer;
    hiss.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 3200;
    band.Q.value = 0.8;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0.16;
    const pulse = ctx.createOscillator();
    pulse.frequency.value = 0.9;
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0.08;
    pulse.connect(pulseDepth);
    pulseDepth.connect(hissGain.gain);
    hiss.connect(band);
    band.connect(hissGain);
    hissGain.connect(out);

    // Warped, wobbling two-note chord: a tape that was left playing
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 0.55;
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = 9;
    wobble.connect(wobbleDepth);
    const toneFilter = ctx.createBiquadFilter();
    toneFilter.type = 'lowpass';
    toneFilter.frequency.value = 900;
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0.07;
    toneFilter.connect(toneGain);
    toneGain.connect(out);
    const tones = [233.08, 293.66].map((f) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      wobbleDepth.connect(osc.detune);
      osc.connect(toneFilter);
      return osc;
    });

    const sources: AudioScheduledSourceNode[] = [hiss, pulse, wobble, ...tones];
    for (const src of sources) src.start();
    return {
      dispose: () => {
        for (const src of sources) {
          try {
            src.stop();
          } catch {
            /* already stopped */
          }
        }
        try {
          panner.disconnect();
        } catch {
          /* context already closed */
        }
      },
    };
  }

  /** Mechanical clunk and a burst of static: a recovered tape starts playing back. */
  public playTapeLog(): void {
    if (!this.ctx || this.ctx.state === 'closed' || !this.sfxBus || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const thunk = ctx.createOscillator();
    thunk.type = 'square';
    thunk.frequency.setValueAtTime(140, now);
    thunk.frequency.exponentialRampToValueAtTime(60, now + 0.08);
    const thunkGain = ctx.createGain();
    thunkGain.gain.setValueAtTime(0.25, now);
    thunkGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    thunk.connect(thunkGain);
    thunkGain.connect(this.sfxBus);
    thunk.start(now);
    thunk.stop(now + 0.12);
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noiseBuffer;
    const band = ctx.createBiquadFilter();
    band.type = 'highpass';
    band.frequency.value = 2500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now + 0.1);
    g.gain.linearRampToValueAtTime(0.12, now + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
    hiss.connect(band);
    band.connect(g);
    g.connect(this.sfxBus);
    hiss.start(now + 0.1, 0, 1.4);
  }

  public isMuted(): boolean {
    return this.muted;
  }

  private buildNoiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private buildCorridorImpulse(duration: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * duration);
    const impulse = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const channel = impulse.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        channel[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return impulse;
  }

  private startFluorescentHum(): void {
    if (!this.ctx || !this.ambientBus || this.humOsc1) return;
    const now = this.ctx.currentTime;

    this.humGain = this.ctx.createGain();
    this.humGain.gain.value = 0.055;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 260;

    // 60Hz mains hum + 120Hz ballast harmonic
    this.humOsc1 = this.ctx.createOscillator();
    this.humOsc1.type = 'sawtooth';
    this.humOsc1.frequency.setValueAtTime(60, now);

    this.humOsc2 = this.ctx.createOscillator();
    this.humOsc2.type = 'triangle';
    this.humOsc2.frequency.setValueAtTime(120.4, now);

    const g2 = this.ctx.createGain();
    g2.gain.value = 0.45;

    this.humOsc1.connect(filter);
    this.humOsc2.connect(g2);
    g2.connect(filter);
    filter.connect(this.humGain);
    this.humGain.connect(this.ambientBus);

    this.humOsc1.start();
    this.humOsc2.start();

    // Sub-bass dread drone that swells as the threat director escalates
    this.droneGain = this.ctx.createGain();
    this.droneGain.gain.value = 0;
    this.droneOsc = this.ctx.createOscillator();
    this.droneOsc.type = 'sine';
    this.droneOsc.frequency.setValueAtTime(41, now);
    this.droneWobbleOsc = this.ctx.createOscillator();
    const droneWobbleGain = this.ctx.createGain();
    this.droneWobbleOsc.frequency.value = 0.13;
    droneWobbleGain.gain.value = 1.6;
    this.droneWobbleOsc.connect(droneWobbleGain);
    droneWobbleGain.connect(this.droneOsc.frequency);
    this.droneOsc.connect(this.droneGain);
    this.droneGain.connect(this.ambientBus);
    this.droneOsc.start();
    this.droneWobbleOsc.start();
  }

  /** 0 at start, +1 per recovered tape: louder, harsher hum and a rising sub-bass drone. */
  public setThreatLevel(level: number): void {
    this.threatLevel = level;
  }

  /** Keep the Web Audio listener on the camera so entity voices pan and attenuate correctly. */
  public updateListener(x: number, y: number, z: number, fx: number, fy: number, fz: number): void {
    this.listenerPos.x = x;
    this.listenerPos.y = y;
    this.listenerPos.z = z;
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = x;
      l.positionY.value = y;
      l.positionZ.value = z;
      l.forwardX.value = fx;
      l.forwardY.value = fy;
      l.forwardZ.value = fz;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(x, y, z);
      l.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  /** A positional voice for one entity, or null until audio has been unlocked by a user gesture. */
  public createVoice(): EntityVoice | null {
    if (!this.ctx || !this.worldBus || !this.reverbNode || !this.noiseBuffer) return null;
    return new SpatialVoice(this.ctx, this.worldBus, this.reverbNode, this.noiseBuffer, this.listenerPos);
  }

  /** One-shot positional sound for level objects (doors). `occluded`: a wall is between it and the listener. */
  public playAt(kind: WorldSound, x: number, y: number, z: number, occluded = false): void {
    if (!this.ctx || !this.worldBus || !this.reverbNode || !this.noiseBuffer) return;
    if (Math.hypot(x - this.listenerPos.x, z - this.listenerPos.z) > CULL_DISTANCE) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const panner = createWorldPanner(ctx);
    placePanner(panner, x, y, z);
    if (occluded) {
      const muffle = ctx.createBiquadFilter();
      muffle.type = 'lowpass';
      muffle.frequency.value = 650;
      const quieter = ctx.createGain();
      quieter.gain.value = 0.45;
      panner.connect(muffle);
      muffle.connect(quieter);
      quieter.connect(this.worldBus);
    } else {
      panner.connect(this.worldBus);
    }
    panner.connect(this.reverbNode);
    let lastEnd = now;

    const noise = (start: number, dur: number, type: BiquadFilterType, freq: number, peak: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(peak, start);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      src.connect(f);
      f.connect(g);
      g.connect(panner);
      src.start(start, Math.random(), dur + 0.05);
      lastEnd = Math.max(lastEnd, start + dur);
    };
    const tone = (start: number, dur: number, type: OscillatorType, from: number, to: number, peak: number) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(from, start);
      osc.frequency.exponentialRampToValueAtTime(to, start + dur);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = (from + to) * 0.8;
      f.Q.value = 1.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(peak, start + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(f);
      f.connect(g);
      g.connect(panner);
      osc.start(start);
      osc.stop(start + dur + 0.05);
      lastEnd = Math.max(lastEnd, start + dur);
    };

    if (kind === 'door_open' || kind === 'door_close') {
      tone(now, 0.38, 'sawtooth', kind === 'door_open' ? 120 : 150, kind === 'door_open' ? 165 : 92, 0.35);
      if (kind === 'door_close') {
        noise(now + 0.34, 0.12, 'lowpass', 260, 0.9);
        noise(now + 0.36, 0.03, 'bandpass', 2200, 0.5);
      }
    } else if (kind === 'claw') {
      // Tearing swipe at the attacker's position, so a hit from behind sounds like it came from behind.
      noise(now, 0.16, 'bandpass', 2400, 1.1);
      noise(now + 0.03, 0.12, 'highpass', 4000, 0.6);
      tone(now, 0.18, 'sine', 140, 55, 0.9);
    } else if (kind === 'door_bash') {
      tone(now, 0.22, 'sine', vary(80, 0.12), 40, vary(1.0, 0.1));
      noise(now, 0.2, 'lowpass', vary(400, 0.18), vary(1.0, 0.1));
    } else {
      noise(now, 0.7, 'lowpass', 900, 1.2);
      noise(now, 0.4, 'highpass', 2500, 0.6);
      tone(now, 0.5, 'sine', 60, 30, 1.0);
    }
    const timerId = window.setTimeout(() => {
      this.pendingCleanupTimers.delete(timerId);
      try {
        panner.disconnect();
      } catch {
        /* ignore */
      }
    }, (lastEnd - now + 0.3) * 1000);
    this.pendingCleanupTimers.add(timerId);
  }

  public updateAmbient(delta: number, nearestEntityDist: number, isPlaying: boolean): void {
    if (!this.ctx || !this.humGain || !this.started) return;
    const now = this.ctx.currentTime;

    const targetHum = isPlaying ? 0.06 + this.threatLevel * 0.012 : 0.03;
    this.humGain.gain.setTargetAtTime(targetHum, now, 0.12);
    this.droneGain?.gain.setTargetAtTime(isPlaying ? this.threatLevel * 0.035 : 0, now, 1.5);

    if (isPlaying && nearestEntityDist < 13) {
      const proximity = Math.max(0, 1 - nearestEntityDist / 13);
      const interval = Math.max(0.32, 0.95 - proximity * 0.58);
      this.heartbeatTimer -= delta;
      if (this.heartbeatTimer <= 0) {
        this.heartbeatTimer = interval;
        this.playHeartbeat(0.12 + proximity * 0.38);
      }
    } else {
      this.heartbeatTimer = 0.1;
    }

    if (isPlaying && this.lowHealth > 0) {
      this.breathTimer -= delta;
      if (this.breathTimer <= 0) {
        this.breathTimer = 2.4 - this.lowHealth;
        this.playBreath(this.lowHealth);
      }
    } else {
      this.breathTimer = 0.5;
    }
  }

  public setLowHealth(level: number): void {
    this.lowHealth = Math.min(1, Math.max(0, level));
  }

  private playBreath(level: number): void {
    if (!this.ctx || this.ctx.state === 'closed' || !this.sfxBus || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Ragged in-breath then out-breath: band-passed noise with slow envelopes.
    for (const [offset, freq, length] of [
      [0, 950, 0.55],
      [0.7, 700, 0.75],
    ] as const) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = freq;
      band.Q.value = 1.2;
      const g = ctx.createGain();
      const peak = 0.05 + 0.12 * level;
      g.gain.setValueAtTime(0.0001, now + offset);
      g.gain.linearRampToValueAtTime(peak, now + offset + length * 0.45);
      g.gain.exponentialRampToValueAtTime(0.0001, now + offset + length);
      src.connect(band);
      band.connect(g);
      g.connect(this.sfxBus);
      src.start(now + offset, Math.random() * 1.2, length + 0.05);
    }
  }

  /** Low falling sweep and a swell of static when the run ends in death. */
  public playDeathSting(): void {
    if (!this.ctx || this.ctx.state === 'closed' || !this.sfxBus || !this.reverbNode || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(32, now + 1.8);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1400, now);
    lp.frequency.exponentialRampToValueAtTime(120, now + 1.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.45, now + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 2.0);
    osc.connect(lp);
    lp.connect(g);
    g.connect(this.sfxBus);
    g.connect(this.reverbNode);
    osc.start(now);
    osc.stop(now + 2.05);
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2200;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.0001, now);
    hg.gain.linearRampToValueAtTime(0.18, now + 0.6);
    hg.gain.exponentialRampToValueAtTime(0.0001, now + 1.9);
    hiss.connect(hp);
    hp.connect(hg);
    hg.connect(this.sfxBus);
    hiss.start(now, 0, 1.95);
  }

  private playHeartbeat(volume: number): void {
    if (!this.ctx || !this.sfxBus) return;
    const now = this.ctx.currentTime;
    const beat = (offset: number, peak: number) => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(64, now + offset);
      osc.frequency.exponentialRampToValueAtTime(34, now + offset + 0.14);
      gain.gain.setValueAtTime(0.001, now + offset);
      gain.gain.linearRampToValueAtTime(peak, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.18);
      osc.connect(gain);
      gain.connect(this.sfxBus!);
      osc.start(now + offset);
      osc.stop(now + offset + 0.2);
    };
    beat(0, volume);
    beat(0.14, volume * 0.68);
  }

  public playGunshot(): void {
    if (!this.ctx || !this.sfxBus || !this.reverbNode || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    // Punchy low-end transient
    const sub = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    sub.type = 'triangle';
    sub.frequency.setValueAtTime(vary(165, 0.05), now);
    sub.frequency.exponentialRampToValueAtTime(42, now + 0.11);
    subGain.gain.setValueAtTime(vary(0.55, 0.06), now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    sub.connect(subGain);
    subGain.connect(this.sfxBus);
    sub.start(now);
    sub.stop(now + 0.15);

    // Sharp crack noise burst routed to dry + corridor reverb
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(vary(1650, 0.08), now);
    band.frequency.exponentialRampToValueAtTime(520, now + 0.18);
    band.Q.value = 0.7;

    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(vary(0.68, 0.06), now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    src.connect(band);
    band.connect(nGain);
    nGain.connect(this.sfxBus);
    nGain.connect(this.reverbNode);
    src.start(now);
    src.stop(now + 0.24);
  }

  public playEmptyClick(): void {
    if (!this.ctx || !this.sfxBus) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1250, now);
    osc.frequency.exponentialRampToValueAtTime(450, now + 0.03);
    g.gain.setValueAtTime(0.14, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    osc.connect(g);
    g.connect(this.sfxBus);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  public playReload(): void {
    if (!this.ctx || !this.sfxBus) return;
    const now = this.ctx.currentTime;
    const clack = (offset: number, freq: number) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'triangle';
      const f = vary(freq, 0.04);
      osc.frequency.setValueAtTime(f, now + offset);
      osc.frequency.exponentialRampToValueAtTime(f * 0.45, now + offset + 0.06);
      g.gain.setValueAtTime(0.18, now + offset);
      g.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.07);
      osc.connect(g);
      g.connect(this.sfxBus!);
      osc.start(now + offset);
      osc.stop(now + offset + 0.08);
    };
    clack(0.05, 580);
    clack(0.45, 760);
    clack(0.88, 980);
  }

  public playFlashlightClick(): void {
    if (!this.ctx || !this.sfxBus) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1800, now);
    g.gain.setValueAtTime(0.09, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
    osc.connect(g);
    g.connect(this.sfxBus);
    osc.start(now);
    osc.stop(now + 0.03);
  }

  public playFootstep(sprinting: boolean): void {
    if (!this.ctx || !this.sfxBus || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = vary(sprinting ? 380 : 280, 0.15);

    const g = this.ctx.createGain();
    const vol = vary(sprinting ? 0.17 : 0.1, 0.15);
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.sfxBus);
    src.start(now, Math.random() * 0.5, 0.1);
  }

  /** 'immune' is a dull, wrong-sounding thunk for bullets passing through a Smiler. */
  /** 'head' is a low, meaty thud; 'immune' a dull, wrong-sounding one for bullets passing through a Smiler. */
  public playHitmarker(kind: 'hit' | 'head' | 'kill' | 'immune'): void {
    if (!this.ctx || !this.uiBus) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = kind === 'immune' || kind === 'head' ? 'triangle' : 'sine';
    const [from, to] =
      kind === 'kill' ? [1480, 720] : kind === 'hit' ? [1080, 640] : kind === 'head' ? [520, 160] : [260, 120];
    const length = kind === 'head' ? 0.11 : 0.07;
    const pitch = vary(1, 0.04);
    osc.frequency.setValueAtTime(from * pitch, now);
    osc.frequency.exponentialRampToValueAtTime(to * pitch, now + length * 0.85);
    g.gain.setValueAtTime(kind === 'head' ? 0.26 : 0.18, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + length);
    osc.connect(g);
    g.connect(this.uiBus);
    osc.start(now);
    osc.stop(now + length + 0.01);
  }

  public playPlayerHurt(): void {
    if (!this.ctx || !this.sfxBus || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 460;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.45, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.sfxBus);
    src.start(now, 0, 0.28);
  }

  public playPickup(kind: 'tape' | 'ammo' | 'almond_water' | 'battery'): void {
    if (!this.ctx || !this.uiBus) return;
    const now = this.ctx.currentTime;
    const notes =
      kind === 'tape'
        ? [523.25, 659.25, 783.99]
        : kind === 'almond_water'
          ? [440, 554.37]
          : kind === 'battery'
            ? [392, 587.33]
            : [330, 440];
    notes.forEach((freq, idx) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.07);
      g.gain.setValueAtTime(0.16, now + idx * 0.07);
      g.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.22);
      osc.connect(g);
      g.connect(this.uiBus!);
      osc.start(now + idx * 0.07);
      osc.stop(now + idx * 0.07 + 0.24);
    });
  }

  public playExitUnlocked(): void {
    if (!this.ctx || !this.reverbNode || !this.uiBus) return;
    const now = this.ctx.currentTime;
    [392, 523.25, 659.25, 783.99].forEach((freq, idx) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, now + idx * 0.11);
      const lp = this.ctx!.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1200;
      g.gain.setValueAtTime(0.14, now + idx * 0.11);
      g.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.11 + 0.45);
      osc.connect(lp);
      lp.connect(g);
      g.connect(this.uiBus!);
      g.connect(this.reverbNode!);
      osc.start(now + idx * 0.11);
      osc.stop(now + idx * 0.11 + 0.48);
    });
  }

  public dispose(): void {
    for (const timerId of this.pendingCleanupTimers) {
      window.clearTimeout(timerId);
    }
    this.pendingCleanupTimers.clear();
    for (const osc of [this.humOsc1, this.humOsc2, this.droneOsc, this.droneWobbleOsc]) {
      if (!osc) continue;
      try {
        osc.stop();
      } catch {
        /* ignore */
      }
    }
    this.humOsc1 = null;
    this.humOsc2 = null;
    this.droneOsc = null;
    this.droneWobbleOsc = null;
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.started = false;
  }
}
