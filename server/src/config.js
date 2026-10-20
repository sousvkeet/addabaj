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

const turnUrls = (process.env.TURN_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  port: Number(process.env.PORT ?? 4080),
  isProd: process.env.NODE_ENV === 'production',
  // Cloudflare Realtime TURN: preferred when set. See services/ice.js.
  cloudflareTurn:
    process.env.CF_TURN_KEY_ID && process.env.CF_TURN_KEY_API_TOKEN
      ? { keyId: process.env.CF_TURN_KEY_ID, apiToken: process.env.CF_TURN_KEY_API_TOKEN }
      : null,
  // Send all media through TURN (hides users' IP addresses from each other; also handy for testing TURN).
  forceTurnRelay: process.env.FORCE_TURN_RELAY === 'true',
  // Used when Cloudflare TURN isn't configured or can't be reached.
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
    ...(turnUrls.length
      ? [{ urls: turnUrls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }]
      : []),
  ],
};

/** Watch together: fetching videos from web pages. */
export const streaming = {
  // The server refuses to fetch from private/local addresses (your machine, LAN,
  // cloud metadata) unless this is true, e.g. to stream from a NAS at home.
  allowPrivate: process.env.STREAM_ALLOW_PRIVATE === 'true',
  // Open pages in a hidden browser when nothing else finds a video.
  deepScan: process.env.DEEP_SCAN !== 'false',
  // Relayed video files are fetched once into this folder and shared by all
  // viewers. Disk use is capped; 0 turns the shared download off.
  cacheDir: process.env.STREAM_CACHE_DIR || resolve(rootDir, 'server/cache'),
  cacheMaxBytes: Math.max(0, Number(process.env.STREAM_CACHE_GB ?? 10)) * 1024 ** 3,
};

export const limits = {
  minRoomMembers: 2,
  maxRoomMembers: 50,
  voiceSeats: 12,
  messageLength: 4000,
};
