import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

// Runs against the dev servers (npm run dev); dev builds expose stores on window.adda.
const clientEnv = new URL('../client/.env', import.meta.url).pathname;
if (existsSync(clientEnv)) process.loadEnvFile(clientEnv);
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.CLIENT_PORT ?? 5180}`;
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);

const browser = await chromium.launch({
  // No autoplay override: calls must work under Chrome's real autoplay rules.
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push(['PASS', label]);
    console.log('PASS', label);
  } catch (err) {
    results.push(['FAIL', label, err.message.split('\n')[0]]);
    console.log('FAIL', label, '-', err.message.split('\n').slice(0, 3).join(' | '));
  }
};

async function user(name, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone', 'camera'] });
  // Keep a handle on every peer connection so we can see which route ICE picked.
  await ctx.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args);
        window.__pcs.push(this);
      }
    };
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  page.on('console', (m) => m.type() === 'error' && console.log(`[${name} console]`, m.text()));
  return { name, page, email: `${name.toLowerCase()}.${stamp}@example.com` };
}

async function signup(u, fullName) {
  await u.page.goto(`${BASE}/signup`);
  await u.page.getByLabel('Your name').fill(fullName);
  await u.page.getByLabel('Email').fill(u.email);
  await u.page.getByLabel('Password').fill('password123');
  await u.page.getByRole('button', { name: 'Create account' }).click();
  await u.page.waitForURL(`${BASE}/chats`);
}

const store = (page, expr) => page.evaluate(expr);

/** Candidate type ('host' | 'srflx' | 'relay') of each connected peer link. */
const routes = (page) =>
  page.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs) {
      if (pc.connectionState !== 'connected') continue;
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) {
          out.push(stats.get(stats.get(s.selectedCandidatePairId).localCandidateId).candidateType);
        }
      });
    }
    return out;
  });

let iceConfig = null;
async function assertRoutes(label, page) {
  const types = await routes(page);
  console.log(`     ${label} routes: ${types.join(', ') || 'none'}`);
  if (iceConfig?.iceTransportPolicy === 'relay' && types.some((t) => t !== 'relay')) {
    throw new Error(`FORCE_TURN_RELAY is on but ${label} used ${types.join(', ')}`);
  }
}

/** Finds one person by exact user ID or email (nobody is listed). */
async function search(page, query) {
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('User ID or email').fill(query);
  await dlg.getByRole('button', { name: 'Find' }).click();
  const result = dlg.getByRole('group', { name: 'Search result' });
  await result.waitFor({ timeout: 5000 });
  return result;
}

const A = await user('Asha');
const B = await user('Rahul');
const C = await user('Mitali', { width: 390, height: 844 });

await check('login page renders with the aurora hero', async () => {
  await A.page.goto(`${BASE}/login`);
  await A.page.waitForTimeout(1800);
  await A.page.screenshot({ path: `${SHOTS}01-login.png` });
  await A.page.getByRole('heading', { name: 'Log in to Adda Khana' }).waitFor();
});

await check('wrong password shows a clear error', async () => {
  await A.page.getByLabel('Email').fill('nobody@example.com');
  await A.page.getByLabel('Password').fill('wrongpass1');
  await A.page.getByRole('button', { name: 'Log in' }).click();
  await A.page.getByText('Email or password is incorrect.').waitFor({ timeout: 5000 });
});

await check('three people sign up', async () => {
  await signup(A, 'Asha Sen');
  await signup(B, 'Rahul Das');
  await signup(C, 'Mitali Roy');
});

await check('TURN server relays traffic (relay-only peer pair)', async () => {
  iceConfig = await A.page.evaluate(async () => (await fetch('/api/config')).json());
  const turnUrls = iceConfig.iceServers.flatMap((s) => [].concat(s.urls)).filter((u) => u.startsWith('turn'));
  if (!turnUrls.length) {
    console.log('     (no TURN configured; skipping)');
    return;
  }
  const result = await A.page.evaluate(async (iceServers) => {
    const cfg = { iceServers, iceTransportPolicy: 'relay' };
    const a = new RTCPeerConnection(cfg);
    const b = new RTCPeerConnection(cfg);
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const ch = a.createDataChannel('probe');
    const got = new Promise((res) => (b.ondatachannel = (e) => (e.channel.onmessage = (m) => res(m.data))));
    ch.onopen = () => ch.send('relayed');
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    const msg = await Promise.race([got, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
    a.close();
    b.close();
    return msg;
  }, iceConfig.iceServers);
  if (result !== 'relayed') throw new Error(`relay-only connection failed (${result}) via ${turnUrls[0]}`);
});

await check('Asha starts a chat with Rahul from the picker', async () => {
  await A.page.getByRole('button', { name: 'Start a new chat' }).click();
  const row = await search(A.page, B.email);
  await row.getByText('Rahul Das').waitFor();
  await row.getByRole('button', { name: 'Message' }).click();
  await A.page.waitForURL(/\/chats\/[0-9a-f-]+$/);
  await A.page.getByText('Say hello to Rahul Das').waitFor();
});

await check('Rahul gets the message in real time with an unread badge, then sees typing', async () => {
  await A.page.getByLabel('Message Rahul').fill('Cha khabe?');
  await A.page.getByLabel('Message Rahul').press('Enter');
  await B.page.getByText('Cha khabe?').first().waitFor({ timeout: 5000 });
  const badge = await B.page.getByRole('link', { name: /^Chats/ }).innerText();
  if (!badge.includes('1')) throw new Error(`badge was ${badge}`);
  await A.page.getByLabel('Message Rahul').pressSequentially('Singara o', { delay: 40 });
  await B.page.getByText('typing…').first().waitFor({ timeout: 5000 });
  await A.page.getByLabel('Message Rahul').press('Enter');
});

await check('Rahul opens the chat and Asha sees the read tick', async () => {
  await B.page.getByRole('link', { name: /Asha Sen/ }).click();
  await B.page.getByLabel('Message Asha').fill('Hyan, ekhuni!');
  await B.page.getByLabel('Message Asha').press('Enter');
  await A.page.getByRole('log').getByText('Hyan, ekhuni!').waitFor({ timeout: 5000 });
  await A.page.getByLabel('Read').first().waitFor({ timeout: 5000 });
  for (const text of ['Cha khabe?', 'Singara o', 'Hyan, ekhuni!']) {
    await A.page.getByRole('log').getByText(text).waitFor({ timeout: 3000 });
    await B.page.getByRole('log').getByText(text).waitFor({ timeout: 3000 });
  }
  await A.page.screenshot({ path: `${SHOTS}02-chat.png` });
});

await check('Asha calls Rahul, Rahul accepts, audio connects both ways', async () => {
  await A.page.getByRole('button', { name: 'Voice call Rahul Das' }).click();
  await B.page.getByRole('alertdialog').waitFor({ timeout: 8000 });
  await B.page.screenshot({ path: `${SHOTS}03-incoming.png` });
  await B.page.getByRole('button', { name: 'Accept call' }).click();
  await A.page.waitForFunction(() => window.adda.call.getState().phase === 'active', null, { timeout: 15000 });
  await B.page.waitForFunction(() => window.adda.call.getState().phase === 'active', null, { timeout: 15000 });
  const tracks = await store(B.page, () => window.adda.call.getState().remoteStream?.getAudioTracks().length ?? 0);
  if (tracks !== 1) throw new Error(`remote audio tracks: ${tracks}`);
  await assertRoutes('call', A.page);
  // Prove sound actually arrives and plays, not just that a track exists.
  await A.page.waitForTimeout(1500);
  for (const u of [A, B]) {
    const audio = await u.page.evaluate(async () => {
      const pc = window.__pcs.find((p) => p.connectionState === 'connected');
      let bytes = 0;
      let energy = 0;
      (await pc.getStats()).forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') {
          bytes = s.bytesReceived;
          energy = s.totalAudioEnergy ?? 0;
        }
      });
      const playing = [...document.querySelectorAll('audio[data-call-audio]')].some((a) => !a.paused && a.currentTime > 0.5);
      return { bytes, energy, playing };
    });
    if (!(audio.bytes > 1000 && audio.energy > 0 && audio.playing)) {
      throw new Error(`${u.name} isn't hearing the call: ${JSON.stringify(audio)}`);
    }
  }
});

