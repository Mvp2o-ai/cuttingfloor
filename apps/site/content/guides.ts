import { FREE_CREDITS } from '@cuttingfloor/plans';

// One page per job, in the words people search it with: /guides/<slug> in English, /es/<slug> in
// Spanish. Each says what to do from your own agent (Kazi, Claude or ChatGPT side by side), shows
// real demos of the job, and answers what people ask. Every claim here holds for the server as it
// is: transcripts with word times in any language whisper knows, captions that highlight words,
// SRT and VTT out.

export type Lang = 'en' | 'es';

export type Guide = {
  slug: string;
  lang: Lang;
  /** The H1: the question or the job, as searched. */
  title: string;
  metaTitle: string;
  metaDescription: string;
  /** The answer under the H1, 40 to 60 words. */
  answer: string;
  updated: string;
  /** The same page in the other language, as its path. */
  alternate?: string;
  /** What to do, in order. */
  steps: { title: string; body: string }[];
  /** A prompt to copy, word for word. */
  prompt: string;
  /** Demos that show the job, by slug. */
  demos: string[];
  faqs: { q: string; a: string }[];
  /**
   * A feature page rather than a how-to: it opens on a demo's before and after, says what the
   * feature does and why an agent can't do it alone, and gives a prompt per job.
   */
  feature?: {
    /** The feature's one name, shown above the H1. */
    name: string;
    /** The demo whose before and after is the proof, by id. */
    proof: string;
    does: { title: string; body: string }[];
    whyHead: string;
    why: { title: string; body: string }[];
    /** Said after the reasons. */
    whyNote: string;
    /** One prompt per job; the first is also `prompt`. */
    prompts: { label: string; text: string }[];
  };
};

const MUSIC_PROMPTS = [
  {
    label: 'All it takes',
    text: 'Sync this video to this song.',
  },
  {
    label: 'Or say more: cut to the music',
    text: 'Cut these clips into a vertical Short synced to this song: change shots on the beat and end on the last hit.',
  },
  {
    label: 'Or say more: fit the music to your video',
    text: 'Fit this song to my video: trim it to the video’s length, end on a beat, and fade it out.',
  },
  {
    label: 'Or say more: music under your voice',
    text: 'Put this music under my talking video and turn it down while I speak.',
  },
];

