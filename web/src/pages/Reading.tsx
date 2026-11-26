// Reading documents with the assistant: a quotation or invoice fills in its form, and a page of a
// paper maintenance register becomes rows of checks. The person checks everything before saving.
import { useState } from 'react';
import { api } from '../api.ts';
import { ErrorNote, Link, Loading, PageHead, useAction, useApi } from '../ui.tsx';

export function useReading() {
  return useApi<{ available: boolean }>('/api/read/status').data?.available ?? false;
}

const PURPOSE = { quotation: 'quotation', invoice: 'invoice', register: 'evidence' } as const;

// Uploads the chosen file once, then asks for it to be read. The same upload is kept with the record.
export function ReadButton({ kind, file, onRead }: { kind: 'quotation' | 'invoice'; file: File | null; onRead: (fields: any, fileId: string) => void }) {
  const available = useReading();
  const { busy, error, run } = useAction();
  if (!available) return null;
  return <div className="read-doc">
    <button type="button" disabled={!file || busy} onClick={() => run(async () => {
      const up = await api.upload(`/api/files?purpose=${PURPOSE[kind]}`, file!);
      onRead(await api.post('/api/read', { kind, fileId: up.id }), up.id);
    })}>{busy ? 'Reading the document…' : 'Fill in from the document'}</button>
    {!file && <span className="quiet small">Choose the file first.</span>}
    <ErrorNote error={error} />
  </div>;
}

export function ReadNote({ fields }: { fields: any }) {
  if (!fields) return null;
  return <p className="note">Filled in from the document. Check every field against it before saving{fields.unclear?.length ? `; these were unclear: ${fields.unclear.join('; ')}` : ''}.</p>;
}

// ------------------------------------------------------------------ paper registers
type Row = { routineId: string; activity: string; day: string; time: string; status: string; note: string; reading: string; reference: string };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
// Words common to many checks ("check", "test run") do not decide the match.
const COMMON = new Set(['check', 'checks', 'test', 'run', 'log', 'logs', 'daily', 'weekly', 'monthly', 'round', 'rounds', 'and', 'the', 'readings', 'reading', 'phase', 'block', 'tower', 'towers']);
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\u0B80-\u0BFF ]+/g, ' ').split(/\s+/).filter(w => w.length > 1 && !COMMON.has(w)));
// The routine whose title shares the most words with what was written.
function bestRoutine(activity: string, routines: any[]) {
  const a = words(activity);
  let best: any = null, score = 0;
  for (const r of routines) { const n = [...words(r.title)].filter(w => a.has(w)).length; if (n > score) { best = r; score = n; } }
  return score > 0 ? best.id : '';
}