await check('mute shows on the other side', async () => {
  await B.page.getByRole('button', { name: 'Mute microphone' }).click();
  await A.page.waitForFunction(() => window.adda.call.getState().peerMuted === true, null, { timeout: 5000 });
  await A.page.waitForTimeout(1200);
  await A.page.screenshot({ path: `${SHOTS}04-in-call.png` });
  await B.page.getByRole('button', { name: 'Unmute microphone' }).click();
  await A.page.waitForFunction(() => window.adda.call.getState().peerMuted === false, null, { timeout: 5000 });
});

await check('ending the call logs it in the chat for both', async () => {
  await A.page.getByRole('button', { name: 'End call' }).first().click();
  await A.page.getByText('Outgoing call').waitFor({ timeout: 5000 });
  await B.page.getByText('Incoming call').waitFor({ timeout: 5000 });
  const phase = await store(B.page, () => window.adda.call.getState().phase);
  if (phase !== 'idle') throw new Error(`Rahul still in phase ${phase}`);
});

await check('declined call shows a toast and a log entry', async () => {
  await A.page.getByRole('button', { name: 'Voice call Rahul Das' }).click();
  await B.page.getByRole('button', { name: 'Decline call' }).click({ timeout: 8000 });
  await A.page.getByText('Rahul Das declined the call.').waitFor({ timeout: 5000 });
  await A.page.getByRole('log').getByText('Call declined').waitFor({ timeout: 5000 });
});

