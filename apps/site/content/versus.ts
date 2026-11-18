export type Side = {
  name: string;
  is: string;
  wins: string;
};

export type Versus = {
  slug: string;
  kind: 'rival' | 'neutral';
  title: string;
  metaTitle: string;
  metaDescription: string;
  answer: string;
  sides: [Side, Side];
  deciding: string;
  pick: [string, string];
  demos: string[];
  faqs: { q: string; a: string }[];
  updated: string;
};

export const VERSUS: Versus[] = [
  {
    slug: 'capcut',
    kind: 'rival',
    title: 'CapCut vs cuttingfloor',
    metaTitle: 'CapCut vs cuttingfloor: timeline app or agent tool call | cuttingfloor',
    metaDescription:
      'CapCut is a timeline you open and work in. cuttingfloor is editing tools an AI agent calls, so the cut happens in Claude, ChatGPT or Cursor. What each does better.',
    answer:
      'CapCut is a timeline editor you open and work in yourself. cuttingfloor is a set of video editing tools an AI agent calls, so the edit happens inside Claude, ChatGPT or Cursor without opening an app. Both cut, caption and export. CapCut needs you at the timeline; cuttingfloor needs a sentence and then a look at the result.',
    sides: [
      {
        name: 'cuttingfloor',
        is: 'An open-source MCP server of video editing tools for the agent you already use.',
        wins: 'Your agent makes the edit and sees a preview with every change, so it can check its own work. Cuts by word timings, exports FCPXML, OTIO and EDL your editing app opens. Self-hostable, one Docker image.',
      },
      {
        name: 'CapCut',
        is: 'A timeline editing app for phone and desktop, free for most of what creators need.',
        wins: 'No setup and nothing to connect. Templates, effects, music and a mobile app that work the moment you install it, and a large library of looks a creator can copy. Free for most edits.',
      },
    ],
    deciding:
      'Where the edit starts: you opening a timeline and dragging clips, or you saying a sentence to an agent you already have open.',
    pick: [
      'you want an edit driven from a conversation, checked by the agent, and still openable in a real editing app afterwards.',
      'you want to work on a timeline by hand, use templates, or edit on a phone with no account to connect.',
    ],
    demos: ['edit-a-product-review-short', 'edit-a-dance-short-to-the-beat'],
    faqs: [
      {
        q: 'Does CapCut work inside Claude or ChatGPT?',
        a: 'Not officially. CapCut publishes no MCP server and no editing API; community projects write CapCut draft files directly, which works until the draft format changes. cuttingfloor is an MCP server, so Claude, ChatGPT, Codex, Cursor and Kazi call it as tools.',
      },
      {
        q: 'Can cuttingfloor open or export a CapCut project?',
        a: 'No. cuttingfloor exports FCPXML, OTIO and EDL, plus SRT and VTT captions, which DaVinci Resolve, Premiere Pro and Final Cut Pro read. A CapCut draft is not a documented interchange format, so there is nothing stable to write into.',
      },
      {
        q: 'Is cuttingfloor free like CapCut?',
        a: 'Editing the timeline is free and self-hosting is free. The hosted server charges credits, one credit per minute of a job running. CapCut is free for most edits and charges for some effects, cloud storage and its pro tier.',
      },
    ],
    updated: '2026-11-17',
  },
  {
    slug: 'descript',
    kind: 'rival',
    title: 'Descript vs cuttingfloor',
    metaTitle:
      'Descript vs cuttingfloor: transcript editing in an app or in your agent | cuttingfloor',
    metaDescription:
      'Both cut video by editing its words. Descript does it in its own editor; cuttingfloor does it inside Claude, ChatGPT or Cursor and exports the timeline. Where each wins.',
    answer:
      'Descript edits video by editing its transcript, in a desktop app built around that idea. cuttingfloor cuts by word timings too, but the transcript and the cut both happen inside the AI agent you already use, and the finished timeline exports to your editing app. Same idea, a different place to work.',
    sides: [
      {
        name: 'cuttingfloor',
        is: 'An open-source MCP server of editing tools that an agent drives.',
        wins: 'The edit runs unattended inside the agent you already talk to. Every change returns a preview the agent can check, and the result exports as FCPXML, OTIO or EDL instead of living only inside one app. Open source and self-hostable.',
      },
      {
        name: 'Descript',
        is: 'A desktop editor where the transcript is the timeline, with studio sound and screen recording built in.',
        wins: 'A finished editor you can see and drive by hand, with years of craft in transcript editing, filler-word removal, studio sound, screen recording and publishing. Its MCP and API expose a prompt to Underlord rather than individual editing tools.',
      },
    ],
    deciding:
      'Whether the cut is something you perform in an editor, or something an agent performs for you and reports back.',
    pick: [
      'you want the edit to happen inside the agent already open on your screen, and the timeline handed back to your editing app.',
      'you want to sit in a transcript editor yourself, with studio sound, screen recording and publishing in the same window.',
    ],
    demos: ['remove-pauses-and-restarts-from-a-talking-video', 'edit-a-two-person-interview'],
    faqs: [
      {
        q: 'Does Descript have an MCP server?',
        a: 'Descript exposes an MCP and an API where you send a prompt to Underlord, its AI assistant. That is a prompt, not a set of editing tools an agent can call one at a time. cuttingfloor exposes the tools: cut, trim, caption, mix, reframe, export.',
      },
      {
        q: 'Which one removes filler words better?',
        a: 'Both remove ums, pauses and restarts by word timings, and neither is clearly better at it. The difference is where: Descript shows you each cut in its transcript editor to approve, while cuttingfloor lets the agent make the cuts and check the result against a preview.',
      },
      {
        q: 'Can I move between them?',
        a: 'One way only. cuttingfloor exports FCPXML, OTIO and EDL, which professional editors read, but Descript does not import those as a transcript project. In practice you choose where the transcript edit happens rather than moving an edit between the two.',
      },
    ],
    updated: '2026-11-17',
  },
  {
    slug: 'vidova',
    kind: 'rival',
    title: 'Vidova vs cuttingfloor',
    metaTitle: 'Vidova vs cuttingfloor: two video MCP servers compared | cuttingfloor',
    metaDescription:
      'Vidova and cuttingfloor are both MCP servers for video editing. The split is open source and self-hosting, what the agent can check, and how each charges. From public docs.',
    answer:
      'Vidova and cuttingfloor are both MCP servers that let an AI agent edit video, so this is the closest comparison on the site: the same shape of product, aimed at the same buyer. cuttingfloor is open source under AGPL-3.0 and self-hostable from one Docker image. Vidova is hosted only.',
    sides: [
      {
        name: 'cuttingfloor',
        is: 'An open-source MCP server of editing tools, hosted or run on your own machine.',
        wins: 'Open source under AGPL-3.0, and the same Docker image runs on your own hardware, so footage need not leave it. Every edit returns a preview the agent checks, with qa.check for exact checks and media.seek to find a moment in plain words. Exports FCPXML, OTIO and EDL.',
      },
      {
        name: 'Vidova',
        is: 'A hosted MCP server for AI video editing, with an MCP endpoint at mcp.vidova.ai.',
        wins: 'A hosted product with nothing to run, a broad sitemap of guides and templates behind it, and simple plan pricing. If you would rather not operate a server at all, that is a real advantage.',
      },
    ],
    deciding:
      'Whether self-hosting matters to you. If your footage cannot leave your own machine, only one of these two works.',
    pick: [
      'you need open source, self-hosting, or the agent to be able to check its own output before you look.',
      'you want a hosted service with nothing to install and the simplest possible setup.',
    ],
    demos: ['make-a-motion-graphics-explainer-video', 'add-a-talking-head-to-your-explainer-video'],
    faqs: [
      {
        q: 'Are Vidova and cuttingfloor the same kind of product?',
        a: 'Yes. Both are MCP servers that give an AI agent video editing tools, and both are aimed at people editing through Claude, ChatGPT or another agent rather than in an editing app. The differences are licensing, self-hosting, pricing and how much the agent can verify.',
      },
      {
        q: 'Can I self-host Vidova?',
        a: 'Its public docs do not describe a self-hosted option, so we do not claim one. cuttingfloor publishes a Docker image and runs self-hosted under AGPL-3.0, free.',
      },
      {
        q: 'How is each priced?',
        a: 'Compare current pricing on each site rather than here, since plans change. cuttingfloor charges credits for minutes of a job running: editing the timeline is free, and so is self-hosting.',
      },
    ],
    updated: '2026-11-17',
  },
  {
    slug: 'veed',
    kind: 'rival',
    title: 'VEED vs cuttingfloor',
    metaTitle: 'VEED vs cuttingfloor: browser editor or tools your agent calls | cuttingfloor',
    metaDescription:
      'VEED is a video editor in a browser tab. cuttingfloor is a set of editing tools an AI agent calls from Claude, ChatGPT or Cursor. What each does better, from public docs.',
    answer:
      'VEED is a video editor you use in a browser tab. cuttingfloor is a set of video editing tools an AI agent calls, so there is no editor window at all: you ask, the agent edits, and the result comes back as a video you can watch or a timeline your editing app opens.',
    sides: [
      {
        name: 'cuttingfloor',
        is: 'An open-source MCP server of editing tools an agent drives.',
        wins: 'No editor to learn and no tab to keep open. The agent makes the cuts and checks a preview, then exports FCPXML, OTIO or EDL. Open source, self-hostable, and it works from whichever agent you already use.',
      },
      {
        name: 'VEED',
        is: 'A browser-based video editor with AI features, subtitles, templates and a public API.',
        wins: 'A complete editor in a tab, with templates, stock, subtitles, and a polished interface built for people who want to see what they are making. Its API exposes AI models such as dubbing and lip-sync rather than editing tools.',
      },
    ],
    deciding: 'Whether you want to see and drive the edit, or describe it and check the result.',
    pick: [
      'the edit should happen inside your agent, and you want the timeline back as a file your editing app opens.',
      'you want a visual editor in a browser with templates and stock, and AI features inside that editor.',
    ],
    demos: ['edit-a-real-estate-listing-video', 'remove-pauses-and-restarts-from-a-talking-video'],
    faqs: [
      {
        q: 'Does VEED have an API I can automate?',
        a: 'VEED publishes an API of AI models, such as dubbing, lip-sync and audio cleanup. That is different from editing tools: it does not expose cut, trim, track, mix or export as calls an agent sequences itself. cuttingfloor exposes those as MCP tools.',
      },
      {
        q: 'Which is easier to start with?',
        a: 'VEED, for most people. You open a tab and edit. cuttingfloor takes a connection step first, adding its MCP server address to Claude, ChatGPT, Codex or Cursor, and is quickest for someone already working in one of those.',
      },
      {
        q: 'Can cuttingfloor replace VEED for social video?',
        a: 'For cutting and captioning existing footage, yes: it trims, captions word by word, reframes and exports vertical or widescreen versions. It has no stock library and no templates, so anything relying on those stays with VEED.',
      },
    ],
    updated: '2026-11-17',
  },
  {
    slug: 'invideo',
    kind: 'rival',
    title: 'Invideo AI vs cuttingfloor',
    metaTitle: 'Invideo AI vs cuttingfloor: generate a video or edit your own | cuttingfloor',
    metaDescription:
      'Invideo AI writes and assembles a video from a prompt. cuttingfloor edits the footage you already shot, from inside your agent. Different jobs, and where each one fits.',
    answer:
      'Invideo AI makes a video from a written prompt, assembling stock and generated scenes into something finished. cuttingfloor edits footage you already shot: your interview, your product clip, your listing walkthrough. One creates a video you did not have; the other cuts the one you did.',
    sides: [
      {
        name: 'cuttingfloor',
        is: 'An open-source MCP server of editing tools for your own footage.',
        wins: 'Your own footage, cut properly: word-timed trims, captions, a real mix, reframes, and a timeline that exports to your editing app. The agent checks its own output. Open source and self-hostable.',
      },
      {
        name: 'Invideo AI',
        is: 'A prompt-to-video generator with stock footage, voiceover and templates, and an MCP on a live timeline.',
        wins: 'When you have no footage, it produces a watchable video from a sentence, with stock, voice and music handled. For volume content where the footage does not matter, that is faster than editing anything.',
      },
    ],
    deciding:
      'Whether the footage already exists. If it does, you need an editor. If it does not, you need a generator.',
    pick: [
      'you shot the footage and want it cut, captioned and mixed, with the agent doing the work and checking it.',
      'you have no footage and want a finished video from a prompt, built from stock and generated scenes.',
    ],
    demos: ['edit-a-two-person-interview', 'edit-a-real-estate-listing-video'],
    faqs: [
      {
        q: 'Can cuttingfloor generate footage that does not exist?',
        a: 'No. It edits the video, audio and images you give it, and can build motion graphics from HTML, but it does not source stock or generate live-action footage. That is a deliberate limit: it is an editor, not a generator.',
      },
      {
        q: 'Does Invideo AI edit footage I shot?',
        a: 'Its public docs describe generating and assembling video on a live multitrack timeline. Editing long footage you shot yourself is not what it is built around, which is why the two are compared less often than people expect.',
      },
      {
        q: 'Which one is cheaper?',
        a: "They are priced on different things, so the answer depends on volume and on whether you supply footage. cuttingfloor charges credits per minute of a job running and is free self-hosted; check Invideo's current plans on its site.",
      },
    ],
    updated: '2026-11-17',
  },
  {
    slug: 'premiere',
    kind: 'rival',
    title: 'Premiere Pro vs cuttingfloor',
    metaTitle:
      'Premiere Pro vs cuttingfloor: finish in Premiere, start in your agent | cuttingfloor',
    metaDescription:
      'Premiere Pro is where a professional edit is finished. cuttingfloor is where an agent does the first pass and hands you an FCPXML timeline. They are meant to be used together.',
    answer:
      'Premiere Pro is a professional editing application, and cuttingfloor is not a replacement for it. cuttingfloor does the first pass an agent can do: cutting to words, removing pauses, captioning, reframing, mixing, then exporting an FCPXML timeline Premiere opens. You finish the edit where you always did.',
    sides: [
      {
        name: 'cuttingfloor',
        is: 'An open-source MCP server that does the first pass and exports a timeline.',
        wins: 'The hours before the creative work: watching, cutting to words, killing pauses, captioning and reframing, done by an agent that checks its output. Exports FCPXML, OTIO and EDL straight into Premiere.',
      },
      {
        name: 'Premiere Pro',
        is: 'A professional non-linear editor, and the standard for finishing work in teams.',
        wins: 'Everything after the first pass: precise creative control, color, graphics, sound design, multicam, collaboration and delivery. No agent replaces a finishing editor, and this comparison is not claiming one does.',
      },
    ],
    deciding:
      'This is not either-or. The question is only whether the first pass is done by hand or by an agent before you open Premiere.',
    pick: [
      'you want the watching, cutting and captioning done before you sit down, then finish in Premiere.',
      'you are doing the whole edit by hand and want full creative control from the first cut.',
    ],
    demos: ['edit-a-two-person-interview', 'pick-your-best-take-with-ai'],
    faqs: [
      {
        q: 'Does cuttingfloor export a Premiere project?',
        a: 'It exports FCPXML, OTIO and EDL, plus SRT and VTT captions. Premiere Pro imports FCPXML, which brings across the cuts, clips and captions so you continue on a real timeline rather than re-cutting from scratch.',
      },
      {
        q: 'Will the timeline survive the round trip?',
        a: 'The cut, the clip order and the captions come across. Effects, blends and some transitions are simplified by the format itself, which is why the export is a first pass to finish rather than a finished project.',
      },
      {
        q: 'Can an agent really do the first pass well?',
        a: 'For cutting to words, removing pauses and restarts, captioning and reframing, yes, and it is measurable. It returns a preview with every change, and qa.check verifies specific things such as captions landing on the right words.',
      },
    ],
    updated: '2026-11-17',
  },
  {
    slug: 'capcut-vs-descript',
    kind: 'neutral',
    title: 'CapCut vs Descript',
    metaTitle: 'CapCut vs Descript: timeline editing or transcript editing | cuttingfloor',
    metaDescription:
      'CapCut is a free timeline editor for phone and desktop. Descript edits video by editing its transcript. An honest comparison of two different ways to cut, and when each fits.',
    answer:
      'CapCut and Descript cut video in fundamentally different ways. CapCut gives you a timeline you operate by hand, free, on phone or desktop, with templates and effects. Descript gives you a transcript you edit like a document, and the video follows. Neither runs inside an AI agent.',
    sides: [
      {
        name: 'CapCut',
        is: 'A free timeline editor for phone and desktop, with templates, effects and music.',
        wins: 'Cost and speed to first edit. Nothing to learn before you start, a phone app that works anywhere, and templates that produce a watchable result without skill.',
      },
      {
        name: 'Descript',
        is: 'A desktop editor where editing the transcript edits the video.',
        wins: 'Cutting talking footage. Deleting a sentence deletes that stretch of video, which is far faster than scrubbing a timeline for an interview or a talking-head video. Studio sound and screen recording are built in.',
      },
    ],
    deciding:
      'Whether your footage is mostly talking. If it is, transcript editing wins. If it is action, product or dance, the timeline wins.',
    pick: [
      'your video is mostly someone talking, and you want to cut by deleting words.',
      'your video is action, product or social, and you want to place clips and effects by hand for free.',
    ],
    demos: ['remove-pauses-and-restarts-from-a-talking-video', 'edit-a-dance-short-to-the-beat'],
    faqs: [
      {
        q: 'Which is better for interviews?',
        a: 'Descript, for the cutting itself. Deleting text removes that part of the video, so a 40-minute interview becomes a document you shorten. CapCut can cut an interview but you find each cut by scrubbing the timeline.',
      },
      {
        q: 'Which is better for social video?',
        a: 'CapCut, for the range of looks and the phone workflow. Templates, effects and trending formats are what social video needs, and most of it is free.',
      },
    ],
    updated: '2026-11-17',
  },
  {
    slug: 'descript-vs-veed',
    kind: 'neutral',
    title: 'Descript vs VEED',
    metaTitle: 'Descript vs VEED: transcript editor or browser editor | cuttingfloor',
    metaDescription:
      'Descript is a desktop app built on transcript editing. VEED is a video editor in a browser tab with templates and stock. Where each one is the better choice, honestly.',
    answer:
      'Descript and VEED are both editors, built around different ideas. Descript is a desktop app where the transcript is the timeline, which suits talking footage. VEED is a browser editor with templates and stock, which suits quick social video and teams that cannot install software.',
    sides: [
      {
        name: 'Descript',
        is: 'A desktop editor where editing text edits the video.',
        wins: 'Long talking footage: interviews, podcasts, courses. Editing by transcript, studio sound and screen recording make it the faster tool when words are the content.',
      },
      {
        name: 'VEED',
        is: 'A browser-based editor with templates, stock and AI features.',
        wins: 'Access and breadth. It runs in a tab on any machine with no install, has templates and stock built in, and covers subtitles, translation and cleanup without leaving the page.',
      },
    ],
    deciding: 'Whether you can install software, and whether your footage is talking or assembled.',
    pick: [
      'you have long talking footage and want to edit it by its words on a desktop.',
      'you need to edit in a browser, on any machine, with templates and stock to hand.',
    ],
    demos: ['edit-a-two-person-interview', 'edit-a-product-review-short'],
    faqs: [
      {
        q: 'Do either of these run inside Claude or ChatGPT?',
        a: 'Neither runs inside an agent as editing tools. Descript offers an MCP and API where you send a prompt to Underlord; VEED offers an API of AI models such as dubbing. cuttingfloor is the one that exposes editing tools to an agent one call at a time.',
      },
      {
        q: 'Which is better for a team?',
        a: 'VEED, generally, because a browser editor needs no install and no licence per machine, and comments and sharing happen in the same place. Descript suits individuals doing long-form work.',
      },
    ],
    updated: '2026-11-17',
  },
  {
    slug: 'invideo-vs-vidova',
    kind: 'neutral',
    title: 'Invideo AI vs Vidova',
    metaTitle: 'Invideo AI vs Vidova: prompt-to-video or agent editing | cuttingfloor',
    metaDescription:
      'Invideo AI generates a video from a prompt. Vidova is an MCP server that lets an agent edit video. Two different jobs in the same category, compared honestly.',
    answer:
      'Invideo AI and Vidova sit in the same category and do different jobs. Invideo generates a video from a written prompt, assembling stock and voice into something finished. Vidova is an MCP server, so an AI agent calls it to edit video as a sequence of tool calls. Neither needs footage to start with the same assumptions.',
    sides: [
      {
        name: 'Invideo AI',
        is: 'A prompt-to-video generator with stock, voiceover and templates.',
        wins: 'Making something from nothing. With no footage and no time, it produces a watchable video from a sentence, with stock, music and voice handled.',
      },
      {
        name: 'Vidova',
        is: 'A hosted MCP server for AI video editing, at mcp.vidova.ai.',
        wins: 'Editing through an agent, as a sequence of calls rather than one prompt. It is the closer of the two to working on real footage from inside Claude or ChatGPT.',
      },
    ],
    deciding: 'Whether you have footage. Generation needs none; agent editing needs some.',
    pick: [
      'you have no footage and want a finished video from a prompt.',
      'you have footage and want an agent to edit it, call by call, from inside your chat.',
    ],
    demos: ['make-a-motion-graphics-explainer-video', 'edit-a-real-estate-listing-video'],
    faqs: [
      {
        q: 'Is Vidova a competitor to Invideo AI?',
        a: 'Barely. Invideo generates video from prompts; Vidova is an MCP server that an agent calls to edit. They overlap only when someone wants a finished video and has not decided whether to supply footage.',
      },
      {
        q: 'Which one gives more control?',
        a: 'Vidova, because an agent can call it repeatedly and see each result. A generation prompt is one shot with limited control over individual cuts. Both offer less control than an editor where you place every clip.',
      },
    ],
    updated: '2026-11-17',
  },
  {
    slug: 'opusclip-vs-kapwing',
    kind: 'neutral',
    title: 'OpusClip vs Kapwing',
    metaTitle: 'OpusClip vs Kapwing: auto-clipping or editing a full project | cuttingfloor',
    metaDescription:
      'OpusClip turns long video into short clips automatically. Kapwing is a browser editor for building a project. Different jobs, and how to choose between them.',
    answer:
      'OpusClip and Kapwing solve different halves of the same problem. OpusClip takes a long video and finds short clips in it automatically, which suits podcasts and webinars. Kapwing is a browser editor where you build and finish a project yourself. One automates the selection; the other gives you the tools.',
    sides: [
      {
        name: 'OpusClip',
        is: 'An automatic clipper that finds short highlights in long video.',
        wins: 'Volume from long footage with no decisions. Give it a webinar and it returns a set of vertical clips with captions, which is faster than choosing highlights by hand.',
      },
      {
        name: 'Kapwing',
        is: 'A browser-based editor for building and finishing a project.',
        wins: 'Control and finish. Templates, collaboration, subtitles and a real editing surface in a tab, so the result is the one you meant rather than the one the model picked.',
      },
    ],
    deciding:
      'Whether you want the machine to choose the moments, or you want to choose them and build the edit.',
    pick: [
      'you have hours of footage and want short clips found for you.',
      'you know what you want to make and need an editor in a browser to make it.',
    ],
    demos: ['edit-a-two-person-interview', 'remove-pauses-and-restarts-from-a-talking-video'],
    faqs: [
      {
        q: 'Does either work inside an AI agent?',
        a: 'Neither publishes editing tools an agent calls. Both are products with their own interface. cuttingfloor is the MCP server in this space: an agent calls its tools and checks the result.',
      },
      {
        q: 'Can I use both together?',
        a: "Yes, and people do: OpusClip to find candidate moments, then an editor to finish them. The weaker link is usually the handoff, since neither imports the other's project directly.",
      },
    ],
    updated: '2026-11-17',
  },
];

// Names on the comparison tables that are not the side's own name.
const VERSUS_ALIAS: Record<string, string> = {
  invideo: 'invideo ai',
  'adobe premiere': 'premiere pro',
};

/** The rival page for a product named on the comparison tables, when one exists. */
export function versusPath(label: string): string | undefined {
  const key = label.toLowerCase().replace(/ mcp$/, '');
  const name = VERSUS_ALIAS[key] ?? key;
  const page = VERSUS.find(
    (v) =>
      v.kind === 'rival' &&
      v.sides.some((s) => s.name !== 'cuttingfloor' && s.name.toLowerCase() === name),
  );
  return page ? `/compare/${page.slug}` : undefined;
}
