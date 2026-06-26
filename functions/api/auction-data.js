/**
 * Cloudflare Pages Functions — NocoDB API 프록시
 * 경로: /api/auction-data
 *
 * 브라우저는 토큰 없이 이 엔드포인트를 호출합니다.
 * 이 함수가 서버 환경변수에서 NOCODB_TOKEN을 읽어
 * NocoDB API에 안전하게 중계합니다.
 *
 * 필요한 Cloudflare 환경변수 (대시보드에서 설정):
 *   NOCODB_TOKEN   — NocoDB Personal Access Token
 *   NOCODB_BASE    — ex) https://crm.thecalibration.kr
 *   TABLE_ID       — NocoDB 테이블 ID
 *   PROJECT_ID     — NocoDB 프로젝트(Base) ID
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestGet({ request, env }) {
  // ── 환경변수 확인 ──────────────────────────────────────
  const { NOCODB_TOKEN, NOCODB_BASE, TABLE_ID, PROJECT_ID } = env;

  if (!NOCODB_TOKEN || !NOCODB_BASE || !TABLE_ID || !PROJECT_ID) {
    return new Response(
      JSON.stringify({
        error: 'Server configuration error: missing environment variables.',
        missing: [
          !NOCODB_TOKEN  && 'NOCODB_TOKEN',
          !NOCODB_BASE   && 'NOCODB_BASE',
          !TABLE_ID      && 'TABLE_ID',
          !PROJECT_ID    && 'PROJECT_ID',
        ].filter(Boolean),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      }
    );
  }

  // ── 클라이언트 쿼리 파라미터를 투명하게 NocoDB에 전달 ──
  const incomingUrl = new URL(request.url);
  const params = incomingUrl.searchParams;

  // 허용된 파라미터만 전달 (보안: 임의 파라미터 차단)
  const allowed = ['where', 'sort', 'limit', 'fields', 'offset'];
  const forwardedParams = new URLSearchParams();
  for (const key of allowed) {
    if (params.has(key)) forwardedParams.set(key, params.get(key));
  }

  const nocoUrl =
    `${NOCODB_BASE}/api/v1/db/data/noco/${PROJECT_ID}/${TABLE_ID}` +
    (forwardedParams.toString() ? `?${forwardedParams.toString()}` : '');

  // ── NocoDB 호출 (토큰은 서버에서만 첨부) ──────────────
  let nocoRes;
  try {
    nocoRes = await fetch(nocoUrl, {
      headers: {
        'xc-token': NOCODB_TOKEN,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Failed to reach NocoDB: ${err.message}` }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      }
    );
  }

  // ── NocoDB 응답 오류 처리 ──────────────────────────────
  if (!nocoRes.ok) {
    const text = await nocoRes.text();
    return new Response(
      JSON.stringify({
        error: `NocoDB responded with ${nocoRes.status}`,
        detail: text,
      }),
      {
        status: nocoRes.status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      }
    );
  }

  // ── 성공: JSON을 그대로 브라우저에 반환 ───────────────
  const data = await nocoRes.json();
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // 30초 캐시 (CDN 엣지에서 캐싱, 불필요한 NocoDB 호출 감소)
      'Cache-Control': 'public, max-age=30, s-maxage=30',
      ...CORS_HEADERS,
    },
  });
}

// OPTIONS 프리플라이트 요청 처리 (CORS)
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
