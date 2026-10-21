import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router';
import { AtSign, EyeOff, KeyRound, LogOut, Mail, MessageCircle, Moon, Settings2, ShieldCheck, Sun, Users } from 'lucide-react';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { useUi } from '../store/ui';
import { Avatar } from './ui/Avatar';
import { Logo } from './ui/Logo';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { PrivacyDialog } from './PrivacyDialog';
import { MyIdDialog } from './MyIdDialog';

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

  const items = [
    { to: '/chats', label: 'Chats', Icon: MessageCircle, badge: chatUnread },
    { to: '/rooms', label: 'Rooms', Icon: Users, badge: roomUnread },
    { to: '/invites', label: 'Invites', Icon: Mail, badge: inviteCount },
    ...(siteAdmin ? [{ to: '/admin', label: 'Admin', Icon: ShieldCheck, badge: 0 }] : []),
  ];

  return (
    <nav
      aria-label="Main"
      className={`${hiddenOnMobile ? 'hidden md:flex' : 'flex'} bg-rail fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-30 h-[68px] items-center justify-around rounded-[26px] border border-rail-line px-2 text-rail-ink shadow-float md:relative md:inset-auto md:z-[44] md:h-full md:w-[84px] md:flex-col md:justify-start md:gap-2 md:rounded-[28px] md:px-0 md:pt-5 md:pb-4`}
    >
      <Logo size={44} className="mb-5 hidden drop-shadow-[0_8px_18px_var(--logo-glow)] md:block" />
      {items.map(({ to, label, Icon, badge }) => (
        <NavLink
          key={to}
          to={to}
          aria-label={badge ? `${label}, ${badge} new` : label}
          className="group flex w-[62px] flex-col items-center gap-1 text-[11.5px] font-semibold md:w-[72px]"
        >
          {({ isActive }) => (
            <>
              <span
                className={`relative flex h-10 w-12 items-center justify-center rounded-2xl transition-all ${
                  isActive ? 'bg-aurora text-white shadow-glow' : 'text-rail-ink/60 group-hover:bg-rail-ink/8 group-hover:text-rail-ink'
                }`}
              >
                <Icon size={21} strokeWidth={2} />
                <Badge count={badge} />
              </span>
              <span className={isActive ? 'text-rail-ink' : 'text-rail-ink/55 group-hover:text-rail-ink/85'}>{label}</span>
            </>
          )}
        </NavLink>
      ))}
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
    <div ref={ref} className="relative flex w-[62px] justify-center md:w-[72px]">
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
          <Avatar name={user.name} hue={user.hue} size={38} />
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className="pop-in absolute right-0 bottom-[60px] z-50 w-72 overflow-hidden rounded-3xl border border-line bg-surface p-1.5 text-ink shadow-float md:right-auto md:bottom-0 md:left-[70px]"
        >
          <div className="mb-1 flex items-center gap-3 rounded-2xl bg-subtle/70 p-3">
            <Avatar name={user.name} hue={user.hue} size={42} />
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
    </div>
  );
}
