import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { useAuth } from './store/auth';
import { AuthPage } from './pages/AuthPage';
import { AppShell } from './pages/AppShell';
import { ChatView } from './pages/ChatView';
import { RoomView } from './pages/RoomView';
import { EmptyPane } from './pages/EmptyPane';
import { Toasts } from './components/Toasts';

export function App() {
  const status = useAuth((s) => s.status);
  const init = useAuth((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  if (status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-shutter-deep">
        <span lang="bn" className="animate-pulse font-display text-6xl text-taxi">
          আ
        </span>
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
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toasts />
    </>
  );
}
