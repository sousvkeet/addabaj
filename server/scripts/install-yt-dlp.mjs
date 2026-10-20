// Downloads yt-dlp (the official single-file release) into server/bin/,
// verifying it against the release's published SHA-256 checksums.
// Usage: npm run setup:yt-dlp   (re-run any time to update; sites change often)
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const binDir = fileURLToPath(new URL('../bin/', import.meta.url));
const tag = process.env.YTDLP_VERSION ?? 'latest';
const base =
  tag === 'latest'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
    : `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}`;

async function get(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

const binName = process.platform === 'linux' ? 'yt-dlp_linux' : 'yt-dlp';
const [binary, sums] = await Promise.all([get(`${base}/${binName}`), get(`${base}/SHA2-256SUMS`)]);
const expected = sums
  .toString('utf8')
  .split('\n')
  .map((line) => line.trim().split(/\s+/))
  .find(([, name]) => name === binName)?.[0];
const actual = createHash('sha256').update(binary).digest('hex');
if (!expected || expected !== actual) {
  throw new Error(`Checksum mismatch for yt-dlp (expected ${expected ?? 'none'}, got ${actual}). Not installed.`);
}
mkdirSync(binDir, { recursive: true });
writeFileSync(`${binDir}yt-dlp`, binary);
chmodSync(`${binDir}yt-dlp`, 0o755);
console.log(`Installed yt-dlp (${tag}, sha256 ${actual.slice(0, 12)}…) to server/bin/yt-dlp`);
