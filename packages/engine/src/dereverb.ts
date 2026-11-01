import { fft } from './correlate.ts';

// Room echo removal by weighted prediction error (WPE; Nakatani et al., "Speech dereverberation
// based on variance-normalized delayed linear prediction", IEEE TASLP 2010; as in nara_wpe, MIT).
// Late reverberation is what the recent past of each frequency predicts: in the short-time
// spectrum, each frame is predicted from `taps` frames that end `delay` frames before it, the
// prediction weighted by the inverse power of the clean speech (estimated in turn), and the
// prediction subtracted. The direct sound and early reflections, which the past cannot predict,
// stay. Pure functions; dereverb-worker.ts runs them off the server's thread.

export interface DereverbOptions {
  /** STFT size and hop, in samples. */
  fftSize: number;
  hop: number;
  /** Frames between a frame and the newest one predicting it (keeps the early reflections). */
  delay: number;
  /** Frames predicting each frame: how long a tail is reached. */
  taps: number;
  iterations: number;
  /** 1 is fully dereverberated; lower blends the original back in. */
  mix: number;
}

/** The STFT settings at 48 kHz: 43 ms windows every 11 ms. */
export const DEREVERB_STFT = { fftSize: 2048, hop: 512, delay: 3 } as const;

/** Prediction taps for a tail reach in milliseconds at `rate`. */
export function tapsFor(reachMs: number, rate: number): number {
  const hopMs = (DEREVERB_STFT.hop / rate) * 1000;
  return Math.max(1, Math.round(reachMs / hopMs) - DEREVERB_STFT.delay);
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Solves A x = b for a Hermitian positive definite A (n×n, row-major re/im), in place, by
 * Gaussian elimination with partial pivoting. Returns x as [re, im].
 */
function solve(
  ar: Float64Array,
  ai: Float64Array,
  br: Float64Array,
  bi: Float64Array,
  n: number,
): void {
  for (let c = 0; c < n; c++) {
    let p = c;
    let best = 0;
    for (let r = c; r < n; r++) {
      const m = (ar[r * n + c] as number) ** 2 + (ai[r * n + c] as number) ** 2;
      if (m > best) {
        best = m;
        p = r;
      }
    }
    if (best === 0) continue;
    if (p !== c) {
      for (let k = 0; k < n; k++) {
        const i1 = c * n + k;
        const i2 = p * n + k;
        [ar[i1], ar[i2]] = [ar[i2] as number, ar[i1] as number];
        [ai[i1], ai[i2]] = [ai[i2] as number, ai[i1] as number];
      }
      [br[c], br[p]] = [br[p] as number, br[c] as number];
      [bi[c], bi[p]] = [bi[p] as number, bi[c] as number];
    }
    const pr = ar[c * n + c] as number;
    const pi = ai[c * n + c] as number;
    const pm = pr * pr + pi * pi;
    for (let r = c + 1; r < n; r++) {
      const xr = ar[r * n + c] as number;
      const xi = ai[r * n + c] as number;
      // f = a[r][c] / a[c][c]
      const fr = (xr * pr + xi * pi) / pm;
      const fi = (xi * pr - xr * pi) / pm;
      if (fr === 0 && fi === 0) continue;
      for (let k = c; k < n; k++) {
        const cr = ar[c * n + k] as number;
        const ci = ai[c * n + k] as number;
        ar[r * n + k] = (ar[r * n + k] as number) - (fr * cr - fi * ci);
        ai[r * n + k] = (ai[r * n + k] as number) - (fr * ci + fi * cr);
      }
      br[r] = (br[r] as number) - (fr * (br[c] as number) - fi * (bi[c] as number));
      bi[r] = (bi[r] as number) - (fr * (bi[c] as number) + fi * (br[c] as number));
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let sr = br[r] as number;
    let si = bi[r] as number;
    for (let k = r + 1; k < n; k++) {
      const cr = ar[r * n + k] as number;
      const ci = ai[r * n + k] as number;
      sr -= cr * (br[k] as number) - ci * (bi[k] as number);
      si -= cr * (bi[k] as number) + ci * (br[k] as number);
    }
    const pr = ar[r * n + r] as number;
    const pi = ai[r * n + r] as number;
    const pm = pr * pr + pi * pi || 1;
    br[r] = (sr * pr + si * pi) / pm;
    bi[r] = (si * pr - sr * pi) / pm;
  }
}

/**
 * WPE on one bin's frames (re/im over time): returns the dereverberated frames. Frames before
 * the first are taken as silence.
 */
export function wpeBin(
  xr: Float64Array,
  xi: Float64Array,
  o: Pick<DereverbOptions, 'delay' | 'taps' | 'iterations'>,
): { re: Float64Array; im: Float64Array } {
  const T = xr.length;
  const K = o.taps;
  const dr = Float64Array.from(xr);
  const di = Float64Array.from(xi);
  const Rr = new Float64Array(K * K);
  const Ri = new Float64Array(K * K);
  const Pr = new Float64Array(K);
  const Pi = new Float64Array(K);
  const vr = new Float64Array(K);
  const vi = new Float64Array(K);
  const power = new Float64Array(T);
  let floor = 0;
  for (let t = 0; t < T; t++) floor += (xr[t] as number) ** 2 + (xi[t] as number) ** 2;
  floor = Math.max(1e-20, (floor / Math.max(1, T)) * 1e-6);
  for (let it = 0; it < o.iterations; it++) {
    Rr.fill(0);
    Ri.fill(0);
    Pr.fill(0);
    Pi.fill(0);
    // The clean speech's power, averaged with the frames either side.
    for (let t = 0; t < T; t++) power[t] = (dr[t] as number) ** 2 + (di[t] as number) ** 2;
    for (let t = o.delay; t < T; t++) {
      const near = ((power[t - 1] ?? 0) + (power[t] as number) + (power[t + 1] ?? 0)) / 3;
      const w = 1 / Math.max(floor, near);
      let any = false;
      for (let k = 0; k < K; k++) {
        const s = t - o.delay - k;
        vr[k] = s >= 0 ? (xr[s] as number) : 0;
        vi[k] = s >= 0 ? (xi[s] as number) : 0;
        if (vr[k] || vi[k]) any = true;
      }
      if (!any) continue;
      const yr = xr[t] as number;
      const yi = xi[t] as number;
      for (let a = 0; a < K; a++) {
        const ar = (vr[a] as number) * w;
        const ai = (vi[a] as number) * w;
        // R[a][b] += v_a conj(v_b) w, Hermitian: fill the upper half, mirror after.
        for (let b = a; b < K; b++) {
          const br = vr[b] as number;
          const bi = vi[b] as number;
          Rr[a * K + b] = (Rr[a * K + b] as number) + ar * br + ai * bi;
          Ri[a * K + b] = (Ri[a * K + b] as number) + ai * br - ar * bi;
        }
        // P[a] += v_a conj(y) w
        Pr[a] = (Pr[a] as number) + ar * yr + ai * yi;
        Pi[a] = (Pi[a] as number) + ai * yr - ar * yi;
      }
    }
    let trace = 0;
    for (let a = 0; a < K; a++) {
      trace += Rr[a * K + a] as number;
      for (let b = 0; b < a; b++) {
        Rr[a * K + b] = Rr[b * K + a] as number;
        Ri[a * K + b] = -(Ri[b * K + a] as number);
      }
    }
    if (trace <= 0) break;
    // A little diagonal loading keeps a near-silent bin's solve stable.
    for (let a = 0; a < K; a++) Rr[a * K + a] = (Rr[a * K + a] as number) + (trace / K) * 1e-6;
    solve(Rr, Ri, Pr, Pi, K);
    // d_t = x_t - G^H v_t
    for (let t = 0; t < T; t++) {
      let pr = 0;
      let pi = 0;
      for (let k = 0; k < K; k++) {
        const s = t - o.delay - k;
        if (s < 0) break;
        const gr = Pr[k] as number;
        const gi = -(Pi[k] as number);
        pr += gr * (xr[s] as number) - gi * (xi[s] as number);
        pi += gr * (xi[s] as number) + gi * (xr[s] as number);
      }
      dr[t] = (xr[t] as number) - pr;
      di[t] = (xi[t] as number) - pi;
    }
  }
  return { re: dr, im: di };
}

/** Dereverberates a stretch of one channel: STFT, WPE per bin, inverse STFT. Same length out. */
export function dereverbChannel(x: Float32Array, o: DereverbOptions): Float32Array {
  const N = o.fftSize;
  const H = o.hop;
  const bins = N / 2 + 1;
  const w = hann(N);
  // Frames start every hop from N - H before the first sample, so every sample is covered by
  // N / H frames.
  const lead = N - H;
  const frames = Math.ceil((x.length + lead) / H);
  const specR = Array.from({ length: bins }, () => new Float64Array(frames));
  const specI = Array.from({ length: bins }, () => new Float64Array(frames));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let j = 0; j < frames; j++) {
    const start = j * H - lead;
    for (let n = 0; n < N; n++) {
      const s = start + n;
      re[n] = s >= 0 && s < x.length ? (x[s] as number) * (w[n] as number) : 0;
      im[n] = 0;
    }
    fft(re, im);
    for (let f = 0; f < bins; f++) {
      (specR[f] as Float64Array)[j] = re[f] as number;
      (specI[f] as Float64Array)[j] = im[f] as number;
    }
  }
  const outR = specR.map((r) => new Float64Array(r.length));
  const outI = specI.map((r) => new Float64Array(r.length));
  for (let f = 0; f < bins; f++) {
    const xr = specR[f] as Float64Array;
    const xi = specI[f] as Float64Array;
    const d = wpeBin(xr, xi, o);
    const or = outR[f] as Float64Array;
    const oi = outI[f] as Float64Array;
    for (let t = 0; t < frames; t++) {
      or[t] = o.mix * (d.re[t] as number) + (1 - o.mix) * (xr[t] as number);
      oi[t] = o.mix * (d.im[t] as number) + (1 - o.mix) * (xi[t] as number);
    }
  }
  // Hann analysis and synthesis windows at a quarter-window hop sum to 1.5 everywhere.
  const norm = (N / H) * 0.375;
  const y = new Float32Array(x.length);
  for (let j = 0; j < frames; j++) {
    for (let f = 0; f < bins; f++) {
      re[f] = (outR[f] as Float64Array)[j] as number;
      im[f] = (outI[f] as Float64Array)[j] as number;
      if (f > 0 && f < N / 2) {
        re[N - f] = re[f] as number;
        im[N - f] = -(im[f] as number);
      }
    }
    fft(re, im, true);
    const start = j * H - lead;
    for (let n = 0; n < N; n++) {
      const s = start + n;
      if (s >= 0 && s < y.length)
        y[s] = (y[s] as number) + ((re[n] as number) * (w[n] as number)) / norm;
    }
  }
  return y;
}
