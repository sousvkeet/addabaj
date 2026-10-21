// Push notifications to the Android app, through Firebase Cloud Messaging (FCM).
//
// A person's phones get a push when they aren't looking at Adda Khana anywhere
// (no app or tab on screen): a new chat or room message, an incoming call
// (which rings the phone even when the app is closed), the call ending, and
// "read elsewhere", so the phone clears notifications already seen.
//
// Pushes are data messages; the app decides how to show them. Turn them on by
// setting FCM_SERVICE_ACCOUNT to the Firebase project's service account key
// (the JSON itself, or a path to the file). See android/README.md.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import '../config.js'; // loads server/.env
import { query } from '../db.js';
import { getIO, userChannel } from '../realtime.js';
import { isDisabled } from './site.js';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const API = (process.env.FCM_API_URL || 'https://fcm.googleapis.com').replace(/\/+$/, '');
const MAX_DEVICES = 10;

function loadAccount() {
  const raw = (process.env.FCM_SERVICE_ACCOUNT ?? '').trim();
  if (!raw) return null;
  try {
    const json = JSON.parse(raw.startsWith('{') ? raw : readFileSync(raw, 'utf8'));
    if (!json.project_id || !json.client_email || !json.private_key) throw new Error('it needs project_id, client_email and private_key');
    return {
      projectId: json.project_id,
      email: json.client_email,
      key: json.private_key,
      tokenUri: json.token_uri || 'https://oauth2.googleapis.com/token',
    };
  } catch (err) {
    console.error(`FCM_SERVICE_ACCOUNT isn't a usable Firebase service account key (${err.message}). Push notifications are off.`);
    return null;
  }
}

const account = loadAccount();
export const pushEnabled = () => !!account;

// ── Google sign-in (an hour-long access token from the service account) ──

let token = null; // { value, expires }
let fetching = null;

async function accessToken() {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  fetching ??= (async () => {
    const now = Math.floor(Date.now() / 1000);
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: account.email, scope: SCOPE, aud: account.tokenUri, iat: now, exp: now + 3600 })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(account.key, 'base64url');
    const res = await fetch(account.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(`Google refused the FCM service account (${res.status} ${data.error ?? ''})`.trim());
    token = { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    return token.value;
  })().finally(() => {
    fetching = null;
  });
  return fetching;
}

