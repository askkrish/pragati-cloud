export class ApiError extends Error {
  constructor(public status: number, message: string, public code: string) { super(message); }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { ...(method !== 'GET' ? { 'x-pragati': '1' } : {}), ...(body && !isForm ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('pragati:signed-out'));
    throw new ApiError(res.status, data?.error ?? 'Something went wrong.', data?.code ?? 'error');
  }
  return data as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b: unknown = {}) => request<T>('POST', p, b),
  patch: <T = any>(p: string, b: unknown) => request<T>('PATCH', p, b),
  put: <T = any>(p: string, b: unknown) => request<T>('PUT', p, b),
  upload: <T = any>(p: string, file: File) => { const f = new FormData(); f.append('file', file); return request<T>('POST', p, f); },
};

export const rupees = (paise: string | number | null | undefined) => {
  if (paise === null || paise === undefined || paise === '') return '';
  const n = Number(paise) / 100;
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: n % 1 ? 2 : 0 });
};
export const shortDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
export const phoneDisplay = (p: string | null | undefined) =>
  !p ? '' : p.startsWith('+91') && p.length === 13 ? `${p.slice(3, 8)} ${p.slice(8)}` : p;
