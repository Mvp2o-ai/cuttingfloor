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
};

export const GUIDES: Guide[] = [
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
  {
    slug: 'turn-a-long-video-into-shorts',
    lang: 'en',
    title: 'How to turn a long video into Shorts with AI',
    metaTitle: 'Turn a long video into Shorts, Reels and TikToks with AI | cuttingfloor',
    metaDescription:
      'Turn a stream, podcast, film or lecture into vertical Shorts from ChatGPT, Claude or Kazi: you pick the moments, it cuts them, keeps every face in frame shot by shot, captions each word and exports MP4s.',
    answer:
      'Connect cuttingfloor to the AI you already use (ChatGPT, Claude or Kazi), send the long video, and say which moments you want. It transcribes every word with its time, finds moments you describe in plain words, cuts each Short, keeps the speaker in frame shot by shot in full-screen 9:16, adds word-by-word captions, and exports each as an MP4.',
    updated: '2026-11-18',
    steps: [
      {
        title: 'Connect your agent once',
        body: 'Add cuttingfloor to ChatGPT, Claude or Kazi (below). It takes a minute, and you sign in the first time.',
      },
      {
        title: 'Send the long video',
        body: 'Attach it in the chat, send a direct link to the file (public Dropbox and Google Drive links work), or drop it on your upload page. A YouTube or Twitch page is not the file itself: download your video first, then send it.',
      },
      {
        title: 'Say which moments, how long and how they look',
        body: 'Name the moments (“the clutch at the end”, “when she explains pricing”) or describe what to look for, how many Shorts, how long each is, and the caption style. Your agent reads the whole transcript and searches the picture for what you described, then shows you what it found.',
      },
      {
        title: 'Check them, then get the files',
        body: 'It looks at frames from every shot before it hands anything over. Ask for changes in words (“start on the joke”, “shorter”, “captions higher”), then get each Short as an MP4 with a link that plays in any browser.',
      },
    ],
    prompt:
      'Here’s my 40-minute stream. Make three vertical Shorts for TikTok, 30 to 60 seconds each: the clutch round, the funniest fail, and the moment chat went wild. Start each on the hook, keep my face in frame, and add big captions that highlight each word. Give me the download links.',
    demos: ['edit-a-two-person-interview', 'edit-a-product-review-short'],
    faqs: [
      {
        q: 'Can AI turn one long video into several Shorts?',
        a: 'Yes. The video is imported once and analysed once; every Short is cut from that same copy, so ten Shorts don’t cost ten imports. Each Short gets its own edit and its own export.',
      },
      {
        q: 'How does it make a wide video vertical without black bars?',
        a: 'By pan and scan: the picture fills the 9:16 frame and the crop moves to keep the subject in view. cuttingfloor finds every shot change and every face (five times a second), then sets the crop once per shot, so it jumps on cuts and never drifts. On a 12-minute film, finding the shot changes took 12 seconds and the faces 41 seconds.',
      },
      {
        q: 'What if there are two people, a facecam, or no face at all?',
        a: 'Two people far apart can be stacked, one above the other, each kept in frame. A gaming stream’s facecam can sit across the top with the gameplay below. With no face, it follows any subject you point at (a car, a player, a product), or puts the whole wide picture in the middle over a blurred copy of itself.',
      },
      {
        q: 'Does the AI pick the best moments for me?',
        a: 'It finds what you describe, and you decide. It reads the full transcript with the time of every word and searches the picture for moments you name in plain words (“a big win”, “when she laughs”), then shows you frames from each before cutting. Taste stays yours; it doesn’t score clips for you.',
      },
      {
        q: 'Can it add TikTok-style captions?',
        a: 'Yes. Captions are placed from the transcript’s word times and can light up each word as it’s said. Style is yours: font, size, colour, position, outline, shadow, and a gradient or rounded band behind the words. You can also get them as an SRT or VTT file.',
      },
      {
        q: 'Can I paste a YouTube or Twitch link?',
        a: 'Not a video page: the server needs the file itself. Download your stream or video (from YouTube Studio, your Twitch VODs or your camera), then attach it, send a direct file link, or drop it on your upload page.',
      },
      {
        q: 'How long can the video be, and how long should each Short be?',
        a: 'Long videos are fine: streams, films, full podcast episodes. Most Shorts that hold attention run 15 to 60 seconds and open on their hook in the first two seconds; YouTube allows Shorts up to three minutes. Tell your agent the length you want.',
      },
      {
        q: 'Is this a separate app like OpusClip?',
        a: 'No. cuttingfloor works inside the AI you already use (ChatGPT, Claude, Kazi, or any app that speaks MCP), so you ask for edits in your own words and can change anything after. It’s open source and can run on your own machine too.',
      },
      {
        q: 'How does my agent know how to do this well?',
        a: 'cuttingfloor ships skills, short methods your agent finds when it needs them: one for turning a long video into Shorts, built on pan and scan, subject tracking and Shorts-style captions. Your agent reads them on its own; you don’t need to mention them.',
      },
      {
        q: 'What does it cost?',
        a: `Start free with ${FREE_CREDITS} credits, no card and no time limit. A credit is a minute of the server working (importing, analysing, exporting); editing and previews are free, so one import feeds every Short. After that, credit packs that never expire, on the pricing page.`,
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
