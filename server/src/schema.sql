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
