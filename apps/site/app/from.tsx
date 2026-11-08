// Where a visitor came from, so the page leads with what they can use. Someone who arrives from
// ChatGPT or Claude already has an agent: they see how to add cuttingfloor to it first, with the
// Kazi live demo a line below. Anyone else has no agent open, so the live demo leads.
//
// Pages are static, so every variant is in the HTML and CSS shows one (globals.css, "From"): the
// script below sets <html data-from> before the first paint. ChatGPT tags its links with
// utm_source=chatgpt.com; Claude's arrive with a claude.ai referrer. The tag is only on the first
// page, so the tab remembers it. `?from=chatgpt` or `?from=claude` previews a variant.

export const AGENT_SOURCES = ['chatgpt', 'claude'] as const;
export type AgentSource = (typeof AGENT_SOURCES)[number];

const DETECT = `(function(){
var f='',s=null,p=new URLSearchParams(location.search),u=(p.get('from')||p.get('utm_source')||'').toLowerCase(),r='';
try{r=new URL(document.referrer).hostname}catch(e){}
if(/chatgpt|openai/.test(u)||/(^|\\.)(chatgpt|openai)\\.com$/.test(r))f='chatgpt';
else if(/claude|anthropic/.test(u)||/(^|\\.)claude\\.(ai|com)$/.test(r))f='claude';
try{s=sessionStorage;if(f)s.setItem('cf-from',f);else f=s.getItem('cf-from')||''}catch(e){}
if(f==='chatgpt'||f==='claude')document.documentElement.dataset.from=f;
})()`;

/** In <head>, so the right variant shows on the first paint. */
export function FromScript() {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant script, no input
  return <script dangerouslySetInnerHTML={{ __html: DETECT }} />;
}

/** Props that hide an element from visitors who came from an agent. */
export const NOT_FROM_AGENT = { 'data-not-from': AGENT_SOURCES.join(' ') } as const;

/** Props that show an element only to visitors who came from `source`. */
export function onlyFrom(source: AgentSource) {
  return { 'data-only-from': source } as const;
}
