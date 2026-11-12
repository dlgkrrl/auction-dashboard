/**
 * /api/* 보호 미들웨어
 * - /api/login        : 누구나 (비밀번호 확인)
 * - /api/item         : 로그인 세션 또는 그 물건의 서명 링크(sig)
 * - 그 밖의 /api/*    : 로그인 세션 필요
 * 정적 파일(index.html 등)은 데이터가 없으므로 그대로 통과합니다.
 */
import { authConfigured, hasValidSession, hasValidItemSig } from './_lib/auth.js';

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith('/api/')) return next();
  if (path === '/api/login') return next();

  if (!authConfigured(env)) {
    // 설정이 빠졌을 때 열어 두지 않고 막습니다.
    return json(503, { error: 'auth_not_configured', message: 'DASHBOARD_PASSWORD / DASHBOARD_SECRET 환경변수를 설정하세요.' });
  }

  // 다른 사이트에서 쿠키를 실어 보내는 쓰기 요청 차단 (SameSite=Strict와 이중 방어)
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json(403, { error: 'bad_origin' });
  }

  if (await hasValidSession(request, env)) return next();

  if (path === '/api/item') {
    const id = url.searchParams.get('id');
    if (await hasValidItemSig(env, id, url.searchParams.get('sig'))) return next();
    return new Response(
      '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<p style="font-family:sans-serif;padding:24px">링크가 만료되었거나 올바르지 않습니다. <a href="/">대시보드에서 로그인</a>하세요.</p>',
      { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  }

  return json(401, { error: 'login_required' });
}
