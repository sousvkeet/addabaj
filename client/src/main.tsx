import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { bindRealtime } from './realtime';
import './index.css';

bindRealtime();

if (import.meta.env.DEV) {
  // Handy for debugging in the console and for end-to-end tests.
  void Promise.all([import('./store/chat'), import('./store/call'), import('./store/voice'), import('./store/liveStream'), import('./lib/socket')]).then(
    ([chat, call, voice, live, io]) => {
      Object.assign(window, { adda: { chat: chat.useChat, call: call.useCall, voice: voice.useVoice, live: live.useLiveStream, socket: io.socket } });
    },
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
