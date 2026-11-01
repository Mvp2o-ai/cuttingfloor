import { ticksPerFrame } from '@cuttingfloor/core';
import { clipPlacements, renderPicture } from '@cuttingfloor/engine';
import type { StoredClip, TimelineDoc } from '@cuttingfloor/schema';
import type { Runtime } from './runtime.ts';

// Readback for compositing edits: where each clip whose transform, mask or animation changed
// now shows in the frame, in sequence pixels, worked out as the compositor places it.

/** Edits whose result carries placements. */
export const PLACING_TOOLS = new Set(['clip.set_transform', 'clip.set_mask', 'clip.set_animation']);

const look = (c: StoredClip) =>
  JSON.stringify([c.transform ?? null, c.mask ?? null, c.animation ?? null]);

/** The placements of the video clips an edit moved, scaled, cropped, masked or animated. */
export async function placementsFor(
  rt: Runtime,
  owner: string,
  base: TimelineDoc,
  doc: TimelineDoc,
) {
  const before = new Map<string, string>();
  for (const t of base.tracks) for (const c of t.clips) before.set(c.id, look(c));
  const tpf = ticksPerFrame(doc.sequence.fps);
  const frame = { width: doc.sequence.width, height: doc.sequence.height };
  const out = [];
  for (const t of doc.tracks) {
    if (t.kind !== 'video') continue;
    for (const c of t.clips) {
      if (c.type === 'adjustment' || before.get(c.id) === look(c)) continue;
      let src = { ...frame, alpha: true };
      if (c.type === 'timeline') {
        const seq = doc.nested?.[c.timeline]?.sequence;
        if (seq) src = { width: seq.width, height: seq.height, alpha: true };
      } else if (c.type === 'media') {
        const record = await rt.media.find(owner, c.media_id);
        let p: ReturnType<typeof renderPicture> | undefined;
        try {
          p = record ? renderPicture(record, 'export') : undefined;
        } catch {
          p = undefined;
        }
        if (!p?.width || !p.height) continue;
        src = { width: p.width, height: p.height, alpha: p.alpha };
      }
      const n = Math.max(1, Math.round(c.duration / tpf));
      out.push({ clip_id: c.id, ...clipPlacements(c, tpf, n, src, frame) });
    }
  }
  return out;
}
