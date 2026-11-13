import type { Metadata } from 'next';
import { Items, LegalPage, P, Part } from '../legal.tsx';

// What the sign-in page's warning means when an app on your computer connects (Codex, Claude Code,
// Cursor and the like). Only those apps' setup links here: apps added on the web never see it.

export const metadata: Metadata = {
  title: 'Why sign-in says “This is a security risk” — cuttingfloor',
  description:
    'Connecting cuttingfloor from an app on your computer, like Codex, Claude Code or Cursor? The sign-in page warns before it sends you back to the app. Here’s why, and when to click Allow access.',
  alternates: {
    canonical: '/sign-in-warning',
    types: { 'text/markdown': '/sign-in-warning.md' },
  },
};

export default function SignInWarning() {
  return (
    <LegalPage
      label="Signing in"
      href="/sign-in-warning"
      title="Why sign-in says “This is a security risk”."
      lede="You see it when you connect cuttingfloor from an app on your computer. If you just started the sign-in from that app, it’s expected: click Allow access."
      dated={false}
    >
      <Part title="Why it shows">
        <P>
          Apps on your computer, like Codex, Claude Code and Cursor, finish signing in by sending
          your browser back to the app itself, at an address on your own machine (often 127.0.0.1
          and a number). The sign-in page can’t see which app is listening there, so it asks you to
          make sure it’s yours. Any service that signs these apps in this way shows a warning like
          it.
        </P>
      </Part>
      <Part title="What to do">
        <Items
          items={[
            'You just started the sign-in from your app: click Allow access, and you’re connected.',
            'You didn’t start a sign-in yourself: click Cancel.',
          ]}
        />
      </Part>
    </LegalPage>
  );
}
