// Ask Pragathi: off until the community switches it on, sees only what the asker may see, keeps
// contact details away from the AI provider, logs each question, and stops at the daily limit.
// The AI provider is a local stand-in that asks for lookups and echoes back what they returned.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { buildCommunity, startHarness, type Harness } from './helpers.ts';

const seen: any[] = [];
let stub: Server;
// Which lookups the stand-in asks for, by a word in the question.
const PLAN: Record<string, { name: string; input?: any }[]> = {
  books: [{ name: 'finance_overview' }],
  dues: [{ name: 'my_dues' }, { name: 'about_me' }],
  notices: [{ name: 'notices' }],
  sneaky: [{ name: 'work_order', input: { id: '../finance/overview' } }, { name: 'no_such_tool' }],
  leak: [{ name: 'draft_service_request', input: { title: 'Water leaking from the bathroom ceiling', category: 'plumbing', urgent: true, details: 'Since this morning' } }],
};

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.ASK_DAILY_LIMIT = '7';
process.env.ASK_MODEL = 'claude-test';

let h: Harness;
let C: Awaited<ReturnType<typeof buildCommunity>>;
let owner: ReturnType<Harness['client']>;
const ok = (r: { status: number; body: any }, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

before(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ headers: req.headers, body });
      const last = body.messages.at(-1);
      let reply: any;
      if (typeof last.content === 'string') {
        const key = Object.keys(PLAN).find(k => last.content.includes(k)) ?? 'notices';
        reply = { stop_reason: 'tool_use', content: PLAN[key].map((t, i) => ({ type: 'tool_use', id: `t${i}`, name: t.name, input: t.input ?? {} })),
          usage: { input_tokens: 100, output_tokens: 10 } };
      } else {
        reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'RESULT ' + last.content.map((r: any) => r.content).join(' | ') }],
          usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 50 } };
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>(r => stub.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(stub.address() as any).port}`;
  h = await startHarness();
  C = await buildCommunity(h, 'ask');
  ok(await C.admin.post(`/api/units/${C.unitA.id}/owners`, { newPerson: { name: 'Owner Asha', phone: '+919000700001' }, sharePct: 100 }));
  owner = h.client(C.host, await h.sessionFor(C.id, '+919000700001'));
});
after(async () => { await h.close(); stub.close(); });

test('the assistant is off until the community switches it on, and only settings managers can', async () => {
  assert.equal(ok(await owner.get('/api/ask/status')).available, false);
  assert.equal((await owner.post('/api/ask', { question: 'notices please' })).status, 503);
  assert.equal((await owner.call('PATCH', '/api/ask/settings', { enabled: true })).status, 403);
  ok(await C.admin.call('PATCH', '/api/ask/settings', { enabled: true }));
  const s = ok(await owner.get('/api/ask/status'));
  assert.equal(s.available, true);
  assert.equal(s.remainingToday, 7);
  assert.equal(seen.length, 0, 'nothing went to the AI provider while it was off');
});

test('lookups run as the asker: refused where their role does not reach, and contact details are removed', async () => {
  const books = ok(await owner.post('/api/ask', { question: 'how are the books?' }));
  assert.match(books.answer, /Not available to this person/);
  assert.deepEqual(books.lookups, ['finance_overview']);

  const mine = ok(await owner.post('/api/ask', { question: 'what are my dues?', language: 'ta' }));
  assert.match(mine.answer, /Owner Asha/);
  assert.match(mine.answer, new RegExp(C.unitA.label));
  assert.doesNotMatch(mine.answer, /\+91|9000700001/, 'phone numbers never reach the AI provider');

  // What was sent: the key and version headers, the model, the tools (cached), the asker and the language.
  const first = seen.find(s => typeof s.body.messages.at(-1).content === 'string' && s.body.messages.at(-1).content.includes('dues'))!;
  assert.equal(first.headers['x-api-key'], 'test-key');
  assert.equal(first.headers['anthropic-version'], '2023-06-01');
  assert.equal(first.body.model, 'claude-test');
  assert.ok(first.body.tools.at(-1).cache_control);
  assert.ok(first.body.tools.every((t: any) => !('path' in t)));
  assert.match(first.body.system[1].text, /Owner Asha/);
  assert.match(first.body.system[1].text, /Tamil/);
  assert.doesNotMatch(JSON.stringify(seen), /9000700001/);

  // The committee sees the books through the same lookup.
  const admin = ok(await C.admin.post('/api/ask', { question: 'how are the books?' }));
  assert.doesNotMatch(admin.answer, /Not available/);
});

test('lookups cannot be steered to other addresses, and unknown lookups are refused', async () => {
  const r = ok(await owner.post('/api/ask', { question: 'sneaky one' }));
  assert.match(r.answer, /id must be an id from an earlier lookup/);
  assert.match(r.answer, /No such lookup/);
});

test('the assistant drafts a request for the asker\'s own home, which they send themselves; answers can be rated', async () => {
  const before = (await h.asOwner(C.id, `select count(*)::int as n from app.work_orders`))[0].n;
  const r = ok(await owner.post('/api/ask', { question: 'there is a leak in my bathroom, please raise it' }));
  assert.equal(r.draft.unitId, C.unitA.id);
  assert.equal(r.draft.category, 'plumbing');
  assert.equal(r.draft.urgent, true);
  assert.equal((await h.asOwner(C.id, `select count(*)::int as n from app.work_orders`))[0].n, before, 'nothing is raised until the person sends it');
  ok(await owner.post('/api/work', { kind: 'request', unitId: r.draft.unitId, title: r.draft.title, category: r.draft.category }));
  // The admin has no home: no draft, and the assistant is told why.
  const a = ok(await C.admin.post('/api/ask', { question: 'leak at my place' }));
  assert.equal(a.draft, null);
  assert.match(a.answer, /no home on record/);
  ok(await owner.post(`/api/ask/${r.id}/rating`, { helpful: true }));
  ok(await C.admin.post(`/api/ask/${r.id}/rating`, { helpful: false }), 404);
  const usage = ok(await C.admin.get('/api/ask/usage'));
  assert.equal(usage.helpful, 1);
  ok(await owner.get('/api/ask/usage'), 403);
});

test('each question is logged with its cost for the asker alone, and the daily limit holds', async () => {
  const mine = ok(await owner.get('/api/ask/history'));
  assert.equal(mine.length, 4);
  assert.ok(mine.every((q: any) => q.answer));
  const [row] = await h.asOwner(C.id, `select lookups, model, input_tokens, output_tokens from app.ask_questions where question = 'what are my dues?'`);
  assert.deepEqual(row.lookups.sort(), ['about_me', 'my_dues']);
  assert.equal(row.model, 'claude-test');
  assert.equal(row.input_tokens, 350);
  assert.equal(row.output_tokens, 40);
  assert.equal(ok(await C.admin.get('/api/ask/history')).length, 2);

  // Follow-ups carry the earlier turns.
  ok(await owner.post('/api/ask', { question: 'notices now', earlier: [{ q: 'what are my dues?', a: 'Nothing is due.' }] }));
  assert.equal(seen.at(-2).body.messages[0].content, 'what are my dues?');

  ok(await owner.post('/api/ask', { question: 'notices again' }));
  ok(await owner.post('/api/ask', { question: 'notices once more' }));
  const over = await owner.post('/api/ask', { question: 'one too many notices' });
  assert.equal(over.status, 429);
  assert.equal(ok(await owner.get('/api/ask/status')).remainingToday, 0);

  // Another community never sees these questions.
  const D = await buildCommunity(h, 'ask2');
  assert.equal(ok(await D.admin.get('/api/ask/history')).length, 0);
});
