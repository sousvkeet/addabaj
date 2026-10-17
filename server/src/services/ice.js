// ICE servers for WebRTC. With Cloudflare Realtime TURN configured, the server
// mints short-lived TURN credentials from the TURN key and caches them, so the
// long-lived key never reaches browsers.
import { config } from '../config.js';

const CF_TTL_SECONDS = 24 * 60 * 60;
// Hand out credentials with at least this much life left, so a call that
// starts now isn't cut off when its TURN allocation needs refreshing.
const MIN_REMAINING_MS = 12 * 60 * 60 * 1000;

let cached = null; // { iceServers, expiresAt }
let inflight = null;

async function fetchCloudflare() {
  const { keyId, apiToken } = config.cloudflareTurn;
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: CF_TTL_SECONDS }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Cloudflare TURN answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { iceServers } = await res.json();
  // Cloudflare advises dropping port 53 URLs: browsers block or time out on them.
  return iceServers
    .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length > 0);
}

export async function getIceServers() {
  if (!config.cloudflareTurn) return config.iceServers;
  const now = Date.now();
  if (cached && cached.expiresAt - now > MIN_REMAINING_MS) return cached.iceServers;
  inflight ??= fetchCloudflare()
    .then((iceServers) => {
      cached = { iceServers, expiresAt: Date.now() + CF_TTL_SECONDS * 1000 };
      return iceServers;
    })
    .finally(() => {
      inflight = null;
    });
  try {
    return await inflight;
  } catch (err) {
    console.error(`Couldn't get Cloudflare TURN credentials: ${err.message}`);
    // Older credentials still work until they expire; otherwise fall back to STUN only.
    return cached && cached.expiresAt > now ? cached.iceServers : config.iceServers;
  }
}

export const iceTransportPolicy = () => (config.forceTurnRelay ? 'relay' : 'all');
