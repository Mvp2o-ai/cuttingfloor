import type { NextConfig } from 'next';

// The site's own config, so Next never picks one up from a parent folder.
const config: NextConfig = {
  // The skill pages read skills/*.md with the same checks the server uses.
  transpilePackages: ['@cuttingfloor/skills', '@cuttingfloor/schema', '@cuttingfloor/plans'],
  // Pages that moved keep working at their old addresses.
  async redirects() {
    return [
      // One address for search engines and sign-in: www and the production vercel.app alias move
      // to cuttingfloor.ai, path and query kept. Preview deployments have other hosts and stay put.
      ...['www.cuttingfloor.ai', 'cuttingfloor-site.vercel.app'].map((value) => ({
        source: '/:path*',
        has: [{ type: 'host' as const, value }],
        destination: 'https://cuttingfloor.ai/:path*',
        permanent: true,
      })),
      { source: '/demo', destination: '/demos', permanent: true },
      {
        source: '/walkthroughs/fix-jagged-cuts',
        destination: '/walkthroughs/cut-pauses-and-restarts',
        permanent: true,
      },
    ];
  },
};

export default config;
