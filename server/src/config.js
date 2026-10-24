import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const rootDir = resolve(here, '../..');

// server/.env; variables already set in the real environment win.
const envFile = resolve(here, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (copy server/.env.example to server/.env)`);
  return value;
}

/** Anyone who knows the secret can sign in as anyone, so a guessable one isn't allowed in production. */
function jwtSecret() {
  const secret = required('JWT_SECRET');
  const weak = secret.length < 32 || /change-me|secret|password|example/i.test(secret);
  if (weak && process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is too easy to guess. Set it to a long random string, e.g. the output of: openssl rand -hex 32');
  }
  if (weak) console.warn('Warning: JWT_SECRET is weak. Use a long random string (openssl rand -hex 32) before going live.');
  return secret;
}

const turnUrls = (process.env.TURN_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: jwtSecret(),
  port: Number(process.env.PORT ?? 4080),
  isProd: process.env.NODE_ENV === 'production',
  // Cloudflare Realtime TURN: preferred when set. See services/ice.js.
  cloudflareTurn:
    process.env.CF_TURN_KEY_ID && process.env.CF_TURN_KEY_API_TOKEN
      ? { keyId: process.env.CF_TURN_KEY_ID, apiToken: process.env.CF_TURN_KEY_API_TOKEN }
      : null,
  // Send all media through TURN (hides users' IP addresses from each other; also handy for testing TURN).
  forceTurnRelay: process.env.FORCE_TURN_RELAY === 'true',
  // Room voice and video through LiveKit (services/livekit.js); without it, a mesh.
  livekit:
    process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
      ? { url: process.env.LIVEKIT_URL, apiKey: process.env.LIVEKIT_API_KEY, apiSecret: process.env.LIVEKIT_API_SECRET }
      : null,
  // Used when Cloudflare TURN isn't configured or can't be reached.
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
    ...(turnUrls.length
      ? [{ urls: turnUrls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }]
      : []),
  ],
};

/**
 * The Android app. Its signing certificate fingerprints (not secret) let room
 * invite links open in the app, and app updates must be signed with them.
 * Default: the key in android/keystore.
 */
export const android = {
  package: 'com.addakhana.app',
  certs: (process.env.ANDROID_CERT_SHA256 || 'F0:BA:1C:4C:BF:4B:25:EC:08:73:B1:71:6C:C6:59:B1:94:B4:F5:20:23:80:DE:FE:BD:EE:83:E4:08:F3:2C:24')
    .split(',')
    .map((c) => c.replace(/[^0-9a-f]/gi, '').toUpperCase())
    .filter((c) => c.length === 64)
    .map((c) => c.match(/../g).join(':')),
};

/** Watch together: fetching videos from web pages. */
export const streaming = {
  // The server refuses to fetch from private/local addresses (your machine, LAN,
  // cloud metadata) unless this is true, e.g. to stream from a NAS at home.
  allowPrivate: process.env.STREAM_ALLOW_PRIVATE === 'true',
  // Open pages in a hidden browser when nothing else finds a video.
  deepScan: process.env.DEEP_SCAN !== 'false',
  // Block ads and trackers while finding videos, with the filter lists Brave uses (see stream/adblock.js).
  adBlock: process.env.AD_BLOCK !== 'false',
  // Install yt-dlp by itself when it's missing (a fresh deploy doesn't include server/bin/).
  autoInstallYtdlp: process.env.YTDLP_AUTO_INSTALL !== 'false',
  // Relayed video files are fetched once into this folder and shared by all
  // viewers. Disk use is capped; 0 turns the shared download off.
  cacheDir: process.env.STREAM_CACHE_DIR || resolve(rootDir, 'server/cache'),
  cacheMaxBytes: Math.max(0, Number(process.env.STREAM_CACHE_GB ?? 10)) * 1024 ** 3,
  // Parallel connections per relayed file, like a download manager (1 = off).
  connections: Math.min(16, Math.max(1, Number(process.env.STREAM_CONNECTIONS ?? 4) || 4)),
};

export const limits = {
  minRoomMembers: 2,
  maxRoomMembers: 50,
  voiceSeats: 12,
  // A live stream from someone's device goes from their browser to each viewer
  // separately, so their upload speed and computer set how many can watch.
  liveViewers: Math.min(30, Math.max(1, Number(process.env.LIVE_MAX_VIEWERS ?? 10) || 10)),
  messageLength: 4000,
};
