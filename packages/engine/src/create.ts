import { BIN, run } from './exec.ts';

// create.matte: a solid or gradient picture as a PNG. Gradients follow CSS: the angle is the
// direction the colour travels (0 up, 90 right, 180 down), the line spans the whole frame, and
// colours mix in sRGB; radial ones reach the farthest corner.

export interface MatteSpec {
  width: number;
  height: number;
  color?: string;
  gradient?: { from: string; to: string; angle: number; kind: 'linear' | 'radial' };
}

const rgba = (hex: string) => {
  const v = hex.replace('#', '');
  const n = (i: number) => Number.parseInt(v.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), v.length === 8 ? n(6) : 255] as const;
};

/** The geq expression for the 0–1 position along the gradient at pixel (X, Y). */
export function gradientPosition(spec: Required<Pick<MatteSpec, 'gradient'>> & MatteSpec): string {
  const { width: w, height: h } = spec;
  const g = spec.gradient;
  if (g.kind === 'radial') {
    return `clip(hypot(X-${w / 2},Y-${h / 2})/${Math.hypot(w / 2, h / 2)},0,1)`;
  }
  const a = (g.angle * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = Math.abs((w / 2) * dx) + Math.abs((h / 2) * dy);
  const f = (n: number) => n.toFixed(6);
  return `clip(((X-${w / 2})*${f(dx)}+(Y-${h / 2})*${f(dy)})/${f(2 * half)}+0.5,0,1)`;
}

export async function renderMatte(
  dest: string,
  spec: MatteSpec,
  signal?: AbortSignal,
): Promise<void> {
  const { width: w, height: h } = spec;
  let graph: string;
  if (spec.gradient) {
    const t = gradientPosition({ ...spec, gradient: spec.gradient });
    const a = rgba(spec.gradient.from);
    const b = rgba(spec.gradient.to);
    const mix = (i: number) => `${a[i]}+(${(b[i] as number) - (a[i] as number)})*${t}`;
    graph = `color=c=black:s=${w}x${h}:d=1,format=rgba,geq=r='${mix(0)}':g='${mix(1)}':b='${mix(2)}':a='${mix(3)}'`;
  } else {
    const [r, g, b, al] = rgba(spec.color ?? '#000000');
    const hex = [r, g, b, al].map((n) => n.toString(16).padStart(2, '0')).join('');
    graph = `color=c=0x${hex}:s=${w}x${h}:d=1,format=rgba`;
  }
  await run(
    BIN.ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      graph,
      '-frames:v',
      '1',
      dest,
    ],
    signal ? { signal } : {},
  );
}
