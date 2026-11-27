import { FREE_CREDITS } from '@cuttingfloor/plans';
import { GENERATORS_LINE, type ToolCall } from './tool-calls.ts';

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
  /** The MCP tool calls the job uses, in order. */
  tools?: ToolCall[];
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
      'make-a-before-and-after-client-testimonial-reel',
      'remove-pauses-and-restarts-from-a-talking-video',
      'edit-a-product-review-short',
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
        a: `Making is free, no card: every edit and export, as many times as you like. Exports download free with a cuttingfloor watermark; removing the watermark costs credits, priced by the video's length, and a new account gets ${FREE_CREDITS} credits when you activate it. After that, credit packs that never expire, on the pricing page.`,
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
        a: `Crear es gratis, sin tarjeta: cada edición y cada exportación, las veces que quieras. Las exportaciones se descargan gratis con la marca de cuttingfloor; una copia limpia cuesta 1 crédito por minuto terminado, y una cuenta nueva recibe ${FREE_CREDITS} créditos al activarla. Después, paquetes de créditos que no caducan, en la página de precios (en inglés).`,
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
      'make-a-before-and-after-client-testimonial-reel',
      'edit-a-product-review-short',
      'edit-a-dance-short-to-the-beat',
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
        a: `Crear es gratis, sin tarjeta: cada edición y cada exportación, las veces que quieras. Las exportaciones se descargan gratis con la marca de cuttingfloor; una copia limpia cuesta 1 crédito por minuto terminado, y una cuenta nueva recibe ${FREE_CREDITS} créditos al activarla. Después, paquetes de créditos que no caducan, en la página de precios (en inglés).`,
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
    demos: [
      'turn-a-gaming-stream-into-shorts',
      'edit-a-two-person-interview',
      'edit-a-product-review-short',
    ],
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
        a: `Making is free, no card: importing, analysing, editing and exporting every Short cost nothing, retries included. Exports download free with a cuttingfloor watermark; removing the watermark costs credits, priced by length: a 40-second Short is 0.75 credit. A new account gets ${FREE_CREDITS} credits when you activate it; after that, credit packs that never expire, on the pricing page.`,
      },
    ],
  },
  {
    slug: 'add-sound-effects-to-shorts',
    lang: 'en',
    title: 'How to add sound effects to your Shorts with AI',
    metaTitle: 'Add sound effects to your Shorts, Reels and TikToks with AI | cuttingfloor',
    metaDescription:
      'Describe a sound in plain words and your agent finds it in a free library of about 20,000 sound effects, lets you hear it in the chat and puts it on the moment. From ChatGPT, Claude or Kazi.',
    answer:
      'Connect cuttingfloor to the AI you already use (ChatGPT, Claude or Kazi), send your Short and describe the sounds you want: “a whoosh on every cut”, “footsteps on gravel while I walk”. Your agent finds the closest sounds in a free library of about 20,000, lets you hear them in the chat, puts each on its moment and sets its level.',
    updated: '2026-11-23',
    steps: [
      {
        title: 'Connect your agent once',
        body: 'Add cuttingfloor to ChatGPT, Claude or Kazi (below). It takes a minute, and you sign in the first time.',
      },
      {
        title: 'Send your Short',
        body: 'Attach it in the chat, send a link, or drop it on your upload page. Silent AI clips, a talking video or gameplay all work.',
      },
      {
        title: 'Describe the sounds and where they go',
        body: 'Say it the way you’d say it to an editor: “a whoosh on every cut”, “a punch sound when he hits the bag”, “rain on a window under the whole scene”, “an airhorn on the win”. You don’t need a sound’s name; describe how it sounds.',
      },
      {
        title: 'Listen, pick, then get the file',
        body: 'Your agent can show the sounds it found in a player in the chat: press play on each, search for another, and pick one. It places your picks on their moments, keeps them under your voice, and exports the Short. Ask for changes in words (“louder boom”, “a different whoosh”).',
      },
    ],
    prompt:
      'Add sound effects to my Short: a whoosh on every cut, footsteps on gravel while I walk, a big boom when the title comes up and a crowd cheering at the end. Let me hear the boom options first, and keep everything under my voice.',
    demos: ['turn-a-gaming-stream-into-shorts'],
    faqs: [
      {
        q: 'Where do the sounds come from?',
        a: 'A sound effects library of about 20,000 sounds that comes with cuttingfloor: real recordings, all CC0 or public domain. They’re free to use in anything you make, with nothing to credit or license.',
      },
      {
        q: 'What kinds of sounds are there?',
        a: 'Footsteps, punches and impacts, whooshes, rain, wind, thunder and other weather, cars and other vehicles, animals, crowds, applause and laughter, doors, glass, weapons and explosions, tools, bells, interface and game sounds, and meme and hype hits like a boom, an airhorn or a record scratch.',
      },
      {
        q: 'Do I need to know what a sound is called?',
        a: 'No. Describe it in plain words (“a giant stomping”, “a door slamming in a big hall”). Your agent finds the closest sounds by their names and by how they actually sound, so a description works even when no sound has those words in its name.',
      },
      {
        q: 'Can I hear a sound before it goes in?',
        a: 'Yes. Your agent can bring up a player in the chat with a play button and a waveform for each sound, a search box and the categories, so you can listen and pick. On a phone, ask “play me that sound” and it comes up as a big play button.',
      },
      {
        q: 'What can I ask for?',
        a: '“A punch sound on every hit.” “A whoosh when the text flies in.” “A reveal sound when the product shows up.” “Footsteps under the walk.” “City traffic under the whole scene, quiet.” “A record scratch when I stop talking.” “Five options for a boom; let me hear them.”',
      },
      {
        q: 'Will the sounds drown out my voice?',
        a: 'No. Your agent sets each sound’s level and keeps them under your voice or music. If one is too loud or too quiet, say so and it changes just that one.',
      },
      {
        q: 'Is there music in the library?',
        a: 'No, it’s sound effects only. For music, your agent can make some for the video from instruments, fitted to the cuts, or fit your own song under it.',
      },
      {
        q: 'Can I use my own sound files?',
        a: 'Yes. Send them like any other file and your agent places them the same way, next to sounds from the library.',
      },
    ],
  },
  {
    slug: 'turn-ai-video-clips-into-a-film',
    lang: 'en',
    title: 'How to turn Kling, Veo, Sora and Runway clips into a film',
    metaTitle:
      'How to turn AI video clips into a film: Kling, Veo, Sora, Runway and more | cuttingfloor',
    metaDescription:
      'AI video generators make short clips; your agent edits them into one film. Story order, clean trims, transitions that fit, matched colour, sound effects, music and voiceover, from ChatGPT, Claude or Kazi.',
    answer: `AI video generators make short clips; editing them into a film is a separate job. Connect cuttingfloor to Kazi, Claude or ChatGPT, give it your clips from ${GENERATORS_LINE}, and say the story. It cuts, blends, matches colour, adds sound and music, and exports one film. Your shots are never regenerated.`,
    updated: '2026-11-23',
    steps: [
      {
        title: 'Bring the clips',
        body: 'Attach them in the chat, send links, or drop them on your upload page. Clips from different generators, sizes and frame rates go together; pick the finished size (16:9 for YouTube, 9:16 for Shorts).',
      },
      {
        title: 'Say the story',
        body: 'The order of the shots, a line on what happens, and how long it should be. Your agent looks at each clip, puts them in order and cuts each to its best part, trimming the warped frames AI clips often have at the start or end.',
      },
      {
        title: 'Ask for the finish',
        body: 'Transitions, matching colour, sound effects, music made for it or your own, a voiceover, titles and credits. Short clips leave little footage for a blend, so when a transition is too long the server says the longest that fits and your agent uses it.',
      },
      {
        title: 'Check it, then take the film',
        body: 'Your agent looks at frames and a quick render before it hands the film over. Ask for changes in words; every version stays, so you can go back. Export an MP4, or the edit as FCPXML, OTIO or EDL to finish in Resolve, Premiere or Final Cut.',
      },
    ],
    prompt:
      'Make a short film from my AI clips. The story: a lost robot finds its way home. Put the shots in story order, cut the weird frames at the ends, blend the joins, make the colour match, add sound effects and my music, a title and credits, and export it in 16:9 at 1080p.',
    demos: [],
    tools: [
      {
        tool: 'media.upload',
        does: 'brings in clips from your device (media.import takes a link)',
      },
      { tool: 'media.get', does: 'reads each clip’s size, frame rate, length and sound' },
      { tool: 'media.analyze (look)', does: 'answers questions about sampled frames of each clip' },
      { tool: 'timeline.create', does: 'sets the finished size and frame rate' },
      { tool: 'edit.batch', does: 'many edits in one call: clip.add, clip.trim and the rest' },
      { tool: 'transition.add', does: 'blends a cut; a refusal gives the longest that fits' },
      { tool: 'filter.add', does: 'colour corrections on a clip, or a LUT on the whole film' },
      {
        tool: 'sounds.list',
        does: 'finds sound effects by description; the user hears them in the chat',
      },
      { tool: 'media.import', does: 'brings in the sound effect picked, or your own file' },
      { tool: 'create.voiceover', does: 'a narrator from your script, with a time for each word' },
      { tool: 'title.add', does: 'the title and the credits' },
      { tool: 'audio.set_master', does: 'the final loudness, with a limiter' },
      { tool: 'render.frames', does: 'frames of the edit to look at before exporting' },
      { tool: 'qa.check', does: 'measures the render: gaps, loudness, black or silent stretches' },
      {
        tool: 'export.video',
        does: 'the finished MP4, with a download link and a page to watch it',
      },
      { tool: 'export.timeline', does: 'the edit as FCPXML, OTIO or EDL for another editor' },
    ],
    faqs: [
      {
        q: 'Which AI video generators does it work with?',
        a: `Any that gives you a video file: ${GENERATORS_LINE}. They all download as ordinary MP4 or MOV files, and clips from several generators can go in one film.`,
      },
      {
        q: 'My clips are different sizes and frame rates. Is that a problem?',
        a: 'No. You pick the finished size and frame rate, and every clip is fitted into that frame and played at that rate. Your agent can zoom or crop a clip that doesn’t fill the frame, and smooth one with fewer frames a second.',
      },
      {
        q: 'My clips have no sound. What can I add?',
        a: 'Music made for the film or your own, a voiceover made from your script, and sound effects. Describe a sound (“footsteps on gravel”, “wind through trees”, “a deep boom”) and your agent finds it in a free library of about 20,000 sound effects, which you can hear in the chat before it goes in. Your own sound files work too.',
      },
      {
        q: 'How long can a transition be on a 5-second clip?',
        a: 'Only as long as the footage past the cut on both sides. Trimmed AI clips have little to spare, so blends are short. When one doesn’t fit, the server says how many frames each side has and the longest that fits.',
      },
      {
        q: 'Will it change my shots?',
        a: 'No. Nothing is regenerated: your clips are cut, ordered, graded and mixed, and the same edit renders the same film every time.',
      },
      {
        q: 'Can I undo, or keep two versions?',
        a: 'Yes. Every change makes a new version and the old ones stay, so you can ask for another cut and keep both, or go back to any earlier one.',
      },
      {
        q: 'Can I finish it in Premiere, Resolve or Final Cut?',
        a: 'Yes. Ask for the edit as FCPXML, OTIO or EDL as well as the MP4, and open it in your editor as the exact cut.',
      },
      {
        q: 'What does it cost?',
        a: `Making is free, no card: every edit and export, as many times as you like. Exports download free with a cuttingfloor watermark; removing the watermark costs credits, priced by the video's length, and a new account gets ${FREE_CREDITS} credits when you activate it. After that, credit packs that never expire, on the pricing page.`,
      },
    ],
  },
  // Music made for a video. The music is built from instruments and notes, layer by layer, and
  // fitted to the picture; it is not a song generator (no singer, no lyrics, no artist's style).
  // Recording is on the upload page, which always works; nothing here promises the microphone
  // inside a chat app. No price is stated for made music.
  {
    slug: 'make-background-music-for-a-video',
    lang: 'en',
    title: 'How to make background music for a video with AI',
    metaTitle: 'Make background music for a video with AI, fitted to your cuts | cuttingfloor',
    metaDescription:
      'Ask ChatGPT, Claude or Kazi for music made for your video: built from instruments layer by layer, the beat on your cuts, steady under your voice, and every part changeable in words.',
    answer:
      'Connect cuttingfloor to the AI you already use (ChatGPT, Claude or Kazi), send your video and say the mood. Your agent builds the music from instruments and notes, layer by layer, fitted to the picture: the beat on your cuts, a hit on the big moment, the last note on the last frame. Then change any part in words.',
    updated: '2026-11-27',
    alternate: '/es/musica-de-fondo-para-videos',
    steps: [
      {
        title: 'Connect your agent once',
        body: 'Add cuttingfloor to ChatGPT, Claude or Kazi (below). It takes a minute, and you sign in the first time.',
      },
      {
        title: 'Send your video',
        body: 'Attach it in the chat, send a link, or drop it on your upload page. A talking video, a reel of clips or silent footage all work.',
      },
      {
        title: 'Say the mood and the moments',
        body: 'How it should feel (“calm piano”, “dark and tense”, “upbeat, building to the end”) and anything it should hit (“a big hit when the logo appears”). Your agent picks a speed so the beats fall on your cuts, then builds the music in layers: drums, bass, chords and a tune on top.',
      },
      {
        title: 'Listen, change it, then get the file',
        body: 'Your agent measures the mix before it hands it over; then you listen. Ask for changes in words (“darker”, “less busy”, “more bass”, “swap the piano for strings”) and it changes that part. Get the finished video as an MP4, or the music on its own as a WAV or MP3.',
      },
    ],
    prompt:
      'Make some background music for my video: warm and calm, piano and soft strings, building a little toward the end. Keep it quiet under my voice and end it on the last frame.',
    demos: [],
    faqs: [
      {
        q: 'Is this a song generator?',
        a: 'No. Your agent writes the music note by note on instruments (piano, strings, basses, guitars, brass, drum kits and more) and puts it together in layers. There’s no singer and no lyrics, and it doesn’t copy an artist’s style. Because every note is there to change, asking for “less busy” gets you exactly that.',
      },
      {
        q: 'Can I put music under a talking video?',
        a: 'Yes. The music sits at one steady level under your voice, low enough that every word stays whole. Your agent can read back the words of the finished mix to check none were lost under the music.',
      },
      {
        q: 'Will the music fit my cuts?',
        a: 'Yes. Your agent finds where your cuts and big moments fall, picks a speed so beats land on them, and puts the biggest hit on the moment you name. The last note can end with the last frame.',
      },
      {
        q: 'What can I change afterwards?',
        a: 'Anything, in words: the mood, the speed, one instrument for another, a layer louder, quieter or gone, a busier beat, a different ending. Each change makes a new version and the old ones stay, so you can go back.',
      },
      {
        q: 'Which instruments are there?',
        a: 'Grand and electric piano, organ, upright, electric, synth and sub basses, strings, a warm synth, brass, flute, glockenspiel, music box, marimba, acoustic and electric guitars, a plucked synth and a choir singing “aah”, plus acoustic, 808, 909 and lo-fi drum kits, a synth to shape your own sound, and effects like reverb and delay.',
      },
      {
        q: 'Who listens to it?',
        a: 'You do. Your agent checks the music by measuring it (how loud it is, where the hits land, that your voice comes through) and by looking at a picture of the notes. Then you listen and say what to change.',
      },
      {
        q: 'Can I use my own song instead?',
        a: 'Yes. Send it and your agent fits it: it cuts the video to the song’s beat, lowers it under your voice and fades it out. A song you bring is yours to clear for where you post.',
      },
    ],
  },
  {
    slug: 'can-chatgpt-make-music-for-a-video',
    lang: 'en',
    title: 'Can ChatGPT make music for a video?',
    metaTitle: 'Can ChatGPT make music? Yes, for your video, with cuttingfloor | cuttingfloor',
    metaDescription:
      'With cuttingfloor connected, ChatGPT, Claude or Kazi make instrumental music for your video from instruments and notes, fitted to your cuts. Not a song generator: no singing, no lyrics.',
    answer:
      'Yes, for your video, once cuttingfloor is connected. ChatGPT (or Claude, or Kazi) then makes instrumental music from instruments and notes, layer by layer, fitted to your cuts, and changes any part when you ask. It is not a song generator: it doesn’t sing, write lyrics or copy an artist’s style.',
    updated: '2026-11-27',
    steps: [
      {
        title: 'Connect cuttingfloor to ChatGPT',
        body: 'Add it once (below); the same works in Claude and Kazi. It takes a minute, and you sign in the first time.',
      },
      {
        title: 'Send the video it’s for',
        body: 'Attach it in the chat, send a link, or drop it on your upload page. With no video, say how long the music should be.',
      },
      {
        title: 'Describe the music',
        body: 'The mood, the instruments and how it should move: “a lo-fi beat with soft piano”, “tense strings that build”, “a big brass hit when the title lands”.',
      },
      {
        title: 'Listen and change it in words',
        body: '“Slower.” “Fewer drums.” “Swap the guitar for piano.” Each change is a new version and the old ones stay. Then get the video with the music in it, or the music alone as a WAV or MP3.',
      },
    ],
    prompt:
      'Make 30 seconds of music for this video: a chill lo-fi beat with soft piano, the beat on my cuts, fading out on the last shot.',
    demos: [],
    faqs: [
      {
        q: 'Can ChatGPT make music on its own?',
        a: 'On its own, ChatGPT can describe music or suggest chords, but it has no instruments to play them on and no way to fit them to your video. cuttingfloor gives it both, and hands you a sound file at the end.',
      },
      {
        q: 'Can it make a song with singing and lyrics?',
        a: 'No. It makes instrumental music: piano, strings, basses, guitars, brass, drums and more. The closest thing to a voice is a choir singing “aah” as one of the instruments. For a sung song, use a song generator or a recording you have, and your agent fits your video to it.',
      },
      {
        q: 'Can it make music in the style of an artist?',
        a: 'Not by name. Describe the sound instead: the mood, the speed and the instruments (“slow, moody piano over a deep bass”, “fast, hard 808 drums”), and your agent builds that.',
      },
      {
        q: 'What is it good for?',
        a: 'Music made to fit a video: background music under a talking video, a beat for a montage or highlight reel with the cuts on it, a short jingle that ends on your logo, a theme from a tune you hum, and music for footage with no sound.',
      },
      {
        q: 'What should I use something else for?',
        a: 'A full song with a singer, a cover or remix of a famous song, or a track meant to sound like a particular artist. For those, bring a song or recording you have the rights to, and your agent cuts your video to it.',
      },
      {
        q: 'Can I change the music after it’s made?',
        a: 'Yes, any part of it. The music is built from separate layers, so “darker”, “less busy”, “more bass” or “swap the piano for strings” changes just that, and your earlier versions stay.',
      },
      {
        q: 'Does it work in Claude and Kazi too?',
        a: 'Yes. The same music works from ChatGPT, Claude, Kazi or any app that speaks MCP.',
      },
    ],
  },
  {
    slug: 'turn-a-hummed-melody-into-music',
    lang: 'en',
    title: 'How to turn a hummed melody into music with AI',
    metaTitle: 'Hum to music: turn a hummed tune into music with AI | cuttingfloor',
    metaDescription:
      'Hum or whistle a tune on your upload page and your agent turns it into notes, then plays it on any instrument, with drums, bass and chords under it. From ChatGPT, Claude or Kazi.',
    answer:
      'Record yourself humming or whistling the tune on your upload page at cuttingfloor.ai/upload, then ask your agent in ChatGPT, Claude or Kazi to turn it into music. It finds the notes you hummed, plays them on any instrument you choose, and can build drums, bass and chords under them, fitted to your video.',
    updated: '2026-11-27',
    steps: [
      {
        title: 'Connect your agent once',
        body: 'Add cuttingfloor to ChatGPT, Claude or Kazi (below). It takes a minute, and you sign in the first time.',
      },
      {
        title: 'Record the tune',
        body: 'Open your upload page (cuttingfloor.ai/upload) on your phone or computer and press Record. Hum it, whistle it or sing it on “la”, listen back, record again if you like, then send it. A voice memo you already have works too.',
      },
      {
        title: 'Say what it should become',
        body: '“Play my tune on piano.” “Make it the intro theme for my podcast, with strings and a soft beat.” Your agent finds the notes and their timing in your recording and builds the music around them.',
      },
      {
        title: 'Listen and change it',
        body: 'Ask for another instrument, a different speed, tidier timing or a wrong note fixed (“the third note should be higher”). Then get the music as a WAV or MP3, or in your video.',
      },
    ],
    prompt:
      'I just recorded a hummed tune on my upload page. Turn it into a 10-second intro theme for my channel: the tune on piano, with soft strings and a light beat under it.',
    demos: [],
    faqs: [
      {
        q: 'Do I need to sing well?',
        a: 'No. Hum, whistle or sing it on “la”, one note at a time. If a note comes out wrong, say which one and your agent changes it.',
      },
      {
        q: 'Where do I record it?',
        a: 'On your upload page at cuttingfloor.ai/upload, in any browser on a phone or computer. Press Record, listen back, and send it; it reaches your agent like any file you send.',
      },
      {
        q: 'Which instruments can play my tune?',
        a: 'Any of them: piano, electric piano, organ, strings, brass, flute, glockenspiel, music box, marimba, acoustic or electric guitar, a plucked synth, a choir singing “aah”, or several at once as one sound.',
      },
      {
        q: 'Does it keep my timing?',
        a: 'Yes, the notes keep the timing you hummed them with. If you’d rather they sat neatly on the beat, ask your agent to straighten the timing.',
      },
      {
        q: 'Can I see the notes it heard?',
        a: 'Yes. Your agent can show a picture of the notes, one row per note like a piano roll, and a picture of your recording drawn the same way, so you can see where they match.',
      },
      {
        q: 'Can a sound I record become an instrument?',
        a: 'Yes. Record a clap, a knock or a finger snap of your own, and your agent can cut it out of the recording and play it as a drum in the beat.',
      },
      {
        q: 'Can it fit my video?',
        a: 'Yes. Send the video too and the music is fitted to it: the tune starting where you want, the beat on your cuts and the last note ending on the last frame.',
      },
    ],
  },
  {
    slug: 'make-a-jingle-for-a-video',
    lang: 'en',
    title: 'How to make a jingle for a video or an ad with AI',
    metaTitle: 'Jingle maker: make a jingle for your video or ad with AI | cuttingfloor',
    metaDescription:
      'Ask ChatGPT, Claude or Kazi for a short tune made for your ad or intro: a few seconds of instruments that ends exactly as your logo appears, built note by note and changeable in words.',
    answer:
      'Connect cuttingfloor to ChatGPT, Claude or Kazi, send your ad or intro and describe the jingle. Your agent writes a short tune on the instruments you want, times it to the picture, and lands the last note exactly as your logo appears. Change the tune, the instruments or the ending in words.',
    updated: '2026-11-27',
    steps: [
      {
        title: 'Connect your agent once',
        body: 'Add cuttingfloor to ChatGPT, Claude or Kazi (below). It takes a minute, and you sign in the first time.',
      },
      {
        title: 'Send the video, or just your logo',
        body: 'Attach the ad, intro or outro in the chat, send a link, or drop it on your upload page. With only a logo, your agent can animate it for you too.',
      },
      {
        title: 'Describe the jingle',
        body: 'How long, how it feels and what it ends on: “four seconds, bright and happy, bells and piano, ending on a big chord as the logo pops in.” Or hum the tune you have in mind on your upload page.',
      },
      {
        title: 'Listen, change it, then use it everywhere',
        body: 'Ask for changes in words (“higher”, “one note shorter”, “end on a drum hit”). Get the video with the jingle in it, or the jingle alone as a WAV or MP3 for the start or end of every video.',
      },
    ],
    prompt:
      'Make a 5-second jingle for the end of my ad: bright and friendly, bells and piano, with the last note landing exactly when my logo appears.',
    demos: [],
    faqs: [
      {
        q: 'How does the last note land on the logo?',
        a: 'Your agent finds the frame your logo appears on, marks that moment in the music and writes the tune so its last note starts there. Then it checks where the note really lands in the finished video.',
      },
      {
        q: 'Can it sing my brand name?',
        a: 'No. Jingles here are instrumental: there’s no singer and no lyrics. For words, add a voiceover over the tune, recorded by you or made from your script.',
      },
      {
        q: 'Can I hum the tune I have in mind?',
        a: 'Yes. Record it on your upload page and your agent turns your hum into notes, then plays it on the instruments you pick.',
      },
      {
        q: 'Can I get the jingle on its own?',
        a: 'Yes, as a WAV or MP3, to use at the start or end of every video, or in a podcast.',
      },
      {
        q: 'Can I try a few versions?',
        a: 'Yes. Ask for two or three (“one with piano, one with brass”). Each is its own version and the earlier ones stay, so you can pick or go back.',
      },
      {
        q: 'Can it sound like another brand’s jingle?',
        a: 'Describe the feel you want instead (“short, warm and confident, like a sign-off”). Your agent writes an original tune from that.',
      },
    ],
  },
  {
    slug: 'make-a-beat-for-a-montage',
    lang: 'en',
    title: 'How to make a beat for a gaming montage or highlight reel',
    metaTitle: 'AI beat maker for gaming montages and highlight reels | cuttingfloor',
    metaDescription:
      'Your agent makes a beat for your clips: drums, bass and hits on an acoustic, 808, 909 or lo-fi kit, with the cuts on the beat and the biggest hit on the big play. From ChatGPT, Claude or Kazi.',
    answer:
      'Connect cuttingfloor to ChatGPT, Claude or Kazi, send your clips and say the feel. Your agent builds a beat for them: it picks a speed so the beats fall on your cuts, lays drums, bass and hits in layers, puts the biggest hit on the big play, and keeps the commentary or game sound coming through.',
    updated: '2026-11-27',
    steps: [
      {
        title: 'Connect your agent once',
        body: 'Add cuttingfloor to ChatGPT, Claude or Kazi (below). It takes a minute, and you sign in the first time.',
      },
      {
        title: 'Send your clips',
        body: 'Gameplay, sports clips or a stream: attach them in the chat, send links, or drop them on your upload page.',
      },
      {
        title: 'Say the feel and the big moment',
        body: '“Hard and fast, building to the end, the biggest hit on the last kill.” Your agent finds each play, cuts on the beat and writes the beat around them: a drum kit and a heavy bass first, then strings or brass on top as it builds.',
      },
      {
        title: 'Check it, change it, get the file',
        body: 'Your agent measures the mix (how loud it is, where the hits land) before it hands it over. Ask for changes in words (“harder drums”, “drop the bass in the slow motion”, “try the 909 kit”), then get the MP4, wide for YouTube or vertical for Shorts.',
      },
    ],
    prompt:
      'Make a 30-second montage of these clips with a beat made for it: hard 808 drums and heavy bass that build, cuts on the beat, and slow motion on the last kill with the biggest hit right there.',
    demos: [],
    faqs: [
      {
        q: 'Which drum kits are there?',
        a: 'Four: an acoustic kit, an 808-style electronic kit, a 909-style kit and a lo-fi kit (the acoustic kit made crunchy and warm). Under them go basses from a deep sub bass to synth and electric bass, and on top anything from strings to brass.',
      },
      {
        q: 'How do the cuts land on the beat?',
        a: 'Your agent picks a speed for the beat so each beat falls exactly on a frame, then cuts your clips on beats. The beat is made for your clips, so the big play never has to wait for a song’s drop.',
      },
      {
        q: 'Can the commentary or game sound come through?',
        a: 'Yes. Your agent lowers the music under the commentator’s calls, or keeps the game sound underneath, and can read back the words of the finished mix to check the calls made it.',
      },
      {
        q: 'Can I add sound effects too?',
        a: 'Yes: booms, airhorns, whooshes and crowd cheers from a library of about 20,000 sound effects, each placed on its moment.',
      },
      {
        q: 'Can I change the beat afterwards?',
        a: 'Yes, any layer of it: busier or simpler drums, another kit, more or less bass, a bigger build, a different ending. Each change is a new version and the old ones stay.',
      },
      {
        q: 'Can I use a song instead?',
        a: 'Yes. Send it and your agent cuts your clips to its beat instead. A song you bring is yours to clear for where you post.',
      },
    ],
  },
  {
    slug: 'record-a-voiceover-for-a-video',
    lang: 'en',
    title: 'How to record a voiceover for your video',
    metaTitle: 'How to record a voiceover for your video, then edit to it with AI | cuttingfloor',
    metaDescription:
      'Record your voiceover on your cuttingfloor upload page, or have one made from your script. Your agent lays it in, times the shots to your words, captions it and puts music under it.',
    answer:
      'Record it on your upload page at cuttingfloor.ai/upload: press Record, read your script, listen back, send. Then ask your agent in ChatGPT, Claude or Kazi to use it. It lays the voiceover in, times the shots to your words, captions them and keeps music under your voice. No microphone? It can make a voiceover from your script.',
    updated: '2026-11-27',
    steps: [
      {
        title: 'Connect your agent once',
        body: 'Add cuttingfloor to ChatGPT, Claude or Kazi (below). It takes a minute, and you sign in the first time.',
      },
      {
        title: 'Record on your upload page',
        body: 'Open cuttingfloor.ai/upload on your phone or computer, press Record and read your script. Listen back, record again until it’s right, then send it. A recording you already have works too.',
      },
      {
        title: 'Tell your agent what it’s for',
        body: '“Use my voiceover on these clips, change shots as I talk, add captions and quiet music under it.” Your agent transcribes the recording with the time of every word, so it can cut and caption by what you said.',
      },
      {
        title: 'Check it, then get the file',
        body: 'Your agent checks your voice stays clear over the music before it hands the video over. Ask for changes in words (“cut the first sentence”, “music quieter”), then get the MP4.',
      },
    ],
    prompt:
      'I recorded a voiceover on my upload page. Put it over these clips, change shots as I talk, add big captions from my words and quiet piano music under my voice.',
    demos: [],
    faqs: [
      {
        q: 'How do I get a good recording?',
        a: 'A quiet room with soft things around you (a closet full of clothes works), the phone a hand’s width from your mouth and the same distance the whole way. Record a couple of takes and send the one you like.',
      },
      {
        q: 'Can it make a voiceover from my script instead?',
        a: 'Yes. Paste the script and your agent makes the voiceover in a natural American or British English voice, with a time for every word, so shots and captions line up with it.',
      },
      {
        q: 'Can I record in another language?',
        a: 'Yes. Your own recording can be in any language your agent transcribes, Spanish included, and the captions come out in it. Voiceovers made from a script are in English.',
      },
      {
        q: 'Can it cut my pauses and restarts?',
        a: 'Yes. Ask it to take out the pauses and the lines you started over; it cuts by the time of each word.',
      },
      {
        q: 'Will music drown out my voice?',
        a: 'No. The music sits at one steady level under your voice, and your agent can read back the words of the finished mix to check every word came through.',
      },
      {
        q: 'Can the music be made for the video?',
        a: 'Yes. Ask for music made to fit, built from instruments in layers and changeable in words (“softer”, “no drums”), or send your own song.',
      },
    ],
  },
  {
    slug: 'musica-de-fondo-para-videos',
    lang: 'es',
    title: 'Música de fondo para videos, hecha a la medida con IA',
    metaTitle: 'Música de fondo para videos, hecha a la medida de tus cortes | cuttingfloor',
    metaDescription:
      'Pídele a ChatGPT, Claude o Kazi música de fondo hecha para tu video: con instrumentos, capa por capa, el ritmo en tus cortes y pareja bajo tu voz. O tu propia canción, ajustada al video.',
    answer:
      'Pídele música de fondo a tu agente (Kazi, Claude o ChatGPT, con cuttingfloor conectado). La arma con instrumentos y notas, capa por capa, a la medida de tu video: el ritmo en tus cortes, un golpe en el momento clave y la última nota en el último cuadro. ¿Ya tienes una canción? La ajusta a tu video.',
    updated: '2026-11-27',
    alternate: '/guides/make-background-music-for-a-video',
    steps: [
      {
        title: 'Conecta tu agente una vez',
        body: 'Agrega cuttingfloor a Kazi, Claude o ChatGPT (abajo). Toma un minuto y solo inicias sesión la primera vez.',
      },
      {
        title: 'Dale el video',
        body: 'Adjúntalo en el chat, envía un enlace o súbelo a tu página de subida. Sirve un video donde hablas, un video de clips o tomas sin sonido.',
      },
      {
        title: 'Di cómo debe sonar',
        body: '“Piano tranquilo”, “oscura y con tensión”, “alegre y que crezca al final”, y qué momento debe marcar. Tu agente elige una velocidad para que los tiempos caigan en tus cortes y arma la música por capas: batería, bajo, acordes y una melodía encima.',
      },
      {
        title: 'Escúchala, cámbiala y descárgala',
        body: 'Pide cambios con palabras (“más oscura”, “menos cargada”, “más bajo”, “cambia el piano por cuerdas”) y cambia esa parte. Descarga el video en MP4, o la música sola en WAV o MP3.',
      },
    ],
    prompt:
      'Hazle música de fondo a mi video: tranquila, con piano y cuerdas suaves, que crezca un poco al final. Que quede bajita debajo de mi voz y que termine en el último cuadro.',
    demos: [],
    faqs: [
      {
        q: '¿Es un generador de canciones?',
        a: 'No. Tu agente escribe la música nota por nota con instrumentos (piano, cuerdas, bajos, guitarras, metales, baterías y más) y la arma por capas. No hay voz cantando ni letra, y no imita a ningún artista. Como cada nota se puede cambiar, pedir “menos cargada” da justo eso.',
      },
      {
        q: '¿Puedo poner música debajo de un video donde hablo?',
        a: 'Sí. La música queda a un volumen parejo debajo de tu voz y tu voz se oye completa. Tu agente puede transcribir la mezcla final para comprobar que no se perdió ninguna palabra.',
      },
      {
        q: '¿Puedo usar mi propia canción?',
        a: 'Sí. Envíala con el video y tu agente la ajusta: corta el video al ritmo, la baja cuando hablas y la desvanece al final. Si la canción es de alguien más, asegúrate de tener permiso para usarla donde publiques.',
      },
      {
        q: '¿Qué instrumentos hay?',
        a: 'Piano de cola y eléctrico, órgano, contrabajo, bajo eléctrico, bajo de sintetizador y sub bajo, cuerdas, metales, flauta, glockenspiel, caja de música, marimba, guitarra acústica y eléctrica, sintetizadores y un coro que canta “aah”, además de baterías acústica, 808, 909 y lo-fi, y efectos como reverb y eco.',
      },
      {
        q: '¿Quién la escucha?',
        a: 'Tú. Tu agente revisa la música midiéndola (qué tan fuerte suena, dónde caen los golpes, que tu voz se oiga) y mirando una imagen de las notas; tú la escuchas y dices qué cambiar.',
      },
      {
        q: '¿Funciona con videos en español?',
        a: 'Sí. La música no tiene idioma, y si hablas en el video, tu agente transcribe tu español para cuidar tu voz y ponerte subtítulos.',
      },
    ],
  },
  {
    slug: 'poner-musica-a-un-video',
    lang: 'es',
    title: 'Cómo poner música a un video con IA',
    metaTitle:
      'Cómo poner música a un video con IA: tu canción o música hecha para él | cuttingfloor',
    metaDescription:
      'Pídele a ChatGPT, Claude o Kazi que le ponga música a tu video: tu propia canción, cortada al ritmo y más bajita cuando hablas, o música hecha a la medida de tus cortes.',
    answer:
      'Conecta cuttingfloor al agente que ya usas (Kazi, Claude o ChatGPT), envía tu video y di qué música quieres: tu propia canción o música hecha para el video. Tu agente la coloca, la baja cuando hablas, corta al ritmo de tu canción o arma el ritmo sobre tus cortes, la desvanece al final y te entrega el MP4.',
    updated: '2026-11-27',
    steps: [
      {
        title: 'Conecta tu agente una vez',
        body: 'Agrega cuttingfloor a Kazi, Claude o ChatGPT (abajo). Toma un minuto y solo inicias sesión la primera vez.',
      },
      {
        title: 'Dale el video y, si tienes, la canción',
        body: 'Adjúntalos en el chat, envía un enlace o súbelos a tu página de subida. Sin canción, tu agente hace la música para el video.',
      },
      {
        title: 'Di cómo va la música',
        body: 'Con tu canción: “corta el video al ritmo”, “que empiece en el coro”, “más bajita cuando hablo”. Sin canción: cómo debe sonar (“alegre, con guitarra y un ritmo suave”) y qué momento debe marcar.',
      },
      {
        title: 'Revisa y descarga',
        body: 'Tu agente mide la mezcla antes de entregártela. Pide cambios con palabras (“más fuerte al final”, “sin batería”) y descarga el MP4, en vertical para Reels y TikTok o en horizontal para YouTube.',
      },
    ],
    prompt:
      'Ponle música a mi video: usa esta canción, corta las tomas al ritmo, bájala cuando hablo y desvanécela al final.',
    demos: [],
    faqs: [
      {
        q: '¿Puedo usar una canción que ya tengo?',
        a: 'Sí. Envía el archivo de audio con tu video. Tu agente encuentra sus tiempos, corta el video al ritmo, la baja cuando hablas y la desvanece al final. Si la canción es de alguien más, asegúrate de tener permiso para usarla donde publiques.',
      },
      {
        q: '¿Y si no tengo música?',
        a: 'Tu agente la hace para tu video con instrumentos y notas, capa por capa: el ritmo en tus cortes, un golpe en el momento clave y la última nota en el último cuadro. No es un generador de canciones: no hay voz cantando ni letra.',
      },
      {
        q: '¿Puedo pegar un enlace de YouTube o Spotify?',
        a: 'No: hace falta el archivo. Envía una canción que tengas como archivo (MP3 o WAV), o un enlace directo al archivo.',
      },
      {
        q: '¿Se va a oír mi voz sobre la música?',
        a: 'Sí. Tu agente baja la música debajo de tu voz y puede transcribir la mezcla final para comprobar que se entiende cada palabra.',
      },
      {
        q: '¿Puedo cambiar la música después?',
        a: 'Sí. Cada cambio crea una versión nueva y las anteriores se guardan. Con música hecha para el video también cambias cada parte: “más lenta”, “sin batería”, “cambia el piano por guitarra”.',
      },
      {
        q: '¿Funciona con videos en español?',
        a: 'Sí. Tu agente transcribe lo que dices en español, así que puede bajar la música donde hablas y ponerte subtítulos en español.',
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
