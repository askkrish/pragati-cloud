// Ask Pragathi: plain questions about the community, answered from its records with only what the
// person may see.
import { useEffect, useRef, useState } from 'react';
import { api, shortDate } from '../api.ts';
import { t, useLang } from '../i18n.ts';
import { can, useApp } from '../main.tsx';
import { ErrorNote, Link, Loading, navigate, PageHead, useAction, useApi } from '../ui.tsx';

// Switching off is rare and affects everyone, so it asks first.
const confirmOff = () => window.confirm('Switch off the assistant for everyone in the community?');

type Turn = { q: string; a: string; lookups?: string[]; id?: string; draft?: any };

// What to suggest depends on what the person can see.
function suggestions(me: any): string[] {
  const s: string[] = [];
  if (me.homes.length) s.push('How much do I owe, and when is it due?', 'What is happening with my requests?');
  s.push('Any notices this week that affect me?');
  if (can(me, 'operations.view')) s.push('Which checks were missed this week, and by whom?', 'Which AMCs or licences need renewing soon?');
  if (can(me, 'approvals.view')) s.push('What is waiting for approval, and for how long?');
  if (can(me, 'finance.view')) s.push('How much is overdue by more than 90 days, and from how many homes?', 'How did spending compare with the budget this year?');
  if (can(me, 'procurement.view')) s.push('Compare the quotations for the clubhouse roof waterproofing.');
  return s.slice(0, 6);
}

// Answers are plain text with "- " lists.
export function Answer({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const linked = (line: string) => line.split(/\b([A-Z]{2}-\d{4,})\b/).map((part, i) => i % 2 ? <Link key={i} to={`/go/${part}`}>{part}</Link> : part);
  const flush = () => { if (list.length) blocks.push(<ul key={blocks.length}>{list.map((l, i) => <li key={i}>{linked(l)}</li>)}</ul>); list = []; };
  // References such as WO-0012 open the record, through the same access checks as everywhere else.
  for (const raw of text.replace(/\*\*/g, '').split('\n')) {
    const line = raw.trim();
    if (/^[-•*] /.test(line)) { list.push(line.slice(2)); continue; }
    flush();
    if (line) blocks.push(<p key={blocks.length}>{linked(line.replace(/^#+\s*/, ''))}</p>);
  }
  flush();
  return <div className="answer">{blocks}</div>;
}

export function Ask() {
  const { me, community } = useApp();
  const lang = useLang();
  const status = useApi<any>('/api/ask/status');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState(() => new URLSearchParams(location.search).get('q') ?? '');
  const { busy, error, run } = useAction();
  const end = useRef<HTMLFormElement>(null);
  const asked = useRef(false);

  const ask = (question: string) => run(async () => {
    const r = await api.post('/api/ask', { question, language: lang, earlier: turns.slice(-4).map(({ q, a }) => ({ q, a })) });
    setTurns(ts => [...ts, { q: question, a: r.answer, lookups: r.lookups, id: r.id, draft: r.draft }]);
    setQ('');
    status.reload();
  });
  // A question passed from the Home box is asked straight away.
  useEffect(() => {
    if (!asked.current && status.data?.available && q.trim().length > 1 && new URLSearchParams(location.search).get('q')) {
      asked.current = true; history.replaceState(null, '', '/ask'); ask(q.trim());
    }
  }, [status.data]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns.length, busy]);

  if (status.loading && !status.data) return <Loading />;
  const s = status.data;
  if (!s?.available) return <>
    <PageHead title={community.assistantName} />
    <AssistantOff status={s} reload={status.reload} />
  </>;

  return <>
    <PageHead title={community.assistantName}><Link to="/ask/history" className="button">Earlier questions</Link></PageHead>
    <p className="quiet" style={{ maxWidth: '68ch' }}>Ask in plain words, in English or தமிழ். Answers come from {community.platformName}'s records, and only from what you are allowed to see. Check anything important in the app before acting on it.</p>
    {turns.length === 0 && <div className="suggest">{suggestions(me).map(x => <button key={x} type="button" onClick={() => ask(x)} disabled={busy}>{x}</button>)}</div>}
    <div className="chat" aria-live="polite">
      {turns.map((tn, i) => <div key={i} className="turn">
        <p className="asked">{tn.q}</p>
        <Answer text={tn.a} />
        {tn.draft && <DraftRequest draft={tn.draft} />}
        {tn.id && <AnswerTools id={tn.id} text={tn.a} />}
      </div>)}
      {busy && <div className="turn"><p className="quiet thinking">Looking through the records…</p></div>}
    </div>
    <ErrorNote error={error} />
    <form ref={end} className="ask-box" onSubmit={e => { e.preventDefault(); if (q.trim().length > 1) ask(q.trim()); }}>
      <textarea rows={2} value={q} maxLength={1000} onChange={e => setQ(e.target.value)} placeholder={turns.length ? 'Ask a follow-up' : 'Ask a question'} aria-label="Your question"
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (q.trim().length > 1 && !busy) ask(q.trim()); } }} />
      <button className="primary" disabled={busy || q.trim().length < 2}>{t('Ask')}</button>
    </form>
    <p className="quiet small">{s.remainingToday} questions left today.{turns.length > 0 && <> <button type="button" className="link" onClick={() => setTurns([])}>Start a new conversation</button></>}
      {s.canSwitch && <> <button type="button" className="link" onClick={() => { if (confirmOff()) api.patch('/api/ask/settings', { enabled: false }).then(() => location.assign('/')); }}>
        Switch off for the community</button></>}</p>
  </>;
}

function AnswerTools({ id, text }: { id: string; text: string }) {
  const [rated, setRated] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const rate = (helpful: boolean) => api.post(`/api/ask/${id}/rating`, { helpful }).then(() => setRated(helpful)).catch(() => {});
  return <div className="answer-tools">
    <button type="button" className="link" onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? 'Copied' : 'Copy'}</button>
    {rated === null ? <>
      <button type="button" className="link" onClick={() => rate(true)} aria-label="This answer helped">Helpful</button>
      <button type="button" className="link" onClick={() => rate(false)} aria-label="This answer did not help">Not helpful</button>
    </> : <span className="quiet small">Thanks for the rating.</span>}
  </div>;
}

