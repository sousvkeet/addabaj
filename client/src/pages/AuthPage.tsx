import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { AudioLines, KeyRound, Lock, MailCheck, MessageCircle, MonitorPlay, Radio, Video } from 'lucide-react';
import { api, ApiError, errorMessage } from '../lib/api';
import { useBackClose } from '../lib/back';
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

type Mode = 'login' | 'signup' | 'forgot';
type Options = { allowSignups: boolean; passwordReset: boolean };

export function AuthPage({ mode }: { mode: Mode }) {
  const [options, setOptions] = useState<Options>({ allowSignups: true, passwordReset: false });

  // The host can close sign-ups (then only they can add people), and sets up email.
  useEffect(() => {
    api<Options>('/auth/options')
      .then(setOptions)
      .catch(() => {});
  }, []);

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

      <div className="mx-auto flex w-full max-w-[1180px] flex-col items-center gap-10 px-5 pt-[max(28px,var(--safe-top))] pb-10 lg:flex-row lg:gap-16 lg:px-10">
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
          <div className="glass relative overflow-hidden rounded-[30px] border border-line/80 p-6 shadow-float sm:p-8">
            <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-aurora" />
            {mode === 'login' ? <LogIn options={options} /> : mode === 'signup' ? <SignUp open={options.allowSignups} /> : <ForgotPassword />}
          </div>
        </section>
      </div>
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h2 className="font-display text-[26px] leading-tight font-bold tracking-[-0.02em]">{title}</h2>
      <p className="mt-1.5 text-[14.5px] text-ink-soft">{children}</p>
    </>
  );
}

function Problem({ error }: { error: string }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-[14px] text-danger">
      {error}
    </p>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <p className="mt-5 text-center text-[14px] text-ink-soft">{children}</p>;
}

const linkClass = 'font-semibold text-brand underline-offset-4 hover:underline dark:text-live';

/** The six digits from an email: just digits, however they were typed or pasted. */
function CodeField({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  return (
    <Field label="Code from the email">
      <input
        className={`${inputClass} text-center font-mono text-[22px] tracking-[0.4em]`}
        inputMode="numeric"
        autoComplete="one-time-code"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder="000000"
        required
        autoFocus
      />
    </Field>
  );
}

/** Seconds left until `until` (a time in ms), counting down. */
function useCountdown(until: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (until <= Date.now()) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [until]);
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** "Didn't get it?": another code, once the minute is up. */
function SendAgain({ until, onSend }: { until: number; onSend: () => Promise<void> }) {
  const wait = useCountdown(until);
  const [busy, setBusy] = useState(false);
  return (
    <p className="text-center text-[14px] text-ink-soft">
      Didn’t get it? Check your spam folder, or{' '}
      {wait > 0 ? (
        <span className="tabular-nums">send a new code in {wait} s</span>
      ) : (
        <button
          type="button"
          disabled={busy}
          className={linkClass}
          onClick={() => {
            setBusy(true);
            void onSend().finally(() => setBusy(false));
          }}
        >
          send a new code
        </button>
      )}
      .
    </p>
  );
}

// A step waiting for an emailed code is kept on this device, so it survives a
// trip to the mail app (and a phone closing this app meanwhile).
function recall<T>(key: string, maxAge: number): T | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as { at: number; data: T } | null;
    return saved && Date.now() - saved.at < maxAge ? saved.data : null;
  } catch {
    return null;
  }
}
function remember(key: string, data: unknown) {
  try {
    if (data) localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
    else localStorage.removeItem(key);
  } catch {
    /* private mode: it just isn't kept */
  }
}

const SIGNUP_KEY = 'adda-signup';
const RESET_KEY = 'adda-reset';
/** As long as the server keeps a sign-up waiting, and a reset code works. */
const SIGNUP_MAX_AGE = 24 * 3600_000;
const RESET_MAX_AGE = 15 * 60_000;
type Waiting = { token: string; email: string; resendAt: number };

// ── Log in ────────────────────────────────────────────────────────────

