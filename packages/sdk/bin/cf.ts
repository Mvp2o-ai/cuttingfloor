#!/usr/bin/env node
import { cf, file, importFile, out, progress } from '../src/index.ts';

// `cf` for bash scripts in code.run:
//   cf clip.trim '{"timeline_id":"t_…","clip_id":"c1","side":"end","by_frames":-12}'
//   cf file m_…            prints the path of a media item's file (fetched into in/)
//   cf import file.mov     imports a file the script made as media now (prints the media)
//   cf out name.mp4        prints the out/ path for a file
//   cf progress 0.5 "half way"
// Tool results print as JSON on stdout; errors as JSON on stderr with exit 1.

const [command, ...rest] = process.argv.slice(2);
try {
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(
      'usage: cf <domain.verb> [json-args] | cf file <id> | cf import <path> [name] | cf out <name> | cf progress <0-1> [message]\n',
    );
  } else if (command === 'file') {
    process.stdout.write(`${await file(rest[0] ?? '')}\n`);
  } else if (command === 'import') {
    process.stdout.write(`${JSON.stringify(await importFile(rest[0] ?? '', rest[1]))}\n`);
  } else if (command === 'out') {
    process.stdout.write(`${out(rest[0] ?? '')}\n`);
  } else if (command === 'progress') {
    await progress(Number(rest[0]), rest.slice(1).join(' '));
  } else {
    const args = rest[0] ? (JSON.parse(rest[0]) as Record<string, unknown>) : {};
    const result = await cf.call(command as never, args as never);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  const e = error as { code?: string; message: string; hint?: string; detail?: unknown };
  process.stderr.write(
    `${JSON.stringify({ code: e.code ?? 'error', message: e.message, ...(e.hint ? { hint: e.hint } : {}) })}\n`,
  );
  process.exit(1);
}
