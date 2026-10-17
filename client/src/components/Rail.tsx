import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router';
import { LogOut, Mail, MessageCircle, Moon, Sun, Users } from 'lucide-react';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { useUi } from '../store/ui';
import { Avatar } from './ui/Avatar';

function Badge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="absolute -top-1 right-0 min-w-[18px] rounded-full bg-taxi px-1 text-center text-[11px] leading-[18px] font-bold text-on-taxi md:right-1">
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function Rail({ hiddenOnMobile }: { hiddenOnMobile: boolean }) {
  const chatUnread = useChat((s) => Object.values(s.conversations).reduce((n, c) => n + c.unread, 0));
  const roomUnread = useChat((s) => Object.values(s.rooms).reduce((n, r) => n + r.unread, 0));
  const inviteCount = useChat((s) => s.invites.length);

  const items = [
    { to: '/chats', label: 'Chats', Icon: MessageCircle, badge: chatUnread },
    { to: '/rooms', label: 'Rooms', Icon: Users, badge: roomUnread },
    { to: '/invites', label: 'Invites', Icon: Mail, badge: inviteCount },
  ];

  return (
    <nav
      aria-label="Main"
      className={`${hiddenOnMobile ? 'hidden md:flex' : 'flex'} fixed inset-x-0 bottom-0 z-30 h-[calc(64px+env(safe-area-inset-bottom))] items-start justify-around bg-shutter-deep pt-1.5 pb-[env(safe-area-inset-bottom)] text-on-shutter md:static md:z-auto md:h-full md:w-[76px] md:flex-col md:items-center md:justify-start md:gap-1.5 md:pt-4 md:pb-4`}
    >
      <span lang="bn" aria-hidden className="mb-4 hidden font-display text-[34px] leading-none text-taxi md:block">
        আ
      </span>
      {items.map(({ to, label, Icon, badge }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            `relative flex w-16 flex-col items-center gap-0.5 rounded-2xl py-1.5 text-[11.5px] font-medium transition-colors ${
              isActive ? 'bg-white/10 text-taxi' : 'text-on-shutter/70 hover:text-on-shutter'
            }`
          }
        >
          <Icon size={22} strokeWidth={1.9} />
          {label}
          <Badge count={badge} />
        </NavLink>
      ))}
      <div className="hidden md:block md:flex-1" />
      <AccountMenu />
    </nav>
  );
}

function AccountMenu() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const [open, setOpen] = useState(false);
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
  return (
    <div ref={ref} className="relative flex w-16 justify-center pt-1 md:pt-0">
      <button
        type="button"
        aria-label="Your account"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        className="rounded-full"
      >
        <Avatar name={user.name} hue={user.hue} size={38} />
      </button>
      {open && (
        <div
          role="menu"
          className="pop-in absolute right-2 bottom-[54px] z-50 w-64 rounded-2xl border border-line bg-paper p-1.5 text-ink shadow-[0_18px_40px_-16px_rgb(10_30_25/0.5)] md:right-auto md:bottom-0 md:left-[64px]"
        >
          <div className="px-3 pt-2 pb-2.5">
            <p className="truncate font-semibold">{user.name}</p>
            <p className="truncate text-[13px] text-ink-soft">{user.email}</p>
          </div>
          <button
            role="menuitem"
            type="button"
            onClick={toggleTheme}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[14px] hover:bg-limewash"
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            {theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => void logout()}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[14px] text-oxide hover:bg-limewash"
          >
            <LogOut size={17} />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
