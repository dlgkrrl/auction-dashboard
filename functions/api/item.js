/**
 * Cloudflare Pages Functions — 이메일 리포트용 물건 상세 페이지 + 관심 등록
 * 경로: /api/item
 *
 * 이메일 클라이언트는 JS를 실행하지 못하므로, 일간/주간 리포트 메일의 버튼은
 * 이 엔드포인트로 연결되는 평범한 링크입니다.
 *
 *   GET  /api/item?id={rowId}                  → 물건 상세 (AI 요약, 매각물건명세서 등 서류 원문)
 *   GET  /api/item?id={rowId}&action=interest  → 관심 등록 후 상세 페이지 표시 (메일에서 한 번 클릭)
 *   POST /api/item?id={rowId}  (form action=interest|uninterest) → 상세 페이지의 버튼
 *
 * 관심 필드는 대시보드 toggleStar와 동일: is_interested, interest_level, interested_at
 * 필요한 Cloudflare 환경변수: NOCODB_TOKEN, NOCODB_BASE, TABLE_ID, PROJECT_ID (auction-data.js와 동일)
 */

const INTEREST_ON = () => ({ is_interested: true, interest_level: 1, interested_at: new Date().toISOString() });
const INTEREST_OFF = { is_interested: false };

const DOC_SECTIONS = [
  { key: 'doc_spec_text',      title: '📄 매각물건명세서', pdf: 'pdf_spec_url' },
  { key: 'doc_survey_text',    title: '📄 현황조사서',     pdf: 'pdf_survey_url' },
  { key: 'doc_appraisal_text', title: '📄 감정평가서',     pdf: 'pdf_appraisal_url' },
  { key: 'doc_registry_text',  title: '📄 등기부등본',     pdf: null },
  { key: 'doc_ledger_text',    title: '📄 건축물대장',     pdf: null },
];

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const action = url.searchParams.get('action');

  const check = validate(env, id);
  if (check) return check;

  let notice = '';
  if (action === 'interest') {
    const res = await patchItem(env, id, INTEREST_ON());
    notice = res.ok ? '⭐ 관심물건에 추가했습니다.' : `❌ 관심 등록 실패: ${res.error}`;
  }
  return renderItem(env, id, notice);
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  const check = validate(env, id);
  if (check) return check;

  let action = '';
  try {
    const form = await request.formData();
    action = form.get('action') || '';
  } catch {
    action = '';
  }

  let notice = '';
  if (action === 'interest' || action === 'uninterest') {
    const res = await patchItem(env, id, action === 'interest' ? INTEREST_ON() : INTEREST_OFF);
    notice = res.ok
      ? (action === 'interest' ? '⭐ 관심물건에 추가했습니다.' : '관심물건에서 해제했습니다.')
      : `❌ 저장 실패: ${res.error}`;
  }
  return renderItem(env, id, notice);
}

// ─────────────────────────────────────────────────────────────────────

function validate(env, id) {
  const { NOCODB_TOKEN, NOCODB_BASE, TABLE_ID, PROJECT_ID } = env;
  if (!NOCODB_TOKEN || !NOCODB_BASE || !TABLE_ID || !PROJECT_ID) {
    return page('설정 오류', '<p>서버 환경변수가 설정되지 않았습니다.</p>', 500);
  }
  if (!id || !/^\d+$/.test(id)) {
    return page('잘못된 요청', '<p>물건 번호(id)가 올바르지 않습니다.</p>', 400);
  }
  return null;
}

function rowUrl(env, id) {
  return `${env.NOCODB_BASE}/api/v1/db/data/noco/${env.PROJECT_ID}/${env.TABLE_ID}/${id}`;
}

