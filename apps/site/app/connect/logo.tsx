import type { Client } from '../../content/clients.ts';

/**
 * One app's mark, in a slot of fixed height. Until an owner approves its logo the slot holds the
 * name as a wordmark; an approved SVG is one `logo` line in content/clients.ts.
 */
export function LogoSlot({ client }: { client: Pick<Client, 'slug' | 'name' | 'logo' | 'ours'> }) {
  return (
    <span className={client.ours ? 'logo-slot ours' : 'logo-slot'}>
      {client.logo ? (
        // biome-ignore lint/performance/noImgElement: a small static SVG; next/image adds nothing
        <img src={client.logo} alt={client.name} />
      ) : (
        <span className={client.slug === 'kazi' ? 'logo-word kazi-word' : 'logo-word'}>
          {client.name}
        </span>
      )}
    </span>
  );
}
