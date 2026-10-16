import { extname } from 'node:path';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.otio': 'application/json',
  '.fcpxml': 'application/xml',
  '.edl': 'text/plain',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
  '.zip': 'application/zip',
  '.png': 'image/png',
};

/** The media type of an output file, by its extension. */
export function outputMime(name: string): string {
  return TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
}
