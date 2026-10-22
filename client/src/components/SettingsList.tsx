import { useState, type ReactNode } from 'react';
import { AtSign, Camera, ChevronRight, EyeOff, KeyRound, LogOut, MonitorSmartphone, Moon, Settings2, ShieldCheck } from 'lucide-react';
import { inApp, nativeAppVersion } from '../lib/native';
import { useAuth } from '../store/auth';
import { useUi } from '../store/ui';
import { Avatar } from './ui/Avatar';
import { ConfirmDialog } from './ui/Dialog';
import { ListHeader } from './ListHeader';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { PrivacyDialog } from './PrivacyDialog';
import { MyIdDialog } from './MyIdDialog';
import { PhotoEditor } from './PhotoEditor';
import { DevicesDialog, devicesSummary, useSessions } from './DevicesDialog';
import { PermissionsDialog, permissionsSummary } from './Permissions';
import { usePermissions } from '../store/permissions';

type RowProps = { icon: ReactNode; title: string; hint?: string; onClick: () => void; trailing?: ReactNode; danger?: boolean; checked?: boolean };

function Row({ icon, title, hint, onClick, trailing, danger, checked }: RowProps) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        role={checked === undefined ? undefined : 'switch'}
        aria-checked={checked}
        className={`ripple flex w-full items-center gap-4 px-5 py-3.5 text-left active:bg-subtle/60 md:rounded-2xl md:px-3 md:hover:bg-subtle/70 ${danger ? 'text-danger' : ''}`}
      >
        <span className={`flex size-10 shrink-0 items-center justify-center rounded-full ${danger ? 'bg-danger/12' : 'bg-subtle text-ink-soft'}`}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15.5px] font-medium">{title}</span>
          {hint && <span className="block truncate text-[13px] text-ink-soft">{hint}</span>}
        </span>
        {trailing ?? (!danger && <ChevronRight size={18} className="shrink-0 text-ink-soft/60" />)}
      </button>
    </li>
  );
}

/** Settings, as a screen of its own on phones (the You tab), like other messengers. */
export function SettingsList() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const openDevices = useUi((s) => s.setDevicesOpen);
  const [open, setOpen] = useState<'photo' | 'id' | 'devices' | 'privacy' | 'permissions' | 'password' | 'logout' | null>(null);
  const permissions = usePermissions((s) => s.state);
  const { sessions } = useSessions(open !== 'devices');
  const [leaving, setLeaving] = useState(false);
  if (!user) return null;
  const version = inApp ? nativeAppVersion().name : null;
  const close = () => setOpen(null);

  return (
    <>
      <ListHeader title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto pb-6 md:px-2.5">
        <div className="flex items-center gap-4 px-5 py-4 md:px-3">
          <button
            type="button"
            onClick={() => setOpen('photo')}
            aria-label={user.photo ? 'Change your profile photo' : 'Add a profile photo'}
            className="relative shrink-0 rounded-full transition-transform active:scale-95"
          >
            <Avatar name={user.name} hue={user.hue} photo={user.photo} size={64} />
            <span aria-hidden className="absolute -right-0.5 -bottom-0.5 flex size-7 items-center justify-center rounded-full border-2 border-canvas bg-aurora text-white">
              <Camera size={14} />
            </span>
          </button>
          <button type="button" onClick={() => setOpen('id')} className="min-w-0 flex-1 text-left">
            <span className="block truncate text-[19px] font-semibold">{user.name}</span>
            <span className="block truncate text-[14px] text-ink-soft">{user.handle ? `@${user.handle}` : user.email}</span>
          </button>
        </div>
        <div className="mx-5 my-2 h-px bg-line/70 md:mx-3" />
        <ul>
          <Row
            icon={<Camera size={19} />}
            title="Profile photo"
            hint={user.photo ? 'Change or remove your photo' : 'Add a photo so people recognise you'}
            onClick={() => setOpen('photo')}
          />
          <Row icon={<AtSign size={19} />} title="Your user ID" hint={user.handle ? `@${user.handle} · how friends find you` : 'How friends find you'} onClick={() => setOpen('id')} />
          <Row
            icon={<MonitorSmartphone size={19} />}
            title="Devices"
            hint={sessions ? devicesSummary(sessions) : 'Where you’re logged in'}
            onClick={() => setOpen('devices')}
          />
          <Row icon={<EyeOff size={19} />} title="Privacy" hint="Last seen, read receipts and blocked people" onClick={() => setOpen('privacy')} />
          <Row icon={<Settings2 size={19} />} title="Microphone, speaker and camera" hint="For calls, voice and video" onClick={() => openDevices(true)} />
          {/* The app (1.10.0 on): what it may use on this phone. */}
          {permissions && <Row icon={<ShieldCheck size={19} />} title="App permissions" hint={permissionsSummary(permissions)} onClick={() => setOpen('permissions')} />}
          <Row
            icon={<Moon size={19} />}
            title="Dark theme"
            hint={theme === 'dark' ? 'Midnight Aurora' : 'Off: Ocean Mint'}
            onClick={toggleTheme}
            checked={theme === 'dark'}
            trailing={
              <span aria-hidden className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${theme === 'dark' ? 'bg-aurora' : 'bg-line'}`}>
                <span className={`absolute top-1 size-5 rounded-full bg-white shadow transition-[left] ${theme === 'dark' ? 'left-6' : 'left-1'}`} />
              </span>
            }
          />
          <Row icon={<KeyRound size={19} />} title="Change password" onClick={() => setOpen('password')} />
          <Row icon={<LogOut size={19} />} title="Log out" onClick={() => setOpen('logout')} danger />
        </ul>
        {version && <p className="mt-6 text-center text-[12.5px] text-ink-soft">Adda Khana {version}</p>}
      </div>
      <PhotoEditor open={open === 'photo'} onClose={close} />
      <MyIdDialog open={open === 'id'} onClose={close} />
      <DevicesDialog open={open === 'devices'} onClose={close} />
      <PrivacyDialog open={open === 'privacy'} onClose={close} />
      <PermissionsDialog open={open === 'permissions'} onClose={close} />
      <ChangePasswordDialog open={open === 'password'} onClose={close} />
      <ConfirmDialog
        open={open === 'logout'}
        title="Log out?"
        body="You'll stop getting messages and calls on this device until you log in again."
        confirm="Log out"
        danger
        busy={leaving}
        onConfirm={() => {
          setLeaving(true);
          void logout().finally(() => setLeaving(false));
        }}
        onClose={close}
      />
    </>
  );
}
