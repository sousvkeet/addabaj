// What "Find videos" can use on this server, for the startup log and the host
// admin's overview: missing tools are the usual reason links stop working
// after a fresh deploy (server/bin/ and the browser aren't in git).
import { adBlockStatus } from './adblock.js';
import { ffmpegPath } from './ffmpeg.js';
import { browserStatus } from './sniff.js';
import { ytdlpVersion } from './ytdlp.js';

let browserCheck = { checked: false, ok: false };
export const recordBrowserCheck = (result) => {
  browserCheck = { checked: true, ...result };
};

export async function videoTools() {
  const browser = browserStatus();
  return {
    ytdlp: { version: await ytdlpVersion(), fix: 'npm run setup:yt-dlp' },
    ffmpeg: { installed: !!ffmpegPath(), fix: 'npm run setup:ffmpeg' },
    browser: {
      enabled: browser.enabled,
      checked: browserCheck.checked,
      ok: browserCheck.ok && !browser.problem,
      problem: browser.problem ?? browserCheck.problem ?? null,
      fix: 'npm run setup:browser',
    },
    adBlock: adBlockStatus(),
  };
}