await check('video call: both people see each other, and audio flows with it', async () => {
  await A.page.getByRole('button', { name: 'Video call Rahul Das' }).click();
  await B.page.getByText('Incoming video call').waitFor({ timeout: 10000 });
  await B.page.getByRole('button', { name: 'Accept with video' }).click();
  for (const u of [A, B]) {
    await u.page.waitForFunction(() => {
      const s = window.adda.call.getState();
      const v = document.querySelector('video[data-remote-video]');
      return s.phase === 'active' && s.peerCameraOn && v && v.videoWidth > 0 && v.currentTime > 0.3;
    }, null, { timeout: 20000 });
    if (!(await u.page.locator('video[data-self-video]').count())) throw new Error(`${u.name} has no self view`);
  }
  await assertRoutes('video', A.page);
  await A.page.screenshot({ path: `${SHOTS}04b-video-call.png` });
});

await check('camera off/on mid-call, and switching microphone keeps the call going', async () => {
  await B.page.getByRole('button', { name: 'Turn camera off' }).click();
  await A.page.getByText("Rahul's camera is off").waitFor({ timeout: 5000 });
  await B.page.getByRole('button', { name: 'Turn camera on' }).click();
  await A.page.locator('video[data-remote-video]').waitFor({ timeout: 5000 });
  await A.page.getByRole('button', { name: 'Audio and video settings' }).click();
  const mic = A.page.getByRole('dialog').getByLabel('Microphone', { exact: true });
  const options = await mic.locator('option').allInnerTexts();
  if (options.length < 2) throw new Error(`microphones listed: ${options}`);
  const label = () => A.page.evaluate(() => window.__pcs.filter((p) => p.connectionState === 'connected').at(-1).getSenders().find((x) => x.track?.kind === 'audio').track.label);
  const before = await label();
  await mic.selectOption({ index: options.length - 1 });
  await A.page.waitForFunction((b) => window.__pcs.filter((p) => p.connectionState === 'connected').at(-1).getSenders().find((x) => x.track?.kind === 'audio')?.track?.label !== b, before, { timeout: 5000 });
  await A.page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
  await A.page.getByRole('region', { name: /Video call with/ }).getByRole('button', { name: 'End call' }).click();
  await A.page.getByText('Outgoing video call').waitFor({ timeout: 5000 });
  await A.page.evaluate(() => localStorage.removeItem('adda-devices'));
});