export const GUIDES: Guide[] = [
  {
    // The lead feature: both outside users so far synced video and music. Every claim holds for
    // the server as it is: media.analyze beats gives the tempo, every beat, likely bar starts and
    // each beat's strength; cuts are frames; audio.set_gain keyframes duck under speech spans;
    // export.video audio_wav_48k gives the song alone. Nothing here clears music rights.
    slug: 'sync-video-to-music',
    lang: 'en',
    title: 'Sync your video to music with AI',
    metaTitle: 'Sync video to music with AI: cut to the beat, fit the song | cuttingfloor',
    metaDescription:
      'Ask ChatGPT, Claude or Kazi to cut your clips on the beat, fit a song to your video’s length, or turn the music down while you talk. cuttingfloor finds the beats and makes the real cut.',
    answer:
      'Connect cuttingfloor to Kazi, Claude or ChatGPT and ask for an edit to music. It finds every beat in your song, then your AI cuts your clips so the shots change on the beat and the video ends on the last hit, or trims the song to fit your video and ends it on a beat. You get a real MP4.',
    updated: '2026-11-08',
    feature: {
      name: 'Sync video to music',
      proof: 'dance',
      does: [
        {
          title: 'Cut your video to the music',
          body: 'Shots change on the beat or the bar, the big move lands on the drop, and the video ends on the last hit. Every cut is placed to the exact frame.',
        },
        {
          title: 'Fit the music to your video',
          body: 'Already have a finished video? The song is trimmed to its length between beats, so it never jumps, then ends on a hit and fades out. Get the video, or just the song as a WAV.',
        },
        {
          title: 'Keep the music under your voice',
          body: 'When someone talks, the music goes down, and it comes back up when they stop. The words stay clear and the song still carries the video.',
        },
      ],
      whyHead: 'Why your AI can’t do it alone.',
      why: [
        {
          title: 'It can’t hear the beat',
          body: 'ChatGPT and Claude can’t hear where the beats in a song fall. cuttingfloor measures them: the tempo, every beat and how hard each one hits.',
        },
        {
          title: 'It can’t cut your real footage',
          body: 'On its own, your AI can’t cut full-quality video to the exact frame. We gave ChatGPT four dance takes and a song by itself, and it couldn’t make the video. cuttingfloor makes the cuts and renders the MP4.',
        },
        {
          title: 'It can’t keep the edit',
          body: 'With cuttingfloor every change is a new version, so “change shots every two bars” or “go back to the last one” is one sentence, not starting over.',
        },
      ],
      whyNote:
        'Your AI still makes the choices: which shot goes where and how it should feel. cuttingfloor gives it the beats and the tools.',
      prompts: MUSIC_PROMPTS,
    },
    steps: [
      {
        title: 'Connect your AI once',
        body: 'Add cuttingfloor to Kazi, Claude or ChatGPT (below). Kazi works on your phone; ChatGPT and Claude add it on a computer.',
      },
      {
        title: 'Give it your video and your song',
        body: 'In ChatGPT, attach them in the chat. In Claude or Kazi, your AI gives you a link to send them from your phone or computer.',
      },
      {
        title: 'Ask it to sync them',
        body: '“Sync this video to this song.” That’s it. Add details only if you want them: how fast the shots change, how long it runs.',
      },
      {
        title: 'Watch it, then ask for another',
        body: 'Ask for changes in your own words (“change shots every two bars”, “start at the chorus”) and get the MP4.',
      },
    ],
    prompt: MUSIC_PROMPTS[0]?.text ?? '',
    demos: ['edit-a-dance-short-to-the-beat', 'edit-a-product-review-short'],
    faqs: [
      {
        q: 'Can I use any song?',
        a: 'Use music you own or have a licence for. cuttingfloor edits the song you give it; it doesn’t clear the rights, and TikTok, Instagram or YouTube can mute or claim a song you don’t have the rights to. Want something of your own? In the dance video above, Kazi made an original beat first, so there was nothing to claim.',
      },
      {
        q: 'Does it find the beats by itself?',
        a: 'Yes. cuttingfloor measures the song’s tempo, every beat and where each bar likely starts, and your AI puts the cuts on those exact frames. It works best on music with a steady beat; with free-flowing music, the cuts follow the strongest hits instead.',
      },
      {
        q: 'Can I get just the song, fitted to my video?',
        a: 'Yes. Ask for the music on its own and you get a WAV file the length of your video, ending on a beat, ready to drop into CapCut or any editor.',
      },
      {
        q: 'What files work?',
        a: 'The ones you already have: MP4 or MOV video from your phone or camera, and MP3, WAV or M4A music, or a song inside a video. Vertical or wide.',
      },
      {
        q: 'Does it work on a phone?',
        a: 'Yes, in Kazi: connect cuttingfloor there and send your clips from your phone. ChatGPT and Claude add cuttingfloor on a computer.',
      },
      {
        q: 'What does it cost?',
        a: `Start free with ${FREE_CREDITS} credits, no card and no time limit. After that, pay as you go: credit packs that never expire, on the pricing page.`,
      },
    ],
  },
  {
    slug: 'add-captions-to-a-video',
    lang: 'en',
    title: 'How to add captions to a video with AI',
    metaTitle: 'How to add captions to a video with AI, word by word | cuttingfloor',
    metaDescription:
      'Ask your agent for captions and get them burned into the video, highlighting each word as it’s said, or as an SRT or VTT file. Works from Kazi, Claude and ChatGPT.',
    answer:
      'Connect cuttingfloor to the agent you use (Kazi, Claude or ChatGPT) and ask for captions. It transcribes your video with the time of every word, places the captions where each line is said, can highlight each word as you say it, and exports the video with captions burned in, or the captions alone as SRT or VTT.',
    updated: '2026-11-04',
    alternate: '/es/poner-subtitulos-a-un-video',
    steps: [
      {
        title: 'Connect your agent once',
        body: 'Add cuttingfloor to Kazi, Claude or ChatGPT (below). It takes a minute, and you sign in the first time.',
      },
      {
        title: 'Give it the video',
        body: 'Attach it in the chat, send a link, or drop it on your account page.',
      },
      {
        title: 'Say how the captions should look',
        body: 'Big or small, where on screen, one line or two, whether each word lights up as it’s said. Say it the way you would to an editor.',
      },
      {
        title: 'Check it, then get the file',
        body: 'Your agent looks at a preview before it hands it over. Ask for changes in words (“bigger”, “higher up”, “fix the spelling of my name”), then get the MP4, or an SRT or VTT file for YouTube.',
      },
    ],
    prompt:
      'Add big captions to my video, two lines at most, near the bottom, and highlight each word as I say it. Export it vertical for Reels and give me an SRT file too.',
    demos: [
      'remove-pauses-and-restarts-from-a-talking-video',
      'edit-a-product-review-short',
      'edit-a-dance-short-to-the-beat',
    ],
    faqs: [
      {
        q: 'Can AI add captions to a video automatically?',
        a: 'Yes. Your agent transcribes the video with the time of every word, then places each caption where it’s said. You don’t type or time anything.',
      },
      {
        q: 'Can each word light up as it’s said?',
        a: 'Yes. The transcript has a time for every word, so captions can highlight the word being said, the way Shorts and Reels captions do.',
      },
      {
        q: 'Can I get an SRT or VTT file instead?',
        a: 'Yes. Ask for the captions as SRT or VTT, for YouTube or any player that takes a caption file, with or without burning them into the video.',
      },
      {
        q: 'Does it work in other languages?',
        a: 'Yes. Transcription recognizes the language spoken, Spanish included, and captions come out in it.',
      },
      {
        q: 'Can I fix a word it got wrong?',
        a: 'Yes. Tell your agent the right word or spelling (a name, a brand) and it changes the caption.',
      },
      {
        q: 'What does it cost?',
        a: `Start free with ${FREE_CREDITS} credits, no card and no time limit. After that, pay as you go: credit packs that never expire, on the pricing page.`,
      },
    ],
  },
  {
    slug: 'poner-subtitulos-a-un-video',
    lang: 'es',
    title: 'Cómo poner subtítulos a un video con IA',
    metaTitle: 'Cómo poner subtítulos a un video con IA, palabra por palabra | cuttingfloor',
    metaDescription:
      'Pídele subtítulos a tu agente y recíbelos dentro del video, resaltando cada palabra al decirla, o como archivo SRT o VTT. Funciona desde Kazi, Claude y ChatGPT.',
    answer:
      'Conecta cuttingfloor al agente que ya usas (Kazi, Claude o ChatGPT) y pídele subtítulos. Transcribe tu video con el momento exacto de cada palabra, coloca cada línea donde se dice, puede resaltar cada palabra al pronunciarla y exporta el video con los subtítulos incluidos, o solo los subtítulos en SRT o VTT.',
    updated: '2026-11-04',
    alternate: '/guides/add-captions-to-a-video',
    steps: [
      {
        title: 'Conecta tu agente una vez',
        body: 'Agrega cuttingfloor a Kazi, Claude o ChatGPT (abajo). Toma un minuto y solo inicias sesión la primera vez.',
      },
      {
        title: 'Dale el video',
        body: 'Adjúntalo en el chat, envía un enlace o súbelo a la página de tu cuenta.',
      },
      {
        title: 'Di cómo quieres los subtítulos',
        body: 'Grandes o pequeños, en qué parte de la pantalla, una línea o dos, si cada palabra se ilumina al decirla. Dilo como se lo dirías a un editor.',
      },
      {
        title: 'Revísalo y descarga el archivo',
        body: 'Tu agente revisa una vista previa antes de entregártelo. Pide cambios con palabras (“más grandes”, “más arriba”, “corrige mi nombre”) y descarga el MP4, o un archivo SRT o VTT para YouTube.',
      },
    ],
    prompt:
      'Ponle subtítulos grandes a mi video, máximo dos líneas, cerca de la parte de abajo, y resalta cada palabra cuando la digo. Exporta en vertical para Reels y dame también un archivo SRT.',
    demos: [
      'remove-pauses-and-restarts-from-a-talking-video',
      'edit-a-product-review-short',
      'edit-a-dance-short-to-the-beat',
    ],
    faqs: [
      {
        q: '¿La IA puede poner subtítulos automáticamente?',
        a: 'Sí. Tu agente transcribe el video con el momento de cada palabra y coloca cada subtítulo donde se dice. No tienes que escribir ni sincronizar nada.',
      },
      {
        q: '¿Funciona con videos en español?',
        a: 'Sí. La transcripción reconoce el idioma que se habla, español incluido, y los subtítulos salen en ese idioma.',
      },
      {
        q: '¿Se puede resaltar cada palabra al decirla?',
        a: 'Sí. Como la transcripción tiene el momento de cada palabra, los subtítulos pueden resaltar la palabra que se está diciendo, como en los Shorts y Reels.',
      },
      {
        q: '¿Puedo recibir un archivo SRT o VTT?',
        a: 'Sí. Pide los subtítulos en SRT o VTT para YouTube o cualquier reproductor, con o sin incluirlos dentro del video.',
      },
      {
        q: '¿Puedo corregir una palabra mal escrita?',
        a: 'Sí. Dile a tu agente la palabra correcta (un nombre, una marca) y cambia el subtítulo.',
      },
      {
        q: '¿Cuánto cuesta?',
        a: `Empieza gratis con ${FREE_CREDITS} créditos, sin tarjeta y sin límite de tiempo. Después, pagas solo lo que usas: paquetes de créditos que no caducan, en la página de precios (en inglés).`,
      },
    ],
  },
  {
    slug: 'editar-videos-con-ia',
    lang: 'es',
    title: 'Cómo editar videos con IA, desde ChatGPT, Claude o Kazi',
    metaTitle: 'Editar videos con IA: tu agente corta, subtitula y exporta | cuttingfloor',
    metaDescription:
      'Conecta cuttingfloor a ChatGPT, Claude o Kazi y pide la edición con tus palabras: cortar pausas, subtítulos, música, formato vertical para Reels y TikTok. Recibes el video terminado.',
    answer:
      'Conecta cuttingfloor al agente que ya usas (Kazi, Claude o ChatGPT) y pídele la edición con tus palabras. Corta las pausas y los errores, pone subtítulos, música y títulos, adapta el formato para Reels, TikTok o Shorts, revisa una vista previa y te entrega el video terminado en MP4.',
    updated: '2026-11-04',
    steps: [
      {
        title: 'Conecta tu agente una vez',
        body: 'Agrega cuttingfloor a Kazi, Claude o ChatGPT (abajo). Toma un minuto y solo inicias sesión la primera vez.',
      },
      {
        title: 'Dale tus videos',
        body: 'Adjúntalos en el chat, envía un enlace o súbelos a la página de tu cuenta. También tu música o tu logo.',
      },
      {
        title: 'Pide la edición como a un editor',
        body: 'Para quién es, cuánto debe durar, cómo se debe sentir. “Un video de 30 segundos para TikTok, con ritmo, subtítulos grandes y que termine con el producto.”',
      },
      {
        title: 'Revisa y pide cambios',
        body: 'Tu agente revisa su propio trabajo con una vista previa. Pide cambios con palabras (“más corto en el medio”, “colores más cálidos”); las versiones anteriores se guardan, así que volver atrás también es una frase.',
      },
    ],
    prompt:
      'Edita este video para Reels: quita las pausas y los errores, ponle subtítulos grandes que resalten cada palabra, música suave debajo de mi voz y un título al inicio. Que dure menos de 30 segundos.',
    demos: [
      'edit-a-product-review-short',
      'edit-a-dance-short-to-the-beat',
      'edit-a-two-person-interview',
    ],
    faqs: [
      {
        q: '¿Qué IA edita videos por ti?',
        a: 'Tu propio agente, con cuttingfloor conectado. ChatGPT, Claude y Kazi pueden planear una edición, pero solos no cortan video; cuttingfloor les da las herramientas para hacerlo.',
      },
      {
        q: '¿Necesito saber editar?',
        a: 'No. Tú sabes cómo quieres que se vea y para quién es. Tu agente se encarga de dónde cortar, cuánto dura cada toma y a qué volumen va la música bajo tu voz.',
      },
      {
        q: '¿Funciona con videos en español?',
        a: 'Sí. La transcripción reconoce el español, así que tu agente puede cortar por lo que dices y poner subtítulos en español.',
      },
      {
        q: '¿Qué puede hacer con mi video?',
        a: 'Cortar pausas y repeticiones, elegir la mejor toma, cortar al ritmo de la música, subtítulos y títulos, voz en off, quitar el fondo, estabilizar tomas movidas y exportar para Reels, TikTok, Shorts o YouTube.',
      },
      {
        q: '¿Cuánto cuesta?',
        a: `Empieza gratis con ${FREE_CREDITS} créditos, sin tarjeta y sin límite de tiempo. Después, pagas solo lo que usas: paquetes de créditos que no caducan, en la página de precios (en inglés).`,
      },
    ],
  },
];

/** A guide's address: /guides/<slug> in English, /es/<slug> in Spanish. */
export const guidePath = (g: Pick<Guide, 'slug' | 'lang'>) =>
  g.lang === 'es' ? `/es/${g.slug}` : `/guides/${g.slug}`;

export function guide(lang: Lang, slug: string): Guide | undefined {
  return GUIDES.find((g) => g.lang === lang && g.slug === slug);
}
