// Which link or ad brought a visitor, so a sign-up and the first export after it can be counted
// per campaign. A link tagged `?utm_source=reddit&utm_campaign=capcut&utm_content=bollywood`
// leaves a first-party cookie for 30 days; /callback reads it when the account is made and keeps
// it on the account (`source` in the WorkOS metadata). Nothing is sent to anyone else, and an
// untagged visit leaves the cookie as it was.

export const SOURCE_COOKIE = 'cf-src';
export const SOURCE_MAX_AGE = 30 * 24 * 60 * 60;
const PART = 40;

/** One tag reduced to lowercase letters, digits, `_` and `-`, so it is safe in a cookie and a name. */
function slug(raw: string | null | undefined): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PART);
}

/** The tags of a visit as `source~campaign~content`, or undefined when it has no `utm_source`. */
export function sourceOf(search: string): string | undefined {
  const p = new URLSearchParams(search);
  const source = slug(p.get('utm_source'));
  if (!source) return undefined;
  return [source, slug(p.get('utm_campaign')), slug(p.get('utm_content'))].join('~');
}

/** A stored cookie value if it is well formed, else undefined; never trusts what a browser sends. */
export function readSource(value: string | undefined): string | undefined {
  if (!value || !/^[a-z0-9_-]{1,40}~[a-z0-9_-]{0,40}~[a-z0-9_-]{0,40}$/.test(value))
    return undefined;
  return value;
}

/** The tags as a label for a person: `reddit / capcut / bollywood`, leaving out empty parts. */
export function sourceLabel(value: string): string {
  return value
    .split('~')
    .filter((part) => part !== '')
    .join(' / ');
}

// Runs in <head> on every page, before anything else, and never throws: a browser that blocks
// cookies simply has no source.
const DETECT = `(function(){try{
var p=new URLSearchParams(location.search),s=(p.get('utm_source')||'').toLowerCase();
if(!s)return;
var c=function(k){return(p.get(k)||'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,${PART})};
var v=[c('utm_source'),c('utm_campaign'),c('utm_content')].join('~');
document.cookie='${SOURCE_COOKIE}='+v+'; max-age=${SOURCE_MAX_AGE}; path=/; samesite=lax'+(location.protocol==='https:'?'; secure':'');
}catch(e){}})()`;

export function SourceScript() {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant script, no input
  return <script dangerouslySetInnerHTML={{ __html: DETECT }} />;
}
