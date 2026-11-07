import { FREE_CREDITS } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import { CLIENTS, MCP_URL } from '../../content/clients.ts';
import { TOOL_COUNT } from '../../content/tools.ts';
import { kaziUrl } from '../kazi.tsx';
import { Items, LegalPage, P, Part } from '../legal.tsx';

// /mcp: what MCP is, for a creator who has never heard the word, and what connecting cuttingfloor
// changes. Short on purpose; the steps per app live on /connect.

export const metadata: Metadata = {
  title: 'What is MCP? How ChatGPT and Claude connect to a video editor | cuttingfloor',
  description: `MCP (Model Context Protocol) is how AI apps like ChatGPT and Claude plug into outside tools. cuttingfloor is a video editing MCP server: paste one address and your AI gets ${TOOL_COUNT} editing tools. Try it live first, free.`,
  alternates: { canonical: '/mcp', types: { 'text/markdown': '/mcp.md' } },
};

const how = (slug: string) => CLIENTS.find((c) => c.slug === slug)?.home?.how ?? '';

export default function Mcp() {
  return (
    <LegalPage
      label="What is MCP"
      href="/mcp"
      title="What is MCP?"
      lede="MCP (Model Context Protocol) is how an AI app like ChatGPT or Claude plugs into outside tools. cuttingfloor is an MCP server for video: plug it in once, and your AI can edit."
      dated={false}
    >
      <Part title="In plain words">
        <P>
          On its own, your AI can talk about a video but can’t touch it. An MCP server gives it
          tools it can use. Your AI app is the brain; cuttingfloor gives it the editing hands.
        </P>
      </Part>
      <Part title="What your AI can do once it’s connected">
        <Items
          items={[
            'Open your footage and read what’s said in it.',
            'Cut out pauses, ums and retakes, add captions, mix the sound.',
            'Add titles, graphics and a voiceover, or reframe for vertical Shorts.',
            'Look at previews of its own work and fix what’s off.',
            'Hand back a real MP4, or a timeline for Premiere, Final Cut or Resolve.',
          ]}
        />
        <P>
          That’s {TOOL_COUNT} tools, all on every plan. <a href="/features">See them all</a>.
        </P>
      </Part>
      <Part title="How to connect">
        <P>
          Every MCP app asks for the same thing: the server’s address. Ours is{' '}
          <code>{MCP_URL}</code>
        </P>
        <Items
          items={[
            <>
              <strong>ChatGPT</strong>: {how('chatgpt')}
            </>,
            <>
              <strong>Claude</strong>: {how('claude')}
            </>,
            <>
              <strong>Codex, Cursor, VS Code and others</strong>: the steps for each are on{' '}
              <a href="/connect">Connect</a>.
            </>,
          ]}
        />
        <P>Sign in when it asks. You start with {FREE_CREDITS} free credits, no card.</P>
      </Part>
      <Part title="Try it before you connect">
        <P>
          The <a href={kaziUrl('demos')}>live demo</a> runs in Kazi, our own AI app, which is
          already connected to cuttingfloor over MCP. Kazi is just one way in: ChatGPT, Claude or
          any MCP app connects to the same server, with the same tools.
        </P>
      </Part>
    </LegalPage>
  );
}
