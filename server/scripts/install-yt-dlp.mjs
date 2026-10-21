// Downloads yt-dlp into server/bin/, verified against the release's SHA-256 checksums.
// Usage: npm run setup:yt-dlp   (re-run any time to update; sites change often)
import { installYtdlp } from '../src/stream/ytdlp-install.js';

const { tag, sha256 } = await installYtdlp();
console.log(`Installed yt-dlp (${tag}, sha256 ${sha256.slice(0, 12)}…) to server/bin/yt-dlp`);
