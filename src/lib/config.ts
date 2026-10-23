// Startup config checks (P-009 K1). Pure, testable.
export type InboxSource = 'kapso' | 'local';
export function inboxSource(env: Record<string, string | undefined> = process.env): InboxSource {
  return env.INBOX_SOURCE === 'local' ? 'local' : 'kapso';
}
export const DEFAULT_GRAPH_VERSION = 'v26.0';
let warnedVersion = false;
/** META_GRAPH_VERSION if it looks like v26.0, else the default (with one warning). */
export function graphVersion(env: Record<string, string | undefined> = process.env): string {
  const v = env.META_GRAPH_VERSION?.trim();
  if (!v) return DEFAULT_GRAPH_VERSION;
  if (/^v\d+\.\d+$/.test(v)) return v;
  if (!warnedVersion) { warnedVersion = true; console.warn(`[config] META_GRAPH_VERSION is not like v26.0; using ${DEFAULT_GRAPH_VERSION}`); }
  return DEFAULT_GRAPH_VERSION;
}
/** Returns the list of problems (names only). Empty = ok. */
export function configProblems(env: Record<string, string | undefined>): string[] {
  const p: string[] = [];
  const need = (n: string) => { if (!env[n]?.trim()) p.push(`${n} missing`); };
  if ((env.AUTH_SECRET ?? '').length < 32) p.push('AUTH_SECRET shorter than 32');
  ['DATA_DIR', 'PHONE_NUMBER_ID', 'WABA_ID', 'APP_ORIGIN'].forEach(need);
  const email = env.ALERT_EMAIL_TO && env.ALERT_EMAIL_FROM && env.ALERT_RESEND_API_KEY;
  if (!email && !env.ALERT_WEBHOOK_URL) p.push('alert channel missing (ALERT_EMAIL_TO+ALERT_EMAIL_FROM+ALERT_RESEND_API_KEY or ALERT_WEBHOOK_URL)');
  if (env.INBOX_SOURCE && !['kapso', 'local'].includes(env.INBOX_SOURCE)) p.push('INBOX_SOURCE must be kapso or local');
  if (inboxSource(env) === 'local') {
    ['META_ACCESS_TOKEN', 'META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN', 'META_GRAPH_VERSION'].forEach(need);
    if ((env.META_WEBHOOK_VERIFY_TOKEN ?? '').length > 0 && (env.META_WEBHOOK_VERIFY_TOKEN ?? '').length < 32) p.push('META_WEBHOOK_VERIFY_TOKEN shorter than 32');
  } else need('KAPSO_API_KEY');
  return p;
}
