import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import { config } from '../config.ts';

export const newOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const otpHash = (challengeId: string, code: string) =>
  createHmac('sha256', config.secret).update(`otp:${challengeId}:${code}`).digest('hex');
export const newSessionToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token: string) => createHash('sha256').update(`session:${token}`).digest();
export const sha256Hex = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

// Accepts Indian numbers written the usual ways (98400 12345, 098400..., +91-98400-12345) and
// other countries in full international form.
export function normalisePhone(input: string): string | null {
  const raw = String(input ?? '').trim();
  const digits = raw.replace(/[\s\-().]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  const d = digits.replace(/^0+/, '');
  if (/^[6-9]\d{9}$/.test(d)) return '+91' + d;
  if (/^91[6-9]\d{9}$/.test(d)) return '+' + d;
  return null;
}
