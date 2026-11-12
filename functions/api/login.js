/**
 * POST   /api/login  { password }  → 세션 쿠키 발급
 * DELETE /api/login                → 로그아웃
 * 무차별 대입을 늦추기 위해 실패 시 1초 지연합니다.
 */
import { authConfigured, makeSessionCookie, clearSessionCookie, safeEqual } from '../_lib/auth.js';

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });

export async function onRequestPost({ request, env }) {
  if (!authConfigured(env)) return json(503, { error: 'auth_not_configured' });

  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return json(403, { error: 'bad_origin' });

  let password = '';
  try {
    const body = await request.json();
    password = String(body.password || '');
  } catch {
    return json(400, { error: 'bad_request' });
  }

  if (!safeEqual(password, env.DASHBOARD_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 1000));
    return json(401, { error: 'wrong_password' });
  }
  return json(200, { ok: true }, { 'Set-Cookie': await makeSessionCookie(env) });
}

export async function onRequestDelete() {
  return json(200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
}
