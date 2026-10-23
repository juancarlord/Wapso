// Private media bucket over the S3-compatible XML API (GCS HMAC interoperability), signed with AWS SigV4.
// Same approach as scripts/backup.sh (curl --aws-sigv4, UNSIGNED-PAYLOAD). Pure: no '@/' imports, testable with node --test.
// Never logs credentials, URLs with signatures, or object contents.
import crypto from 'node:crypto';

export type BucketConfig = { baseUrl: string; accessKeyId: string; secretAccessKey: string; region: string; prefix: string };

/** null when any of the three required vars is missing: tiering is disabled and everything stays local. */
export function bucketConfig(env: Record<string, string | undefined> = process.env): BucketConfig | null {
  const url = env.MEDIA_BUCKET_URL?.trim(), id = env.MEDIA_BUCKET_ACCESS_KEY_ID?.trim(), secret = env.MEDIA_BUCKET_SECRET_ACCESS_KEY?.trim();
  if (!url || !id || !secret) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  return { baseUrl: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, accessKeyId: id, secretAccessKey: secret, region: env.MEDIA_BUCKET_REGION?.trim() || 'auto', prefix: 'media' };
}

/** Object key for a stored media file name (<sha256>.<ext>), sharded by the first 2 hex chars. */
export function objectKeyFor(rel: string, prefix = 'media'): string {
  return `${prefix}/${rel.slice(0, 2)}/${rel}`;
}

const hmac = (k: crypto.BinaryLike, s: string) => crypto.createHmac('sha256', k).update(s, 'utf8').digest();
const sha256hex = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const encPath = (p: string) => p.split('/').map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');

/** SigV4 headers for a request with no query string. Payload is UNSIGNED-PAYLOAD (as in backup.sh). */
export function signV4(cfg: BucketConfig, method: string, key: string, extra: Record<string, string> = {}, now = new Date()) {
  const u = new URL(`${cfg.baseUrl}/${key}`);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: u.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate };
  for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = String(v).trim();
  const names = Object.keys(headers).sort();
  const canonical = [method, encPath(u.pathname), '', names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, day), cfg.region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSign).update(toSign, 'utf8').digest('hex');
  const { host: _host, ...send } = headers; // fetch sets Host itself
  void _host;
  return { url: u.toString(), headers: { ...send, Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` } as Record<string, string> };
}

export type ObjectInfo = { size: number; etag: string | null } | null;

export async function headObject(cfg: BucketConfig, key: string, f: typeof fetch = fetch): Promise<ObjectInfo> {
  const s = signV4(cfg, 'HEAD', key);
  const r = await f(s.url, { method: 'HEAD', headers: s.headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw Object.assign(new Error('bucket head failed'), { status: r.status });
  return { size: Number(r.headers.get('content-length') ?? -1), etag: (r.headers.get('etag') ?? '').replace(/"/g, '').toLowerCase() || null };
}

/** PUT with Content-MD5: the bucket rejects the upload if the bytes don't match. */
export async function putObject(cfg: BucketConfig, key: string, bytes: Uint8Array, contentType: string, md5b64: string, f: typeof fetch = fetch): Promise<void> {
  const s = signV4(cfg, 'PUT', key, { 'content-type': contentType, 'content-md5': md5b64 });
  const r = await f(s.url, { method: 'PUT', headers: s.headers, body: bytes as unknown as BodyInit, redirect: 'manual', signal: AbortSignal.timeout(300_000) });
  await r.body?.cancel().catch(() => {});
  if (!r.ok) throw Object.assign(new Error('bucket put failed'), { status: r.status });
}

/** Server-side GET; the caller streams the body. Never hand this URL to a browser. */
export async function getObject(cfg: BucketConfig, key: string, f: typeof fetch = fetch): Promise<Response> {
  const s = signV4(cfg, 'GET', key);
  return f(s.url, { method: 'GET', headers: s.headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
}
