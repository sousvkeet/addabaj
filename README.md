# Adda Khana

A real-time hangout app: one-to-one chat with voice and video calls, plus rooms with group chat and a shared voice table.

## Features

- **Accounts:** sign up and log in with email and password. You stay logged in for 30 days.
- **Presence:** see who's online and when they were last seen.
- **One-to-one chat:** instant delivery, typing indicator, read ticks, unread counts and message history.
- **One-to-one voice and video calls:**
  - Start either kind from a chat. The person you call sees a ring screen; a video call can be answered with video or voice only.
  - During any call you can mute, turn your camera on or off (so a voice call can become a video call), and see when the other person is speaking, muted or has their camera off.
  - Video shows the other person large with you in a corner. On desktop it's a floating window you can shrink back to the call bar; on phones it's full screen.
  - Missed, declined and finished calls are logged in the chat.
- **Microphone, speaker and camera choice:** from the account menu, during a call, or under room voice.
  - A live level bar shows which microphone hears you.
  - A test sound checks the speaker. Speaker choice works in Chrome, Edge and Firefox; Safari always uses the system output.
  - A preview checks the camera.
  - Choices apply immediately, even mid-call, are remembered per browser, and fall back to the system default if a device is unplugged.
- **Rooms:**
  - Whoever starts a room is its admin and chooses the maximum members (2–50).
  - Admins can **add** people straight in, or **invite** them so they can accept or decline. Admins can also cancel invites and remove members.
  - The room's creator can make other members admins and can delete the room.
  - The member limit is enforced on the server, including when two people join at the same moment. The limit can't be lowered below the current member count.
- **Room voice (the adda table):** members join a voice channel and sit around a table. Each person's avatar lights up while they speak, and mute shows for everyone. Up to 12 people can talk at once.
- **Layout and themes:** light and dark themes, and layouts that work on phones.

## Stack

| Part | Tech |
|---|---|
| Client | React 19, Vite 7, TypeScript, Tailwind CSS 4, Zustand, React Router 7 |
| Server | Node.js 22, Express 5, Socket.IO 4 |
| Database | PostgreSQL (`pg`); the schema is applied automatically on start |
| Calls | WebRTC peer-to-peer audio and video, with Socket.IO carrying the connection setup messages, and Cloudflare Realtime TURN as the relay |

## Setup

1. Create the two settings files from their examples:
   ```sh
   cp server/.env.example server/.env
   cp client/.env.example client/.env
   ```
   In `server/.env`, set `DATABASE_URL` and a long random `JWT_SECRET`.
2. Create the database:
   ```sh
   createdb adda_khana
   ```
3. Install dependencies:
   ```sh
   npm install
   ```
4. Run in development:
   ```sh
   npm run dev
   ```
   This starts the API on http://localhost:4080 and the app on http://localhost:5180. Open the app URL.

### Settings files

| File | Read by | Holds |
|---|---|---|
| `server/.env` | `server/src/config.js` | `DATABASE_URL`, `JWT_SECRET`, `PORT` (API), `NODE_ENV`, Cloudflare TURN keys, `FORCE_TURN_RELAY`, optional `TURN_*` |
| `client/.env` | `client/vite.config.ts` | `CLIENT_PORT` (dev server), `API_URL` (where the dev server forwards `/api` and `/socket.io`) |

To change the API port, change `PORT` in `server/.env` and the port in `API_URL` in `client/.env` to match.

Values set in the shell override both files. Only `VITE_`-prefixed variables in `client/.env` reach browser code, so never put secrets there. Both `.env` files are excluded from git; the `.env.example` files are committed.

To try calls by yourself, open a second browser profile or an incognito window and sign up as another person.

## Production

```sh
npm run build        # builds client/dist
NODE_ENV=production npm start
```

The server then serves the app and the API on `PORT` from `server/.env`. `client/.env` is only used by the development server. Two requirements:

- **HTTPS.** Browsers only allow the microphone on HTTPS (or localhost), so put the app behind a TLS proxy such as nginx or Caddy. The proxy must forward WebSocket upgrades for `/socket.io`.
- **TURN relay.** Calls use [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/), for networks that block direct connections. Set `CF_TURN_KEY_ID` and `CF_TURN_KEY_API_TOKEN` in `server/.env`.
  - The server uses that key to request 24-hour TURN credentials and caches them (`server/src/services/ice.js`). The key itself never reaches the browser.
  - Calls connect directly when they can and fall back to Cloudflare's relay over UDP, TCP or TLS on ports 3478, 5349, 443 and 80.
  - `FORCE_TURN_RELAY=true` sends all audio through Cloudflare. This hides users' IP addresses from each other, at the cost of a little delay and more relayed traffic.
  - To use another TURN server, leave the Cloudflare keys empty and set `TURN_URL`, `TURN_USERNAME` and `TURN_CREDENTIAL`.

## Tests

`npm run test:e2e` runs an end-to-end test with real browsers. Start `npm run dev` first. If Playwright's Chromium isn't installed, run `npx playwright install chromium` once.

The test drives three users with fake microphones. It checks the TURN relay with a relay-only connection, and logs which route each call and voice link used. With `FORCE_TURN_RELAY=true`, it fails if any link avoids the relay. It covers:

- sign-up and a wrong-password error,
- chat with typing indicator and read ticks,
- an accepted call, mute, hang-up, and a declined call,
- a video call with real video frames both ways, camera off/on, and switching microphone mid-call,
- creating a room, adding and inviting members, and the room-full limit,
- three-way room voice,
- removing a member, and dark theme.

Screenshots are saved to `tests/screenshots/`.

## Project layout

```
server/src/
  index.js            Express + Socket.IO entry, serves client/dist in production
  schema.sql          Tables (applied on start)
  routes/             REST: auth, users, dms, rooms, invites
  services/rooms.js   Membership checks, member-limit locking, room summaries
  socket/             Realtime: chat, typing, read receipts, calls, room voice
client/src/
  store/              Zustand stores: auth, chat, call (1:1 WebRTC), voice (room mesh)
  realtime.ts         Socket events into the stores
  pages/, components/ UI
tests/e2e.mjs         Browser end-to-end test
```

## Limits to know about

- Call and voice state is kept in server memory. Run a single server process; restarting it ends any calls in progress.
- Room voice is a full mesh, meaning each person sends audio directly to every other person. That's why voice is capped at 12 people.
- Any logged-in user can search for every other user by name or email.
