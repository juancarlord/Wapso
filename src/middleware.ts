import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, getAuthSecret, cookieOptions } from '@/lib/session';
import { getSessionUser, isSameOrigin } from '@/lib/auth';

if (process.env.NODE_ENV === 'production' && !process.env.APP_ORIGIN) {
  console.error('[auth] APP_ORIGIN is not set: all state-changing API requests will be rejected.');
}

if (process.env.AUTH_INSECURE_COOKIE === '1') {
  console.warn(process.env.NODE_ENV === 'production'
    ? '[auth] !!! AUTH_INSECURE_COOKIE=1 is REFUSED in production; cookies stay Secure. Remove it.'
    : '[auth] !!! AUTH_INSECURE_COOKIE=1: session cookie is NOT Secure (dev only).');
}

const PUBLIC_PATHS = new Set(['/login', '/api/auth/login']);
// Reachable while a password change is pending.
const CHANGE_PW_PATHS = new Set(['/cambiar-contrasena', '/api/auth/change-password', '/api/auth/logout', '/api/auth/me']);

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith('/api/');
  const method = req.method.toUpperCase();

  if (!getAuthSecret()) {
    console.error('[auth] AUTH_SECRET missing or shorter than 32 chars');
    return isApi
      ? NextResponse.json({ error: 'Auth not configured' }, { status: 503 })
      : new NextResponse('Auth not configured', { status: 503 });
  }

  // CSRF: every state-changing API call must come from our own origin.
  if (isApi && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !isSameOrigin(req)) {
    return NextResponse.json({ error: 'Forbidden (origin)' }, { status: 403 });
  }

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const user = await getSessionUser(req);
  if (!user) {
    const res = isApi
      ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      : NextResponse.redirect(new URL('/login', req.url));
    if (req.cookies.get(SESSION_COOKIE)) res.cookies.set(SESSION_COOKIE, '', cookieOptions(0));
    return res;
  }

  if (user.must_change_password && !CHANGE_PW_PATHS.has(pathname)) {
    return isApi
      ? NextResponse.json({ error: 'Password change required' }, { status: 403 })
      : NextResponse.redirect(new URL('/cambiar-contrasena', req.url));
  }

  if ((pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/api/admin/')) && user.role !== 'admin') {
    return isApi
      ? NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      : new NextResponse('403 - Solo administradores', { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  runtime: 'nodejs',
  // Only Next build assets, the favicon and the exact public/ files are excluded.
  matcher: ['/((?!_next/static/|_next/image|favicon\\.ico$|file\\.svg$|globe\\.svg$|next\\.svg$|vercel\\.svg$|window\\.svg$).*)'],
};
