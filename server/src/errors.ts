export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'error') {
    super(message);
  }
}
export const fail = (status: number, message: string, code?: string): never => {
  throw new AppError(status, message, code);
};
export const notFound = (what = 'That item') => fail(404, `${what} was not found.`, 'not_found');
export const forbidden = (message = 'You do not have access to do this.') => fail(403, message, 'forbidden');

type PgError = { code?: string; constraint?: string; message: string; detail?: string };

// Turns database errors into messages a committee member can act on. Messages raised by our own
// triggers are already written for people; generic constraint errors are summarised.
export function fromDatabase(e: unknown): AppError | null {
  const err = e as PgError;
  switch (err?.code) {
    case '23505': return new AppError(409, 'Something with that name or number already exists.', 'duplicate');
    case '23503': return new AppError(400, err.constraint ? 'That refers to something that does not exist in this community.' : err.message, 'reference');
    case '23514': return new AppError(400, err.constraint ? `A value is not allowed (${err.constraint}).` : err.message, 'invalid');
    case '23502': return new AppError(400, 'A required value is missing.', 'invalid');
    case '22P02': return new AppError(400, 'A value is in the wrong format.', 'invalid');
    case '22023': return new AppError(400, err.message, 'invalid');
    case '42501': return new AppError(403, 'This change is not allowed.', 'forbidden');
    case '57014': return new AppError(503, 'The request took too long. Please try again.', 'timeout');
    default: return null;
  }
}
