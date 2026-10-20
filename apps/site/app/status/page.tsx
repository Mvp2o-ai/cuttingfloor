import { SUPPORT_EMAIL } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import { Footer, Nav } from '../shell.tsx';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Status — cuttingfloor',
  description: 'Whether the cuttingfloor server and website are up right now, checked live.',
  alternates: { canonical: '/status' },
};

type Check = { name: string; what: string; up: boolean; ms: number | null; note: string };

/** One live check from this server, with a 5 s limit. */
async function probe(
  name: string,
  what: string,
  url: string,
  ok: (res: Response) => Promise<boolean>,
): Promise<Check> {
  const started = Date.now();
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const up = await ok(res);
    return {
      name,
      what,
      up,
      ms: Date.now() - started,
      note: up ? 'Answering' : `Answered ${res.status}`,
    };
  } catch (error) {
    const timedOut = (error as Error).name === 'TimeoutError';
    return {
      name,
      what,
      up: false,
      ms: null,
      note: timedOut ? 'No answer in 5 seconds' : 'Unreachable',
    };
  }
}

export default async function Status() {
  const checks: Check[] = await Promise.all([
    probe(
      'Editing server',
      'api.cuttingfloor.ai',
      'https://api.cuttingfloor.ai/healthz',
      async (res) => res.status === 200 && (await res.text()).trim() === 'ok',
    ),
    probe(
      'Sign-in for agents',
      'the MCP address your agent connects to',
      'https://api.cuttingfloor.ai/.well-known/oauth-protected-resource/mcp',
      async (res) => res.status === 200 && Boolean(await res.json().catch(() => null)),
    ),
  ]);
  checks.push({
    name: 'Website',
    what: 'cuttingfloor.ai',
    up: true,
    ms: null,
    note: 'You are reading it',
  });
  const allUp = checks.every((c) => c.up);
  const at = new Date().toUTCString();

  return (
    <>
      <Nav />
      <main className="frame">
        <section className="cell marks">
          <span className="mark-b" />
          <span className="label">Status</span>
          <h1 className="display">{allUp ? 'Everything is up.' : 'Something is down.'}</h1>
          <p className="lede">Checked live just now ({at}). Reload to check again.</p>
        </section>
        <section className="cell">
          <div className="wt-prose">
            {checks.map((c) => (
              <section key={c.name}>
                <h2>
                  {c.up ? 'Up' : 'Down'}: {c.name}
                </h2>
                <p>
                  {c.what}. {c.note}
                  {c.ms !== null ? ` in ${c.ms} ms` : ''}.
                </p>
              </section>
            ))}
            <section>
              <p>
                Problems? Write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
              </p>
            </section>
          </div>
        </section>
        <Footer />
      </main>
    </>
  );
}
