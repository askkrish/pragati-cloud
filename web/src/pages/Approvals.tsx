import { useEffect, useState } from 'react';
import { api, rupees, shortDate } from '../api.ts';
import { t } from '../i18n.ts';
import { can, useApp } from '../main.tsx';
import { ErrorNote, Initials, Link, Loading, MODE_LABEL, navigate, PageHead, sentence, Sheet, StatusTag, useAction, useApi } from '../ui.tsx';
import type { TreeNode } from './Home.tsx';

const SUBJECTS: Record<string, string> = { expense: 'Spending', project: 'Project', vendor_selection: 'Choosing a vendor',
  work_order: 'Work order', work_order_change: 'Change to a work order', policy: 'Policy or bye-law', other: 'Something else' };

export function ApprovalList() {
  const { me } = useApp();
  const [tab, setTab] = useState(me.waitingForMyVote ? 'mine' : 'pending');
  const q = tab === 'mine' ? 'mine=1' : tab === 'pending' ? 'status=pending' : 'status=all';
  const { data, loading, error } = useApi<any[]>(`/api/approvals?${q}`);
  const list = tab === 'decided' ? data?.filter(a => a.status !== 'pending') : data;
  return <>
    <PageHead title={t('Approvals')}>{can(me, 'approvals.propose') || me.roles.some(r => r.scope) ?
      <Link to="/approvals/new" className="button primary">{t('New request')}</Link> : null}</PageHead>
    <div className="tabs" role="group" aria-label="Show">
      {[['mine', t('Waiting for your vote')], ['pending', 'Open'], ['decided', 'Decided']].map(([k, label]) =>
        <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>)}
    </div>
    <ErrorNote error={error} />
    {loading && !data ? <Loading /> : <div className="rows">
      {list?.length ? list.map(a => <Link key={a.id} to={`/approvals/${a.id}`} className="row">
        <span><span className="title">{a.title}</span><br />
          <span className="meta">{a.ref}, {a.scope}. {a.status === 'pending'
            ? `${a.stages > 1 ? `Stage ${a.current_stage} of ${a.stages}: ` : ''}with ${a.committee}`
            : `Raised by ${a.proposer}`}</span></span>
        <span className="side"><span className="num">{rupees(a.amount_paise)}</span><br /><StatusTag status={a.status} />
          {a.escalated && <><br /><span className="tag escalated">Waiting {a.waiting_days} days</span></>}</span>
      </Link>) : <p className="empty">{tab === 'mine' ? 'Nothing is waiting for your vote.' : 'No requests here.'}</p>}
    </div>}
  </>;
}

