import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { useAuth } from './store/auth';
import { AuthPage } from './pages/AuthPage';
import { AppShell } from './pages/AppShell';
import { ChatView } from './pages/ChatView';
import { RoomView } from './pages/RoomView';
import { EmptyPane } from './pages/EmptyPane';
import { Overview } from './pages/admin/Overview';
import { People } from './pages/admin/People';
import { RoomsAdmin } from './pages/admin/RoomsAdmin';
import { SiteSettings } from './pages/admin/SiteSettings';
import { Toasts } from './components/Toasts';
import { Logo, Wordmark } from './components/ui/Logo';

/** The host admin's pages; everyone else goes back to their chats. */
function HostOnly({ children }: { children: ReactNode }) {
  const siteAdmin = useAuth((s) => !!s.user?.siteAdmin);
  return siteAdmin ? children : <Navigate to="/chats" replace />;
}

export function App() {
  const status = useAuth((s) => s.status);
  const init = useAuth((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  if (status === 'loading') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5">
        <Logo size={76} className="animate-pulse drop-shadow-[0_12px_30px_var(--logo-glow)]" />
        <Wordmark className="text-[22px]" />
      </div>
    );
  }

  const authed = status === 'authed';
  return (
    <>
      <Routes>
        <Route path="/login" element={authed ? <Navigate to="/" replace /> : <AuthPage mode="login" />} />
        <Route path="/signup" element={authed ? <Navigate to="/" replace /> : <AuthPage mode="signup" />} />
        <Route path="/" element={authed ? <AppShell /> : <Navigate to="/login" replace />}>
          <Route index element={<Navigate to="/chats" replace />} />
          <Route path="chats" element={<EmptyPane section="chats" />} />
          <Route path="chats/:userId" element={<ChatView />} />
          <Route path="rooms" element={<EmptyPane section="rooms" />} />
          <Route path="rooms/:roomId" element={<RoomView />} />
          <Route path="invites" element={<EmptyPane section="invites" />} />
          <Route path="admin" element={<HostOnly><Overview /></HostOnly>} />
          <Route path="admin/overview" element={<HostOnly><Overview /></HostOnly>} />
          <Route path="admin/people" element={<HostOnly><People /></HostOnly>} />
          <Route path="admin/rooms" element={<HostOnly><RoomsAdmin /></HostOnly>} />
          <Route path="admin/settings" element={<HostOnly><SiteSettings /></HostOnly>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toasts />
    </>
  );
}
