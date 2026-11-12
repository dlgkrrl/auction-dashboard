/**
 * 대시보드 API 인증 도우미 (Cloudflare Pages Functions, WebCrypto)
 *
 * 환경변수 (Cloudflare Pages > Settings > Environment variables, 암호화로 저장)
 *   DASHBOARD_PASSWORD — 대시보드 로그인 비밀번호
 *   DASHBOARD_SECRET   — 세션 쿠키·메일 링크 서명 키 (32자 이상 무작위 문자열)
 *
 * 세션 쿠키:  cal_session = "{만료 epoch초}.{HMAC(secret, 'session:'+만료)}"
 * 메일 링크:  /api/item?id={Id}&sig={HMAC(secret, 'item:'+Id)}  — 그 물건 하나의 보기·관심 등록만 허용
 */

export const SESSION_COOKIE = 'cal_session';
export const SESSION_DAYS = 30;

const enc = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return base64url(new Uint8Array(sig));
}

function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 길이와 무관하게 끝까지 비교 (타이밍 차이로 값을 추측하지 못하게) */
export function safeEqual(a, b) {
  a = String(a ?? '');
  b = String(b ?? '');
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function authConfigured(env) {
  return !!(env.DASHBOARD_SECRET && env.DASHBOARD_SECRET.length >= 16 && env.DASHBOARD_PASSWORD);
}

export async function makeSessionCookie(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const value = `${exp}.${await hmac(env.DASHBOARD_SECRET, `session:${exp}`)}`;
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

/** 진단용: 비밀값 없이 쿠키 상태만 설명 (GET /api/session) */
export async function describeSession(request, env) {
  const header = request.headers.get('Cookie') || '';
  const names = header.split(';').map((p) => p.trim().split('=')[0]).filter(Boolean);
  const raw = readCookie(request, SESSION_COOKIE);
  const dot = raw.indexOf('.');
  const exp = dot > 0 ? Number(raw.slice(0, dot)) : NaN;
  let sigOk = false;
  if (dot > 0 && Number.isFinite(exp)) {
    sigOk = safeEqual(raw.slice(dot + 1), await hmac(env.DASHBOARD_SECRET, `session:${exp}`));
  }
  return {
    cookie_header_present: !!header,
    cookie_names: names,
    session_cookie_present: !!raw,
    format_ok: dot > 0 && Number.isFinite(exp),
    expired: Number.isFinite(exp) ? exp < Date.now() / 1000 : null,
    signature_ok: sigOk,
  };
}

export async function hasValidSession(request, env) {
  const raw = readCookie(request, SESSION_COOKIE);
  const dot = raw.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(raw.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const expected = await hmac(env.DASHBOARD_SECRET, `session:${exp}`);
  return safeEqual(raw.slice(dot + 1), expected);
}

export async function itemSig(env, id) {
  return hmac(env.DASHBOARD_SECRET, `item:${id}`);
}

export async function hasValidItemSig(env, id, sig) {
  if (!id || !sig) return false;
  return safeEqual(sig, await itemSig(env, id));
}
