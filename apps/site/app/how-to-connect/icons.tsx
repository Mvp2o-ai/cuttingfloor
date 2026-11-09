import type { WayIcon } from '../../content/ways.ts';

// Plain line icons for each way in, drawn on a 24-unit grid in the text colour. Kazi is ours, so
// it shows its own mark; other apps get a generic icon for what they are, not their logo.

const PATHS: Record<Exclude<WayIcon, 'kazi'>, string[]> = {
  chat: ['M4 5h16v11H9l-5 4z', 'M8 9.5h8', 'M8 12.5h5'],
  cowork: ['M3 6h11v9H3z', 'M10 9h11v9H10z', 'M6 18v2h4'],
  terminal: ['M3 4h18v16H3z', 'M7 9l3 3-3 3', 'M12 15h5'],
  plug: ['M9 3v5', 'M15 3v5', 'M6 8h12v3a6 6 0 0 1-12 0z', 'M12 17v4'],
  braces: [
    'M8 4c-2 0-3 1-3 3v2c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v2c0 2 1 3 3 3',
    'M16 4c2 0 3 1 3 3v2c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v2c0 2-1 3-3 3',
    'M10 12h4',
  ],
  key: ['M8 15a4 4 0 1 1 3.5-6', 'M11 11h10', 'M18 11v3', 'M15 11v2'],
};

export function WayIconMark({ icon, size = 40 }: { icon: WayIcon; size?: number }) {
  if (icon === 'kazi')
    return (
      // biome-ignore lint/performance/noImgElement: a small static mark; next/image adds nothing
      <img className="hc-icon hc-kazi" src="/logos/kazi.png" alt="" width={size} height={size} />
    );
  return (
    <svg
      className="hc-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[icon].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
