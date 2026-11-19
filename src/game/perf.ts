/**
 * Frame measurement for the debug API (performance-optimization skill: measure before optimizing, and look
 * at the 95th percentile, not just the mean, because stutter lives in the slow frames).
 */

/** Fixed-size ring of samples with mean and percentile. */
export class SampleRing {
  private readonly data: Float64Array;
  private count = 0;
  private next = 0;

  constructor(size = 240) {
    this.data = new Float64Array(size);
  }

  public push(value: number): void {
    this.data[this.next] = value;
    this.next = (this.next + 1) % this.data.length;
    this.count = Math.min(this.count + 1, this.data.length);
  }

  public get size(): number {
    return this.count;
  }

  public clear(): void {
    this.count = 0;
    this.next = 0;
  }

  public mean(): number {
    if (this.count === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.count; i++) sum += this.data[i];
    return sum / this.count;
  }

  /** Nearest-rank percentile, p in 0..100. */
  public percentile(p: number): number {
    if (this.count === 0) return 0;
    const sorted = Array.from(this.data.subarray(0, this.count)).sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * this.count) - 1;
    return sorted[Math.min(this.count - 1, Math.max(0, rank))];
  }

  public summary(): { mean: number; p95: number } {
    return { mean: round2(this.mean()), p95: round2(this.percentile(95)) };
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/**
 * GPU time per frame from EXT_disjoint_timer_query_webgl2. Results arrive a few frames late, so queries are
 * pooled and read when available. Browsers that hide the extension (most of them outside desktop Chrome)
 * get null from create() and the debug API reports gpuMs as null.
 */
export class GpuTimer {
  public readonly samples = new SampleRing();
  private readonly pending: WebGLQuery[] = [];
  private readonly free: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly ext: TimerQueryExt,
  ) {}

  public static create(gl: WebGLRenderingContext | WebGL2RenderingContext): GpuTimer | null {
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return null;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
    return ext ? new GpuTimer(gl, ext) : null;
  }

  public begin(): void {
    if (this.active || this.pending.length > 6) return;
    const query = this.free.pop() ?? this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = query;
  }

  public end(): void {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Collect finished queries. A disjoint event (GPU reset, power state change) invalidates them. */
  public poll(): void {
    const disjoint = Boolean(this.gl.getParameter(this.ext.GPU_DISJOINT_EXT));
    while (this.pending.length > 0) {
      const query = this.pending[0];
      if (!this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT) as number;
      this.pending.shift();
      this.free.push(query);
      if (!disjoint) this.samples.push(ns / 1e6);
    }
  }

  public dispose(): void {
    if (this.active) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    for (const query of [...this.pending, ...this.free]) this.gl.deleteQuery(query);
    if (this.active) this.gl.deleteQuery(this.active);
    this.pending.length = 0;
    this.free.length = 0;
    this.active = null;
  }
}
