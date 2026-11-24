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
  label.over, label:focus-within { border-color: var(--accent); }
  @media (hover: hover) { label:hover { border-color: var(--accent); } }
  label strong { display: block; color: var(--fg); }
  label span { color: var(--muted); }
  input { display: none; }
  /* A phone has nothing to drag: the box is one big button to the gallery or files. */
  .on-phone { display: none; }
  @media (pointer: coarse) {
    .on-phone { display: block; }
    .on-computer { display: none; }
    label { border-style: solid; border-color: var(--accent); background: var(--bar); padding: 36px 20px; }
    label strong { font-size: 18px; }
    label:active { background: color-mix(in srgb, var(--accent) 22%, var(--bar)); }
  }
  .bar { height: 8px; background: var(--bar); border-radius: 4px; overflow: hidden; margin: 20px 0 8px; }
  .bar div { height: 100%; width: 0; background: var(--accent); transition: width .2s; }
  #status { min-height: 1.5em; }
  .done { color: var(--accent); font-weight: 600; }
  code { font-size: 14px; }
  /* Sharing a sent sound as a community sound: off until turned on. */
  #share { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--line); }
  #share .on { display: flex; gap: 10px; align-items: flex-start; border: 0; padding: 0; text-align: left; cursor: pointer; }
  #share .on input { display: inline; margin-top: 4px; width: 18px; height: 18px; accent-color: var(--accent); }
  #share small { display: block; color: var(--muted); }
  #fields { display: grid; gap: 10px; margin-top: 14px; }
  #fields label.f { display: grid; gap: 4px; border: 0; padding: 0; text-align: left; color: var(--muted); font-size: 14px; cursor: default; }
  #fields input, #fields textarea { display: block; font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
  #fields textarea { min-height: 60px; }
  #fields button { justify-self: start; font: inherit; font-weight: 600; border: 0; border-radius: 8px; padding: 10px 18px; background: var(--accent); color: #04170a; cursor: pointer; }
  .fine { color: var(--muted); font-size: 14px; margin: 0; }
