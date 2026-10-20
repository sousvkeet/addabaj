import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router';
import { useChat } from '../store/chat';
import { Rail } from '../components/Rail';
import { ChatList } from '../components/ChatList';
import { RoomList } from '../components/RoomList';
import { InviteList } from '../components/InviteList';
import { AudioSinks, CallStage, IncomingCall, LiveBar, useLive } from '../components/CallUi';
import { DeviceSettings } from '../components/DeviceSettings';
import { ConnectionNotice } from '../components/ConnectionNotice';

export function AppShell() {
  const { pathname } = useLocation();
  const section = pathname.startsWith('/rooms') ? 'rooms' : pathname.startsWith('/invites') ? 'invites' : 'chats';
  const inThread = /^\/(chats|rooms)\/[^/]+/.test(pathname);
  const live = useLive();

  const unread = useChat(
    (s) =>
      Object.values(s.conversations).reduce((n, c) => n + c.unread, 0) +
      Object.values(s.rooms).reduce((n, r) => n + r.unread, 0) +
      s.invites.length,
  );
  useEffect(() => {
    document.title = unread ? `(${unread}) Adda Khana` : 'Adda Khana';
  }, [unread]);

  return (
    <div className={`flex h-full overflow-hidden bg-wall ${live ? 'pt-[68px] md:pt-0' : ''}`}>
      <Rail hiddenOnMobile={inThread} />
      <aside
        className={`${inThread ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col bg-limewash pb-[calc(64px+env(safe-area-inset-bottom))] md:w-[320px] md:border-r md:border-line md:pb-0 ${
          live ? 'md:pb-[92px]' : ''
        }`}
      >
        {section === 'chats' && <ChatList />}
        {section === 'rooms' && <RoomList />}
        {section === 'invites' && <InviteList />}
      </aside>
      <main className={`${inThread ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
        <Outlet />
      </main>
      <LiveBar />
      <CallStage />
      <IncomingCall />
      <DeviceSettings />
      <ConnectionNotice />
      <AudioSinks />
    </div>
  );
}