export function ApprovalNew() {
  const tree = useApi<{ nodes: TreeNode[] }>('/api/property/tree');
  const [f, setF] = useState({ subjectType: 'expense', title: '', details: '', amount: '', scopeNodeId: '' });
  const [route, setRoute] = useState<any>(null);
  const { busy, error, run } = useAction();
  const nodes = (tree.data?.nodes ?? []).filter(n => n.in_scope && !['floor'].includes(n.kind));
  useEffect(() => {
    if (!tree.data) return;
    const h = setTimeout(() => {
      api.post('/api/approval-rules/preview', { subjectType: f.subjectType, amount: f.amount || null, scopeNodeId: f.scopeNodeId || nodes[0]?.id || null })
        .then(setRoute).catch(() => setRoute(null));
    }, 250);
    return () => clearTimeout(h);
  }, [f.subjectType, f.amount, f.scopeNodeId, tree.data]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const save = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    const r = await api.post('/api/approvals', { ...f, amount: f.amount || null, scopeNodeId: f.scopeNodeId || nodes[0]?.id || null });
    navigate(`/approvals/${r.id}`);
  }); };
  if (tree.loading) return <Loading />;
  return <>
    <PageHead title={t('New request')} crumbs={[{ to: '/approvals', label: t('Approvals') }]} />
    <form className="form" onSubmit={save} style={{ maxWidth: 640 }}>
      <label className="field">What needs approval<input required minLength={3} value={f.title} onChange={set('title')}
        placeholder="For example, replace the Block B lift ropes" /></label>
      <div className="two">
        <label className="field">Kind<select value={f.subjectType} onChange={set('subjectType')}>
          {Object.entries(SUBJECTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">Amount, ₹<input inputMode="decimal" value={f.amount} onChange={set('amount')} placeholder="1,60,000" /></label>
      </div>
      <label className="field">Which place it is for<select value={f.scopeNodeId} onChange={set('scopeNodeId')}>
        {nodes.map(n => <option key={n.id} value={n.id}>{' '.repeat(n.depth)}{n.name}</option>)}</select>
        <span className="hint">A cost for one block goes to that block's committee first.</span></label>
      <label className="field">Details<textarea value={f.details} onChange={set('details')} placeholder="Quotes compared, why it is needed, who pays" /></label>
      {route && <div className="note" aria-live="polite">
        {route.rule ? <>Under "{route.rule.name}", this goes to {route.stages.map((s: any, i: number) =>
          <span key={i}>{i > 0 && ', then '}<strong>{s.committee?.name ?? 'no committee yet'}</strong>, where {MODE_LABEL(s.mode, s.required, s.voters)}</span>)}.</>
          : 'No approval rule covers this yet. Your administrator can add one.'}
      </div>}
      <ErrorNote error={error} />
      <div className="actions"><button className="primary" disabled={busy || !route?.rule}>Send for approval</button></div>
    </form>
  </>;
}

export function ApprovalView({ id }: { id: string }) {
  const { refreshMe } = useApp();
  const { data: r, error, loading, reload } = useApi(`/api/approvals/${id}`);
  const [note, setNote] = useState('');
  const [sheet, setSheet] = useState<null | 'object' | 'withdraw' | 'reject' | 'letter'>(null);
  const act = useAction();
  if (loading && !r) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const done = () => { setSheet(null); setNote(''); reload(); refreshMe(); };
  const vote = (v: 'approve' | 'object') => act.run(async () => { await api.post(`/api/approvals/${id}/vote`, { vote: v, note }); done(); });

  return <>
    <PageHead title={r.title} crumbs={[{ to: '/approvals', label: t('Approvals') }, { label: r.ref }]}><StatusTag status={r.status} /></PageHead>
    <div className="head-row" style={{ alignItems: 'baseline' }}>
      {r.amountPaise && <span className="amount">{rupees(r.amountPaise)}</span>}
      <span className="quiet">{SUBJECTS[r.subjectType]} for {r.scope.name}. Raised by {r.proposer.name} on {shortDate(r.createdAt)}.</span>
    </div>
    {r.details && <p style={{ maxWidth: '68ch', whiteSpace: 'pre-wrap' }}>{r.details}</p>}

    {r.actions.vote && <section className="panel pad">
      <h2>{r.actions.myVote ? `You ${r.actions.myVote === 'approve' ? 'approved' : 'objected'}. Change your vote?` : 'Your vote'}</h2>
      <ErrorNote error={act.error} />
      <div className="actions">
        <button className="yes" disabled={act.busy || r.actions.myVote === 'approve'} onClick={() => vote('approve')}>{t('Approve')}</button>
        <button className="no" disabled={act.busy} onClick={() => setSheet('object')}>{t('Object')}</button>
      </div>
    </section>}

    <section>
      <header><h2>Who decides</h2><span className="quiet">Rule: {r.rule.name}</span></header>
      <div className="stages">
        {r.stages.map((s: any) => <div key={s.stageNo} className={`stage ${s.status}`}>
          <div className="body">
            <h3>{s.committee}</h3>
            <p className="quiet">{s.status === 'waiting' ? `Opens after stage ${s.stageNo - 1}. ` : ''}
              {sentence(MODE_LABEL(s.mode, s.mode === 'count' ? s.required : null))}.
              {s.status !== 'waiting' && s.required ? ` ${s.approvals} of the ${s.required} approvals needed${s.status === 'approved' ? '.' : ' so far.'}` : ''}</p>
            {s.status !== 'waiting' && s.required && <div className="progress"><i style={{ width: `${Math.min(100, (s.approvals / s.required) * 100)}%` }} /></div>}
            {s.voters.length > 0 && <div className="voters">{s.voters.map((v: any) => <span key={v.personId}
              className={`voter ${v.vote ?? ''} ${v.active ? '' : 'inactive'}`} title={v.active ? '' : 'No longer on the committee'}>
              <Initials name={v.name} />{v.name}<span className="faint">{v.vote === 'approve' ? 'approved' : v.vote === 'object' ? 'objected' : 'waiting'}</span></span>)}</div>}
            {s.voters.filter((v: any) => v.vote === 'object').map((v: any) => <p key={v.personId} className="objection">{v.name}: {v.note}</p>)}
          </div>
        </div>)}
      </div>
    </section>

    {r.override && <p className="note ok">Approved by a signed letter recorded by {r.override.byName} on {shortDate(r.override.at)}: {r.override.note}.{' '}
      <a href={`/api/files/${r.override.fileId}`}>Download the letter</a></p>}
    {r.outcomeNote && r.status !== 'pending' && <p className="note">{r.status === 'withdrawn' ? 'Withdrawn' : 'Closed'}: {r.outcomeNote}</p>}

    {(r.actions.withdraw || r.actions.reject || r.actions.override) && <section>
      <header><h2>Other actions</h2></header>
      <div className="actions">
        {r.actions.override && <button onClick={() => setSheet('letter')}>Record a signed letter</button>}
        {r.actions.reject && <button onClick={() => setSheet('reject')}>Close as rejected</button>}
        {r.actions.withdraw && <button onClick={() => setSheet('withdraw')}>Withdraw</button>}
      </div>
    </section>}

    <Sheet open={sheet === 'object'} onClose={() => setSheet(null)} title="Object to this request">
      <label className="field">Your reason<textarea value={note} onChange={e => setNote(e.target.value)} placeholder="The committee sees this with your objection" /></label>
      <ErrorNote error={act.error} /><button className="primary" disabled={!note.trim() || act.busy} onClick={() => vote('object')}>Send objection</button>
    </Sheet>
    <Sheet open={sheet === 'withdraw' || sheet === 'reject'} onClose={() => setSheet(null)} title={sheet === 'reject' ? 'Close as rejected' : 'Withdraw this request'}>
      <label className="field">{sheet === 'reject' ? "The committee's reason" : 'Reason (optional)'}<textarea value={note} onChange={e => setNote(e.target.value)} /></label>
      <ErrorNote error={act.error} />
      <button className="primary" disabled={act.busy || (sheet === 'reject' && !note.trim())}
        onClick={() => act.run(async () => { await api.post(`/api/approvals/${id}/${sheet}`, { note }); done(); })}>
        {sheet === 'reject' ? 'Close as rejected' : 'Withdraw'}</button>
    </Sheet>
    <LetterSheet open={sheet === 'letter'} id={id} onClose={() => setSheet(null)} onDone={done} />
  </>;
}

function LetterSheet({ open, id, onClose, onDone }: { open: boolean; id: string; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  return <Sheet open={open} onClose={onClose} title="Record a signed letter">
    <p className="quiet">Use this when the committee has signed a letter approving the request. The request is approved and the letter is kept with it.</p>
    <label className="field">Scanned letter (PDF, JPG or PNG)<input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
    <label className="field">Describe the letter<input value={note} onChange={e => setNote(e.target.value)} placeholder="Dated 25 Nov, signed by all seven members" /></label>
    <ErrorNote error={error} />
    <button className="primary" disabled={!file || !note.trim() || busy} onClick={() => run(async () => {
      const f = await api.upload('/api/files?purpose=approval_letter', file!);
      await api.post(`/api/approvals/${id}/override`, { note, fileId: f.id });
      onDone();
    })}>Approve with this letter</button>
  </Sheet>;
}
