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
  meta: { outcome?: 'completed' | 'missed' | 'declined'; duration?: number } | null;
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
};

export type Invite = {
  id: string;
  createdAt: string;
  room: { id: string; name: string; description: string; memberCount: number; maxMembers: number };
  inviter: User;
};

export type PickerUser = User & { roomStatus?: 'member' | 'invited' | null };

export type Paged<T> = { items: T[]; loaded: boolean; hasMore: boolean; loadingMore?: boolean };
