import { useState } from 'react';
import { api } from '../api.ts';
import { t, useLang } from '../i18n.ts';
import type { Community } from '../main.tsx';
import { ErrorNote, useAction } from '../ui.tsx';

export function SignIn({ community, onSignedIn }: { community: Community; onSignedIn: () => void }) {
  useLang();
  const [phone, setPhone] = useState('');
  const [challenge, setChallenge] = useState<{ id: string; devCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const { busy, error, run, setError } = useAction();

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api.post('/api/auth/otp/start', { phone });
      setChallenge({ id: r.challengeId, devCode: r.devCode });
      setCode('');
    });
  };
  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => { await api.post('/api/auth/otp/verify', { challengeId: challenge!.id, code }); onSignedIn(); });
  };
  const digits = phone.replace(/\D/g, '');

  return <div className="signin">
    <div className="hero">
      <div className="platform-name">{community.platformName}</div>
      <p>Your community's homes, committees and decisions, in one place.</p>
    </div>
    <div className="card"><div>
      {!challenge ? <form className="form" onSubmit={send}>
        <h2>{t('Sign in')}</h2>
        <label className="field">{t('Mobile number')}
          <span className="phone-input"><span>+91</span>
            <input inputMode="tel" autoComplete="tel-national" value={phone} onChange={e => setPhone(e.target.value)}
              placeholder="98400 12345" required autoFocus /></span>
          <span className="hint">Use the number your association has for you. We'll send a 6-digit code by SMS.</span>
        </label>
        <ErrorNote error={error} />
        <button className="primary" disabled={busy || digits.length < 10}>{busy ? 'Sending…' : t('Send code')}</button>
      </form> : <form className="form" onSubmit={verify}>
        <h2>{t('Enter the 6-digit code')}</h2>
        <p className="quiet">If {digits.slice(-10, -5)} {digits.slice(-5)} has access, the code is on its way. It works for 5 minutes.</p>
        {challenge.devCode && <p className="note">Development mode: the code is {challenge.devCode}</p>}
        <input className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, ''))} aria-label="6-digit code" autoFocus />
        <ErrorNote error={error} />
        <button className="primary" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : t('Sign in')}</button>
        <button type="button" className="quiet-btn" onClick={() => { setChallenge(null); setError(null); }}>{t('Use a different number')}</button>
      </form>}
    </div></div>
  </div>;
}
