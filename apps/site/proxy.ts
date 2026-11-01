import { authkitProxy } from '@workos-inc/authkit-nextjs';
import { type NextFetchEvent, type NextRequest, NextResponse } from 'next/server';
import { markdownRoute, prefersMarkdown, sectionTwinRoute } from './app/lib/negotiate.ts';

// Two jobs, and the matcher keeps both narrow so every public page stays a static file:
// - Sessions for the signed-in pages. Signed-out visitors to /account, /welcome and the billing
//   routes go to the WorkOS sign-in first; /start sends them to the sign-up screen itself.
// - Markdown for agents. A request whose Accept header names text/markdown (and likes it at least
//   as much as HTML) gets the page's Markdown twin; /demos/<slug>.md and the like reach their twin.
//   It runs only when the header asks, decided on the header and never the user agent, and before
//   Vercel's cache, so the HTML and Markdown are cached under different paths.

const auth = authkitProxy({
  middlewareAuth: { enabled: true, unauthenticatedPaths: ['/callback', '/start'] },
});

const AUTH = /^\/(account|welcome|start|callback)$|^\/api\//;

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const { pathname } = request.nextUrl;
  if (AUTH.test(pathname)) return auth(request, event);
  const twin =
    sectionTwinRoute(pathname) ??
    (prefersMarkdown(request.headers.get('accept')) ? markdownRoute(pathname) : null);
  return twin ? NextResponse.rewrite(new URL(twin, request.url)) : NextResponse.next();
}

export const config = {
  matcher: [
    '/account',
    '/welcome',
    '/start',
    '/callback',
    '/api/:path*',
    '/:section(demos|walkthroughs|skills)/:slug.md',
    {
      source: '/((?!_next/|api/|md/|account|welcome|start|callback|.*\\.).*)',
      has: [{ type: 'header', key: 'accept', value: '.*text/(x-)?markdown.*' }],
    },
  ],
};