function LogIn({ options }: { options: Options }) {
  const login = useAuth((s) => s.login);
  // Back from the mail app (an app the phone closed meanwhile opens here): carry on where they were.
  const [unfinished] = useState(() => {
    const signup = recall<Waiting>(SIGNUP_KEY, SIGNUP_MAX_AGE);
    if (signup) return { to: '/signup', text: `Finish creating your account: enter the code we emailed to ${signup.email}.` };
    const reset = recall<{ email: string }>(RESET_KEY, RESET_MAX_AGE);
    return reset ? { to: '/forgot', text: `Finish resetting your password: enter the code we emailed to ${reset.email}.` } : null;
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <Heading title="Log in to Adda Khana">Welcome back. Your chats and rooms are waiting.</Heading>
      {unfinished && (
        <Link
          to={unfinished.to}
          replace
          className="mt-5 flex items-center gap-3 rounded-2xl border border-live/40 bg-live/10 p-3.5 text-[14px] text-live-ink transition-colors hover:bg-live/15"
        >
          <MailCheck size={18} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{unfinished.text}</span>
        </Link>
      )}
      <div className="mt-6 space-y-4">
        <Field label="Email or username">
          <input
            className={inputClass}
            type="text"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            autoFocus
            placeholder="you@example.com"
          />
        </Field>
        <div>
          <Field label="Password">
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              placeholder="••••••••"
            />
          </Field>
          {options.passwordReset && (
            <p className="mt-2 text-right text-[13.5px]">
              <Link to="/forgot" state={{ email: email.includes('@') ? email.trim() : '' }} className={linkClass}>
                Forgot password?
              </Link>
            </p>
          )}
        </div>
        <Problem error={error} />
        <Button type="submit" size="lg" busy={busy} className="w-full">
          Log in
        </Button>
      </div>
      {options.allowSignups && (
        <Footer>
          New here?{' '}
          <Link to="/signup" replace className={linkClass}>
            Create an account
          </Link>
        </Footer>
      )}
    </form>
  );
}

// ── Sign up ───────────────────────────────────────────────────────────

function SignUp({ open }: { open: boolean }) {
  const register = useAuth((s) => s.register);
  const [waiting, setWaiting] = useState<Waiting | null>(() => recall<Waiting>(SIGNUP_KEY, SIGNUP_MAX_AGE));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const pending = await register(name, email, password);
      // Otherwise they're in, and on their way to the chats.
      if (pending) {
        const next = { token: pending.token, email: pending.email, resendAt: Date.now() + pending.resendIn * 1000 };
        remember(SIGNUP_KEY, next);
        setWaiting(next);
        setPassword('');
        setBusy(false);
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (waiting) {
    return (
      <ConfirmEmail
        waiting={waiting}
        onRestart={(why) => {
          remember(SIGNUP_KEY, null);
          setWaiting(null);
          setError(why ?? '');
        }}
      />
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <Heading title="Create your account">It takes less than a minute. No phone number needed.</Heading>
      {!open ? (
        <div className="mt-6 rounded-2xl border border-line bg-subtle/60 p-5 text-center">
          <span className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-aurora text-white shadow-glow">
            <Lock size={20} />
          </span>
          <p className="mt-3 font-semibold">Sign-ups are closed right now</p>
          <p className="mt-1 text-[14px] text-ink-soft">Ask the host to make an account for you, then log in.</p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
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
          <Field label="Email">
            <input
              className={inputClass}
              type="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </Field>
          <Field label="Password" hint="At least 8 characters.">
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              placeholder="••••••••"
            />
          </Field>
          <Problem error={error} />
          <Button type="submit" size="lg" busy={busy} className="w-full">
            Create account
          </Button>
        </div>
      )}
      <Footer>
        Already have an account?{' '}
        <Link to="/login" replace className={linkClass}>
          Log in
        </Link>
      </Footer>
    </form>
  );
}

/** The sign-up's last step: the code emailed to the new address. */
function ConfirmEmail({ waiting, onRestart }: { waiting: Waiting; onRestart: (why?: string) => void }) {
  const confirmSignup = useAuth((s) => s.confirmSignup);
  const resendSignup = useAuth((s) => s.resendSignup);
  const [code, setCode] = useState('');
  const [resendAt, setResendAt] = useState(waiting.resendAt);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const tried = useRef('');

  // A sign-up that ran out (a day old, or the code's tries used up and it was restarted elsewhere): start over.
  const gone = (err: unknown) => err instanceof ApiError && err.status === 410;

  async function submit(value: string) {
    if (value.length !== 6) return;
    tried.current = value;
    setError('');
    setNote('');
    setBusy(true);
    try {
      await confirmSignup(waiting.token, value);
      remember(SIGNUP_KEY, null);
    } catch (err) {
      if (gone(err)) return onRestart(errorMessage(err));
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  // All six digits in: check them (once for each code typed).
  useEffect(() => {
    if (code.length === 6 && tried.current !== code && !busy) void submit(code);
  });

  async function sendAgain() {
    setError('');
    setNote('');
    try {
      const at = Date.now() + (await resendSignup(waiting.token)) * 1000;
      setResendAt(at);
      remember(SIGNUP_KEY, { ...waiting, resendAt: at });
      setCode('');
      tried.current = '';
      setNote(`We sent a new code to ${waiting.email}.`);
    } catch (err) {
      if (gone(err)) return onRestart(errorMessage(err));
      setError(errorMessage(err));
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit(code);
      }}
      noValidate
    >
      <span className="mb-4 flex size-11 items-center justify-center rounded-2xl bg-aurora text-white shadow-glow">
        <MailCheck size={20} />
      </span>
      <Heading title="Check your email">
        We sent a 6-digit code to <span className="font-semibold break-all text-ink">{waiting.email}</span>. Enter it to finish creating your account.
      </Heading>
      <div className="mt-6 space-y-4">
        <CodeField value={code} onChange={setCode} />
        <Problem error={error} />
        {note && (
          <p role="status" className="rounded-2xl border border-live/30 bg-live/10 px-4 py-3 text-[14px] text-live-ink">
            {note}
          </p>
        )}
        <Button type="submit" size="lg" busy={busy} disabled={code.length !== 6} className="w-full">
          Create account
        </Button>
        <SendAgain until={resendAt} onSend={sendAgain} />
      </div>
      <Footer>
        <button type="button" className={linkClass} onClick={() => onRestart()}>
          Use a different email
        </button>
      </Footer>
    </form>
  );
}

// ── Forgot password ───────────────────────────────────────────────────

function ForgotPassword() {
  const forgotPassword = useAuth((s) => s.forgotPassword);
  const resetPassword = useAuth((s) => s.resetPassword);
  const location = useLocation();
  const navigate = useNavigate();
  // In the app, Back goes to the login page (rather than leaving the app).
  useBackClose(true, () => {
    if (((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0) void navigate(-1);
    else void navigate('/login', { replace: true });
  });
  const [sent, setSent] = useState<{ email: string; resendAt: number } | null>(() => recall(RESET_KEY, RESET_MAX_AGE));
  const [email, setEmail] = useState(() => sent?.email ?? (location.state as { email?: string } | null)?.email ?? '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    setError('');
    setNote('');
    setBusy(true);
    try {
      const target = sent?.email ?? email.trim();
      const next = { email: target, resendAt: Date.now() + (await forgotPassword(target)) * 1000 };
      remember(RESET_KEY, next);
      if (sent) {
        setCode('');
        setNote(`If ${target} has an account, a new code is on its way.`);
      }
      setSent(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function reset(e: FormEvent) {
    e.preventDefault();
    if (!sent) return;
    setError('');
    setNote('');
    setBusy(true);
    try {
      await resetPassword(sent.email, code, password);
      remember(RESET_KEY, null);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (!sent) {
    return (
      <form onSubmit={send} noValidate>
        <span className="mb-4 flex size-11 items-center justify-center rounded-2xl bg-aurora text-white shadow-glow">
          <KeyRound size={20} />
        </span>
        <Heading title="Forgot your password?">Enter your account’s email, and we’ll send you a code to choose a new password.</Heading>
        <div className="mt-6 space-y-4">
          <Field label="Email">
            <input
              className={inputClass}
              type="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              autoFocus
              placeholder="you@example.com"
            />
          </Field>
          <Problem error={error} />
          <Button type="submit" size="lg" busy={busy} className="w-full">
            Send code
          </Button>
        </div>
        <Footer>
          Remembered it?{' '}
          <Link to="/login" replace className={linkClass}>
            Log in
          </Link>
        </Footer>
      </form>
    );
  }

  return (
    <form onSubmit={reset} noValidate>
      <span className="mb-4 flex size-11 items-center justify-center rounded-2xl bg-aurora text-white shadow-glow">
        <MailCheck size={20} />
      </span>
      <Heading title="Check your email">
        If <span className="font-semibold break-all text-ink">{sent.email}</span> has an account, we sent it a 6-digit code. Enter it with your new password.
      </Heading>
      <div className="mt-6 space-y-4">
        <CodeField value={code} onChange={setCode} />
        <Field label="New password" hint="At least 8 characters. You’ll be logged out everywhere else.">
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
            placeholder="••••••••"
          />
        </Field>
        <Problem error={error} />
        {note && (
          <p role="status" className="rounded-2xl border border-live/30 bg-live/10 px-4 py-3 text-[14px] text-live-ink">
            {note}
          </p>
        )}
        <Button type="submit" size="lg" busy={busy} disabled={code.length !== 6 || password.length < 8} className="w-full">
          Reset password
        </Button>
        <SendAgain until={sent.resendAt} onSend={() => send()} />
      </div>
      <Footer>
        <button
          type="button"
          className={linkClass}
          onClick={() => {
            remember(RESET_KEY, null);
            setSent(null);
            setCode('');
            setError('');
            setNote('');
          }}
        >
          Use a different email
        </button>
        {' · '}
        <Link to="/login" replace className={linkClass}>
          Log in
        </Link>
      </Footer>
    </form>
  );
}
