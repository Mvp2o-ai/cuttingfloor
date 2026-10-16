import type { ProviderId } from '@cuttingfloor/credentials';

/** What each create.* tool can run on. `local` engines need no key. */
export const CREATE_ENGINES = {
  'create.transcript': {
    local: 'whisper.cpp',
    providers: ['deepgram', 'assemblyai', 'elevenlabs'],
  },
  'create.voiceover': { local: 'kokoro', providers: ['elevenlabs', 'openai', 'cartesia'] },
  'create.music': { local: null, providers: ['elevenlabs', 'stability'] },
  'create.image': { local: null, providers: ['openai', 'google', 'bfl'] },
} as const satisfies Record<string, { local: string | null; providers: readonly ProviderId[] }>;

/** Jev (TypeSafe) backs qa.check. */
export const QA_PROVIDER: ProviderId = 'typesafe';
