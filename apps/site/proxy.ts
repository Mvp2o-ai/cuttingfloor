import { authkitProxy } from '@workos-inc/authkit-nextjs';
import { type NextFetchEvent, type NextRequest, NextResponse } from 'next/server';
import { markdownRoute, prefersMarkdown, sectionTwinRoute } from './app/lib/negotiate.ts';
import { referralCookie, referralPath } from './app/referral.ts';

// Three jobs, and the matcher keeps them narrow so every public page stays a static file:
// - Sessions for the signed-in pages. Signed-out visitors to /account, /upload, /welcome, /kazi, /r/<file>, the staff
//   pages (/admin, /admin/<account id>) and the billing
//   routes go to the WorkOS sign-in first; /start sends them to the sign-up screen itself.
// - A person's link, /r/<code> (referral.ts): no sign-in; it leaves the tagged links' cookie,
//   naming the code, and the page shows what cuttingfloor makes.
// - Markdown for agents. A request whose Accept header names text/markdown (and likes it at least
//   as much as HTML) gets the page's Markdown twin; /demos/<slug>.md and the like reach their twin.
//   It runs only when the header asks, decided on the header and never the user agent, and before
//   Vercel's cache, so the HTML and Markdown are cached under different paths.

const auth = authkitProxy({
  middlewareAuth: { enabled: true, unauthenticatedPaths: ['/callback', '/start'] },
});

const AUTH =
  /^\/(account|upload|welcome|kazi|start|callback|admin)$|^\/admin\/user_[0-9A-Z]{26}$|^\/api\/|^\/r\/[^/]+$/;

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const { pathname } = request.nextUrl;
  const code = referralPath(pathname);
  if (code) {
    const next = NextResponse.next();
    next.cookies.set(referralCookie(code, request.nextUrl.protocol === 'https:'));
    return next;
  }
  if (AUTH.test(pathname)) return auth(request, event);
  const twin =
    sectionTwinRoute(pathname) ??
    (prefersMarkdown(request.headers.get('accept')) ? markdownRoute(pathname) : null);
  return twin ? NextResponse.rewrite(new URL(twin, request.url)) : NextResponse.next();
}

export const config = {
  matcher: [
    '/account',
    '/upload',
    '/welcome',
    '/kazi',
    '/start',
    '/callback',
    '/r/:file',
    '/admin',
    '/admin/:id(user_[0-9A-Z]{26})',
    '/api/:path*',
    '/:section(demos|walkthroughs|skills|agents|guides|fixes|es|compare)/:slug.md',
    {
      source: '/((?!_next/|api/|md/|r/|account|upload|welcome|kazi|start|callback|admin|.*\\.).*)',
      has: [{ type: 'header', key: 'accept', value: '.*text/(x-)?markdown.*' }],
    },
  ],
};
