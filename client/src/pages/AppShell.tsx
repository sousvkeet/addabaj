import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router';
import { useChat } from '../store/chat';
import { Rail } from '../components/Rail';
import { ChatList } from '../components/ChatList';
import { RoomList } from '../components/RoomList';
import { InviteList } from '../components/InviteList';
import { AdminNav } from './admin/AdminNav';
import { Announcement } from '../components/Announcement';
import { ChangePasswordDialog } from '../components/ChangePasswordDialog';
import { useAuth } from '../store/auth';
import { AudioSinks, CallStage, IncomingCall, LiveBar, useLive } from '../components/CallUi';
import { DeviceSettings } from '../components/DeviceSettings';
import { ConnectionNotice } from '../components/ConnectionNotice';

export function AppShell() {
  const { pathname } = useLocation();
  const section = pathname.startsWith('/rooms')
    ? 'rooms'
    : pathname.startsWith('/invites')
      ? 'invites'
      : pathname.startsWith('/admin')
        ? 'admin'
        : 'chats';
  const inThread = /^\/(chats|rooms|admin)\/[^/]+/.test(pathname);
  const passwordRequired = useAuth((s) => !!s.user?.passwordChangeRequired);
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
    <div className={`flex h-full overflow-hidden md:gap-3 md:p-3 ${live ? 'pt-[76px] md:pt-3' : ''}`}>
      <Rail hiddenOnMobile={inThread} />
      <aside
        className={`${inThread ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col overflow-hidden pb-[calc(92px+env(safe-area-inset-bottom))] md:w-[340px] md:rounded-[28px] md:border md:border-line/70 md:pb-0 md:shadow-float md:glass ${
          live ? 'md:pb-[96px]' : ''
        }`}
      >
        {/* Phones show the list on its own, so the announcement goes here too. */}
        <div className="md:hidden">
          <Announcement />
        </div>
        {section === 'chats' && <ChatList />}
        {section === 'rooms' && <RoomList />}
        {section === 'invites' && <InviteList />}
        {section === 'admin' && <AdminNav />}
      </aside>
      <main
        className={`${inThread ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col overflow-hidden md:rounded-[28px] md:border md:border-line/70 md:shadow-float md:glass`}
      >
        <Announcement />
        <Outlet />
      </main>
      <LiveBar />
      <CallStage />
      <IncomingCall />
      <DeviceSettings />
      <ConnectionNotice />
      <AudioSinks />
      <ChangePasswordDialog open={passwordRequired} onClose={() => {}} required />
    </div>
  );
}
