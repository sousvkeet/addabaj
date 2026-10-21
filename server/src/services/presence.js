// Online status and last seen go only to someone's contacts (the people they
// have a chat with or share a room with), and only to those who share their
// own: there's no list of who's on Adda Khana.
import { getIO, presence, userChannel } from '../realtime.js';
import { hidesPresence } from './privacy.js';
import { contactIds } from './users.js';

/** Sends a presence event about `userId` to their online contacts who share theirs. */
export async function tellContacts(userId, payload) {
  const io = getIO();
  if (!io) return;
  const channels = [...(await contactIds(userId))].filter((id) => presence.isOnline(id) && !hidesPresence(id)).map(userChannel);
  if (channels.length) io.to(channels).emit('presence:update', payload);
}

/** Which of `userId`'s contacts are online, as they may see it (none if they hide their own). */
export async function onlineContacts(userId) {
  if (hidesPresence(userId)) return [];
  return [...(await contactIds(userId))].filter((id) => presence.isOnline(id) && !hidesPresence(id));
}

/** Two people just became contacts (a first message, a shared room): show each other's status. */
export function introduce(a, b) {
  const io = getIO();
  if (!io || a === b || hidesPresence(a) || hidesPresence(b)) return;
  io.to(userChannel(a)).emit('presence:update', { userId: b, online: presence.isOnline(b) });
  io.to(userChannel(b)).emit('presence:update', { userId: a, online: presence.isOnline(a) });
}
