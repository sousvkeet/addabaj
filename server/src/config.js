import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const rootDir = resolve(here, '../..');

const envFile = resolve(rootDir, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
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

export const limits = {
  minRoomMembers: 2,
  maxRoomMembers: 50,
  voiceSeats: 12,
  messageLength: 4000,
};
