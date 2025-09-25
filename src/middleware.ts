/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

// 1️⃣ 显式指定 Edge Runtime → 构建器会强制报错“出现 Node 模块”
export const config = {
  // Next 14 requires the experimental edge runtime name for edge-rendered middleware
  runtime: 'experimental-edge',
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|login|warning|api/login|api/register|api/logout|api/cron|api/server-config|api/search|api/detail|api/image-proxy|api/tvbox).*)',
  ],
};

// 2️⃣ 其余逻辑保持原样
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (shouldSkipAuth(pathname)) return NextResponse.next();

  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';

  const password = process.env.PASSWORD;
  if (!password) {
    return NextResponse.redirect(new URL('/warning', request.url));
  }

  // 3️⃣ 这里不再调用任何可能引入 async_hooks 的库
  //    先用最原始的实现顶过构建
  const authInfo = parseCookie(request.headers.get('cookie') || '');

  if (!authInfo) return handleAuthFailure(request, pathname);

  if (storageType === 'localstorage') {
    if (authInfo.password !== process.env.PASSWORD) {
      return handleAuthFailure(request, pathname);
    }
    return NextResponse.next();
  }

  if (
    !authInfo.username ||
    !authInfo.signature ||
    !(await verifySignature(authInfo.username, authInfo.signature, password))
  ) {
    return handleAuthFailure(request, pathname);
  }

  return NextResponse.next();
}

// 4️⃣ 临时用正则解析 cookie，避开 cookies() 封装
function parseCookie(cookie: string) {
  try {
    const obj: Record<string, string> = {};
    cookie.split(';').forEach((c) => {
      const [k, v] = c.trim().split('=');
      obj[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    return JSON.parse(obj.auth || '{}');
  } catch {
    return null;
  }
}

/* 以下函数与之前完全一致，仅复制过来 */
async function verifySignature(data: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const matches = signature.match(/.{1,2}/g);
  if (!matches) return false;
  const sig = new Uint8Array(matches.map((b) => parseInt(b, 16)));
  return crypto.subtle.verify('HMAC', key, sig, encoder.encode(data));
}

function handleAuthFailure(req: NextRequest, pathname: string) {
  if (pathname.startsWith('/api')) return new NextResponse('Unauthorized', { status: 401 });
  const login = new URL('/login', req.url);
  login.searchParams.set('redirect', `${pathname}${req.nextUrl.search}`);
  return NextResponse.redirect(login);
}

function shouldSkipAuth(pathname: string) {
  return ['/_next', '/favicon.ico', '/robots.txt', '/manifest.json', '/icons/', '/logo.png', '/screenshot.png']
    .some((p) => pathname.startsWith(p));
}