/** Sends one data message to one phone: 'ok', or 'gone' when the app was uninstalled or signed out. */
async function send(deviceToken, data, ttl) {
  const res = await fetch(`${API}/v1/projects/${account.projectId}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token: deviceToken, data, android: { priority: 'high', ttl: `${ttl}s` } } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return 'ok';
  const body = await res.json().catch(() => ({}));
  const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? '';
  if (res.status === 404 || code === 'UNREGISTERED') return 'gone';
  if (res.status === 400 && /registration token/i.test(body.error?.message ?? '')) return 'gone';
  if (res.status === 401) token = null;
  throw new Error(`FCM answered ${res.status} ${code}`.trim());
}

/** Sends `data` to every phone of `userId`. Values become strings (FCM data is string-only). */
export async function pushToUser(userId, data, { ttl = 3600 } = {}) {
  if (!account || isDisabled(userId)) return 0;
  const { rows } = await query('SELECT token FROM push_devices WHERE user_id = $1', [userId]);
  if (!rows.length) return 0;
  const payload = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  let sent = 0;
  await Promise.all(
    rows.map(async ({ token: t }) => {
      try {
        if ((await send(t, payload, ttl)) === 'gone') await query('DELETE FROM push_devices WHERE token = $1', [t]);
        else sent++;
      } catch (err) {
        console.error('Push notification failed:', err.message);
      }
    }),
  );
  return sent;
}

// ── Phones ─────────────────────────────────────────────────────────────

/** `sessionId`: the login on that phone, so logging the phone out (Settings › Devices) stops its notifications. */
export async function registerDevice(userId, deviceToken, platform = 'android', sessionId = null) {
  await query(
    `INSERT INTO push_devices (token, user_id, platform, session_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, session_id = EXCLUDED.session_id, updated_at = now()`,
    [deviceToken, userId, platform, sessionId],
  );
  // Keep the newest few; old phones that never said goodbye drop off.
  await query(
    `DELETE FROM push_devices WHERE user_id = $1 AND token NOT IN (
       SELECT token FROM push_devices WHERE user_id = $1 ORDER BY updated_at DESC LIMIT ${MAX_DEVICES})`,
    [userId],
  );
}

export async function unregisterDevice(userId, deviceToken) {
  await query('DELETE FROM push_devices WHERE token = $1 AND user_id = $2', [deviceToken, userId]);
}

/** Signed out everywhere: no more notifications until each phone signs in again. */
export async function forgetDevices(userId) {
  await query('DELETE FROM push_devices WHERE user_id = $1', [userId]);
}

export async function hasDevices(userId) {
  if (!account) return false;
  return !!(await query('SELECT 1 FROM push_devices WHERE user_id = $1 LIMIT 1', [userId])).rowCount;
}

// ── Is the person looking? ─────────────────────────────────────────────

/**
 * True when one of the person's apps or tabs is on screen and in use (each
 * reports it with `client:state`). Connections that haven't said count as
 * looking, so nobody gets a phone buzz for a chat they're reading.
 */
export function isLooking(userId) {
  const io = getIO();
  for (const id of io?.sockets.adapter.rooms.get(userChannel(userId)) ?? []) {
    if (io.sockets.sockets.get(id)?.data.active !== false) return true;
  }
  return false;
}

// ── What gets pushed ──────────────────────────────────────────────────

const LABEL = { image: '📷 Photo', video: '🎥 Video', voice: '🎤 Voice message' };

/** One line for the notification: the text, or what was attached. */
export function preview(message) {
  const a = message.attachment;
  const text = (message.body ?? '').trim().replace(/\s+/g, ' ');
  let line = text;
  if (a) {
    const label = LABEL[a.kind] ?? `📎 ${a.name || 'File'}`;
    line = text ? `${label.split(' ')[0]} ${text}` : label;
  }
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

// Chats a phone was notified about since they were last read, so reading
// elsewhere can clear just those notifications.
const pushedChats = new Map(); // userId -> Set<"dm:<id>" | "room:<id>">

function remember(userId, key) {
  let set = pushedChats.get(userId);
  if (!set) pushedChats.set(userId, (set = new Set()));
  set.add(key);
}

const failed = (err) => console.error('Push notification failed:', err.message);

/** A new chat message: buzz the recipient's phones unless they're looking. */
export function pushDm(message, sender) {
  const to = message.recipientId;
  if (!account || isLooking(to)) return;
  remember(to, `dm:${sender.id}`);
  pushToUser(to, {
    type: 'message',
    scope: 'dm',
    chatId: sender.id,
    chatName: sender.name,
    chatHue: sender.hue,
    senderId: sender.id,
    senderName: sender.name,
    senderHue: sender.hue,
    ...(sender.photo ? { chatPhoto: sender.photo, senderPhoto: sender.photo } : {}),
    messageId: message.id,
    text: preview(message),
    sentAt: new Date(message.createdAt).getTime(),
  }).catch(failed);
}

/** A new room message: every other member who isn't looking. */
export async function pushRoomMessage(message) {
  if (!account || !message.sender) return;
  const { rows } = await query(
    `SELECT rm.user_id, r.name FROM room_members rm JOIN rooms r ON r.id = rm.room_id
     WHERE rm.room_id = $1 AND rm.user_id <> $2`,
    [message.roomId, message.sender.id],
  );
  for (const { user_id: userId, name } of rows) {
    if (isLooking(userId)) continue;
    remember(userId, `room:${message.roomId}`);
    pushToUser(userId, {
      type: 'message',
      scope: 'room',
      chatId: message.roomId,
      chatName: name,
      senderId: message.sender.id,
      senderName: message.sender.name,
      senderHue: message.sender.hue,
      ...(message.sender.photo ? { senderPhoto: message.sender.photo } : {}),
      messageId: message.id,
      text: preview(message),
      sentAt: new Date(message.createdAt).getTime(),
    }).catch(failed);
  }
}

/** Read on some device: other phones drop that chat's notification. */
export function pushChatRead(userId, scope, chatId) {
  const set = pushedChats.get(userId);
  if (!account || !set?.delete(`${scope}:${chatId}`)) return;
  if (!set.size) pushedChats.delete(userId);
  pushToUser(userId, { type: 'read', scope, chatId }).catch(failed);
}

/**
 * A message was deleted for everyone: phones still showing it in a
 * notification take it out (only those with a notification for that chat).
 */
export function pushDeleted(userIds, { scope, chatId, messageId }) {
  if (!account) return;
  for (const userId of userIds) {
    if (!pushedChats.get(userId)?.has(`${scope}:${chatId}`)) continue;
    pushToUser(userId, { type: 'deleted', scope, chatId, messageId }).catch(failed);
  }
}

/** Rings the callee's phones. Short-lived: a call nobody answered in time is no use later. */
export function pushCall(call, caller) {
  return pushToUser(
    call.calleeId,
    {
      type: 'call', callId: call.id, callerId: caller.id, callerName: caller.name, callerHue: caller.hue,
      ...(caller.photo ? { callerPhoto: caller.photo } : {}),
      video: call.video ? 1 : 0, sentAt: Date.now(),
    },
    { ttl: 40 },
  ).catch((err) => {
    failed(err);
    return 0;
  });
}

/** Stops the ringing; `reason` "missed" / "cancelled" leaves a missed-call notification. */
export function pushCallEnded(call, caller, reason) {
  pushToUser(call.calleeId, {
    type: 'call_end',
    callId: call.id,
    reason,
    callerId: caller.id,
    callerName: caller.name,
    callerHue: caller.hue,
    ...(caller.photo ? { callerPhoto: caller.photo } : {}),
    video: call.video ? 1 : 0,
    sentAt: Date.now(),
  }).catch(failed);
}
