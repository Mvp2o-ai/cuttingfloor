import type { NextConfig } from 'next';

// The site's own config, so Next never picks one up from a parent folder.
const config: NextConfig = {
  // The skill pages read skills/*.md with the same checks the server uses.
  transpilePackages: ['@cuttingfloor/skills', '@cuttingfloor/schema'],
  // Pages that moved keep working at their old addresses.
  async redirects() {
    return [
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
