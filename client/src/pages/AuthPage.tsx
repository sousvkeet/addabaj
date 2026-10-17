import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../lib/api';
import { useAuth } from '../store/auth';
import { Button } from '../components/ui/Button';
import { Field, inputClass } from '../components/ui/Dialog';

export function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const login = useAuth((s) => s.login);
  const register = useAuth((s) => s.register);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';

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
    <div className="flex min-h-full flex-col bg-wall md:flex-row">
      {/* The shop front: a rolling shutter lifts to reveal the wordmark. */}
      <section className="relative isolate flex shrink-0 flex-col justify-end overflow-hidden bg-shutter-deep px-6 pt-16 pb-8 text-on-shutter md:w-[52%] md:px-14 md:pb-16">
        <div
          aria-hidden
          className="absolute inset-0 -z-10 opacity-[0.07]"
          style={{ background: 'repeating-linear-gradient(180deg, #fff 0 1px, transparent 1px 26px)' }}
        />
        <div aria-hidden className="shop-shutter absolute inset-0 z-10" />
        <p
          lang="bn"
          className="font-display text-[clamp(5.5rem,17vw,12.5rem)] leading-[0.85] tracking-tight text-taxi"
        >
          আড্ডা
        </p>
        <h1 className="mt-4 font-display text-[clamp(1.6rem,3vw,2.3rem)] leading-tight">Adda Khana</h1>
        <p className="mt-2 max-w-[34ch] text-[16px] text-on-shutter/75">
          Chat one-to-one, call with a tap, and gather in rooms to talk for hours.
        </p>
      </section>

      <section className="flex flex-1 items-center justify-center px-6 py-10">
        <form onSubmit={submit} className="w-full max-w-[380px] space-y-5" noValidate>
          <h2 className="font-display text-[28px] leading-tight">
            {signup ? 'Create your account' : 'Log in to Adda Khana'}
          </h2>
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
              />
            </Field>
          )}
          <Field label="Email">
            <input
              className={inputClass}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              autoFocus={!signup}
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
            />
          </Field>
          {error && (
            <p role="alert" className="rounded-xl bg-oxide/10 px-3.5 py-2.5 text-[14px] text-oxide">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" busy={busy} className="w-full">
            {signup ? 'Create account' : 'Log in'}
          </Button>
          <p className="text-[14px] text-ink-soft">
            {signup ? 'Already have an account? ' : 'New here? '}
            <Link to={signup ? '/login' : '/signup'} className="font-semibold text-shutter underline-offset-4 hover:underline dark:text-taxi">
              {signup ? 'Log in' : 'Create an account'}
            </Link>
          </p>
        </form>
      </section>
    </div>
  );
}
