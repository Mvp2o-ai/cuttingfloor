// Tells Bing (and the other IndexNow engines) which pages changed, so they recrawl them soon;
// ChatGPT search finds pages through Bing. Run it after a deploy, never before: the engines fetch
// the key file and the pages from the live site.
//
//   node apps/site/scripts/indexnow.ts                    every URL in the live sitemap
//   node apps/site/scripts/indexnow.ts /fixes /fixes/x    just these (paths or full URLs)
//   --site https://cuttingfloor.ai                        another origin (default: the live site)
//   --dry-run                                             print what would be sent, send nothing
//
// The key is public by design: it only proves we own the host, by being served at /<key>.txt
// (apps/site/public). Changing it means renaming that file too.

export {};

const KEY = '17783e35f6b91d975df5cb4ddd33a0bc';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
/** IndexNow takes at most 10,000 URLs a request. */
const BATCH = 10_000;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const siteAt = args.indexOf('--site');
const site = new URL(siteAt >= 0 ? (args[siteAt + 1] ?? '') : 'https://cuttingfloor.ai');
const given = args.filter((a, i) => !a.startsWith('--') && (siteAt < 0 || i !== siteAt + 1));
const keyLocation = new URL(`/${KEY}.txt`, site).toString();

async function sitemapUrls(): Promise<string[]> {
  const res = await fetch(new URL('/sitemap.xml', site));
  if (!res.ok) throw new Error(`sitemap.xml: HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1] as string);
}

const all = given.length ? given.map((u) => new URL(u, site).toString()) : await sitemapUrls();
// Every URL in a request must be on the host the key belongs to.
const urls = [...new Set(all)].filter((u) => new URL(u).host === site.host);
const skipped = all.length - urls.length;
if (!urls.length) throw new Error(`no URLs on ${site.host} to send`);

console.log(
  `${urls.length} URLs on ${site.host}${skipped ? ` (${skipped} on other hosts skipped)` : ''}`,
);
if (dryRun) {
  for (const u of urls) console.log(`  ${u}`);
  console.log(`key file: ${keyLocation} (not checked, nothing sent)`);
  process.exit(0);
}

const served = await fetch(keyLocation).then((r) => (r.ok ? r.text() : ''));
if (served.trim() !== KEY)
  throw new Error(`${keyLocation} does not serve the key yet; deploy apps/site/public first`);

for (let i = 0; i < urls.length; i += BATCH) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: site.host,
      key: KEY,
      keyLocation,
      urlList: urls.slice(i, i + BATCH),
    }),
  });
  // 200: received. 202: received, the key is still being checked. Anything else is a refusal.
  if (res.status !== 200 && res.status !== 202)
    throw new Error(`IndexNow: HTTP ${res.status} ${await res.text()}`);
  console.log(`IndexNow: HTTP ${res.status} for ${Math.min(BATCH, urls.length - i)} URLs`);
}
