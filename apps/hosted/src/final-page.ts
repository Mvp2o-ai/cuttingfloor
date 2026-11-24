import { esc } from './watch-page.ts';

/**
 * What a final-copy link (/final/…) shows when the account has too few credits to remove the
 * watermark: the price, what it has, where to get more, and the watermarked copy, which still
 * downloads. Nothing was spent.
 */
export function finalShortPage(o: {
  name: string;
  price: number;
  left: number;
  /** The signed /outputs/… path and query of the watermarked file. */
  reviewUrl: string;
  /** The site's account page, where credits are bought. */
  accountUrl: string;
}): string {
  const credits = (n: number) => `${Math.round(n * 100) / 100} credit${n === 1 ? '' : 's'}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(o.name)}: more credits needed</title>
<style>
  :root { --bg: #fafaf7; --fg: #16181a; --muted: #5d6166; --line: #d7d9d4; --accent: #12b84a; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #111312; --fg: #eceeea; --muted: #a2a6a0; --line: #2d312e; --accent: #2bd665; }
  }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
  main { max-width: 440px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 16px; color: var(--muted); }
  a.go { display: inline-block; padding: 10px 16px; border-radius: 10px; background: var(--accent); color: #fff; font-weight: 600; text-decoration: none; }
  a.alt { display: inline-block; margin-left: 12px; color: var(--fg); }
</style>
</head>
<body>
<main>
  <h1>The final copy needs ${credits(o.price)}</h1>
  <p>${esc(o.name)} without the watermark uses ${credits(o.price)}, and this account has ${credits(o.left)}. Nothing was spent. Once you have the credits, open the same link again.</p>
  <a class="go" href="${esc(o.accountUrl)}">Get credits</a>
  <a class="alt" href="${esc(o.reviewUrl)}">Download the review copy</a>
</main>
</body>
</html>`;
}
