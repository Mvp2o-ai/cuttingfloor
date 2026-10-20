import type { McpServer } from '@modelcontextprotocol/server';
import type { ServerDeps } from './server.ts';
import { SERVER_VERSION } from './version.ts';

/**
 * The player an MCP Apps host (io.modelcontextprotocol/ui) shows with export.video and media.get
 * results: it plays the signed file in the chat. While an export still runs (a client without
 * Tasks gets a job handle), it follows the job with job.get and plays the result when it lands.
 */
export const PLAYER_URI = 'ui://cuttingfloor/player';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';

/** `_meta` for a tool whose results the player shows. */
export const PLAYER_TOOL_META = { ui: { resourceUri: PLAYER_URI } };

export function registerPlayer(server: McpServer, deps: ServerDeps): void {
  // The page loads the file from this server, so the host lets the sandbox fetch media from it.
  const ui = {
    csp: { resourceDomains: [new URL(deps.runtime.config.publicUrl).origin] },
    prefersBorder: false,
  };
  server.registerResource(
    'player',
    PLAYER_URI,
    {
      title: 'Player',
      description: 'Plays an export or a media file in the chat (MCP Apps view).',
      mimeType: MCP_APP_MIME,
      _meta: { ui },
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: PLAYER_HTML, _meta: { ui } }],
    }),
  );
}

const PLAYER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --bg: transparent; --fg: #16181a; --muted: #5d6166; --stage: #e9ebe6; --accent: #12b84a; --bar: #e7e9e3; }
  :root[data-theme="dark"] { --fg: #eceeea; --muted: #a2a6a0; --stage: #000; --accent: #2bd665; --bar: #222623; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .stage { background: var(--stage); border-radius: 10px; overflow: hidden; display: grid; place-items: center; min-height: 48px; }
  video, img { display: block; max-width: 100%; max-height: 70vh; }
  audio { width: 100%; margin: 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 4px 12px; justify-content: space-between; align-items: baseline; padding: 8px 2px 2px; }
  .name { font-weight: 600; overflow-wrap: anywhere; }
  .meta { color: var(--muted); }
  a { color: var(--accent); cursor: pointer; text-decoration: underline; }
  .wait { padding: 16px; width: 100%; }
  .bar { height: 6px; background: var(--bar); border-radius: 3px; overflow: hidden; margin-top: 8px; }
  .bar div { height: 100%; width: 0; background: var(--accent); transition: width .3s; }
  .error { padding: 16px; }
</style>
</head>
<body>
<div id="root"></div>
<script>
(() => {
  const root = document.getElementById('root');
  let nextId = 1;
  const pending = new Map();
  const send = (msg) => window.parent.postMessage(msg, '*');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
  const el = (tag, attrs, text) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const openLink = (url) => request('ui/open-link', { url }).catch(() => window.open(url, '_blank', 'noopener'));

  function show(nodes) {
    root.replaceChildren(...nodes);
  }

  function kindOf(data) {
    if (data.kind === 'video' || data.kind === 'audio' || data.kind === 'image') return data.kind;
    return (data.mime_type || '').split('/')[0];
  }

  function play(data) {
    const kind = kindOf(data);
    const stage = el('div', { class: 'stage' });
    if (kind === 'video') stage.append(el('video', { src: data.url, controls: '', playsinline: '', preload: 'metadata' }));
    else if (kind === 'audio') stage.append(el('audio', { src: data.url, controls: '', preload: 'metadata' }));
    else if (kind === 'image') stage.append(el('img', { src: data.url, alt: data.name || '' }));
    else stage.append(el('div', { class: 'wait meta' }, 'This file does not play here.'));
    const row = el('div', { class: 'row' });
    const label = data.name || (data.url ? decodeURIComponent(new URL(data.url).pathname.split('/').pop()) : '');
    row.append(el('span', { class: 'name' }, label));
    const links = el('span', { class: 'meta' });
    if (data.page_url) {
      const page = el('a', {}, 'Open page');
      page.addEventListener('click', () => openLink(data.page_url));
      links.append(page, document.createTextNode(' · '));
    }
    const dl = el('a', {}, 'Download');
    dl.addEventListener('click', () => openLink(data.url));
    links.append(dl);
    row.append(links);
    show([stage, row]);
  }

  function waiting(text, progress) {
    const box = el('div', { class: 'stage' });
    const inner = el('div', { class: 'wait' });
    inner.append(el('div', { class: 'meta' }, text));
    const bar = el('div', { class: 'bar' });
    const fill = el('div');
    fill.style.width = Math.round((progress || 0) * 100) + '%';
    bar.append(fill);
    inner.append(bar);
    box.append(inner);
    show([box]);
  }

  function failed(text) {
    show([el('div', { class: 'stage error meta' }, text)]);
  }

  async function follow(jobId) {
    for (;;) {
      let view;
      try {
        const r = await request('tools/call', { name: 'job.get', arguments: { job_id: jobId, wait_seconds: 50 } });
        view = r && r.structuredContent;
        if (r && r.isError) return failed((view && view.message) || 'The job could not be read.');
      } catch (e) {
        return failed('Waiting for the export: ' + (e && e.message ? e.message : 'the host did not answer') + '.');
      }
      if (!view) return failed('The job could not be read.');
      if (view.status === 'completed' && view.result) return render(view.result);
      if (view.status === 'failed' || view.status === 'cancelled') {
        return failed((view.error && view.error.message) || 'The export ' + view.status + '.');
      }
      waiting(view.status_message || 'Working…', view.progress);
    }
  }

  function render(data) {
    if (!data) return failed('Nothing to show.');
    if (data.url) return play(data);
    if (data.job_id && data.status && data.status !== 'completed') {
      waiting('Working…', 0);
      return follow(data.job_id);
    }
    if (data.status === 'importing' || data.status === 'processing') return waiting('Still importing…', 0);
    failed('Nothing to play yet.');
  }

  function onResult(result) {
    if (!result) return;
    if (result.isError) return failed((result.structuredContent && result.structuredContent.message) || 'The call failed.');
    render(result.structuredContent);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'error'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'ui/notifications/tool-result') onResult(msg.params);
    else if (msg.method === 'ui/notifications/host-context-changed' && msg.params && msg.params.theme) {
      document.documentElement.dataset.theme = msg.params.theme;
    } else if (msg.method === 'ui/resource-teardown' && msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  });

  new ResizeObserver(() => {
    notify('ui/notifications/size-changed', { width: document.body.scrollWidth, height: document.body.scrollHeight });
  }).observe(document.body);

  request('ui/initialize', {
    appInfo: { name: 'cuttingfloor-player', version: ${JSON.stringify(SERVER_VERSION)} },
    appCapabilities: {},
    protocolVersion: '2026-01-26',
  }).then((r) => {
    const theme = r && r.hostContext && r.hostContext.theme;
    if (theme) document.documentElement.dataset.theme = theme;
    notify('ui/notifications/initialized', {});
  }).catch(() => notify('ui/notifications/initialized', {}));
})();
</script>
</body>
</html>
`;
