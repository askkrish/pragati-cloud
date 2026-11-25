import { z } from 'zod';
export { z };
export const uuid = z.string().uuid();
export const idParam = z.object({ id: uuid });
export const text = (max = 200) => z.string().trim().min(1).max(max);
export const optText = (max = 200) => z.string().trim().max(max).optional().nullable().transform(v => v || null);
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
export const rupeesToPaise = z.union([z.number(), z.string()]).optional().nullable().transform((v, ctx) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[,₹\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1e11) { ctx.addIssue({ code: 'custom', message: 'is not a valid amount' }); return z.NEVER; }
  return String(Math.round(n * 100));
});
