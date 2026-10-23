export type User = {
  id: string;
  /** Only on your own account and the host admin's pages: nobody else sees someone's email. */
  email?: string;
  /** Their user ID: what people type to find them ("ana.rahman4821"). */
  handle?: string | null;
  name: string;
  hue: number;
  /** Their profile photo's address, or null for initials. */
  photo?: string | null;
  lastSeenAt: string | null;
  online?: boolean;
  /** Only on your own account: */
  siteAdmin?: boolean;
  /** Still using the default password the host admin account came with. */
  mustChangePassword?: boolean;
  /** On a public server that default must be changed before anything else. */
  passwordChangeRequired?: boolean;
  /** Online status and last seen aren't shared (by them, or by you, which works both ways). */
  presenceHidden?: boolean;
  /** I blocked them: they can't message or call me (whether they blocked me isn't said). */
  blocked?: boolean;
  /** Only on your own account: your privacy choices. */
  privacy?: { sharePresence: boolean; readReceipts: boolean };
};

export type Announcement = { id: string; text: string; at: string };

/** How messages work on this site, as the host admin set it (host admins aren't limited). */
export type Messaging = {
  linkPreviews: boolean;
  editing: boolean;
  /** Messages can be edited this long after sending. */
  editMinutes: number;
  forwarding: boolean;
  /** Most chats one message can be forwarded to at once. */
  forwardTo: number;
};

/** The card a message's first link gets: the page's title, picture (kept on this server) and so on. */
export type LinkPreview = { url: string; title: string; description: string; site: string; image: string | null };

/** A photo, video, voice message or file sent with a message. */
export type Attachment = {
  id: string;
  kind: 'image' | 'video' | 'voice' | 'file';
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  waveform: number[] | null;
  url: string;
};

/** The message being replied to, as quoted inside the reply. */
export type ReplyRef = {
  id: number;
  senderId?: string;
  senderName: string;
  body: string;
  attachment: { kind: Attachment['kind']; name: string; duration?: number | null } | null;
  deleted?: boolean;
};

export type Reaction = { emoji: string; users: string[] };

/** A file ready to upload (photos already shrunk), with a local preview. */
export type PreparedFile = {
  blob: Blob;
  meta: { kind: Attachment['kind']; name: string; mime: string; width?: number; height?: number; duration?: number; waveform?: number[] };
  previewUrl: string | null;
  /** Set once uploaded, so a retry doesn't upload again. */
  uploaded?: Attachment;
};

/** What the composer sends: text, optionally a file and/or the message replied to. */
/** A person named in a room message ("@Rahul Das"): where in its text. */
export type Mention = { id: string; offset: number; length: number };

export type Draft = {
  body: string;
  file?: PreparedFile;
  replyTo?: ReplyRef | null;
  /** In rooms: the people it names. */
  mentions?: Mention[];
  /** Names this send, kept across retries, so the server saves it once even if its answer was lost. */
  clientId?: string;
};

/** Fields every chat and room message carries besides its text. */
type MessageExtras = {
  attachment?: Attachment | null;
  replyTo?: ReplyRef | null;
  replyToId?: number | null;
  reactions?: Reaction[];
  /** Client-only while sending a file: upload progress (0–100). */
  upload?: number;
  /** Client-only: what to send again on retry. */
  draft?: Draft;
  /** The sender's name for this send (see Draft); only on the sender's own messages. */
  clientId?: string | null;
  /** Changed after sending (shown "edited"). */
  editedAt?: string | null;
  /** A copy of a message from another chat. */
  forwarded?: boolean;
  /** Its first link's card, once the server has fetched it. */
  preview?: LinkPreview | null;
};

export type DmMessage = MessageExtras & {
  id: number;
  senderId: string;
  recipientId: string;
  kind: 'text' | 'call';
  body: string;
  meta: { outcome?: 'completed' | 'missed' | 'declined'; duration?: number; video?: boolean } | null;
  createdAt: string;
  /** When the other person's app got it (null: not yet). */
  deliveredAt: string | null;
  readAt: string | null;
  /** Deleted for everyone: only a "This message was deleted" marker remains. */
  deletedAt?: string | null;
  /** Client-only: optimistic send state. */
  pending?: 'sending' | 'failed';
  tempId?: string;
};

/** My own settings for a chat or room (only I see them). */
export type ChatSettings = {
  /** Notifications off until then (year 9999: until I turn them back on). */
  mutedUntil?: string | null;
  /** Pinned to the top of my list. */
  pinnedAt?: string | null;
  /** Out of my list, under Archived. */
  archivedAt?: string | null;
};

export type Conversation = ChatSettings & {
  partner: User;
  lastMessage: DmMessage | null;
  unread: number;
  /** Its history was cleared then: it stays in the list, empty, until the next message. */
  clearedAt?: string | null;
};

export type RoomMessage = MessageExtras & {
  id: number;
  roomId: string;
  kind: 'text' | 'system';
  body: string;
  createdAt: string;
  sender: { id: string; name: string; hue: number; photo?: string | null } | null;
  /** The people it names ("@Rahul Das"), who are notified even in a room they muted. */
  mentions?: Mention[] | null;
  /** Deleted for everyone (by its sender, or by a room admin). */
  deletedAt?: string | null;
  deletedByAdmin?: boolean;
  pending?: 'sending' | 'failed';
  tempId?: string;
};

