import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { appRoutes } from './App';
import { bindRealtime } from './realtime';
import { bindNative } from './nativeApp';
import { watchActivity } from './lib/activity';
import { watchRipples } from './lib/ripple';
import { watchScreens } from './lib/screens';
import './index.css';

bindRealtime();
watchActivity();
bindNative();
watchRipples();

// The router animates moving between screens, and plays it back on back
// (including Android's back gesture).
const router = createBrowserRouter(appRoutes);
watchScreens(router);

if (import.meta.env.DEV) {
  // Handy for debugging in the console and for end-to-end tests.
  void Promise.all([import('./store/chat'), import('./store/call'), import('./store/voice'), import('./store/liveStream'), import('./lib/socket'), import('./store/auth')]).then(
    ([chat, call, voice, live, io, auth]) => {
      Object.assign(window, { adda: { chat: chat.useChat, call: call.useCall, voice: voice.useVoice, live: live.useLiveStream, socket: io.socket, auth: auth.useAuth } });
    },
  );
}

// Built app: keep the page on the device so it opens at once, and offline (public/sw.js).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
