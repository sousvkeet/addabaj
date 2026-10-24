// Room voice and video through LiveKit (a media server), when it's set up
// (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET): each person sends their
// microphone and camera once, to LiveKit, which passes them on to everyone in
// the call, at the size each one shows them. Without it, every phone sends to
// every other phone (a mesh), which gets heavy beyond three or four people.
// This server still keeps the seats (socket/voice.js: who's in voice, muted,
// on camera, moderated, reconnecting); LiveKit only carries sound and
// pictures. A token lets one person into one room's call, sending only what
// the room's admins allow; admins' decisions reach LiveKit at once too.
import { createHmac } from 'node:crypto';
import { config } from '../config.js';

const lk = config.livekit;
const httpUrl = lk?.url.replace(/^ws/, 'http').replace(/\/$/, '');

export const livekitEnabled = () => !!lk;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A LiveKit access token (a JWT signed with the API secret). */
function sign(claims, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ iss: lk.apiKey, nbf: now - 10, exp: now + ttlSeconds, ...claims });
  return `${head}.${body}.${createHmac('sha256', lk.apiSecret).update(`${head}.${body}`).digest('base64url')}`;
}

/** The LiveKit room that carries a room's voice. */
const callRoom = (roomId) => `room-${roomId}`;

/** What someone may send: their microphone unless an admin muted them, their camera unless an admin stopped it. */
const allowed = ({ voiceMuted, cameraBlocked }) => [...(voiceMuted ? [] : ['microphone']), ...(cameraBlocked ? [] : ['camera'])];

/** Into a room's call: { url, token } for one person (LiveKit renews the token while they're in). */
export function callTicket({ roomId, userId, name, moderation }) {
  const token = sign(
    {
      sub: userId,
      name,
      video: { room: callRoom(roomId), roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: false, canPublishSources: allowed(moderation) },
    },
    6 * 3600,
  );
  return { url: lk.url, token };
}

/** LiveKit's room API (Twirp). Someone already gone counts as done. */
async function roomApi(method, roomId, body) {
  const token = sign({ video: { room: callRoom(roomId), roomAdmin: true } }, 60);
  const res = await fetch(`${httpUrl}/twirp/livekit.RoomService/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ room: callRoom(roomId), ...body }),
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LiveKit ${method}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const failed = (what) => (err) => console.error(`LiveKit: ${what} failed:`, err.message);

/**
 * An admin muted someone or stopped their camera (or let them again): from
 * now on they can't send it, and what they're sending stops now.
 */
export function moderateInCall(roomId, userId, moderation) {
  if (!lk) return;
  void (async () => {
    await roomApi('UpdateParticipant', roomId, {
      identity: userId,
      permission: { canSubscribe: true, canPublish: true, canPublishData: false, canPublishSources: allowed(moderation).map((s) => s.toUpperCase()) },
    });
    const who = await roomApi('GetParticipant', roomId, { identity: userId });
    const stop = new Set([...(moderation.voiceMuted ? ['MICROPHONE'] : []), ...(moderation.cameraBlocked ? ['CAMERA'] : [])]);
    for (const t of who?.tracks ?? []) {
      if (stop.has(t.source) && !t.muted) await roomApi('MutePublishedTrack', roomId, { identity: userId, trackSid: t.sid, muted: true });
    }
  })().catch(failed('moderating'));
}

/** Removals on their way to LiveKit, by room and person. */
const removing = new Map();

/** Out of a room's call: left, removed from the room, the room deleted, or gone too long. */
export function removeFromCall(roomId, userId) {
  if (!lk) return;
  const key = `${roomId}:${userId}`;
  const done = roomApi('RemoveParticipant', roomId, { identity: userId })
    .catch(failed('removing someone'))
    .finally(() => {
      if (removing.get(key) === done) removing.delete(key);
    });
  removing.set(key, done);
}

/**
 * Before someone gets a ticket into a call they just left: their removal
 * reaches LiveKit first. (LiveKit goes by who it is, so a removal arriving
 * after they're back in would take out their new connection.)
 */
export async function removalsDone(roomId, userId) {
  await removing.get(`${roomId}:${userId}`);
}
