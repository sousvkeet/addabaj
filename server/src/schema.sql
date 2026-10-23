CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  password_hash text NOT NULL,
  avatar_hue    smallint NOT NULL DEFAULT 160,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS dm_messages (
  id           bigserial PRIMARY KEY,
  sender_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'call')),
  body         text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  meta         jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz,
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS dm_pair_idx
  ON dm_messages (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), id DESC);
CREATE INDEX IF NOT EXISTS dm_unread_idx
  ON dm_messages (recipient_id, sender_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 280),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_members int NOT NULL CHECK (max_members BETWEEN 2 AND 50),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id      uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  last_read_id bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members (user_id);

CREATE TABLE IF NOT EXISTS room_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  invitee_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inviter_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS room_invites_pending_key
  ON room_invites (room_id, invitee_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS room_invites_invitee_idx ON room_invites (invitee_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS room_messages (
  id         bigserial PRIMARY KEY,
  room_id    uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  kind       text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system')),
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_messages_room_idx ON room_messages (room_id, id DESC);

-- Watch together: what the room is watching and where playback is (null when nothing plays).
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS watch jsonb;

-- Photos, files and voice messages; replies; reactions.
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS reply_to_id bigint REFERENCES dm_messages(id) ON DELETE SET NULL;
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS reply_to_id bigint REFERENCES room_messages(id) ON DELETE SET NULL;
-- A message can be just a photo or file now, so its text may be empty.
ALTER TABLE dm_messages DROP CONSTRAINT IF EXISTS dm_messages_body_check;
ALTER TABLE room_messages DROP CONSTRAINT IF EXISTS room_messages_body_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dm_messages_body_len') THEN
    ALTER TABLE dm_messages ADD CONSTRAINT dm_messages_body_len CHECK (char_length(body) <= 4000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_messages_body_len') THEN
    ALTER TABLE room_messages ADD CONSTRAINT room_messages_body_len CHECK (char_length(body) <= 4000);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('image', 'video', 'voice', 'file')),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  mime            text NOT NULL,
  size            bigint NOT NULL,
  width           int,
  height          int,
  duration        real,
  waveform        jsonb,
  stored          text NOT NULL,          -- file name on disk (random)
  dm_message_id   bigint REFERENCES dm_messages(id) ON DELETE CASCADE,
  room_message_id bigint REFERENCES room_messages(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_dm_idx ON attachments (dm_message_id) WHERE dm_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attachments_room_idx ON attachments (room_message_id) WHERE room_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attachments_unsent_idx ON attachments (created_at) WHERE dm_message_id IS NULL AND room_message_id IS NULL;

CREATE TABLE IF NOT EXISTS dm_reactions (
  message_id bigint NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS room_reactions (
  message_id bigint NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- Host admin: a site-wide role (separate from room admins), switching accounts
-- off, and site settings such as whether new people may sign up.
ALTER TABLE users ADD COLUMN IF NOT EXISTS site_role text NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
-- Logins issued before this moment no longer count (set when a password changes).
ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_after timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_site_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_site_role_check CHECK (site_role IN ('user', 'admin'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS site_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Delivery and read receipts, and privacy. A chat message is delivered once the
-- recipient's app has it; a room member's delivered / read points move forward
-- as their app receives and shows messages.
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
UPDATE dm_messages SET delivered_at = read_at WHERE delivered_at IS NULL AND read_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS dm_undelivered_idx ON dm_messages (recipient_id) WHERE delivered_at IS NULL;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS last_delivered_id bigint NOT NULL DEFAULT 0;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS last_read_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_presence boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS read_receipts boolean NOT NULL DEFAULT true;

-- Phones that get push notifications: Firebase Cloud Messaging tokens from the
-- Android app. A token moves to whoever signs in on that phone.
CREATE TABLE IF NOT EXISTS push_devices (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   text NOT NULL DEFAULT 'android',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_devices_user_idx ON push_devices (user_id);

-- User IDs: a unique, shareable name (like "ana.rahman4821") for finding
-- someone. There's no list of everyone: you find people by their exact user
-- ID or email. Every account gets one automatically; people can change theirs.
ALTER TABLE users ADD COLUMN IF NOT EXISTS handle text;
CREATE OR REPLACE FUNCTION adda_new_handle(display_name text) RETURNS text AS $$
DECLARE
  base text;
  candidate text;
BEGIN
  base := left(trim(both '._' from lower(regexp_replace(coalesce(display_name, ''), '[^A-Za-z0-9]+', '.', 'g'))), 16);
  base := trim(both '._' from base);
  IF length(base) < 2 THEN base := 'user'; END IF;
  LOOP
    candidate := base || (1000 + floor(random() * 9000))::int;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE lower(handle) = candidate);
  END LOOP;
  RETURN candidate;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION adda_default_handle() RETURNS trigger AS $$
BEGIN
  IF NEW.handle IS NULL THEN NEW.handle := adda_new_handle(NEW.name); END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER users_default_handle BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION adda_default_handle();
UPDATE users SET handle = adda_new_handle(name) WHERE handle IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_key ON users (lower(handle));

-- Who someone has chatted with (their contacts see their online status).
CREATE INDEX IF NOT EXISTS dm_sender_idx ON dm_messages (sender_id, recipient_id);
CREATE INDEX IF NOT EXISTS dm_recipient_idx ON dm_messages (recipient_id, sender_id);

-- Joining rooms with an invite code (made by the server), optionally with a
-- password (bcrypt hash; no password means anyone with the code can join).
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS join_code text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS join_password_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS rooms_join_code_key ON rooms (join_code);

-- Deleting messages. "For everyone" empties a message (text, file, reactions)
-- and leaves a "This message was deleted" marker in its place; in rooms,
-- deleted_by says when an admin did it. "For me" hides a message from one
-- person only.
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS dm_hidden (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id bigint NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, message_id)
);
CREATE TABLE IF NOT EXISTS room_hidden (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id bigint NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, message_id)
);

-- Android app updates the host uploads (Admin › App updates). The app checks
-- on every start; a mandatory release has to be installed before going on.
CREATE TABLE IF NOT EXISTS app_releases (
  version_code int PRIMARY KEY,
  version_name text NOT NULL,
  notes        text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
  mandatory    boolean NOT NULL DEFAULT false,
  size         bigint NOT NULL,
  sha256       text NOT NULL,
  cert_sha256  text,
  min_sdk      int,
  stored       text NOT NULL,
  uploaded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Profile photos: the version of the current photo (its file is
-- <user id>-<version>.jpg in server/data/photos), or null for initials.
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo text;

-- Signed-in devices (Settings › Devices): one session per login, named by the
-- login cookie. Logging a device out deletes its session, and with it that
-- phone's push registration.
CREATE TABLE IF NOT EXISTS sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  user_agent     text NOT NULL DEFAULT '',
  ip             text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES sessions(id) ON DELETE CASCADE;

-- Room photos: like profile photos (room-<room id>-<version>.jpg), set by the room's admins.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS photo text;

-- A send's name from the app (kept across retries): a message whose answer was
-- lost and is sent again is saved once.
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS client_id text;
CREATE UNIQUE INDEX IF NOT EXISTS dm_messages_client_idx ON dm_messages (sender_id, client_id) WHERE client_id IS NOT NULL;
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS client_id text;
CREATE UNIQUE INDEX IF NOT EXISTS room_messages_client_idx ON room_messages (sender_id, client_id) WHERE client_id IS NOT NULL;

-- Watch together's Up next: videos an admin queued to play after the current
-- one; the server moves on by itself when a video ends (see socket/queue.js).
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS watch_queue jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Watch together: an admin turned the video's sound off for everyone in the
-- room ({ by, byName }), until an admin turns it back on or the video stops.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS watch_muted jsonb;

-- Email codes (see services/codes.js). A sign-up waiting for the code sent to
-- its address: the account is only made once the code comes back, from the
-- same browser or app (it holds the token). Gone after a day.
CREATE TABLE IF NOT EXISTS pending_signups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  code_hash     text NOT NULL,
  expires_at    timestamptz NOT NULL,
  attempts      int NOT NULL DEFAULT 0,
  sends         int NOT NULL DEFAULT 1,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_signups_email_idx ON pending_signups (lower(email), created_at);

-- A forgotten password: the code sent to the account's email ('' once used,
-- or after too many wrong tries), and how many were sent today.
CREATE TABLE IF NOT EXISTS password_resets (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  sends        int NOT NULL DEFAULT 1,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  window_start timestamptz NOT NULL DEFAULT now()
);

-- Mentions in room messages: [{ id, offset, length }] for the members named in
-- the text ("@Rahul Das"). They're notified even in a room they've muted.
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS mentions jsonb;
-- A member muted the room's notifications until then (year 9999: until they
-- turn them back on). Mentions and replies to them still come through.
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS muted_until timestamptz;

-- ── Safety: blocking, and reports to the host admin ─────────────────────
-- Blocked: the two can't message or call each other, the blocked person can't
-- add the blocker to rooms, and neither sees the other's online status.
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_blocked_idx ON blocks (blocked_id);

-- A report about a person, or one of their messages: with a copy of the
-- message and what came just before, as the reporter saw it.
CREATE TABLE IF NOT EXISTS reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  scope       text NOT NULL CHECK (scope IN ('user', 'dm', 'room')),
  room_id     uuid REFERENCES rooms(id) ON DELETE SET NULL,
  message_id  bigint,
  reason      text NOT NULL,
  details     text,
  snapshot    jsonb,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  action      text,
  handled_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  handled_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_target_idx ON reports (target_id);

-- ── My chats: muted, pinned, archived ──────────────────────────────────
-- For a chat with someone (rooms keep theirs on room_members).
CREATE TABLE IF NOT EXISTS dm_settings (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_until timestamptz,
  pinned_at   timestamptz,
  archived_at timestamptz,
  PRIMARY KEY (user_id, peer_id)
);
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- ── Messages: edited, forwarded, link previews ─────────────────────────
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS forwarded boolean NOT NULL DEFAULT false;
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS forwarded boolean NOT NULL DEFAULT false;
-- The first link's preview: { url, title, description, site, image }.
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS preview jsonb;
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS preview jsonb;

-- What an edited message said before (the host admin sees it with reports).
CREATE TABLE IF NOT EXISTS message_edits (
  id         bigserial PRIMARY KEY,
  scope      text NOT NULL CHECK (scope IN ('dm', 'room')),
  message_id bigint NOT NULL,
  body       text NOT NULL,
  edited_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_edits_idx ON message_edits (scope, message_id);

-- Link previews, fetched once per address (kept a day), and their pictures,
-- served from here so nobody's browser loads the other site.
CREATE TABLE IF NOT EXISTS link_previews (
  url        text PRIMARY KEY,
  data       jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS preview_images (
  id           text PRIMARY KEY,
  content_type text NOT NULL,
  bytes        bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A room's chat history, cleared by its admins: on a schedule (messages older
-- than "30 days", "12 hours", "1 month"... go by themselves) and all at once.
-- history_cleared_at: the last time it was cleared at once, so apps drop what
-- they kept from before (also when they were offline then).
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS clear_after text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS history_cleared_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_clear_after_check') THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_clear_after_check
      CHECK (clear_after IS NULL OR clear_after ~ '^[1-9][0-9]{0,3} (minute|hour|day|month)s?$');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS room_messages_room_time_idx ON room_messages (room_id, created_at);

-- Room voice, kept in order by its admins: someone muted by an admin can't
-- unmute, and someone whose camera an admin stopped can't turn it back on,
-- until an admin lets them (also after leaving voice and coming back).
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS voice_muted boolean NOT NULL DEFAULT false;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS camera_blocked boolean NOT NULL DEFAULT false;

-- A chat with someone, cleared (Clear chat history): when, for whoever it was
-- cleared for (me only, or both of us). The chat stays in their list, empty,
-- until the next message.
ALTER TABLE dm_settings ADD COLUMN IF NOT EXISTS cleared_at timestamptz;
