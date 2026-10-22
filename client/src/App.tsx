import { useEffect, type ReactNode } from 'react';
import { Navigate, Outlet, Route, createRoutesFromElements, useLocation, useNavigate, useParams } from 'react-router';
import { useAuth } from './store/auth';
import { AuthPage } from './pages/AuthPage';
import { AppShell } from './pages/AppShell';
import { ChatView } from './pages/ChatView';
import { RoomView } from './pages/RoomView';
import { EmptyPane } from './pages/EmptyPane';
import { Overview } from './pages/admin/Overview';
import { People } from './pages/admin/People';
import { RoomsAdmin } from './pages/admin/RoomsAdmin';
import { Reports } from './pages/admin/Reports';
import { SiteSettings } from './pages/admin/SiteSettings';
import { AppReleases } from './pages/admin/AppReleases';
import { Toasts } from './components/Toasts';
import { AppUpdate } from './components/AppUpdate';
import { FirstRunPermissions } from './components/Permissions';
import { Logo, Wordmark } from './components/ui/Logo';
import { setNativeNavigator } from './nativeApp';

/** The host admin's pages; everyone else goes back to their chats. */
function HostOnly({ children }: { children: ReactNode }) {
  const siteAdmin = useAuth((s) => !!s.user?.siteAdmin);
  return siteAdmin ? children : <Navigate to="/chats" replace />;
}

const PENDING_JOIN = 'adda-join-code';

/** /join/K7PQ2XMB: the join dialog with that code (after logging in, if needed). */
function JoinLink({ authed }: { authed: boolean }) {
  const { code = '' } = useParams();
  if (authed) return <Navigate to="/rooms" replace state={{ joinCode: code }} />;
  try {
    sessionStorage.setItem(PENDING_JOIN, code);
  } catch {
    // Private mode: they'll have to open the link again after logging in.
  }
  return <Navigate to="/login" replace />;
}

/** After logging in, finish opening a /join link that sent them to the login page. */
function PendingJoin() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    // Let the redirects after logging in (to / and then /chats) finish first.
    if (pathname === '/login' || pathname === '/signup' || pathname === '/forgot' || pathname === '/') return;
    let code: string | null = null;
    try {
      code = sessionStorage.getItem(PENDING_JOIN);
      sessionStorage.removeItem(PENDING_JOIN);
    } catch {
      return;
    }
    if (code) navigate('/rooms', { replace: true, state: { joinCode: code } });
  }, [pathname, navigate]);
  return null;
}

/** Lets the Android app open a chat when a notification is tapped. */
function NativeNavigator() {
  const navigate = useNavigate();
  useEffect(() => {
    setNativeNavigator((path) => navigate(path));
    return () => setNativeNavigator(null);
  }, [navigate]);
  return null;
}

/** The app's own pages, for people signed in; everyone else goes to the login page. */
function SignedIn({ children }: { children: ReactNode }) {
  const authed = useAuth((s) => s.status === 'authed');
  return authed ? children : <Navigate to="/login" replace />;
}

/** The login and sign-up pages, for people not signed in yet. */
function SignedOut({ children }: { children: ReactNode }) {
  const authed = useAuth((s) => s.status === 'authed');
  return authed ? <Navigate to="/" replace /> : children;
}

/** /join/:code, whether signed in or not. */
function Join() {
  const authed = useAuth((s) => s.status === 'authed');
  return <JoinLink authed={authed} />;
}

/** Everything around the pages: the splash while checking who's signed in, notices, the update check. */
function Root() {
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

  return (
    <>
      <Outlet />
      <FirstRunPermissions />
      <Toasts />
      <AppUpdate />
      <NativeNavigator />
      {status === 'authed' && <PendingJoin />}
    </>
  );
}

/**
 * The pages, as the router's own routes (so moving between them can animate,
 * and the animation plays back on back; see lib/screens.ts).
 */
export const appRoutes = createRoutesFromElements(
  <Route element={<Root />}>
    <Route path="/login" element={<SignedOut><AuthPage mode="login" /></SignedOut>} />
    <Route path="/signup" element={<SignedOut><AuthPage mode="signup" /></SignedOut>} />
    <Route path="/forgot" element={<SignedOut><AuthPage mode="forgot" /></SignedOut>} />
    <Route path="/join/:code" element={<Join />} />
    <Route path="/" element={<SignedIn><AppShell /></SignedIn>}>
      <Route index element={<Navigate to="/chats" replace />} />
      <Route path="chats" element={<EmptyPane section="chats" />} />
      <Route path="chats/:userId" element={<ChatView />} />
      <Route path="rooms" element={<EmptyPane section="rooms" />} />
      <Route path="rooms/:roomId" element={<RoomView />} />
      <Route path="invites" element={<EmptyPane section="invites" />} />
      <Route path="settings" element={<EmptyPane section="settings" />} />
      <Route path="admin" element={<HostOnly><Overview /></HostOnly>} />
      <Route path="admin/overview" element={<HostOnly><Overview /></HostOnly>} />
      <Route path="admin/people" element={<HostOnly><People /></HostOnly>} />
      <Route path="admin/rooms" element={<HostOnly><RoomsAdmin /></HostOnly>} />
      <Route path="admin/reports" element={<HostOnly><Reports /></HostOnly>} />
      <Route path="admin/settings" element={<HostOnly><SiteSettings /></HostOnly>} />
      <Route path="admin/app" element={<HostOnly><AppReleases /></HostOnly>} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Route>,
);
