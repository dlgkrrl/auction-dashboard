/**
 * Cloudflare Pages Functions — n8n 경매 일일 파이프라인 실행 프록시
 * 경로: /api/run-pipeline
 *
 * 브라우저의 직접 호출(CSP/CORS 제한 및 보안)을 방지하고
 * Cloudflare 서버리스 환경에서 n8n 웹훅 엔드포인트로 안전하게 POST 요청을 전달합니다.
 *
 * Cloudflare 환경변수 (설정 권장):
 *   N8N_WEBHOOK_URL — ex) https://n8n.thecalibration.kr/webhook/auction
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// 기본 fallback 웹훅 URL
const DEFAULT_WEBHOOK_URL = 'https://n8n.thecalibration.kr/webhook/auction';

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export async function onRequestPost({ request, env }) {
  const webhookUrl = env.N8N_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;

  // 요청 Body 확인 (있으면 전달, 없으면 기본 빈 객체)
  let requestPayload = {};
  try {
    const text = await request.text();
    if (text) {
      requestPayload = JSON.parse(text);
    }
  } catch (e) {
    // 본문 파싱 실패 시 기본 빈 객체 유지
    requestPayload = {};
  }

  // 타임아웃 10초 설정 (n8n Webhook 노드는 'onReceived' 즉시 200 반환)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const n8nRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TheCalibration-AuctionDashboard/1.0',
      },
      body: JSON.stringify({
        source: 'dashboard_manual_trigger',
        triggeredAt: new Date().toISOString(),
        ...requestPayload,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!n8nRes.ok) {
      const errText = await n8nRes.text();
      return new Response(
        JSON.stringify({
          success: false,
          error: `n8n webhook error (${n8nRes.status}): ${errText || n8nRes.statusText}`,
        }),
        {
          status: n8nRes.status,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        }
      );
    }

    let responseData = {};
    try {
      responseData = await n8nRes.json();
    } catch {
      responseData = { message: 'Workflow execution triggered successfully.' };
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: '크롤링 및 분석 파이프라인이 성공적으로 시작되었습니다.',
        data: responseData,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      }
    );
  } catch (err) {
    clearTimeout(timeoutId);

    const isTimeout = err.name === 'AbortError';
    const errorMessage = isTimeout
      ? 'n8n 서버 응답 시간 초과 (10초). n8n 서버 상태를 확인해주세요.'
      : `n8n 웹훅 연결 실패: ${err.message}`;

    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage,
      }),
      {
        status: isTimeout ? 504 : 502,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      }
    );
  }
}