export function RegisterImport() {
  const available = useReading();
  const routines = useApi<any[]>('/api/routines');
  const past = useApi<any[]>('/api/register-imports');
  const [file, setFile] = useState<File | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const [title, setTitle] = useState('Pump room register');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [unclear, setUnclear] = useState<string[]>([]);
  const [readByAi, setReadByAi] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const { busy, error, run } = useAction();
  const blank = (): Row => ({ routineId: '', activity: '', day: today(), time: '', status: 'done', note: '', reading: '', reference: '' });
  const upload = async () => fileId ?? (async () => { const up = await api.upload('/api/files?purpose=evidence', file!); setFileId(up.id); return up.id; })();
  const set = (i: number, k: keyof Row, v: string) => setRows(rs => rs!.map((r, j) => j === i ? { ...r, [k]: v } : r));
  if (!routines.data) return <Loading />;
  if (done !== null) return <>
    <PageHead title="Paper register" />
    <p className="note ok">{done} checks recorded from “{title}”, with the scan kept as their evidence.</p>
    <div className="actions"><Link to="/work" className="button primary">Back to Today</Link>
      <button onClick={() => { setDone(null); setRows(null); setFile(null); setFileId(null); past.reload(); }}>Enter another page</button></div>
  </>;
  return <>
    <PageHead title="Paper register" />
    <p className="quiet" style={{ maxWidth: '70ch' }}>Where staff still write checks in a register, photograph or scan the page and enter it here.
      {available ? ' The assistant can read the page for you; check every row against the page before recording.' : ' Type each entry from the page.'} The scan is kept with the checks, and the same page cannot be entered twice.</p>
    <section className="panel pad">
      <div className="two">
        <label className="field">Register<input value={title} onChange={e => setTitle(e.target.value)} placeholder="For example, Pump room register" /></label>
        <label className="field">Photo or scan of the page<input type="file" accept=".pdf,image/*" onChange={e => { setFile(e.target.files?.[0] ?? null); setFileId(null); setRows(null); }} /></label>
      </div>
      <div className="actions">
        {available && <button className="primary" disabled={!file || busy} onClick={() => run(async () => {
          const id = await upload();
          const r = await api.post('/api/read', { kind: 'register', fileId: id });
          setUnclear(r.unclear ?? []); setReadByAi(true);
          setRows((r.entries.length ? r.entries : [{}]).map((e: any) => ({ ...blank(), activity: e.activity ?? '', day: e.day ?? today(), time: e.time ?? '',
            status: e.status ?? 'done', note: e.remarks ?? '', reading: e.reading ?? '', reference: e.reference ?? '', routineId: bestRoutine(e.activity ?? '', routines.data!) })));
        })}>{busy && !rows ? 'Reading the page…' : 'Read the page'}</button>}
        <button disabled={!file || busy} onClick={() => setRows([blank()])}>Type the entries</button>
      </div>
      {!rows && <ErrorNote error={error} />}
    </section>
    {rows && <section>
      {readByAi && <p className="note">Read from the page. Choose the check for each row, and correct anything that does not match the page{unclear.length ? `. Unclear: ${unclear.join('; ')}` : ''}.</p>}
      <div className="register-rows">{rows.map((r, i) => <fieldset key={i} className="panel pad register-row">
        <legend>Row {i + 1}{r.activity ? `: ${r.activity}` : ''}</legend>
        <div className="two">
          <label className="field">Check<select required value={r.routineId} onChange={e => set(i, 'routineId', e.target.value)}><option value="">Choose the check…</option>
            {routines.data!.map(x => <option key={x.id} value={x.id}>{x.title}{x.place ? `, ${x.place}` : ''}</option>)}</select></label>
          <label className="field">Result<select value={r.status} onChange={e => set(i, 'status', e.target.value)}>
            <option value="done">Done</option><option value="skipped">Skipped</option><option value="blocked">Could not be done</option></select></label>
          <label className="field">Date<input type="date" required max={today()} value={r.day} onChange={e => set(i, 'day', e.target.value)} /></label>
          <label className="field">Time{r.status === 'done' ? '' : ' (optional)'}<input type="time" required={r.status === 'done'} value={r.time} onChange={e => set(i, 'time', e.target.value)} /></label>
          <label className="field">Reading (if any)<input inputMode="decimal" value={r.reading} onChange={e => set(i, 'reading', e.target.value)} /></label>
          <label className="field">Reference (if any)<input value={r.reference} onChange={e => set(i, 'reference', e.target.value)} /></label>
        </div>
        <label className="field">Remarks{r.status === 'done' ? ' (optional)' : ''}<input required={r.status !== 'done'} value={r.note} onChange={e => set(i, 'note', e.target.value)} /></label>
        <div className="actions"><button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove this row</button></div>
      </fieldset>)}</div>
      <ErrorNote error={error} />
      <div className="actions">
        <button type="button" onClick={() => setRows([...rows, blank()])}>Add a row</button>
        <button className="primary" disabled={busy || !rows.length || rows.some(r => !r.routineId)} onClick={() => run(async () => {
          const id = await upload();
          const r = await api.post('/api/register-imports', { fileId: id, title, readByAi, rows: rows.map(x => ({ routineId: x.routineId, day: x.day, status: x.status,
            performedAt: x.time || null, note: x.note, reading: x.reading || null, reference: x.reference || null })) });
          setDone(r.entries);
        })}>Record {rows.length} {rows.length === 1 ? 'check' : 'checks'}</button>
      </div>
    </section>}
    {(past.data?.length ?? 0) > 0 && <section><header><h2>Pages entered</h2></header>
      <div className="rows">{past.data!.map(p => <a key={p.id} className="row" href={`/api/files/${p.file_id}`}>
        <span><span className="title">{p.title}</span><br /><span className="meta">{p.entries} checks, by {p.by}{p.read_by_ai ? ', read by the assistant' : ''}</span></span>
        <span className="side quiet">{new Date(p.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span></a>)}</div></section>}
  </>;
}
