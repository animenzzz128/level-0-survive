export class HorrorAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private dryGain: GainNode | null = null;
  private reverbNode: ConvolverNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private humOsc1: OscillatorNode | null = null;
  private humOsc2: OscillatorNode | null = null;
  private humGain: GainNode | null = null;
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
  }

  public updateAmbient(delta: number, nearestEntityDist: number, isPlaying: boolean): void {
    if (!this.ctx || !this.humGain || !this.started) return;
    const now = this.ctx.currentTime;

    const targetHum = isPlaying ? 0.06 : 0.03;
    this.humGain.gain.setTargetAtTime(targetHum, now, 0.12);

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

  public playHitmarker(kill: boolean): void {
    if (!this.ctx || !this.dryGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(kill ? 1480 : 1080, now);
    osc.frequency.exponentialRampToValueAtTime(kill ? 720 : 640, now + 0.06);
    g.gain.setValueAtTime(0.18, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    osc.connect(g);
    g.connect(this.dryGain);
    osc.start(now);
    osc.stop(now + 0.08);
  }

  public playEntityScreech(intensity = 0.35): void {
    if (!this.ctx || !this.reverbNode || !this.dryGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const mod = this.ctx.createOscillator();
    const modGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(340, now);
    osc.frequency.linearRampToValueAtTime(195, now + 0.42);

    mod.type = 'square';
    mod.frequency.value = 37;
    modGain.gain.value = 110;

    filter.type = 'bandpass';
    filter.frequency.value = 820;
    filter.Q.value = 2.2;

    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(intensity, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.48);

    mod.connect(modGain);
    modGain.connect(osc.frequency);
    osc.connect(filter);
    filter.connect(g);
    g.connect(this.dryGain);
    g.connect(this.reverbNode);

    osc.start(now);
    mod.start(now);
    osc.stop(now + 0.5);
    mod.stop(now + 0.5);
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

  public playPickup(kind: 'tape' | 'ammo' | 'almond_water'): void {
    if (!this.ctx || !this.dryGain) return;
    const now = this.ctx.currentTime;
    const notes =
      kind === 'tape' ? [523.25, 659.25, 783.99] : kind === 'almond_water' ? [440, 554.37] : [330, 440];
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
    if (this.humOsc1) {
      try {
        this.humOsc1.stop();
      } catch {
        /* ignore */
      }
    }
    if (this.humOsc2) {
      try {
        this.humOsc2.stop();
      } catch {
        /* ignore */
      }
    }
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
