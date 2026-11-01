import { TRIAL_DAYS } from '@cuttingfloor/plans';
import { IMAGE, LICENCE, LOCAL_ADDRESS, REPO_URL } from '../../content/facts.ts';

// The words on /self-host, shared by the page and its Markdown twin. Checked against README.md and
// compose.yaml: what compose starts, where files go, what needs memory.

export const SELF_HOST_TITLE = 'Run cuttingfloor yourself: free and open source';
export const SELF_HOST_DESCRIPTION = `cuttingfloor is open source (${LICENCE}). Run the same Docker image that powers cuttingfloor.ai on your own computer for free, change it to fit how you work, or let us run it for you.`;
export const SELF_HOST_LEAD = `cuttingfloor is free and open source. One Docker image holds the whole editor: the editing engines, the models and the server your agent connects to. It’s the same image that runs cuttingfloor.ai.`;

export const CONTRIBUTING_URL = `${REPO_URL}/blob/HEAD/CONTRIBUTING.md`;
export const LICENCE_URL = `${REPO_URL}/blob/HEAD/LICENSE`;
export const COMPOSE_NAME = 'cuttingfloor';

/** How an agent on the same computer connects, once compose is up. */
export const LOCAL_CONNECT = [
  {
    label: 'Cursor and other apps that use mcpServers',
    code: JSON.stringify({ mcpServers: { cuttingfloor: { url: LOCAL_ADDRESS } } }, null, 2),
  },
  {
    label: 'Claude Code, in a terminal',
    code: `claude mcp add --transport http cuttingfloor ${LOCAL_ADDRESS}`,
  },
  {
    label: 'Apps that only start a command (for example claude_desktop_config.json)',
    code: JSON.stringify(
      {
        mcpServers: {
          cuttingfloor: {
            command: 'docker',
            args: ['exec', '-i', COMPOSE_NAME, 'cuttingfloor', 'mcp'],
          },
        },
      },
      null,
      2,
    ),
  },
] as const;

export const LOCAL_NOTES = [
  `Apps on your computer connect the same way as to hosted: follow your app’s steps on the Connect page, with ${LOCAL_ADDRESS} in place of the hosted address.`,
  `There is no sign-in: the server only answers on your own computer, at ${LOCAL_ADDRESS}.`,
  'Apps that run in the cloud, like claude.ai, ChatGPT and Kazi, can’t reach a server on your computer. Use them with the hosted address instead.',
  'Your agent reads footage from your Movies folder (~/Movies, read-only) and writes finished videos to ~/cuttingfloor/exports. Change either in a .env file next to compose.yaml (see .env.example).',
  'The command-only setup forwards to the running container, so a long export keeps going after your app closes.',
  'To try it with nothing of your own, the image includes a 10-second test clip and a picture: /samples/sample.mp4 and /samples/card.png.',
] as const;

export const UPDATE_STEPS = ['git pull', 'docker compose pull', 'docker compose up -d'] as const;

/** Hosted vs self-hosted, by who does the work. */
export const COMPARE: { row: string; hosted: string; self: string }[] = [
  {
    row: 'The software',
    hosted: 'The same Docker image, run by us.',
    self: `The same Docker image (${IMAGE}), run by you.`,
  },
  {
    row: 'Updates',
    hosted: 'We do them. You always have the newest tools.',
    self: `You do, when you want: ${UPDATE_STEPS.join(', then ')}.`,
  },
  {
    row: 'Machines',
    hosted: 'Ours. Nothing to install; rendering, transcripts and cutouts run on our servers.',
    self: 'Yours: your computer or a server you run, with Docker.',
  },
  {
    row: 'Render limits',
    hosted:
      'Your plan’s render minutes each month, plus its jobs at once, video size and storage. When minutes run out, new jobs wait; you’re never charged more than the plan.',
    self: 'None but your machine. How many jobs run at once follows your computer’s cores, and you can change it.',
  },
  {
    row: 'Keys',
    hosted: 'None, except your own sync. labs key for lip-sync.',
    self: 'Your own sync. labs key for lip-sync, and a TypeSafe key for visual judgment. Everything else needs none.',
  },
  {
    row: 'Storage and time limits',
    hosted:
      'On our servers, for a while: timelines for a day after you last use them, media and renders for 7 days, download links for 24 hours. Download what you want to keep.',
    self: 'On your machine, with the same time limits inside Docker. Finished exports also land in a folder on your computer, and stay there.',
  },
  {
    row: 'Sign-in',
    hosted:
      'Your agent opens the cuttingfloor sign-in. Scripts use a key from your account page (cf_…).',
    self: 'None. It only answers on your own computer.',
  },
  {
    row: 'Cost',
    hosted: `A monthly plan, after ${TRIAL_DAYS} days free. Editing is free; you pay for render minutes.`,
    self: 'Free. You pay for your own computer, and for any key you choose to add.',
  },
];

/** What AGPL-3.0 means, in plain words. No promise of other licences, nothing about outputs. */
export const AGPL = [
  {
    q: 'Use it',
    a: 'Free, for anyone. Run it on your own computer for your own videos, or for your company. No fee and no seat count.',
  },
  {
    q: 'Change it',
    a: 'Fork it, change anything, and run your changed version yourself.',
  },
  {
    q: 'Share your changes if you offer it to others',
    a: `If you let other people use a changed version over a network (for example, you host it for customers), you have to offer them your changed source code, under the same licence (${LICENCE}).`,
  },
  {
    q: 'The fine print',
    a: 'This is a plain-words summary, not legal advice. The licence text in the repository is what counts.',
  },
] as const;

export const REQUIREMENTS = [
  'Docker (Docker Desktop, or Docker Engine on Linux). It’s the only thing you install: the editing engines and models are inside the image.',
  'A copy of the repository, from git clone. Compose needs the sandbox’s security profile that comes with it (tools/motion/seccomp.json).',
  'Memory: background removal for any subject (BiRefNet) needs about 3 GB free for Docker. The motion graphics sandbox can use up to 4 GB and 4 CPU cores.',
  'On Docker Desktop for Mac, raise the memory limit for long 4K timelines.',
  'The first transcript and the first voiceover download their models once (the voice model is about 350 MB).',
  'On Linux, create the exports folder before the first start, so it belongs to you.',
] as const;
