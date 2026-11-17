import {
  ALLOW_ACCESS,
  ALLOW_ACCESS_SHOT,
  allowAccessNote,
  LOCALHOST_SPEC,
} from '../../content/clients.ts';

/**
 * For an app that finishes sign-in on the person's computer: the warning they will see, shown
 * before they meet it, so it reads as expected. Apps added on the web never render this.
 */
export function AllowAccess({ name }: { name: string }) {
  return (
    <div className="allow-access">
      <p>
        {allowAccessNote(name)} <a href={ALLOW_ACCESS}>Why?</a> You can read more in the{' '}
        <a href={LOCALHOST_SPEC} rel="noopener">
          MCP spec
        </a>
        .
      </p>
      <figure>
        {/* biome-ignore lint/performance/noImgElement: a static screenshot; next/image adds nothing */}
        <img
          src={ALLOW_ACCESS_SHOT.src}
          width={ALLOW_ACCESS_SHOT.width}
          height={ALLOW_ACCESS_SHOT.height}
          alt={ALLOW_ACCESS_SHOT.alt}
          loading="lazy"
        />
        <figcaption>
          {name === 'Codex'
            ? 'What you’ll see.'
            : `What you’ll see, shown for Codex: ${name}’s name appears in its place.`}
        </figcaption>
      </figure>
    </div>
  );
}
