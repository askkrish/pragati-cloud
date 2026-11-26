// Reading documents with Claude, carried over from JAOA: a quotation or invoice becomes a filled-in
// form, and a page of a paper maintenance register becomes rows of checks. Nothing read is saved
// until the person has checked it; saving goes through the usual forms and rules.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Runner, Services } from '../app.ts';
import { config } from '../config.ts';
import { many, one } from '../db.ts';
import { AppError, fail, forbidden } from '../errors.ts';
import { READERS, readDocument, type ReadKind } from '../services/ai.ts';
import { CHECK_INPUT, recordCheck } from './operations.ts';
import { ZodError } from 'zod';
import { date, uuid, z } from './z.ts';

const READ_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const PER_PERSON_PER_DAY = Number(process.env.READ_DAILY_LIMIT ?? 40);
const MODEL = () => process.env.READ_MODEL ?? config.ask.model;

const may = (actor: any, kind: ReadKind) => ({
  quotation: actor.canAnywhere('procurement.manage'),
  invoice: actor.canAnywhere('finance.prepare') || actor.canAnywhere('finance.manage'),
  register: actor.canAnywhere('operations.update') || actor.canAnywhere('operations.manage'),
})[kind];

export async function readingRoutes(app: FastifyInstance, run: Runner, svc: Services) {
  const available = (req: FastifyRequest) => !!config.ask.apiKey && !!req.tenant?.assistant_enabled;

  app.get('/api/read/status', async req => run.auth(req, async () => ({ available: available(req) })));

  app.post('/api/read', async req => {
    const b = z.object({ kind: z.enum(['quotation', 'invoice', 'register']), fileId: uuid }).parse(req.body);
    if (!available(req)) fail(503, 'Reading documents needs the assistant, which is not switched on for this community.', 'assistant_off');
    const job = await run.auth(req, async ({ tx, actor }) => {
      if (!may(actor, b.kind)) forbidden();
      const f = await one(tx, `select id, storage_key, content_type, size_bytes from app.files where id = $1 and purpose = $2 and uploaded_by = $3`,
        [b.fileId, READERS[b.kind].purpose, actor.personId]);
      if (!f) fail(400, 'Upload the document again.', 'invalid');
      if (!READ_TYPES.includes(f.content_type)) fail(400, 'Choose a PDF or a photo (JPEG, PNG or WebP).', 'invalid');
      if (f.content_type !== 'application/pdf' && f.size_bytes > 5 * 1024 * 1024) fail(400, 'Choose a photo under 5 MB.', 'invalid');
      const used = await one(tx, `select
          (select count(*) from app.document_reads where person_id = $1 and created_at > now() - interval '1 day')::int as today,
          ((select count(*) from app.document_reads where created_at > date_trunc('month', now()))
            + (select count(*) from app.ask_questions where created_at > date_trunc('month', now())))::int as month`, [actor.personId]);
      if (used!.today >= PER_PERSON_PER_DAY) fail(429, `You have had ${PER_PERSON_PER_DAY} documents read today, which is the daily limit.`, 'ask_limit');
      if (used!.month >= config.ask.perCommunityPerMonth) fail(429, 'The community has reached its monthly limit for the assistant. It starts again next month.', 'ask_limit');
      return { personId: actor.personId, file: f };
    });
    const bytes = await svc.storage.get(job.file.storage_key);
    let out: Awaited<ReturnType<typeof readDocument>> | null = null, error: string | null = null;
    try { out = await readDocument(b.kind, bytes, job.file.content_type, MODEL()); }
    catch (e) { error = (e as Error).message; req.log.warn({ err: error }, 'document read failed'); }
    await run.auth(req, ({ tx }) => tx.query(`insert into app.document_reads (person_id, kind, file_id, model, input_tokens, output_tokens, error)
      values ($1, $2, $3, $4, $5, $6, $7)`, [job.personId, b.kind, b.fileId, MODEL(), out?.tokens.input ?? 0, out?.tokens.output ?? 0, error]));
    if (!out) fail(502, error?.startsWith('The ') ? error : 'The document could not be read just now. Please fill in the form yourself, or try again.', 'read_failed');
    return clean(b.kind, out!.fields);
  });

  // ---------------------------------------------------------------- paper registers
  app.get('/api/register-imports', async req => run.auth(req, async ({ tx, actor }) => {
    if (!may(actor, 'register')) forbidden();
    return many(tx, `select r.id, r.title, r.entries, r.read_by_ai, r.created_at, r.file_id, p.full_name as by from app.register_imports r
      join app.people p on p.tenant_id = r.tenant_id and p.id = r.created_by
      where $1 or r.created_by = $2 order by r.created_at desc limit 50`, [actor.canAnywhere('operations.manage'), actor.personId]);
  }));

  // Every row is checked and recorded with the same rules as the check sheet, all together or not at all.
  app.post('/api/register-imports', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!may(actor, 'register')) forbidden();
    const b = z.object({ fileId: uuid, title: z.string().trim().min(2).max(120).default('Maintenance register'), readByAi: z.boolean().default(false),
      rows: z.array(CHECK_INPUT.omit({ photoFileId: true, raiseWorkOrder: true }).extend({ routineId: uuid, day: date })).min(1).max(60) }).parse(req.body);
    const f = await one(tx, `select id, storage_key from app.files where id = $1 and purpose = 'evidence' and uploaded_by = $2`, [b.fileId, actor.personId]);
    if (!f) fail(400, 'Upload the register page again.', 'invalid');
    const sha = createHash('sha256').update(await svc.storage.get(f.storage_key)).digest('hex');
    const dup = await one(tx, `select r.created_at, p.full_name from app.register_imports r join app.people p on p.tenant_id = r.tenant_id and p.id = r.created_by where r.sha256 = $1`, [sha]);
    if (dup) fail(409, `This page was already entered by ${dup.full_name} on ${new Date(dup.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}.`, 'duplicate');
    const seen = new Set<string>();
    const imp = await one(tx, `insert into app.register_imports (file_id, sha256, title, entries, read_by_ai, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [f.id, sha, b.title, b.rows.length, b.readByAi, actor.personId]);
    for (const [i, row] of b.rows.entries()) {
      const where = `Row ${i + 1}`;
      const key = `${row.routineId}/${row.day}`;
      if (seen.has(key)) fail(400, `${where} repeats another row for the same check and day. Nothing was saved.`, 'invalid');
      seen.add(key);
      if (await one(tx, `select 1 from app.routine_checks where routine_id = $1 and occurrence_on = $2`, [row.routineId, row.day]))
        fail(409, `${where}: that check is already recorded for ${row.day}. Remove the row to keep the existing record. Nothing was saved.`, 'duplicate');
      try {
        const { routineId, day, ...input } = row;
        await recordCheck(tx, actor, audit, routineId, day, { ...input, photoFileId: f.id, raiseWorkOrder: false }, { fromRegister: true });
      } catch (e) {
        if (!(e instanceof AppError) && !(e instanceof ZodError)) throw e;
        const msg = e instanceof ZodError ? `${e.issues[0].path.join('.')}: ${e.issues[0].message}.` : e.message;
        fail(e instanceof AppError && e.status < 500 ? e.status : 400, `${where}: ${msg} Nothing was saved.`, 'invalid');
      }
      await tx.query(`update app.routine_checks set register_import_id = $3 where routine_id = $1 and occurrence_on = $2`, [row.routineId, row.day, imp!.id]);
    }
    await audit('register.imported', 'register_import', imp!.id, `${b.rows.length} checks entered from "${b.title}"`, { readByAi: b.readByAi });
    return { id: imp!.id, entries: b.rows.length };
  }));
}

// Values from the model are tidied and checked before they reach a form.
function clean(kind: ReadKind, f: Record<string, any>) {
  const day = (v: any) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
  const money = (v: any) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e11 ? Math.round(v * 100) / 100 : null;
  const str = (v: any, n: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null;
  const gstin = (v: any) => typeof v === 'string' && /^[0-9]{2}[A-Z0-9]{13}$/.test(v.replace(/\s/g, '').toUpperCase()) ? v.replace(/\s/g, '').toUpperCase() : null;
  const unclear = Array.isArray(f.unclear) ? f.unclear.filter((x: any) => typeof x === 'string').slice(0, 12).map((x: string) => x.slice(0, 200)) : [];
  if (kind === 'quotation') return { kind, unclear, vendorName: str(f.vendor_name, 120), vendorGstin: gstin(f.vendor_gstin), quoteDate: day(f.quote_date),
    amount: money(f.amount_rupees), tax: ['included', 'excluded', 'unclear'].includes(f.tax) ? f.tax : 'unclear', gst: money(f.gst_rupees),
    scope: str(f.scope, 2000), exclusions: str(f.exclusions, 1000), timeline: str(f.timeline, 200), warranty: str(f.warranty, 200),
    validUntil: day(f.valid_until), paymentTerms: str(f.payment_terms, 500) };
  if (kind === 'invoice') return { kind, unclear, vendorName: str(f.vendor_name, 120), vendorGstin: gstin(f.vendor_gstin), invoiceNo: str(f.invoice_no, 60),
    invoiceDate: day(f.invoice_date), description: str(f.description, 300), total: money(f.total_rupees), gst: money(f.gst_rupees) };
  const time = (v: any) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null;
  return { kind, unclear, entries: (Array.isArray(f.entries) ? f.entries : []).slice(0, 40).map((e: any) => ({
    activity: str(e?.activity, 200) ?? '', day: day(e?.day), time: time(e?.time),
    status: ['done', 'skipped', 'blocked'].includes(e?.status) ? e.status : null, remarks: str(e?.remarks, 600) ?? '',
    reading: typeof e?.reading === 'string' && /^-?\d{1,12}(\.\d{1,6})?$/.test(e.reading.trim()) ? e.reading.trim() : null, reference: str(e?.reference, 120) })) };
}
