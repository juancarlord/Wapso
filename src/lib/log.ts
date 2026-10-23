// PII-safe error logging (P-009 K1): name, scrubbed/truncated message and HTTP status only. Never objects, headers or bodies.
export function scrub(s: string): string {
  return s
    .replace(/(Bearer|key|token|secret)[=: ]+\S+/gi, '$1 [redacted]')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '[num]')
    .slice(0, 200);
}
export function safeError(tag: string, e: unknown, extra?: Record<string, string | number | boolean | null | undefined>) {
  const o = (e && typeof e === 'object' ? e : {}) as { name?: unknown; message?: unknown; status?: unknown; httpStatus?: unknown };
  const name = typeof o.name === 'string' ? o.name : typeof e;
  const msg = typeof o.message === 'string' ? scrub(o.message) : typeof e === 'string' ? scrub(e) : '';
  const status = typeof o.status === 'number' ? o.status : typeof o.httpStatus === 'number' ? o.httpStatus : undefined;
  const parts = [`[${tag}]`, name, msg && `msg="${msg}"`, status !== undefined && `status=${status}`];
  if (extra) for (const [k, v] of Object.entries(extra)) if (v !== undefined) parts.push(`${k}=${typeof v === 'string' ? scrub(v) : v}`);
  console.error(parts.filter(Boolean).join(' '));
}