// A request the assistant drafted: the person checks it, changes anything, and sends it themselves.
function DraftRequest({ draft }: { draft: any }) {
  const [f, setF] = useState({ title: draft.title, details: draft.details, urgent: draft.urgent });
  const [sent, setSent] = useState<any>(null);
  const { busy, error, run } = useAction();
  if (sent) return <p className="note ok">Request {sent.ref} sent. <Link to={`/work/orders/${sent.id}`}>Follow it here</Link>.</p>;
  return <form className="form panel pad draft" onSubmit={e => { e.preventDefault(); run(async () => {
    setSent(await api.post('/api/work', { kind: 'request', unitId: draft.unitId, title: f.title, details: f.details, category: draft.category,
      priority: f.urgent ? 'urgent' : 'normal', permitKind: draft.permitKind })); }); }}>
    <p className="quiet small">Draft request for {draft.unit}{draft.permitKind ? ', needing the committee\'s permission' : ''}. Check it and send it, or change anything first.</p>
    <label className="field">What is the problem<input required minLength={3} value={f.title} onChange={e => setF({ ...f, title: e.target.value })} /></label>
    <label className="field">Details<textarea value={f.details} onChange={e => setF({ ...f, details: e.target.value })} /></label>
    <label className="check"><input type="checkbox" checked={f.urgent} onChange={e => setF({ ...f, urgent: e.target.checked })} />Urgent</label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Send request</button></div>
  </form>;
}

function AssistantOff({ status, reload }: { status: any; reload: () => void }) {
  const { community } = useApp();
  const act = useAction();
  if (!status?.configured) return <p className="note" style={{ maxWidth: '68ch' }}>{community.assistantName} is not available on this platform yet. It needs the platform's AI key, which the platform team adds.</p>;
  return <section className="panel pad" style={{ maxWidth: '68ch' }}>
    <h2>{community.assistantName} is switched off for this community</h2>
    {status.canSwitch ? <>
      <p>When it is on, owners, residents, staff and the committee can ask questions in plain words and get answers from the community's records: dues, requests, work, notices, approvals and, for those allowed, the accounts.</p>
      <p>To answer, the question and the records it needs are sent to the AI provider (Anthropic's Claude). Phone numbers, email addresses and bank details are removed first. Each person sees only what their role allows, and the AI can only read, never change anything.</p>
      <ErrorNote error={act.error} />
      <div className="actions"><button className="primary" disabled={act.busy} onClick={() => act.run(async () => { await api.patch('/api/ask/settings', { enabled: true }); location.reload(); })}>Switch it on</button></div>
    </> : <p>Your committee can switch it on in the app.</p>}
  </section>;
}

export function AskHistory() {
  const { data, loading, error } = useApi<any[]>('/api/ask/history');
  const { community } = useApp();
  return <>
    <PageHead title="Earlier questions" crumbs={[{ to: '/ask', label: community.assistantName }, { label: 'Earlier questions' }]} />
    <ErrorNote error={error} />
    {loading && !data ? <Loading /> : data?.length ? <div className="chat">{data.map(x => <div key={x.id} className="turn">
      <p className="asked">{x.question} <span className="quiet small">{shortDate(x.created_at)}</span></p>
      {x.answer ? <Answer text={x.answer} /> : <p className="quiet">No answer: the assistant could not reach the AI provider.</p>}
    </div>)}</div> : <p className="empty">You have not asked anything yet.</p>}
  </>;
}

export function AskPanel() {
  const { community } = useApp();
  const status = useApi<any>('/api/ask/status');
  const [q, setQ] = useState('');
  if (!status.data?.available) return null;
  return <form className="ask-home" onSubmit={e => { e.preventDefault(); if (q.trim().length > 1) navigate(`/ask?q=${encodeURIComponent(q.trim())}`); }}>
    <label htmlFor="ask-home">{community.assistantName}</label>
    <div><input id="ask-home" value={q} onChange={e => setQ(e.target.value)} placeholder="For example, what is due for my home?" maxLength={1000} />
      <button className="primary" disabled={q.trim().length < 2}>{t('Ask')}</button></div>
  </form>;
}
