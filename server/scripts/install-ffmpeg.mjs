// Downloads a static FFmpeg build (BtbN/FFmpeg-Builds, GPL) into server/bin/,
// verified against the release's published SHA-256 checksums. FFmpeg joins
// separate picture and sound files into one video, like download managers do.
// Usage: npm run setup:ffmpeg   (Linux x64/arm64; elsewhere install ffmpeg and set FFMPEG_PATH)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const binDir = fileURLToPath(new URL('../bin/', import.meta.url));
const arch = { x64: 'linux64', arm64: 'linuxarm64' }[process.arch];
if (process.platform !== 'linux' || !arch) {
  console.error('This installer supports Linux x64 and arm64. Install FFmpeg yourself and set FFMPEG_PATH in server/.env.');
  process.exit(1);
}
const base = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
const name = `ffmpeg-master-latest-${arch}-gpl.tar.xz`;

async function get(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

console.log(`Downloading ${name} (about 160 MB)…`);
const [archive, sums] = await Promise.all([get(`${base}/${name}`), get(`${base}/checksums.sha256`)]);
const expected = sums
  .toString('utf8')
  .split('\n')
  .map((line) => line.trim().split(/\s+/))
  .find(([, file]) => file === name)?.[0];
const actual = createHash('sha256').update(archive).digest('hex');
if (!expected || expected !== actual) {
  throw new Error(`Checksum mismatch for ${name} (expected ${expected ?? 'none'}, got ${actual}). Not installed.`);
}

const work = mkdtempSync(join(tmpdir(), 'ffmpeg-'));
try {
  writeFileSync(join(work, name), archive);
  // Only the ffmpeg program is needed (not ffprobe/ffplay or the docs).
  execFileSync('tar', ['-xJf', join(work, name), '-C', work, '--wildcards', '*/bin/ffmpeg']);
  const extracted = execFileSync('find', [work, '-path', '*/bin/ffmpeg', '-type', 'f']).toString().trim().split('\n')[0];
  mkdirSync(binDir, { recursive: true });
  copyFileSync(extracted, join(binDir, 'ffmpeg')); // copy: /tmp may be another disk
  chmodSync(join(binDir, 'ffmpeg'), 0o755);
} finally {
  rmSync(work, { recursive: true, force: true });
}
const version = execFileSync(join(binDir, 'ffmpeg'), ['-hide_banner', '-version']).toString().split('\n')[0];
console.log(`Installed ${version} (sha256 ${actual.slice(0, 12)}…) to server/bin/ffmpeg`);
