/**
 * GET /api/session — 로그인 쿠키 진단 (비밀값은 내보내지 않음)
 * 로그인했는데 401이 날 때 원인 확인용: 쿠키가 브라우저에서 오는지, 형식·만료·서명이 맞는지.
 */
import { authConfigured, describeSession } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const body = authConfigured(env)
    ? await describeSession(request, env)
    : { error: 'auth_not_configured' };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
