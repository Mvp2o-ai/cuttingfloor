/**
 * The page a signed upload URL shows in a browser: drop or pick the file, and it goes up in
 * parts to the same URL, resuming from what the server already has. For people whose agent
 * can't send files itself; the agent then imports the upload_id.
 */
export function uploadPage(uploadId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Send a file to cuttingfloor</title>
<style>
  :root { --bg: #fafaf7; --fg: #16181a; --muted: #5d6166; --line: #d7d9d4; --accent: #12b84a; --bar: #e7e9e3; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #111312; --fg: #eceeea; --muted: #a2a6a0; --line: #2d312e; --accent: #2bd665; --bar: #222623; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
  main { width: 100%; max-width: 520px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p { color: var(--muted); margin: 0 0 20px; }
  label { display: block; border: 2px dashed var(--line); border-radius: 12px; padding: 40px 16px; text-align: center;
    cursor: pointer; transition: border-color .15s; }
  label.over, label:hover { border-color: var(--accent); }
  input { display: none; }
  .bar { height: 8px; background: var(--bar); border-radius: 4px; overflow: hidden; margin: 20px 0 8px; }
  .bar div { height: 100%; width: 0; background: var(--accent); transition: width .2s; }
  #status { min-height: 1.5em; }
  .done { color: var(--accent); font-weight: 600; }
  code { font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>Send a file</h1>
  <p>Your agent asked for this file. Drop it here; it goes straight to your cuttingfloor workspace.</p>
  <label id="drop">Drop a video, audio file or image, or click to choose one<input id="pick" type="file"></label>
  <div class="bar" hidden><div></div></div>
  <div id="status" role="status" aria-live="polite"></div>
</main>
<script>
(() => {
  const url = location.href;
  const id = ${JSON.stringify(uploadId)};
  const PART = 16 * 1024 * 1024;
  const drop = document.getElementById('drop');
  const pick = document.getElementById('pick');
  const bar = document.querySelector('.bar');
  const fill = bar.firstElementChild;
  const status = document.getElementById('status');
  let busy = false;
  const say = (text, done) => { status.textContent = text; status.className = done ? 'done' : ''; };
  const mb = (n) => (n / 1e6).toFixed(1) + ' MB';

  async function offset() {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (r.status === 404) throw new Error('This link has already been used or has expired. Ask your agent for a new one.');
    if (!r.ok) throw new Error('This link no longer works (' + r.status + '). Ask your agent for a new one.');
    return { at: Number(r.headers.get('upload-offset') || 0), complete: r.headers.get('upload-complete') === 'true' };
  }

  async function send(file) {
    if (busy) return;
    busy = true;
    bar.hidden = false;
    try {
      let { at, complete } = await offset();
      if (at > file.size) at = 0;
      for (let tries = 0; !complete; ) {
        const end = Math.min(at + PART, file.size);
        fill.style.width = (100 * at / Math.max(file.size, 1)) + '%';
        say('Sending ' + file.name + ': ' + mb(at) + ' of ' + mb(file.size));
        try {
          const r = await fetch(url, {
            method: 'PUT',
            headers: { 'content-range': 'bytes ' + at + '-' + (end - 1) + '/' + file.size },
            body: file.slice(at, end),
          });
          const body = await r.json().catch(() => ({}));
          if (r.status === 413) throw Object.assign(new Error(body.error || 'The file is too big.'), { final: true });
          if (r.status === 403 || r.status === 404) throw Object.assign(new Error('This link no longer works. Ask your agent for a new one.'), { final: true });
          if (!r.ok && r.status !== 409) throw new Error(body.error || 'HTTP ' + r.status);
          at = Number(r.headers.get('upload-offset') || end);
          complete = r.headers.get('upload-complete') === 'true';
          tries = 0;
        } catch (error) {
          if (error.final || ++tries > 5) throw error;
          say('Connection dropped; picking up where it stopped…');
          await new Promise((r) => setTimeout(r, 1000 * tries));
          ({ at, complete } = await offset());
        }
      }
      fill.style.width = '100%';
      say('Sent. Tell your agent the file is in (upload ' + id + ').', true);
      drop.hidden = true;
    } catch (error) {
      say(error.message || String(error));
    } finally {
      busy = false;
    }
  }

  pick.addEventListener('change', () => pick.files[0] && send(pick.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const file = e.dataTransfer.files[0];
    if (file) send(file);
  });
  offset().then(({ complete }) => {
    if (complete) { drop.hidden = true; say('This file is already here. Tell your agent it is in.', true); }
  }, (error) => say(error.message));
})();
</script>
</body>
</html>
`;
}
