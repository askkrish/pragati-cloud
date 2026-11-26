// The person's own account: photo, language and home screen.
import { useState } from 'react';
import { api, phoneDisplay } from '../api.ts';
import { setLang, t, useLang } from '../i18n.ts';
import { useApp } from '../main.tsx';
import { ErrorNote, Initials, Link, PageHead, useAction } from '../ui.tsx';

// Photos are made small and square on the phone before upload; this also drops the camera's
// location and other details stored inside the original picture.
export async function squarePhoto(file: File, size = 320): Promise<File> {
  const img = await createImageBitmap(file);
  const side = Math.min(img.width, img.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d')!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('The photo could not be prepared.')), 'image/jpeg', 0.86));
  return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
}

export function PhotoPicker({ name, photo, onSave, onRemove }: { name: string; photo: string | null; onSave: (fileId: string) => Promise<void>; onRemove: () => Promise<void> }) {
  const { busy, error, run } = useAction();
  return <div className="photo-picker">
    <Initials name={name} photo={photo} size={96} />
    <div className="actions">
      <label className="button">{photo ? 'Change photo' : 'Add a photo'}
        <input type="file" accept="image/*" hidden disabled={busy} onChange={e => { const f = e.target.files?.[0]; if (f) run(async () => {
          const up = await api.upload('/api/files?purpose=avatar', await squarePhoto(f)); await onSave(up.id); }); e.target.value = ''; }} /></label>
      {photo && <button type="button" disabled={busy} onClick={() => run(onRemove)}>Remove photo</button>}
    </div>
    <ErrorNote error={error} />
  </div>;
}

export function Account() {
  const { me, community } = useApp();
  const lang = useLang();
  const [photo, setPhoto] = useState<string | null>(me.person.photo ?? null);
  return <>
    <PageHead title="Your account" />
    <section className="panel pad account">
      <PhotoPicker name={me.person.name} photo={photo}
        onSave={async id => { await api.put('/api/me/photo', { fileId: id }); setPhoto(id); }}
        onRemove={async () => { await api.put('/api/me/photo', { fileId: null }); setPhoto(null); }} />
      <p className="quiet small">Your photo is seen by people in {community.brandName} wherever your name appears, such as committee lists and approvals.</p>
      <dl className="facts">
        <div><dt>Name</dt><dd>{me.person.name}</dd></div>
        <div><dt>{t('Mobile number')}</dt><dd>{phoneDisplay(me.person.phone)}</dd></div>
        <div><dt>Roles</dt><dd>{me.roles.length ? me.roles.map(r => r.scope ? `${r.name}, ${r.scope}` : r.name).join('; ') : 'None'}</dd></div>
      </dl>
      <p className="quiet small">To change your name or number, ask your association office.</p>
    </section>
    <section className="panel pad">
      <h2>Language</h2>
      <div className="actions">{community.languages.map(l => <button key={l} className={l === lang ? 'primary' : ''} onClick={() => setLang(l)}>
        {{ en: 'English', ta: 'தமிழ்', hi: 'हिंदी' }[l] ?? l}</button>)}</div>
      <p className="quiet small">Voice entry listens in the language chosen here.</p>
    </section>
    <section className="panel pad">
      <h2>Home screen</h2>
      <p>Choose the order of the panels on your home screen, and hide the ones you do not need. <Link to="/">Go to Home</Link> and choose "Arrange this screen" at the bottom.</p>
    </section>
  </>;
}
