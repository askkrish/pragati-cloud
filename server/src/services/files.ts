import type { MultipartFile } from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../app.ts';
import { sha256Hex } from '../auth/crypto.ts';
import { fail } from '../errors.ts';
import type { Storage } from './storage.ts';

// The type is checked from the file's first bytes, not from its name or the browser's claim.
const SNIFF: [string, (b: Buffer) => boolean][] = [
  ['application/pdf', b => b.subarray(0, 5).toString('latin1') === '%PDF-'],
  ['image/png', b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];
const ALLOWED: Record<string, string[]> = {
  logo: ['image/png', 'image/jpeg', 'image/webp'],
  approval_letter: ['application/pdf', 'image/png', 'image/jpeg'],
  ownership_document: ['application/pdf', 'image/png', 'image/jpeg'],
  other: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
  work_photo: ['image/png', 'image/jpeg', 'image/webp'],
  contract: ['application/pdf', 'image/png', 'image/jpeg'],
  quotation: ['application/pdf', 'image/png', 'image/jpeg'],
  invoice: ['application/pdf', 'image/png', 'image/jpeg'],
  payment_proof: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
  document: ['application/pdf', 'image/png', 'image/jpeg'],
  notice: ['application/pdf', 'image/png', 'image/jpeg'],
  evidence: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
  avatar: ['image/jpeg', 'image/png', 'image/webp'],
};

export async function saveUpload(c: Ctx, storage: Storage, part: MultipartFile, purpose: string) {
  const allowed = ALLOWED[purpose] ?? fail(400, 'Unknown document type.', 'invalid');
  const body = await part.toBuffer();
  if (part.file.truncated) fail(413, 'The file is too large.', 'too_large');
  if (!body.length) fail(400, 'The file is empty.', 'invalid');
  const type = SNIFF.find(([, test]) => test(body))?.[0];
  if (!type || !allowed.includes(type)) fail(400, `Upload a ${allowed.map(t => t.split('/')[1].toUpperCase()).join(', ')} file.`, 'invalid');
  const id = randomUUID();
  const key = `${c.tenant.id}/${purpose}/${id}`;
  await storage.put(key, body, type!);
  const name = (part.filename || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  await c.tx.query(`insert into app.files (id, purpose, storage_key, file_name, content_type, size_bytes, sha256, uploaded_by)
    values ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, purpose, key, name, type, body.length, sha256Hex(body), c.actor.personId]);
  await c.audit('file.uploaded', 'file', id, `Uploaded ${name}`, { purpose, size: body.length });
  return { id, fileName: name, contentType: type, size: body.length };
}
