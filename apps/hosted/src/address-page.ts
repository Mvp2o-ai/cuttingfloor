/**
 * What a browser shows at the MCP address. People paste it into a browser tab instead of their
 * AI app (right after signing up, most often) and saw a JSON sign-in error that read as broken.
 * The response keeps its 401 and sign-in challenge; only the body is for a person.
 */
export function addressPage(address: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>cuttingfloor: paste this address into your AI app</title>
<style>
  :root { --bg: #fafaf7; --fg: #16181a; --muted: #5d6166; --line: #d7d9d4; --accent: #12b84a; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #111312; --fg: #eceeea; --muted: #a2a6a0; --line: #2d312e; --accent: #2bd665; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
  main { width: 100%; max-width: 520px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: var(--muted); margin: 0 0 20px; }
  .line { display: flex; gap: 8px; border: 1px solid var(--line); border-radius: 10px; padding: 8px 8px 8px 12px;
    align-items: center; margin: 0 0 20px; }
  code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 14px; }
  button, a.go { font: inherit; font-weight: 600; border: 0; border-radius: 8px; padding: 8px 14px; cursor: pointer;
    background: var(--fg); color: var(--bg); text-decoration: none; white-space: nowrap; }
  a.go { display: inline-block; background: var(--accent); color: #fff; }
</style>
</head>
<body>
<main>
  <h1>This address goes in your AI app</h1>
  <p>It's where ChatGPT, Claude or another AI app connects to cuttingfloor. It isn't a page to open in a browser. Copy it and add it in your app; when the app asks, sign in.</p>
  <div class="line"><code id="address">${address}</code><button type="button" id="copy">Copy</button></div>
  <a class="go" href="https://cuttingfloor.ai/connect">How to add it to your app</a>
</main>
<script>
document.getElementById('copy').onclick = (e) => {
  navigator.clipboard.writeText(document.getElementById('address').textContent)
    .then(() => { e.target.textContent = 'Copied'; });
};
</script>
</body>
</html>`;
}

/** Whether a request is a person opening the address in a browser tab, not an app. */
export function wantsPage(method: string | undefined, accept: string | undefined): boolean {
  return method === 'GET' && /\btext\/html\b/.test(accept ?? '');
}