let roomUrl;
await check('Asha creates a room with a 3-member limit', async () => {
  await A.page.getByRole('link', { name: 'Rooms' }).click();
  await A.page.getByRole('button', { name: 'Start a room' }).first().click();
  await A.page.getByLabel('Room name', { exact: true }).fill('Tea stall');
  await A.page.getByLabel("What's it for?").fill('Evening adda after office');
  await A.page.getByLabel('Maximum members', { exact: true }).fill('3');
  await A.page.getByRole('button', { name: 'Create room' }).click();
  await A.page.waitForURL(/\/rooms\/[0-9a-f-]+$/);
  roomUrl = A.page.url();
  await A.page.getByRole('dialog').getByText('1 of 3 seats taken, 2 left.').waitFor({ timeout: 5000 });
});

await check('Asha adds Rahul directly; Rahul sees the room appear', async () => {
  const row = await search(A.page, B.email);
  await row.getByRole('button', { name: 'Add' }).click();
  await row.getByText('In the room').waitFor({ timeout: 5000 });
  await B.page.getByText('You were added to Tea stall.').waitFor({ timeout: 5000 });
});

await check('Asha invites Mitali; Mitali sees the invite', async () => {
  const row = await search(A.page, C.email);
  await row.getByRole('button', { name: 'Invite' }).click();
  await row.getByText('Invited').waitFor({ timeout: 5000 });
  await C.page.getByText('Asha Sen invited you to Tea stall.').waitFor({ timeout: 5000 });
  await A.page.keyboard.press('Escape');
  await A.page.getByText('Waiting to join').waitFor({ timeout: 5000 });
});

await check('Mitali (phone size) accepts and lands in the room; it is now full', async () => {
  await C.page.getByRole('link', { name: /Invites/ }).click();
  await C.page.screenshot({ path: `${SHOTS}05-mobile-invite.png` });
  await C.page.getByRole('button', { name: 'Join room' }).click();
  await C.page.waitForURL(/\/rooms\/[0-9a-f-]+$/);
  await A.page.getByRole('log').getByText('Mitali Roy joined').waitFor({ timeout: 5000 });
  await A.page.getByText('3 of 3 members').first().waitFor({ timeout: 5000 });
});

await check('server refuses a 4th member when the room is full', async () => {
  // A fourth person (registered from here, so nobody's browser login changes).
  const extra = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fourth Person', email: `fourth.${Date.now()}@example.com`, password: 'password123' }),
  }).then((r) => r.json());
  const res = await A.page.evaluate(
    async ([roomId, userId]) => {
      const x = await fetch(`/api/rooms/${roomId}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
      return [[x.status, (await x.json()).error]];
    },
    [roomUrl.split('/').pop(), extra.user.id],
  );
  const full = res.find(([s]) => s === 409 && /full/.test(res.find(([st]) => st === 409)?.[1] ?? ''));
  if (!full) throw new Error(JSON.stringify(res.slice(0, 4)));
});

await check('admin cannot lower the limit below the member count', async () => {
  const res = await A.page.evaluate(async (roomId) => {
    const r = await fetch(`/api/rooms/${roomId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxMembers: 2 }) });
    return [r.status, (await r.json()).error];
  }, roomUrl.split('/').pop());
  if (res[0] !== 409) throw new Error(JSON.stringify(res));
});

