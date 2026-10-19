
// In-memory login limiter: 5 failures/15 min per IP+username, 30 per IP, 10 per username (any IP).
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_KEY = 5;
const MAX_PER_IP = 30;
const MAX_PER_USER = 10;
const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const list = (failures.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list); else failures.delete(key);
  return list;
}

export function isLimited(ip: string, username: string): boolean {
  const now = Date.now();
  return recent(`k:${ip}:${username.toLowerCase()}`, now).length >= MAX_PER_KEY || recent(`ip:${ip}`, now).length >= MAX_PER_IP
    || recent(`u:${username.toLowerCase()}`, now).length >= MAX_PER_USER;
}

export function recordFailure(ip: string, username: string) {
  const now = Date.now();
  for (const key of [`k:${ip}:${username.toLowerCase()}`, `ip:${ip}`, `u:${username.toLowerCase()}`]) {
    failures.set(key, [...recent(key, now), now]);
  }
  if (failures.size > 10000) {
    for (const k of failures.keys()) recent(k, now);
  }
}

export function clearFailures(ip: string, username: string) {
  failures.delete(`k:${ip}:${username.toLowerCase()}`);
}
