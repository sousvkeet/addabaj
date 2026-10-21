import { useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { DoorOpen, KeyRound, LayoutDashboard, ShieldCheck, SlidersHorizontal, Smartphone, Users } from 'lucide-react';
import { useAuth } from '../../store/auth';
import { ListHeader, listRowClass } from '../../components/ListHeader';
import { Button } from '../../components/ui/Button';
import { ChangePasswordDialog } from '../../components/ChangePasswordDialog';

const ITEMS = [
  { to: '/admin/overview', label: 'Overview', hint: 'Activity at a glance', Icon: LayoutDashboard },
  { to: '/admin/people', label: 'People', hint: 'Accounts, roles and passwords', Icon: Users },
  { to: '/admin/rooms', label: 'Rooms', hint: 'Every room on the site', Icon: DoorOpen },
  { to: '/admin/settings', label: 'Site settings', hint: 'Sign-ups and announcements', Icon: SlidersHorizontal },
  { to: '/admin/app', label: 'App updates', hint: 'New versions of the Android app', Icon: Smartphone },
];

/** The admin area's menu, in the list panel. */
export function AdminNav() {
  const user = useAuth((s) => s.user);
  const { pathname } = useLocation();
  const [changing, setChanging] = useState(false);

  return (
    <>
      <ListHeader title="Admin" subtitle="Run Adda Khana" />
      <nav aria-label="Admin" className="md:space-y-1 md:px-2.5">
        {ITEMS.map(({ to, label, hint, Icon }) => {
          // On a computer /admin shows the overview, so mark it too.
          const active = pathname === to || (to === '/admin/overview' && pathname === '/admin');
          return (
            <NavLink key={to} to={to} viewTransition className={() => listRowClass(active)}>
              <span
                className={`flex size-11 shrink-0 items-center justify-center rounded-2xl ${
                  active ? 'bg-aurora text-white shadow-glow' : 'bg-subtle text-brand dark:text-live'
                }`}
              >
                <Icon size={20} />
              </span>
              <span className="min-w-0">
                <span className="block font-semibold">{label}</span>
                <span className="block truncate text-[13px] text-ink-soft">{hint}</span>
              </span>
            </NavLink>
          );
        })}
      </nav>
      <div className="mt-auto p-3">
        {user?.mustChangePassword ? (
          <div className="rounded-3xl border border-amber-400/40 bg-amber-400/10 p-4">
            <p className="flex items-center gap-2 font-semibold text-amber-700 dark:text-amber-300">
              <KeyRound size={17} />
              Default password in use
            </p>
            <p className="mt-1 text-[13px] text-ink-soft">Anyone who knows it can run your site. Choose your own now.</p>
            <Button size="sm" className="mt-3 w-full" onClick={() => setChanging(true)}>
              Change password
            </Button>
          </div>
        ) : (
          <p className="flex items-center gap-2 rounded-2xl bg-subtle/60 px-3.5 py-3 text-[13px] text-ink-soft">
            <ShieldCheck size={17} className="shrink-0 text-brand dark:text-live" />
            Signed in as host admin {user?.name}
          </p>
        )}
      </div>
      <ChangePasswordDialog open={changing} onClose={() => setChanging(false)} />
    </>
  );
}
