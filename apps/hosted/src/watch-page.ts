/**
 * The page a signed /watch/… link opens: the file played (or shown) in the browser, with a
 * download link. It is what an agent gives a person to watch or share an export; the link works
 * as long as the file's own signed URL, and needs no sign-in.
 */
export function watchPage(o: {
  name: string;
  mime: string;
  /** The signed /outputs/… path and query of the file itself. */
  fileUrl: string;
  /** This server's public base URL, for the link previews chat apps show (they need it whole). */
  base: string;
  expiresAt: Date;
  /** The file is fetched from a bucket: what plays it asks for it to be shown, not saved. */
  inline?: boolean;
  /**
   * It has a cuttingfloor watermark: what removing it costs, the credits the account has
   * (undefined when that can't be told, null for no cap), and the final-copy link the page's
   * button posts to. Only the button spends: opening the page (a mail scanner checking an emailed
   * link, say) spends nothing.
   */
  mark?: { credits: number; left?: number | null | undefined; finalUrl: string };
}): string {
  const name = esc(o.name);
  const href = esc(o.fileUrl);
  const src = esc(o.inline ? `${o.fileUrl}&inline=1` : o.fileUrl);
  const whole = esc(`${o.base}${o.fileUrl}`);
  const kind = o.mime.split('/')[0];
  const player =
    kind === 'video'
      ? `<video src="${src}" controls playsinline preload="metadata"></video>`
      : kind === 'audio'
        ? `<audio src="${src}" controls preload="metadata"></audio>`
        : kind === 'image'
          ? `<img src="${src}" alt="${name}">`
          : `<p class="none">This file doesn't play in a browser. Download it to open it.</p>`;
  const og =
    kind === 'video'
      ? `<meta property="og:type" content="video.other">
<meta property="og:video" content="${whole}">
<meta property="og:video:type" content="${esc(o.mime)}">`
      : kind === 'image'
        ? `<meta property="og:image" content="${whole}">`
        : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${name}</title>
<meta property="og:title" content="${name}">
${og}
<style>
  :root { --bg: #fafaf7; --fg: #16181a; --muted: #5d6166; --line: #d7d9d4; --accent: #12b84a; --stage: #e9ebe6; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #111312; --fg: #eceeea; --muted: #a2a6a0; --line: #2d312e; --accent: #2bd665; --stage: #000; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
  main { width: 100%; max-width: 960px; }
  .stage { background: var(--stage); border-radius: 12px; overflow: hidden; display: grid; place-items: center; }
  video, img { display: block; max-width: 100%; max-height: 80vh; }
  /* Over checks: what is transparent shows as checks, a background baked into the file as itself. */
  img, video { background: repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 50% / 16px 16px; }
  audio { width: 100%; margin: 24px; }
  .none { color: var(--muted); padding: 48px 16px; margin: 0; text-align: center; }
  footer { display: flex; flex-wrap: wrap; gap: 8px 16px; justify-content: space-between; align-items: baseline; margin-top: 12px; }
  h1 { font-size: 16px; font-weight: 600; margin: 0; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 14px; }
  a { color: var(--accent); }
  .mark { color: var(--muted); font-size: 14px; margin: 12px 0 0; }
  form { margin: 12px 0 0; }
  button { font: inherit; font-weight: 600; padding: 10px 16px; border: 0; border-radius: 10px; background: var(--accent); color: #fff; cursor: pointer; }
</style>
</head>
<body>
<main>
  <div class="stage">${player}</div>
  <footer>
    <h1>${name}</h1>
    <span class="meta"><a href="${href}" download>Download</a> · link works until <time datetime="${o.expiresAt.toISOString()}">${o.expiresAt.toUTCString()}</time></span>
  </footer>
  ${o.mark ? markBlock(o.mark) : ''}
</main>
</body>
</html>
`;
}

function markBlock(mark: { credits: number; left?: number | null | undefined; finalUrl: string }) {
  const credits = (n: number) => `${Math.round(n * 100) / 100} credit${n === 1 ? '' : 's'}`;
  const has = typeof mark.left === 'number' ? `; you have ${credits(mark.left)}` : '';
  return `<p class="mark">This file has a cuttingfloor watermark. Removing it uses ${credits(mark.credits)}${has}. From then on this link plays and downloads it without the watermark.</p>
  <form method="post" action="${esc(mark.finalUrl)}"><button type="submit">Remove the watermark · ${credits(mark.credits)}</button></form>`;
}

export function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
