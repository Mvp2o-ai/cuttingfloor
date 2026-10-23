// Sync offset by cross-correlation: how far B's sound sits from A's. The correlation of the two
// waveforms at every lag comes from one FFT product; each lag is normalised by the energy of the
// parts that overlap there, so the strength is the correlation coefficient of the overlap (1: the
// same sound). Pure functions; sound-worker.ts runs them off the server's thread.

/** In-place iterative radix-2 FFT; `inverse` scales by 1/n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = (re[b] as number) * cr - (im[b] as number) * ci;
        const xi = (re[b] as number) * ci + (im[b] as number) * cr;
        re[b] = (re[a] as number) - xr;
        im[b] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = (re[i] as number) / n;
      im[i] = (im[i] as number) / n;
    }
  }
}

export interface Offset {
  /** Seconds: B's moment t lines up with A's moment t + offset_seconds. */
  offset_seconds: number;
  /** Correlation coefficient of the overlapping sound at that offset, -1 to 1. */
  strength: number;
  /** Seconds of sound that overlap at that offset. */
  overlap_seconds: number;
  /** The best offset outside the winning peak, for how clear-cut the match is. */
  next_best: { offset_seconds: number; strength: number } | null;
}

/**
 * The lag (in samples, within ±maxLag) where B best matches A, among lags where at least half
 * of the shorter sound overlaps the other.
 */
export function crossCorrelate(
  a: Float32Array,
  b: Float32Array,
  rate: number,
  options: { maxLag: number },
): Offset | null {
  const na = a.length;
  const nb = b.length;
  if (!na || !nb) return null;
  let n = 1;
  while (n < na + nb) n <<= 1;
  const mean = (x: Float32Array) => x.reduce((s, v) => s + v, 0) / x.length;
  const ma = mean(a);
  const mb = mean(b);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  for (let i = 0; i < na; i++) ar[i] = (a[i] as number) - ma;
  for (let i = 0; i < nb; i++) br[i] = (b[i] as number) - mb;
  // Prefix sums of squares, for the energy of any overlap.
  const pa = new Float64Array(na + 1);
  const pb = new Float64Array(nb + 1);
  for (let i = 0; i < na; i++) pa[i + 1] = (pa[i] as number) + (ar[i] as number) ** 2;
  for (let i = 0; i < nb; i++) pb[i + 1] = (pb[i] as number) + (br[i] as number) ** 2;
  fft(ar, ai);
  fft(br, bi);
  // A · conj(B): r[d] = Σ a[i + d] · b[i].
  for (let i = 0; i < n; i++) {
    const r = (ar[i] as number) * (br[i] as number) + (ai[i] as number) * (bi[i] as number);
    const m = (ai[i] as number) * (br[i] as number) - (ar[i] as number) * (bi[i] as number);
    ar[i] = r;
    ai[i] = m;
  }
  fft(ar, ai, true);
  const minOverlap = Math.ceil(Math.min(na, nb) / 2);
  const lo = Math.max(-options.maxLag, -(nb - minOverlap));
  const hi = Math.min(options.maxLag, na - minOverlap);
  if (hi < lo) return null;
  const ncc = new Float64Array(hi - lo + 1);
  for (let d = lo; d <= hi; d++) {
    // Overlap: a[j] for j in [max(0, d), min(na, nb + d)), b[i] for i = j - d.
    const j0 = Math.max(0, d);
    const j1 = Math.min(na, nb + d);
    const ea = (pa[j1] as number) - (pa[j0] as number);
    const eb = (pb[j1 - d] as number) - (pb[j0 - d] as number);
    const r = ar[d >= 0 ? d : n + d] as number;
    ncc[d - lo] = ea > 0 && eb > 0 ? r / Math.sqrt(ea * eb) : 0;
  }
  let best = 0;
  for (let k = 1; k < ncc.length; k++) if ((ncc[k] as number) > (ncc[best] as number)) best = k;
  // Sub-sample peak by a parabola through the neighbours.
  let frac = 0;
  if (best > 0 && best < ncc.length - 1) {
    const y0 = ncc[best - 1] as number;
    const y1 = ncc[best] as number;
    const y2 = ncc[best + 1] as number;
    const den = y0 - 2 * y1 + y2;
    if (den < 0) frac = (0.5 * (y0 - y2)) / den;
  }
  // The winning peak's lobe runs until the correlation first falls to zero either side.
  let left = best;
  while (left > 0 && (ncc[left - 1] as number) > 0) left--;
  let right = best;
  while (right < ncc.length - 1 && (ncc[right + 1] as number) > 0) right++;
  let second = -1;
  for (let k = 0; k < ncc.length; k++) {
    if (k >= left && k <= right) continue;
    if (second < 0 || (ncc[k] as number) > (ncc[second] as number)) second = k;
  }
  const d = best + lo;
  const round = (x: number, p = 1e4) => Math.round(x * p) / p;
  return {
    offset_seconds: round((d + frac) / rate),
    strength: round(ncc[best] as number, 1000),
    overlap_seconds: round((Math.min(na, nb + d) - Math.max(0, d)) / rate, 1000),
    next_best:
      second >= 0
        ? {
            offset_seconds: round((second + lo) / rate),
            strength: round(ncc[second] as number, 1000),
          }
        : null,
  };
}
