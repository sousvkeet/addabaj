import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { AudioLines, Lock, MessageCircle, MonitorPlay, Radio, Video } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../store/auth';
import { Button } from '../components/ui/Button';
import { Field, inputClass } from '../components/ui/Dialog';
import { Logo, Wordmark } from '../components/ui/Logo';

const FEATURES = [
  { Icon: MessageCircle, label: 'Chats, photos and voice notes' },
  { Icon: Video, label: 'HD voice and video calls' },
  { Icon: AudioLines, label: 'Rooms with live voice' },
  { Icon: MonitorPlay, label: 'Watch videos together' },
];

export function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const login = useAuth((s) => s.login);
  const register = useAuth((s) => s.register);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [signupsOpen, setSignupsOpen] = useState(true);
  const signup = mode === 'signup';

  // The host can close sign-ups; then only they can add people.
  useEffect(() => {
    api<{ allowSignups: boolean }>('/auth/options')
      .then((o) => setSignupsOpen(o.allowSignups))
      .catch(() => {});
  }, []);
  const closed = signup && !signupsOpen;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (signup) await register(name, email, password);
      else await login(email, password);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="relative isolate flex min-h-full overflow-hidden">
      {/* Slow aurora behind everything. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <span className="aurora-blob -top-40 -left-32 size-[520px] bg-brand" />
        <span className="aurora-blob top-1/3 -right-40 size-[480px] bg-brand-2 [animation-delay:-6s]" />
        <span className="aurora-blob -bottom-48 left-1/3 size-[420px] bg-live opacity-30 [animation-delay:-12s]" />
        <div
          className="absolute inset-0 opacity-[0.035]"
          style={{ backgroundImage: 'radial-gradient(currentColor 1px, transparent 1px)', backgroundSize: '22px 22px' }}
        />
      </div>

      <div className="mx-auto flex w-full max-w-[1180px] flex-col items-center gap-10 px-5 pt-[max(28px,env(safe-area-inset-top))] pb-10 lg:flex-row lg:gap-16 lg:px-10">
        <section className="w-full max-w-[560px] lg:flex-1">
          <div className="flex items-center gap-3">
            <Logo size={48} className="drop-shadow-[0_10px_24px_var(--logo-glow)]" />
            <Wordmark className="text-[24px]" />
          </div>
          <h1 className="mt-6 font-display text-[clamp(2rem,4.2vw,3.6rem)] leading-[1.05] font-bold tracking-[-0.035em] lg:mt-8">
            Where your friends <br className="hidden lg:block" />
            <span className="text-aurora">hang out live.</span>
          </h1>
          <p className="mt-4 hidden max-w-[44ch] text-[17px] text-ink-soft lg:block">
            Chat one to one, call with a tap, and gather in rooms to talk, listen and watch together for hours.
          </p>
          <ul className="mt-8 hidden grid-cols-2 gap-3 lg:grid">
            {FEATURES.map(({ Icon, label }) => (
              <li key={label} className="glass flex items-center gap-3 rounded-2xl border border-line/70 p-3.5 text-[14px] font-semibold">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-aurora text-white shadow-glow">
                  <Icon size={17} />
                </span>
                {label}
              </li>
            ))}
          </ul>
          <div aria-hidden className="mt-8 hidden items-center gap-3 lg:flex">
            <span className="flex items-center gap-2 rounded-full border border-live/40 bg-live/10 px-3 py-1.5 text-[12.5px] font-bold text-live-ink">
              <Radio size={14} />
              LIVE in Friday Night Adda
            </span>
            <span className="flex -space-x-2">
              {[262, 320, 190, 40].map((h) => (
                <span
                  key={h}
                  className="size-8 rounded-full border-2 border-canvas"
                  style={{ background: `linear-gradient(135deg, hsl(${h} 78% 62%), hsl(${(h + 48) % 360} 72% 48%))` }}
                />
              ))}
            </span>
            <span className="text-[13px] text-ink-soft">4 people talking</span>
          </div>
        </section>

        <section className="w-full max-w-[440px]">
          <form
            onSubmit={submit}
            className="glass relative overflow-hidden rounded-[30px] border border-line/80 p-6 shadow-float sm:p-8"
            noValidate
          >
            <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-aurora" />
            <h2 className="font-display text-[26px] leading-tight font-bold tracking-[-0.02em]">
              {signup ? 'Create your account' : 'Log in to Adda Khana'}
            </h2>
            <p className="mt-1.5 text-[14.5px] text-ink-soft">
              {signup ? 'It takes less than a minute. No phone number needed.' : 'Welcome back. Your chats and rooms are waiting.'}
            </p>
            {closed ? (
              <div className="mt-6 rounded-2xl border border-line bg-subtle/60 p-5 text-center">
                <span className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-aurora text-white shadow-glow">
                  <Lock size={20} />
                </span>
                <p className="mt-3 font-semibold">Sign-ups are closed right now</p>
                <p className="mt-1 text-[14px] text-ink-soft">Ask the host to make an account for you, then log in.</p>
              </div>
            ) : (
            <div className="mt-6 space-y-4">
              {signup && (
                <Field label="Your name" hint="This is how people see you in chats and rooms.">
                  <input
                    className={inputClass}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    maxLength={40}
                    required
                    autoFocus
                    placeholder="Asha Sen"
                  />
                </Field>
              )}
              <Field label={signup ? 'Email' : 'Email or username'}>
                <input
                  className={inputClass}
                  type={signup ? 'email' : 'text'}
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete={signup ? 'email' : 'username'}
                  required
                  autoFocus={!signup}
                  placeholder="you@example.com"
                />
              </Field>
              <Field label="Password" hint={signup ? 'At least 8 characters.' : undefined}>
                <input
                  className={inputClass}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={signup ? 'new-password' : 'current-password'}
                  minLength={signup ? 8 : undefined}
                  required
                  placeholder="••••••••"
                />
              </Field>
              {error && (
                <p role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-[14px] text-danger">
                  {error}
                </p>
              )}
              <Button type="submit" size="lg" busy={busy} className="w-full">
                {signup ? 'Create account' : 'Log in'}
              </Button>
            </div>
            )}
            {(signup || signupsOpen) && (
              <p className="mt-5 text-center text-[14px] text-ink-soft">
                {signup ? 'Already have an account? ' : 'New here? '}
                <Link to={signup ? '/login' : '/signup'} className="font-semibold text-brand underline-offset-4 hover:underline dark:text-live">
                  {signup ? 'Log in' : 'Create an account'}
                </Link>
              </p>
            )}
          </form>
        </section>
      </div>
    </div>
  );
}
