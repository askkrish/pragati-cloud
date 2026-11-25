// A short guide for each kind of person, and a way to tell the platform team what is not working.
import { useState } from 'react';
import { api } from '../api.ts';
import { can, useApp } from '../main.tsx';
import { ErrorNote, Link, PageHead, useAction } from '../ui.tsx';

export function Help() {
  const { me, community } = useApp();
  const staff = ['operations.update', 'operations.manage'].some(p => can(me, p));
  const committee = can(me, 'committees.view');
  const books = can(me, 'finance.manage') || can(me, 'finance.view');
  const [f, setF] = useState({ kind: 'problem', body: '' });
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();
  return <>
    <PageHead title="Help and feedback" />
    <div className="guide">
      {me.homes.length > 0 && <section className="panel pad"><h2>For owners and residents</h2><ul>
        <li><Link to="/requests">Requests</Link>: raise a problem at your home, add a photo, and follow it until it is fixed. Choose "needs the committee's permission" for renovation, terrace work or moving.</li>
        <li><Link to="/dues">Dues</Link>: what is due, a statement to print, and paying by UPI. Tap "I have paid" with the UTR so the treasurer can match it.</li>
        <li><Link to="/notices">Notices</Link> and the <Link to="/records">records library</Link>: what the association has published for you.</li>
        {community.assistantOn && <li><Link to="/ask">{community.assistantName}</Link>: ask in plain words, in English or Tamil.</li>}
      </ul></section>}
      {staff && <section className="panel pad"><h2>For staff and the facility team</h2><ul>
        <li><Link to="/work">Today</Link>: each check in its time window. Tap it to mark it done, skipped or blocked. Without signal, checks are kept on the phone and sent later.</li>
        <li>Scan the QR label at a place to open its checks. Managers print the labels from <Link to="/work/qr">QR labels</Link>.</li>
        <li><Link to="/work/orders">Work orders</Link>: requests, incidents, maintenance and projects; quotations, contracts, milestones and handover.</li>
      </ul></section>}
      {committee && <section className="panel pad"><h2>For the committee</h2><ul>
        <li><Link to="/approvals">Approvals</Link>: vote with a note when you object. Decisions waiting too long are flagged.</li>
        <li><Link to="/packs">Report packs</Link>: the end-of-day summary, the weekly pack, the owners' update and the annual pack for the AGM, to print or save as PDF.</li>
      </ul></section>}
      {books && <section className="panel pad"><h2>For the treasurer</h2><ul>
        <li><Link to="/money">Money</Link>: billing runs, receipts, vouchers with TDS and GST checks, bank statement matching, reports and Tally export.</li>
        <li>Vouchers can be imported from a spreadsheet; each goes through approval.</li>
      </ul></section>}
      <section className="panel pad"><h2>Installing the app</h2>
        <p>On Android, open {community.platformName} in Chrome and choose "Add to Home screen" or "Install app". On an iPhone, open it in Safari, tap Share, then "Add to Home Screen".</p></section>
    </div>
    <section className="panel pad" style={{ maxWidth: 680 }}>
      <h2>Tell us what is not working, or what would help</h2>
      {sent ? <p className="note ok">Thank you. The platform team reads every message.</p> : <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
        await api.post('/api/feedback', { ...f, page: document.referrer ? new URL(document.referrer).pathname : '/help' }); setSent(true); }); }}>
        <label className="field">About<select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}>
          <option value="problem">Something is not working</option><option value="idea">An idea</option><option value="question">A question</option><option value="praise">Something that works well</option></select></label>
        <label className="field">Message<textarea required minLength={3} value={f.body} onChange={e => setF({ ...f, body: e.target.value })}
          placeholder="What you were doing, what happened, and what you expected" /></label>
        <p className="quiet small">For your association's own matters, such as dues or a request, contact your committee or office instead.</p>
        <ErrorNote error={error} />
        <div className="actions"><button className="primary" disabled={busy}>Send</button></div>
      </form>}
    </section>
  </>;
}
