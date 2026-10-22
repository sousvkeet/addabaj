import { useEffect, useState, type FormEvent } from 'react';
import { CircleCheck, Mail, Send } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../store/auth';
import { toast } from '../../store/ui';
import { Button } from '../../components/ui/Button';
import { Field, inputClass } from '../../components/ui/Dialog';
import { Toggle } from '../../components/ui/Toggle';
import { Panel } from './shared';

type Security = 'starttls' | 'tls' | 'none';
type EmailSettings = {
  enabled: boolean;
  host: string;
  port: number;
  security: Security;
  user: string;
  from: string;
  verifySignups: boolean;
  /** A password is saved (it's never sent back). */
  passwordSet: boolean;
  /** Where these came from: this page, or server/.env. */
  source: 'admin' | 'env' | null;
  envAvailable: boolean;
  ready: boolean;
};

const SECURITY: { value: Security; label: string; port: number }[] = [
  { value: 'starttls', label: 'STARTTLS (usually port 587)', port: 587 },
  { value: 'tls', label: 'SSL/TLS (usually port 465)', port: 465 },
  { value: 'none', label: 'None (not encrypted)', port: 25 },
];

/** The mail server Adda Khana sends codes through: confirming new accounts and resetting passwords. */
export function EmailSettingsPanel() {
  const me = useAuth((s) => s.user);
  const [saved, setSaved] = useState<EmailSettings | null>(null);
  const [form, setForm] = useState<EmailSettings | null>(null);
  const [password, setPassword] = useState('');
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'env'>('');
  const [error, setError] = useState('');

  const load = (email: EmailSettings) => {
    setSaved(email);
    setForm(email);
    setPassword('');
  };

  useEffect(() => {
    api<{ email: EmailSettings }>('/admin/email')
      .then(({ email }) => load(email))
      .catch((err) => setError(errorMessage(err)));
  }, []);

  useEffect(() => {
    if (me?.email?.includes('@')) setTestTo((t) => t || me.email!);
  }, [me?.email]);

  if (!form || !saved) {
    return (
      <Panel title="Email">
        {error ? <p className="text-[14px] text-danger">{error}</p> : <p className="text-[14px] text-ink-soft">Loading…</p>}
      </Panel>
    );
  }

  const set = <K extends keyof EmailSettings>(key: K, value: EmailSettings[K]) => setForm({ ...form, [key]: value });
  const changed = password !== '' || (['enabled', 'host', 'port', 'security', 'user', 'from', 'verifySignups'] as const).some((k) => form[k] !== saved[k]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy('save');
    try {
      const { email } = await api<{ email: EmailSettings }>('/admin/email', {
        method: 'PUT',
        body: {
          enabled: form!.enabled,
          host: form!.host,
          port: form!.port,
          security: form!.security,
          user: form!.user,
          from: form!.from,
          verifySignups: form!.verifySignups,
          ...(password ? { password } : {}),
        },
      });
      load(email);
      toast(email.ready ? 'Email settings saved. Send a test to check them.' : 'Email settings saved. Email is off.', 'live');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy('');
    }
  }

  async function test() {
    setBusy('test');
    try {
      await api('/admin/email/test', { method: 'POST', body: { to: testTo } });
      toast(`Test email sent to ${testTo}. Check that inbox (and its spam folder).`, 'live');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy('');
    }
  }

  async function switchToEnv() {
    setBusy('env');
    try {
      const { email } = await api<{ email: EmailSettings }>('/admin/email', { method: 'DELETE' });
      load(email);
      toast('Using the email settings in the server’s .env file.', 'live');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <Panel
      title="Email"
      hint="Codes by email: new people confirm their address, and anyone can reset a forgotten password. Without it, only you can reset passwords (from People)."
    >
      <p
        role="status"
        className={`mb-4 flex items-start gap-2.5 rounded-2xl border p-3.5 text-[14px] ${
          saved.ready ? 'border-live/30 bg-live/10 text-live-ink' : 'border-line bg-subtle/60 text-ink-soft'
        }`}
      >
        {saved.ready ? <CircleCheck size={18} className="mt-px shrink-0" /> : <Mail size={18} className="mt-px shrink-0" />}
        <span>
          {saved.ready
            ? saved.verifySignups
              ? 'Email is on. New accounts confirm their email with a code, and people can reset a forgotten password.'
              : 'Email is on. People can reset a forgotten password; new accounts don’t confirm their email.'
            : 'Email is off. Sign-ups don’t confirm an email, and there’s no “Forgot password?”.'}
          {saved.source === 'env' && ' These settings come from the server’s .env file; saving here takes over from it.'}
        </span>
      </p>

      <form onSubmit={save} className="space-y-4" noValidate>
        <Toggle checked={form.enabled} onChange={(on) => set('enabled', on)} label="Send email from Adda Khana" hint="Through your mail server, below." />
        <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
          <Field label="Mail server (SMTP)">
            <input className={inputClass} value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.gmail.com" autoCapitalize="none" spellCheck={false} />
          </Field>
          <Field label="Port">
            <input className={inputClass} inputMode="numeric" value={form.port || ''} onChange={(e) => set('port', Number(e.target.value.replace(/\D/g, '').slice(0, 5)))} placeholder="587" />
          </Field>
        </div>
        <Field label="Security">
          <select
            className={inputClass}
            value={form.security}
            onChange={(e) => {
              const next = SECURITY.find((s) => s.value === e.target.value)!;
              // The usual port for it, unless they'd chosen an unusual one.
              const usual = SECURITY.some((s) => s.port === form.port);
              setForm({ ...form, security: next.value, port: usual ? next.port : form.port });
            }}
          >
            {SECURITY.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username">
            <input className={inputClass} value={form.user} onChange={(e) => set('user', e.target.value)} placeholder="you@gmail.com" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </Field>
          <Field label="Password" hint={saved.passwordSet ? 'Saved. Leave empty to keep it.' : undefined}>
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={saved.passwordSet ? '••••••••' : 'App password'}
              autoComplete="new-password"
            />
          </Field>
        </div>
        <Field label="Emails come from" hint="The name and address people see. Use an address your mail server may send as.">
          <input className={inputClass} value={form.from} onChange={(e) => set('from', e.target.value)} placeholder="Adda Khana <no-reply@yourdomain.com>" spellCheck={false} />
        </Field>
        <Toggle
          checked={form.verifySignups}
          onChange={(on) => set('verifySignups', on)}
          label="New people confirm their email with a code"
          hint="Their account is made once they enter the code we email them. People already here aren't asked."
        />
        <p className="text-[13px] text-ink-soft">
          Gmail: smtp.gmail.com, port 587, STARTTLS, your Gmail address as the username, and an app password (Google Account › Security › 2-Step Verification › App passwords).
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {saved.source === 'admin' && saved.envAvailable && (
            <Button type="button" variant="ghost" size="sm" busy={busy === 'env'} onClick={() => void switchToEnv()}>
              Use the .env settings
            </Button>
          )}
          <Button type="submit" size="sm" busy={busy === 'save'} disabled={!changed}>
            Save
          </Button>
        </div>
      </form>

      <div className="mt-5 border-t border-line/70 pt-4">
        <p className="mb-2 text-[13.5px] font-semibold">Send a test email</p>
        <div className="flex flex-wrap gap-2">
          <input
            className={`${inputClass} min-w-[200px] flex-1`}
            type="email"
            aria-label="Send a test email to"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="you@example.com"
            autoCapitalize="none"
            spellCheck={false}
          />
          <Button variant="soft" busy={busy === 'test'} disabled={!saved.ready || !testTo.includes('@') || changed} onClick={() => void test()}>
            <Send size={16} />
            Send test
          </Button>
        </div>
        {saved.ready && changed && <p className="mt-2 text-[13px] text-ink-soft">Save your changes first, then test them.</p>}
      </div>
    </Panel>
  );
}
