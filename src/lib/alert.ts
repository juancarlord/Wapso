// Failure alerts (P-009 K1), max once per type per hour, never throws. Juan's choice (Q2): email.
// Senders (any that are configured are used):
//  - Email via Resend HTTP API: ALERT_EMAIL_TO, ALERT_EMAIL_FROM, ALERT_RESEND_API_KEY (no SDK needed).
//  - Generic JSON webhook: ALERT_WEBHOOK_URL (e.g. an email-forwarding webhook, Slack, Telegram bridge).
const last = new Map<string, number>();
const HOUR = 3_600_000;

export function shouldSend(type: string, now = Date.now()): boolean {
  const t = last.get(type);
  if (t !== undefined && now - t < HOUR) return false;
  last.set(type, now);
  return true;
}

export async function alert(type: string, details: Record<string, string | number | boolean | null> = {}): Promise<void> {
  try {
    const url = process.env.ALERT_WEBHOOK_URL;
    if (!shouldSend(type)) return;
    console.warn(`[alert] ${type}`);
    const { ALERT_EMAIL_TO: to, ALERT_EMAIL_FROM: from, ALERT_RESEND_API_KEY: key } = process.env;
    if (to && from && key) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ from, to: to.split(',').map((x) => x.trim()), subject: `[Wapso] alerta: ${type}`,
          text: `Tipo: ${type}\nDetalles: ${JSON.stringify(details)}\nHora: ${new Date().toISOString()}` }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => console.warn(`[alert] email failed for ${type}`));
    }
    if (!url) return;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'wapso', type, details, at: new Date().toISOString(), text: `Wapso alert: ${type}` }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    console.warn(`[alert] delivery failed for ${type}`);
  }
}
