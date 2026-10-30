// ─────────────────────────────────────
// 이메일 액션 삽입 (일간/주간 리포트 공용)
// "HTML 리포트 생성" 결과 HTML의 각 물건 행 아래에
// AI 요약 한 줄 + [⭐ 관심 추가] [📄 AI요약·명세서] 버튼 행을 추가합니다.
// 버튼은 대시보드의 /api/item 페이지로 연결됩니다 (functions/api/item.js).
// ─────────────────────────────────────

const DASHBOARD_URL = '__DASHBOARD_URL__'; // 예: https://auction.example.com (끝에 / 없이)
const SOURCE_NODE = '__SOURCE_NODE__';     // NocoDB 조회 노드 이름

const report = $input.first().json;
const list = $(SOURCE_NODE).first().json.list || [];

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const truncate = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

const btn = (href, label, bg, color) =>
  `<a href="${href}" style="display:inline-block;background:${bg};color:${color};padding:6px 12px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:700;margin:4px 6px 0 0">${label}</a>`;

const actionRow = (item) => {
  const base = `${DASHBOARD_URL}/api/item?id=${encodeURIComponent(item.Id)}`;
  const done = ['낙찰', '유찰'].includes(item.status);
  const summary = truncate(item.ai_summary, 180);
  const flags = truncate(item.ai_flags, 80);
  const interested = item.is_interested === true || item.is_interested === 1 || item.is_interested === 'true';
  const interestBtn = done ? '' : interested
    ? '<span style="display:inline-block;background:#ede9fe;color:#6d28d9;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:700;margin:4px 6px 0 0">⭐ 관심물건</span>'
    : btn(`${base}&action=interest`, '⭐ 관심 추가', '#7c3aed', '#fff');
  return `
  <tr>
    <td colspan="7" style="padding:0 8px 12px;border-bottom:1px solid #e5e7eb">
      ${summary ? `<div style="font-size:12px;color:#374151;line-height:1.5;background:#f9fafb;border-radius:6px;padding:8px 10px">🤖 ${esc(summary)}${flags ? `<br><span style="color:#b45309">🚩 ${esc(flags)}</span>` : ''}</div>` : ''}
      ${interestBtn}${btn(base, '📄 AI요약·명세서 보기', '#eef2ff', '#1e3a5f')}
    </td>
  </tr>`;
};

let html = report.html || '';
let injected = 0;

for (const item of list) {
  if (!item.case_no || !item.Id) continue;
  const marker = `사건: ${item.case_no}</div>`;
  let from = 0;
  while (true) {
    const at = html.indexOf(marker, from);
    if (at === -1) break;
    const end = html.indexOf('</tr>', at);
    if (end === -1) break;
    const insertAt = end + '</tr>'.length;
    const row = actionRow(item);
    html = html.slice(0, insertAt) + row + html.slice(insertAt);
    from = insertAt + row.length;
    injected++;
  }
}

return [{ json: { ...report, html, actions_injected: injected } }];