export type Role = 'admin' | 'member';

/** A live stream from an admin's device: a video file playing there, or their screen. */
export type DeviceStream = {
  sessionId: string;
  hostId: string;
  hostName: string;
  mode: 'file' | 'screen';
  /** Length of the file being streamed (null for screens). */
  duration: number | null;
  audio: boolean;
};

export type WatchSource = {
  kind: 'youtube' | 'file' | 'hls' | 'device';
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
  /** Up next's video is being found again (its link had expired); it plays when found. */
  finding?: boolean;
  /** Why the video couldn't be prepared. */
  error?: string;
  /** Set when kind is 'device'. */
  device?: DeviceStream;
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

export type FindResult = {
  scanId: string;
  videos: FoundVideo[];
  notes: string[];
  /** The link is a playlist: all its videos (up to `count` of its `total`) can go into Up next. */
  playlist?: { title: string; count: number; total: number } | null;
};

/** A video waiting in the room's Up next. */
export type QueueItem = {
  id: string;
  title: string;
  site: string | null;
  thumbnail: string | null;
  duration: number | null;
  kind: string;
  addedBy: { id: string; name: string };
  addedAt: number;
};

/** Shared playback: at server time `at`, the video was at `position` seconds. */
export type WatchState = {
  /** This video's turn (a new one each time a video starts). */
  id?: string;
  source: WatchSource;
  playing: boolean;
  position: number;
  at: number;
  by: string;
  byName: string;
  /** How long it is (seconds), once known: Up next moves on at its end. */
  duration?: number | null;
  /** An admin turned the sound off for everyone, until an admin turns it back on. */
  muted?: { by: string; byName: string } | null;
};

export type RoomSummary = ChatSettings & {
  id: string;
  name: string;
  description: string;
  /** The room's photo (its admins choose it), or null for its letter. */
  photo?: string | null;
  ownerId: string;
  maxMembers: number;
  memberCount: number;
  myRole: Role;
  unread: number;
  /** Unread messages that mention me or reply to me. */
  unreadMentions?: number;
  createdAt: string;
  lastMessage: RoomMessage | null;
  /** Title of the video the room is watching together, if any. */
  watching?: string | null;
  /** Joining with the invite code needs a password. */
  hasPassword?: boolean;
  /** The invite code (admins only). */
  joinCode?: string;
  /** Its admins clear its chat history after this (messages older go by themselves); null: kept. */
  clearAfter?: ClearAfter | null;
  /** When an admin last cleared its chat history at once: nothing from before shows. */
  clearedAt?: string | null;
};

export type ClearAfterUnit = 'minute' | 'hour' | 'day' | 'month';
export type ClearAfter = { amount: number; unit: ClearAfterUnit };

/** What an invite code opens, before joining. */
export type RoomPreview = {
  id: string;
  name: string;
  description: string;
  photo?: string | null;
  memberCount: number;
  maxMembers: number;
  needsPassword: boolean;
  member: boolean;
};

export type RoomMember = User & {
  role: Role;
  joinedAt: string;
  /** The newest message this member has seen, and the newest their app has received. */
  lastReadId: number;
  lastDeliveredId: number;
  /** An admin muted them in the room's voice: they can't unmute until an admin lets them. */
  voiceMuted?: boolean;
  /** An admin stopped their camera: they can't turn it on until an admin lets them. */
  cameraBlocked?: boolean;
};

/** Where a message of mine has got to. */
export type Receipt = 'sent' | 'delivered' | 'read';

export type RoomInviteAdminView = {
  id: string;
  createdAt: string;
  invitedBy: string;
  invitee: User;
};

export type VoiceParticipant = {
  userId: string;
  muted: boolean;
  /** Their camera is on (room video). */
  camera?: boolean;
  /** Their connection dropped (a network change): their seat waits for them. */
  away?: boolean;
  /** Muted by an admin: everyone's app keeps them quiet. */
  silenced?: boolean;
  /** Their camera was stopped by an admin. */
  cameraBlocked?: boolean;
};

export type RoomDetail = RoomSummary & {
  members: RoomMember[];
  invites: RoomInviteAdminView[];
  voice: VoiceParticipant[];
  watch: WatchState | null;
  /** Watch together's Up next. */
  queue?: QueueItem[];
};

export type Invite = {
  id: string;
  createdAt: string;
  room: { id: string; name: string; description: string; photo?: string | null; memberCount: number; maxMembers: number };
  inviter: User;
};

export type PickerUser = User & { roomStatus?: 'member' | 'invited' | null };

/** `stale`: kept on the phone from last time (lib/localCache.ts), until the server's copy arrives. */
export type Paged<T> = {
  items: T[];
  loaded: boolean;
  hasMore: boolean;
  loadingMore?: boolean;
  /** A copy kept from last time, or loaded before this device was away: replaced by the server's when next opened. */
  stale?: boolean;
  /** The open chat, after this device was away: its newest page is checked against the server's (see land()). */
  recheck?: boolean;
};