await check('room messages reach every member live', async () => {
  await B.page.getByRole('link', { name: 'Rooms' }).click();
  await B.page.getByRole('link', { name: /Tea stall/ }).click();
  await B.page.getByLabel('Message Tea stall').fill('Ami singara anchi');
  await B.page.getByLabel('Message Tea stall').press('Enter');
  await A.page.getByRole('log').getByText('Ami singara anchi').waitFor({ timeout: 5000 });
  await C.page.getByRole('log').getByText('Ami singara anchi').waitFor({ timeout: 5000 });
  for (const text of ['Ar cha?', 'Duto bhaar']) {
    await B.page.getByLabel('Message Tea stall').fill(text);
    await B.page.getByLabel('Message Tea stall').press('Enter');
  }
  for (const u of [A, B, C]) {
    for (const text of ['Ami singara anchi', 'Ar cha?', 'Duto bhaar']) await u.page.getByRole('log').getByText(text).waitFor({ timeout: 5000 });
  }
});

await check('three people join room voice and all mesh links connect', async () => {
  await A.page.getByRole('button', { name: 'Join voice' }).first().click();
  await A.page.waitForFunction(() => window.adda.voice.getState().status === 'live', null, { timeout: 10000 });
  await B.page.getByRole('button', { name: 'Join voice' }).first().click();
  await C.page.getByRole('button', { name: 'Join voice' }).first().click();
  for (const u of [A, B, C]) {
    await u.page.waitForFunction(
      () => {
        const s = window.adda.voice.getState();
        const conns = Object.values(s.connection);
        return s.status === 'live' && conns.length === 2 && conns.every((c) => c === 'connected');
      },
      null,
      { timeout: 20000 },
    );
  }
  await assertRoutes('voice', A.page);
  const panelMic = A.page.getByRole('region', { name: 'Voice', exact: true }).getByLabel('Microphone', { exact: true });
  const micChoices = await panelMic.locator('option').allInnerTexts();
  if (micChoices.length < 2) throw new Error(`room panel microphone choices: ${micChoices}`);
  await A.page.waitForTimeout(1500);
  await A.page.screenshot({ path: `${SHOTS}06-room-voice.png` });
});

await check('voice mute reflects for others; leaving removes the seat', async () => {
  await C.page.getByRole('button', { name: 'Members and voice' }).click();
  await C.page.getByRole('button', { name: 'Mute', exact: true }).click();
  await A.page.waitForFunction(() => Object.values(window.adda.chat.getState().voice).flat().some((p) => p.muted), null, { timeout: 5000 });
  await C.page.screenshot({ path: `${SHOTS}07-mobile-voice-panel.png` });
  await C.page.getByRole('button', { name: 'Leave', exact: true }).click();
  await A.page.waitForFunction(() => Object.values(window.adda.voice.getState().connection).length === 1, null, { timeout: 5000 });
});

await check('removing a member kicks them out of the room live', async () => {
  await A.page.getByRole('button', { name: 'Options for Mitali Roy' }).click();
  await A.page.getByRole('menuitem', { name: 'Remove from room' }).click();
  await A.page.getByRole('button', { name: 'Remove', exact: true }).click();
  await C.page.getByText('You were removed from Tea stall.').waitFor({ timeout: 5000 });
  await A.page.getByText('2 of 3 members').first().waitFor({ timeout: 5000 });
});

await check('the app opens dark, and the light theme can be picked and is remembered', async () => {
  if ((await A.page.evaluate(() => document.documentElement.dataset.theme)) !== 'dark') throw new Error('did not open in the dark theme');
  await A.page.getByRole('button', { name: 'Your account' }).click();
  await A.page.waitForTimeout(300);
  await A.page.screenshot({ path: `${SHOTS}08a-account-menu.png` });
  await A.page.getByRole('menuitem', { name: 'Switch to light theme' }).click({ timeout: 5000 });
  await A.page.waitForTimeout(400);
  await A.page.screenshot({ path: `${SHOTS}08-light-room.png` });
  await A.page.reload();
  if ((await A.page.evaluate(() => document.documentElement.dataset.theme)) !== 'light') throw new Error('the light theme was not remembered');
});

await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('  FAILED:', f[1], '-', f[2]);
process.exit(failed.length ? 1 : 0);
