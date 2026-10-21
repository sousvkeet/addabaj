// Downloads yt-dlp (the official single-file release) into server/bin/,
// verifying it against the release's published SHA-256 checksums. Used by
// `npm run setup:yt-dlp`, and by the server itself when yt-dlp is missing.
import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const binDir = fileURLToPath(new URL('../../bin/', import.meta.url));

async function get(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Installs yt-dlp (`tag`: a release like "2026.08.19", or "latest"); returns where and which. */
export async function installYtdlp(tag = process.env.YTDLP_VERSION || 'latest') {
  const base =
    tag === 'latest'
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
      : `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}`;
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
  await mkdir(binDir, { recursive: true });
  // Written next to it, then swapped in, so a running search never sees half a file.
  await writeFile(`${binDir}yt-dlp.tmp`, binary);
  await chmod(`${binDir}yt-dlp.tmp`, 0o755);
  await rename(`${binDir}yt-dlp.tmp`, `${binDir}yt-dlp`);
  return { path: `${binDir}yt-dlp`, tag, sha256: actual };
}
