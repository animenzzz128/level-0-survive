import type { EntityVoice } from './entities';
import type { EntityArchetype } from './types';

export type WorldSound = 'door_open' | 'door_close' | 'door_bash' | 'door_break';

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
  private readonly panner: PannerNode;
  private readonly reverbSend: GainNode;

  constructor(
    private readonly ctx: AudioContext,
    dry: AudioNode,
    reverb: AudioNode,
    private readonly noise: AudioBuffer,
  ) {
    this.input = ctx.createGain();
    this.occlusion = ctx.createBiquadFilter();
    this.occlusion.type = 'lowpass';
    this.occlusion.frequency.value = 9000;
    this.panner = createWorldPanner(ctx);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.5;
    this.input.connect(this.occlusion);
    this.occlusion.connect(this.panner);
    this.panner.connect(dry);
    this.panner.connect(this.reverbSend);
    this.reverbSend.connect(reverb);
  }

  setPosition(x: number, y: number, z: number): void {
    if (this.ctx.state === 'closed') return;
    placePanner(this.panner, x, y, z);
  }

  setOccluded(occluded: boolean): void {
    if (this.ctx.state === 'closed') return;
    this.occlusion.frequency.setTargetAtTime(occluded ? 650 : 9000, this.ctx.currentTime, 0.08);
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
    if (this.ctx.state === 'closed') return;
    const now = this.ctx.currentTime;
    this.noiseBurst(now, heavy ? 0.16 : 0.1, 'lowpass', heavy ? 170 : 260, heavy ? 0.9 : 0.55);
    if (heavy) this.tone(now, 0.18, 'sine', 70, 38, 0.6, 400);
  }

  playScreech(archetype: EntityArchetype): void {
    if (this.ctx.state === 'closed') return;
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
    if (this.ctx.state === 'closed') return;
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

  playDeath(): void {
    if (this.ctx.state === 'closed') return;
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

export class HorrorAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private dryGain: GainNode | null = null;
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
  private muted = false;
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
    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 18;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : 0.72;

    this.dryGain = this.ctx.createGain();
    this.dryGain.gain.value = 0.85;

    this.reverbNode = this.ctx.createConvolver();
    this.reverbNode.buffer = this.buildCorridorImpulse(1.5, 2.8);

    const wetGain = this.ctx.createGain();
    wetGain.gain.value = 0.34;

    this.dryGain.connect(compressor);
    this.reverbNode.connect(wetGain);
    wetGain.connect(compressor);
    compressor.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    this.noiseBuffer = this.buildNoiseBuffer(2.0);
    this.startFluorescentHum();
    this.started = true;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.72, this.ctx.currentTime, 0.04);
    }
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
    if (!this.ctx || !this.dryGain || this.humOsc1) return;
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
    this.humGain.connect(this.dryGain);

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
    this.droneGain.connect(this.dryGain);
    this.droneOsc.start();
    this.droneWobbleOsc.start();
  }

  /** 0 at start, +1 per recovered tape: louder, harsher hum and a rising sub-bass drone. */
  public setThreatLevel(level: number): void {
    this.threatLevel = level;
  }

  /** Keep the Web Audio listener on the camera so entity voices pan and attenuate correctly. */
  public updateListener(x: number, y: number, z: number, fx: number, fy: number, fz: number): void {
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
    if (!this.ctx || !this.dryGain || !this.reverbNode || !this.noiseBuffer) return null;
    return new SpatialVoice(this.ctx, this.dryGain, this.reverbNode, this.noiseBuffer);
  }

  /** One-shot positional sound for level objects (doors). */
  public playAt(kind: WorldSound, x: number, y: number, z: number): void {
    if (!this.ctx || !this.dryGain || !this.reverbNode || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const panner = createWorldPanner(ctx);
    placePanner(panner, x, y, z);
    panner.connect(this.dryGain);
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
    } else if (kind === 'door_bash') {
      tone(now, 0.22, 'sine', 80, 40, 1.0);
      noise(now, 0.2, 'lowpass', 400, 1.0);
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
  }

  private playHeartbeat(volume: number): void {
    if (!this.ctx || !this.dryGain) return;
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
      gain.connect(this.dryGain!);
      osc.start(now + offset);
      osc.stop(now + offset + 0.2);
    };
    beat(0, volume);
    beat(0.14, volume * 0.68);
  }

  public playGunshot(): void {
    if (!this.ctx || !this.dryGain || !this.reverbNode || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    // Punchy low-end transient
    const sub = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    sub.type = 'triangle';
    sub.frequency.setValueAtTime(165, now);
    sub.frequency.exponentialRampToValueAtTime(42, now + 0.11);
    subGain.gain.setValueAtTime(0.55, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    sub.connect(subGain);
    subGain.connect(this.dryGain);
    sub.start(now);
    sub.stop(now + 0.15);

    // Sharp crack noise burst routed to dry + corridor reverb
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(1650, now);
    band.frequency.exponentialRampToValueAtTime(520, now + 0.18);
    band.Q.value = 0.7;

    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.68, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    src.connect(band);
    band.connect(nGain);
    nGain.connect(this.dryGain);
    nGain.connect(this.reverbNode);
    src.start(now);
    src.stop(now + 0.24);
  }

  public playEmptyClick(): void {
    if (!this.ctx || !this.dryGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1250, now);
    osc.frequency.exponentialRampToValueAtTime(450, now + 0.03);
    g.gain.setValueAtTime(0.14, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    osc.connect(g);
    g.connect(this.dryGain);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  public playReload(): void {
    if (!this.ctx || !this.dryGain) return;
    const now = this.ctx.currentTime;
    const clack = (offset: number, freq: number) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + offset);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.45, now + offset + 0.06);
      g.gain.setValueAtTime(0.18, now + offset);
      g.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.07);
      osc.connect(g);
      g.connect(this.dryGain!);
      osc.start(now + offset);
      osc.stop(now + offset + 0.08);
    };
    clack(0.05, 580);
    clack(0.45, 760);
    clack(0.88, 980);
  }

  public playFlashlightClick(): void {
    if (!this.ctx || !this.dryGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1800, now);
    g.gain.setValueAtTime(0.09, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
    osc.connect(g);
    g.connect(this.dryGain);
    osc.start(now);
    osc.stop(now + 0.03);
  }

  public playFootstep(sprinting: boolean): void {
    if (!this.ctx || !this.dryGain || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = sprinting ? 380 : 280;

    const g = this.ctx.createGain();
    const vol = sprinting ? 0.17 : 0.1;
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.dryGain);
    src.start(now, Math.random() * 0.5, 0.1);
  }

  /** 'immune' is a dull, wrong-sounding thunk for bullets passing through a Smiler. */
  public playHitmarker(kind: 'hit' | 'kill' | 'immune'): void {
    if (!this.ctx || !this.dryGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = kind === 'immune' ? 'triangle' : 'sine';
    const [from, to] = kind === 'kill' ? [1480, 720] : kind === 'hit' ? [1080, 640] : [260, 120];
    osc.frequency.setValueAtTime(from, now);
    osc.frequency.exponentialRampToValueAtTime(to, now + 0.06);
    g.gain.setValueAtTime(0.18, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    osc.connect(g);
    g.connect(this.dryGain);
    osc.start(now);
    osc.stop(now + 0.08);
  }

  public playPlayerHurt(): void {
    if (!this.ctx || !this.dryGain || !this.noiseBuffer) return;
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
    g.connect(this.dryGain);
    src.start(now, 0, 0.28);
  }

  public playPickup(kind: 'tape' | 'ammo' | 'almond_water' | 'battery'): void {
    if (!this.ctx || !this.dryGain) return;
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
      g.connect(this.dryGain!);
      osc.start(now + idx * 0.07);
      osc.stop(now + idx * 0.07 + 0.24);
    });
  }

  public playExitUnlocked(): void {
    if (!this.ctx || !this.reverbNode || !this.dryGain) return;
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
      g.connect(this.dryGain!);
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
