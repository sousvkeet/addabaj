// Where FFmpeg is: FFMPEG_PATH, the copy from `npm run setup:ffmpeg`, or PATH.
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundled = fileURLToPath(new URL('../../bin/ffmpeg', import.meta.url));

let found;
export function ffmpegPath() {
  if (found !== undefined) return found;
  const candidates = [process.env.FFMPEG_PATH, bundled, ...(process.env.PATH ?? '').split(delimiter).map((d) => join(d, 'ffmpeg'))];
  found =
    candidates.find((p) => {
      if (!p) return false;
      try {
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }) ?? null;
  return found;
}
