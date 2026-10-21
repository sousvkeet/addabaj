import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { goTab } from '../lib/back';
import { inApp } from '../lib/native';
import { AtSign, Camera, EyeOff, KeyRound, LogOut, Mail, MessageCircle, MonitorSmartphone, Moon, Settings2, ShieldCheck, Sun, Users } from 'lucide-react';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { useUi } from '../store/ui';
import { Avatar } from './ui/Avatar';
import { Logo } from './ui/Logo';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { PrivacyDialog } from './PrivacyDialog';
import { MyIdDialog } from './MyIdDialog';
import { PhotoEditor } from './PhotoEditor';
import { DevicesDialog } from './DevicesDialog';

function Badge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="absolute -top-1 -right-1.5 min-w-[19px] rounded-full bg-brand-2 px-1 text-center text-[11px] leading-[19px] font-bold text-white shadow-[0_0_0_2px_var(--rail),0_4px_12px_-2px_var(--brand-2)]">
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function Rail({ hiddenOnMobile }: { hiddenOnMobile: boolean }) {
  const chatUnread = useChat((s) => Object.values(s.conversations).reduce((n, c) => n + c.unread, 0));
  const roomUnread = useChat((s) => Object.values(s.rooms).reduce((n, r) => n + r.unread, 0));
  const inviteCount = useChat((s) => s.invites.length);
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const siteAdmin = useAuth((s) => !!s.user?.siteAdmin);
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // In the app, tabs don't pile up history: Back goes to the chats, then leaves (lib/back.ts).
  const tab = (to: string) => (e: React.MouseEvent) => {
    if (!inApp) return;
    e.preventDefault();
    goTab(navigate, to, pathname);
  };

  const items = [
    { to: '/chats', label: 'Chats', Icon: MessageCircle, badge: chatUnread },
    { to: '/rooms', label: 'Rooms', Icon: Users, badge: roomUnread },
    { to: '/invites', label: 'Invites', Icon: Mail, badge: inviteCount },
    ...(siteAdmin ? [{ to: '/admin', label: 'Admin', Icon: ShieldCheck, badge: 0 }] : []),
  ];

  return (
    <nav
      aria-label="Main"
      className={`bottom-nav ${hiddenOnMobile ? 'hidden md:flex' : 'flex'} relative z-30 h-[calc(68px+var(--safe-bottom))] shrink-0 items-start justify-around border-t border-rail-line bg-rail px-1 pt-2 pb-[var(--safe-bottom)] text-rail-ink md:z-[44] md:h-full md:w-[84px] md:flex-col md:items-center md:justify-start md:gap-2 md:rounded-[28px] md:border md:px-0 md:pt-5 md:pb-4 md:shadow-float`}
    >
      <Logo size={44} className="mb-5 hidden drop-shadow-[0_8px_18px_var(--logo-glow)] md:block" />
      {items.map(({ to, label, Icon, badge }) => (
        <NavLink
          key={to}
          to={to}
          viewTransition
          onClick={tab(to)}
          aria-label={badge ? `${label}, ${badge} new` : label}
          className="group flex min-w-0 flex-1 flex-col items-center gap-1 text-[12px] font-semibold md:w-[72px] md:flex-none md:text-[11.5px]"
        >
          {({ isActive }) => (
            <>
              <span
                className={`relative flex h-8 w-14 items-center justify-center rounded-full transition-colors md:h-10 md:w-12 md:rounded-2xl md:transition-all ${
                  isActive
                    ? 'bg-brand/18 text-brand dark:bg-brand/40 dark:text-white md:bg-aurora md:text-white md:shadow-glow'
                    : 'text-rail-ink/65 group-hover:bg-rail-ink/8 group-hover:text-rail-ink md:text-rail-ink/60'
                }`}
              >
                <Icon size={21} strokeWidth={isActive ? 2.3 : 2} />
                <Badge count={badge} />
              </span>
              <span className={isActive ? 'font-bold text-rail-ink' : 'text-rail-ink/60 group-hover:text-rail-ink/85'}>{label}</span>
            </>
          )}
        </NavLink>
      ))}
      {/* Phones: settings is a tab, like other messengers. */}
      {user && (
        <NavLink to="/settings" viewTransition onClick={tab('/settings')} aria-label="You: settings" className="group flex min-w-0 flex-1 flex-col items-center gap-1 text-[12px] font-semibold md:hidden">
          {({ isActive }) => (
            <>
              <span className={`flex h-8 w-14 items-center justify-center rounded-full transition-colors ${isActive ? 'bg-brand/18 dark:bg-brand/40' : ''}`}>
                <Avatar name={user.name} hue={user.hue} photo={user.photo} size={26} />
              </span>
              <span className={isActive ? 'font-bold text-rail-ink' : 'text-rail-ink/60'}>You</span>
            </>
          )}
        </NavLink>
      )}
      <div className="hidden md:block md:flex-1" />
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
        className="mb-2 hidden size-11 items-center justify-center rounded-2xl text-rail-ink/60 transition-colors hover:bg-rail-ink/8 hover:text-rail-ink md:flex"
      >
        {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
      </button>
      <AccountMenu />
    </nav>
  );
}

function AccountMenu() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const openDevices = useUi((s) => s.setDevicesOpen);
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [idOpen, setIdOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;
  const item = 'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] font-medium transition-colors hover:bg-subtle';
  return (
    <div ref={ref} className="relative hidden justify-center md:flex md:w-[72px]">
      <button
        type="button"
        aria-label="Your account"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        className="rounded-full p-[2px] transition-transform hover:scale-105"
        style={{ background: 'linear-gradient(135deg, var(--brand), var(--brand-2))' }}
      >
        <span className="block rounded-full bg-rail p-[2px]">
          <Avatar name={user.name} hue={user.hue} photo={user.photo} size={38} />
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className="pop-in absolute bottom-0 left-[70px] z-50 w-72 overflow-hidden rounded-3xl border border-line bg-surface p-1.5 text-ink shadow-float"
        >
          <div className="mb-1 flex items-center gap-3 rounded-2xl bg-subtle/70 p-3">
            <Avatar name={user.name} hue={user.hue} photo={user.photo} size={42} />
            <div className="min-w-0">
              <p className="truncate font-semibold">{user.name}</p>
              <p className="truncate text-[13px] text-ink-soft">{user.handle ? `@${user.handle}` : user.email}</p>
            </div>
          </div>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              setPhotoOpen(true);
            }}
            className={item}
          >
            <Camera size={17} className="text-ink-soft" />
            Profile photo
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              setIdOpen(true);
            }}
            className={item}
          >
            <AtSign size={17} className="text-ink-soft" />
            Your user ID
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              openDevices(true);
            }}
            className={item}
          >
            <Settings2 size={17} className="text-ink-soft" />
            Microphone, speaker and camera
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              setDevicesOpen(true);
            }}
            className={item}
          >
            <MonitorSmartphone size={17} className="text-ink-soft" />
            Devices
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              setChanging(true);
            }}
            className={item}
          >
            <KeyRound size={17} className="text-ink-soft" />
            Change password
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              setPrivacyOpen(true);
            }}
            className={item}
          >
            <EyeOff size={17} className="text-ink-soft" />
            Privacy: last seen and read receipts
          </button>
          <button role="menuitem" type="button" onClick={toggleTheme} className={item}>
            {theme === 'dark' ? <Sun size={17} className="text-ink-soft" /> : <Moon size={17} className="text-ink-soft" />}
            {theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          </button>
          <button role="menuitem" type="button" onClick={() => void logout()} className={`${item} text-danger`}>
            <LogOut size={17} />
            Log out
          </button>
        </div>
      )}
      <ChangePasswordDialog open={changing} onClose={() => setChanging(false)} />
      <PrivacyDialog open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
      <MyIdDialog open={idOpen} onClose={() => setIdOpen(false)} />
      <PhotoEditor open={photoOpen} onClose={() => setPhotoOpen(false)} />
      <DevicesDialog open={devicesOpen} onClose={() => setDevicesOpen(false)} />
    </div>
  );
}