async function patchItem(env, id, body) {
  try {
    const res = await fetch(rowUrl(env, id), {
      method: 'PATCH',
      headers: { 'xc-token': env.NOCODB_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `NocoDB ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function renderItem(env, id, notice) {
  let item;
  try {
    const res = await fetch(rowUrl(env, id), {
      headers: { 'xc-token': env.NOCODB_TOKEN, 'Content-Type': 'application/json' },
    });
    if (res.status === 404) return page('물건 없음', '<p>해당 물건을 찾을 수 없습니다.</p>', 404);
    if (!res.ok) return page('조회 실패', `<p>NocoDB 응답 오류 (${res.status})</p>`, 502);
    item = await res.json();
  } catch (err) {
    return page('조회 실패', `<p>NocoDB에 연결하지 못했습니다: ${esc(err.message)}</p>`, 502);
  }
  return page(item.complex_name || item.case_no || '물건 상세', itemBody(item, id, notice));
}

export function itemBody(item, id, notice = '') {
  const interested = !!item.is_interested && item.is_interested !== 'false' && item.is_interested !== 0;
  const riskColor = { 안전: '#10b981', 주의: '#f59e0b', 위험: '#ef4444' }[item.ai_risk] || '#6b7280';

  const docs = DOC_SECTIONS.map(({ key, title, pdf }) => {
    const text = item[key];
    const pdfUrl = pdf ? getDocUrl(item[pdf]) : null;
    if (!text && !pdfUrl) return '';
    const pdfLink = pdfUrl ? ` <a href="${esc(pdfUrl)}" target="_blank" rel="noopener" class="pdf">PDF 원본 →</a>` : '';
    return `
      <details${key === 'doc_spec_text' ? ' open' : ''}>
        <summary>${title}${pdfLink}</summary>
        ${text ? `<div class="doc">${esc(text)}</div>` : '<div class="muted">텍스트 추출본이 없습니다.</div>'}
      </details>`;
  }).join('');

  return `
    ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
    <div class="card">
      <div class="title">${esc(item.complex_name || '단지명 미확인')}</div>
      <div class="sub">${esc(item.location || '')}</div>
      <div class="sub">사건 ${esc(item.case_no || '-')} · ${esc(item.area_m2 ?? '-')}㎡ · ${esc(item.floor ?? '-')}층 · 매각기일 ${esc(String(item.bid_date || '-').split('T')[0])}</div>
      <div class="prices">
        <div><span>감정가</span><b>${fmt(item.appraisal_price)}</b></div>
        <div><span>최저가 (${esc(item.price_rate ?? 0)}%)</span><b class="blue">${fmt(item.min_price)}</b></div>
        <div><span>유찰</span><b>${esc(item.loss_count || 0)}회</b></div>
      </div>
      <form method="POST" action="/api/item?id=${esc(id)}" class="actions">
        ${interested
          ? '<button name="action" value="uninterest" class="btn ghost">⭐ 관심물건 (해제)</button>'
          : '<button name="action" value="interest" class="btn">⭐ 관심물건 추가</button>'}
        ${item.court_url ? `<a class="btn ghost" href="${esc(item.court_url)}" target="_blank" rel="noopener">법원 경매정보 →</a>` : ''}
        <a class="btn ghost" href="/">대시보드 →</a>
      </form>
    </div>

    <div class="card">
      <h2>🤖 AI 권리분석 요약</h2>
      ${item.ai_summary || item.ai_risk
        ? `<div class="ai" style="border-color:${riskColor}">
             <b style="color:${riskColor}">${esc(item.ai_risk || '미분석')}${item.ai_recommend ? ` | ${esc(item.ai_recommend)}` : ''}</b>
             <div class="doc plain">${esc(item.ai_summary || '')}</div>
             ${item.ai_flags ? `<div class="muted">🚩 특이사항: ${esc(item.ai_flags)}</div>` : ''}
           </div>`
        : '<div class="muted">AI 분석 결과가 아직 없습니다.</div>'}
    </div>

    <div class="card">
      <h2>서류</h2>
      ${docs || '<div class="muted">수집된 서류가 없습니다.</div>'}
    </div>`;
}

function page(title, body, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{margin:0;background:#f8fafc;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:16px}
  .card{background:#fff;border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .title{font-size:20px;font-weight:800}
  .sub{font-size:13px;color:#6b7280;margin-top:4px}
  .prices{display:flex;gap:16px;flex-wrap:wrap;margin:14px 0}
  .prices span{display:block;font-size:12px;color:#6b7280}
  .prices b{font-size:15px}.blue{color:#2563eb}
  .actions{display:flex;gap:8px;flex-wrap:wrap}
  .btn{display:inline-block;border:0;border-radius:8px;padding:10px 14px;font-size:14px;font-weight:700;background:#7c3aed;color:#fff;text-decoration:none;cursor:pointer}
  .btn.ghost{background:#eef2ff;color:#1e3a5f}
  h2{font-size:15px;margin:0 0 10px}
  .ai{border-left:4px solid;padding-left:12px}
  .doc{white-space:pre-wrap;font-size:13px;line-height:1.6;background:#f9fafb;border-radius:8px;padding:12px;margin-top:8px;max-height:480px;overflow:auto}
  .doc.plain{background:none;padding:0;max-height:none}
  details{border-top:1px solid #f3f4f6;padding:10px 0}
  summary{font-weight:700;cursor:pointer;font-size:14px}
  .pdf{font-weight:400;font-size:12px;margin-left:8px}
  .muted{color:#6b7280;font-size:13px;margin-top:6px}
  .notice{background:#ede9fe;color:#5b21b6;font-weight:700;border-radius:10px;padding:12px 14px;margin-bottom:14px}
</style></head>
<body><div class="wrap">${body}</div></body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function getDocUrl(val) {
  if (!val) return null;
  if (typeof val === 'string') {
    if (val.trim().startsWith('[')) {
      try { return getDocUrl(JSON.parse(val)); } catch { return null; }
    }
    return /^https?:\/\//.test(val) ? val : null;
  }
  if (Array.isArray(val) && val.length > 0) return val[0].url || val[0].signedUrl || null;
  return null;
}

function fmt(n) {
  n = Number(n);
  if (!n || n <= 0) return '-';
  const eok = Math.floor(n / 100000000);
  const man = Math.round((n % 100000000) / 10000);
  return eok > 0 ? (man > 0 ? `${eok}억 ${man.toLocaleString()}만` : `${eok}억`) : `${man.toLocaleString()}만`;
}

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
