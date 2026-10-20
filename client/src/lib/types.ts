export type User = {
  id: string;
  email: string;
  name: string;
  hue: number;
  lastSeenAt: string | null;
  online?: boolean;
};

export type DmMessage = {
  id: number;
  senderId: string;
  recipientId: string;
  kind: 'text' | 'call';
  body: string;
  meta: { outcome?: 'completed' | 'missed' | 'declined'; duration?: number; video?: boolean } | null;
  createdAt: string;
  readAt: string | null;
  /** Client-only: optimistic send state. */
  pending?: 'sending' | 'failed';
  tempId?: string;
};

export type Conversation = {
  partner: User;
  lastMessage: DmMessage | null;
  unread: number;
};

export type RoomMessage = {
  id: number;
  roomId: string;
  kind: 'text' | 'system';
  body: string;
  createdAt: string;
  sender: { id: string; name: string; hue: number } | null;
  pending?: 'sending' | 'failed';
  tempId?: string;
};

export type Role = 'admin' | 'member';

export type WatchSource = {
  kind: 'youtube' | 'file' | 'hls';
  url: string;
  videoId?: string;
  title: string;
  /** e.g. "720p MP4 file, from archive.org" */
  detail?: string;
  /** The server relay, used if the browser can't play `url` directly. */
  fallbackUrl?: string;
  /** Plays through the server relay. */
  relay?: boolean;
  /** The server is joining picture and sound; playback starts when ready. */
  preparing?: boolean;
  /** Why the video couldn't be prepared. */
  error?: string;
};

/** One way to play a found video (a quality, or YouTube's player). */
export type FoundOption = {
  id: string;
  kind: WatchSource['kind'] | 'merge';
  label: string;
  detail: string;
  size: string | null;
  recommended: boolean;
  relay: boolean;
};

export type FoundVideo = {
  id: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  live: boolean;
  site: string | null;
  options: FoundOption[];
};

export type FindResult = { scanId: string; videos: FoundVideo[]; notes: string[] };

/** Shared playback: at server time `at`, the video was at `position` seconds. */
export type WatchState = {
  source: WatchSource;
  playing: boolean;
  position: number;
  at: number;
  by: string;
  byName: string;
};

export type RoomSummary = {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  maxMembers: number;
  memberCount: number;
  myRole: Role;
  unread: number;
  createdAt: string;
  lastMessage: RoomMessage | null;
  /** Title of the video the room is watching together, if any. */
  watching?: string | null;
};

export type RoomMember = User & { role: Role; joinedAt: string };

export type RoomInviteAdminView = {
  id: string;
  createdAt: string;
  invitedBy: string;
  invitee: User;
};

export type VoiceParticipant = { userId: string; muted: boolean };

export type RoomDetail = RoomSummary & {
  members: RoomMember[];
  invites: RoomInviteAdminView[];
  voice: VoiceParticipant[];
  watch: WatchState | null;
};

export type Invite = {
  id: string;
  createdAt: string;
  room: { id: string; name: string; description: string; memberCount: number; maxMembers: number };
  inviter: User;
};

export type PickerUser = User & { roomStatus?: 'member' | 'invited' | null };

export type Paged<T> = { items: T[]; loaded: boolean; hasMore: boolean; loadingMore?: boolean };