</style>
</head>
<body>
<main>
  <h1>Send a file</h1>
  <p>Your AI asked for this file. Pick it here and it goes straight to cuttingfloor.</p>
  <label id="drop">
    <span class="on-computer"><strong>Drop a video, audio file or image here</strong><span>or click to choose one</span></span>
    <span class="on-phone"><strong>Tap to choose a video, audio file or photo</strong><span>From your gallery or files</span></span>
    <input id="pick" type="file">
  </label>
  <div class="bar" hidden><div></div></div>
  <div id="status" role="status" aria-live="polite"></div>
  <form id="share" hidden novalidate>
    <label class="on"><input type="checkbox" id="share-on"><span><strong>Share as a community sound</strong><small>A small way to give back: other creators can find it and use it in their edits, free.</small></span></label>
    <div id="fields" hidden>
      <label class="f">Name<input id="s-name" maxlength="80"></label>
      <label class="f">What it is<textarea id="s-desc" maxlength="500" placeholder="The hook from my track, a bass drop at 0:04"></textarea></label>
      <label class="f">Category<input id="s-cat" maxlength="60" list="s-cats" placeholder="Music"></label>
      <label class="f">Tags<input id="s-tags" maxlength="200" placeholder="hype, drop, edm"></label>
      <label class="f">Credit as<input id="s-author" maxlength="60" placeholder="Your first name"></label>
      <datalist id="s-cats"><option value="Trending sounds"><option value="Music"><option value="Meme and hype"><option value="Voice and quotes"></datalist>
      <p class="fine">Share only sounds that are yours to share. You can take it down from your upload page, and sounds people report are taken down.</p>
      <button type="submit" id="s-go">Share</button>
      <p class="fine" id="s-note" role="status"></p>
    </div>
  </form>
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
  // Phones freeze the page when the user switches back to the chat: keep the screen awake while
  // sending, and send again a part cut off in the background once the page is back.
  let lock;
  let cut;
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (busy && navigator.wakeLock) navigator.wakeLock.request('screen').then((l) => { lock = l; }, () => {});
    if (hiddenAt && Date.now() - hiddenAt > 3000 && cut) cut.abort();
    hiddenAt = 0;
  });
  const say = (text, done) => { status.textContent = text; status.className = done ? 'done' : ''; };
  const mb = (n) => (n / 1e6).toFixed(1) + ' MB';

  async function offset() {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (r.status === 404) throw new Error('This link has already been used or has expired. Ask your agent for a new one.');
    if (!r.ok) throw new Error('This link no longer works (' + r.status + '). Ask your agent for a new one.');
    return { at: Number(r.headers.get('upload-offset') || 0), complete: r.headers.get('upload-complete') === 'true' };
  }

  // The link with something after its path: /parts, /parts/3, /complete.
  const sub = (more, query) => location.origin + location.pathname + more + location.search + (query || '');
  const gone = () => Object.assign(new Error('This link no longer works. Ask your agent for a new one.'), { final: true });

  // Sends the file as numbered parts, six at once, each sent again by itself if it drops. A
  // reload or another device asks which parts are in and sends the rest. Answers false where
  // the server takes a file whole (or this one was begun that way, or the server does not know
  // the parts path): then it is sent in order.
  async function sendParts(file) {
    const begun = await fetch(sub('/parts', '&bytes=' + file.size), { cache: 'no-store', headers: { 'upload-name': encodeURIComponent(file.name) } });
    const plan = await begun.json().catch(() => ({}));
    if (begun.status === 413) throw Object.assign(new Error(plan.error || 'The file is too big.'), { final: true });
    // Anything else not taken (a server that takes a file whole, a link it does not know):
    // sent in order, which says what is wrong if anything is.
    if (!begun.ok || !plan.part_bytes) return false;
    if (plan.complete) return true;
    const size = plan.part_bytes;
    const count = Math.max(1, Math.ceil(file.size / size));
    const have = new Set((plan.parts || []).map((p) => p.part));
    const todo = [];
    for (let n = 1; n <= count; n++) if (!have.has(n)) todo.push(n);
    const sent = new Map();
    let done = (plan.parts || []).reduce((sum, p) => sum + p.bytes, 0);
    const show = () => {
      let now = done;
      for (const v of sent.values()) now += v;
      fill.style.width = (100 * now / Math.max(file.size, 1)) + '%';
      say('Sending ' + file.name + ': ' + mb(now) + ' of ' + mb(file.size) + '. Keep this page open until it is sent; if you switch apps, come back and it carries on.');
    };
    show();
    cut = new AbortController();
    const one = async (n) => {
      const body = file.slice((n - 1) * size, Math.min(n * size, file.size));
      for (let tries = 0; ; ) {
        const mine = cut;
        try {
          const r = await fetch(sub('/parts/' + n), { method: 'PUT', body, signal: mine.signal });
          if (r.status === 403 || r.status === 404) throw gone();
          if (r.status === 413) throw Object.assign(new Error('The file is too big.'), { final: true });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          done += body.size;
          sent.delete(n);
          show();
          return;
        } catch (error) {
          // A part cut off because the page came back from the background is not a failure.
          const resumed = mine.signal.aborted;
          if (error.final || (!resumed && ++tries > 5)) throw error;
          if (resumed) { if (cut === mine) cut = new AbortController(); }
          else await new Promise((r) => setTimeout(r, 1000 * tries));
        }
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(6, todo.length); i++) {
      workers.push((async () => { while (todo.length) await one(todo.shift()); })());
    }
    await Promise.all(workers);
    for (let tries = 0; ; ) {
      const r = await fetch(sub('/complete'), { method: 'POST' });
      if (r.ok) return true;
      const body = await r.json().catch(() => ({}));
      // Parts the server does not have after all are sent again.
      if (r.status === 409 && body.missing && body.missing.length && ++tries <= 3) {
        for (const n of body.missing) await one(n);
        continue;
      }
      if (r.status === 403 || r.status === 404) throw gone();
      if (++tries > 3) throw new Error(body.error || 'HTTP ' + r.status);
      await new Promise((res) => setTimeout(res, 1000 * tries));
    }
  }

  async function send(file) {
    if (busy) return;
    busy = true;
    bar.hidden = false;
    if (navigator.wakeLock) lock = await navigator.wakeLock.request('screen').catch(() => undefined);
    try {
      let { at, complete } = await offset();
      if (at > file.size) at = 0;
      if (!complete && (await sendParts(file).catch((error) => { if (error.final) throw error; return offset().then((o) => { if (o.complete) return true; throw error; }); }))) complete = true;
      for (let tries = 0; !complete; ) {
        const end = Math.min(at + PART, file.size);
        fill.style.width = (100 * at / Math.max(file.size, 1)) + '%';
        say('Sending ' + file.name + ': ' + mb(at) + ' of ' + mb(file.size) + '. Keep this page open until it is sent; if you switch apps, come back and it carries on.');
        cut = new AbortController();
        try {
          const r = await fetch(url, {
            method: 'PUT',
            headers: { 'content-range': 'bytes ' + at + '-' + (end - 1) + '/' + file.size, 'upload-name': encodeURIComponent(file.name) },
            body: file.slice(at, end),
            signal: cut.signal,
          });
          const body = await r.json().catch(() => ({}));
          if (r.status === 413) throw Object.assign(new Error(body.error || 'The file is too big.'), { final: true });
          if (r.status === 403 || r.status === 404) throw Object.assign(new Error('This link no longer works. Ask your agent for a new one.'), { final: true });
          if (!r.ok && r.status !== 409) throw new Error(body.error || 'HTTP ' + r.status);
          at = Number(r.headers.get('upload-offset') || end);
          complete = r.headers.get('upload-complete') === 'true';
          tries = 0;
        } catch (error) {
          // A part cut off because the page came back from the background is not a failure.
          const resumed = cut.signal.aborted;
          if (error.final || (!resumed && ++tries > 5)) throw error;
          say('Connection dropped; picking up where it stopped…');
          if (!resumed) await new Promise((r) => setTimeout(r, 1000 * tries));
          ({ at, complete } = await offset());
        }
      }
      fill.style.width = '100%';
      say('Sent. Go back to the chat and say it’s in. (Upload ' + id + ')', true);
      drop.hidden = true;
      if (file.type.startsWith('audio/') || AUDIO.test(file.name)) offerShare(file.name);
    } catch (error) {
      say(error.message || String(error));
    } finally {
      busy = false;
      cut = undefined;
      if (lock) lock.release().catch(() => {});
      lock = undefined;
    }
  }

  // ---------- sharing a sent sound (off unless the person turns it on) ----------
  const AUDIO = /[.](mp3|wav|m4a|aac|flac|ogg|opus)$/i;
  const shareForm = document.getElementById('share');
  const $s = (sel) => document.getElementById(sel);
  function offerShare(name) {
    shareForm.hidden = false;
    $s('s-name').value = name.replace(/[.][^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 80);
  }
  $s('share-on').addEventListener('change', (e) => { $s('fields').hidden = !e.target.checked; });
  shareForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = (t) => { $s('s-note').textContent = t; };
    const body = {
      name: $s('s-name').value.trim(),
      description: $s('s-desc').value.trim(),
      category: $s('s-cat').value.trim(),
      tags: $s('s-tags').value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10),
    };
    if ($s('s-author').value.trim()) body.author = $s('s-author').value.trim();
    if (!body.name || !body.description || !body.category) return note('Give it a name, say what it is and pick a category.');
    $s('s-go').disabled = true;
    note('Sharing…');
    try {
      const r = await fetch(sub('/share'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.sound) throw new Error([d.error, d.hint].filter(Boolean).join('. ') || 'HTTP ' + r.status);
      shareForm.innerHTML = '';
      const done = document.createElement('p');
      done.className = 'done';
      done.textContent = 'Shared as a community sound: “' + d.sound.name + '”. Thank you. ';
      const a = document.createElement('a');
      a.href = 'https://cuttingfloor.ai/community-sounds?sound=' + encodeURIComponent(d.sound.sound_id);
      a.textContent = 'See it';
      done.append(a);
      shareForm.append(done);
    } catch (error) {
      $s('s-go').disabled = false;
      note(error.message || String(error));
    }
  });

  pick.addEventListener('change', () => pick.files[0] && send(pick.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const file = e.dataTransfer.files[0];
    if (file) send(file);
  });
  offset().then(({ at, complete }) => {
    if (complete) { drop.hidden = true; say('This file is already here. Go back to the chat and say it’s in. (Upload ' + id + ')', true); }
    else if (at > 0) say(mb(at) + ' of your file is already here. Choose the same file again and the rest is sent.');
  }, (error) => say(error.message));
})();
</script>
</body>
</html>
`;
}
