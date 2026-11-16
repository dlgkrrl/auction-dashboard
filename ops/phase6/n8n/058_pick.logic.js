// 058 · 서류 재수집 대상 고르기 (매일 02:15 — 크롤러·browserless 켜진 00:50~04:00 중 012·043과 010 사이 빈 시간)
// refetch_status: '대기 · …'(대시보드 요청) → 이번에 수집, '수집중 · …'(지난밤에 끝나지 못함) → 실패로 정리
const list = ($input.first().json.list) || [];
const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
const MAX = 10;   // 1건 1~2분 → 10건이면 03:00 010 전에 끝남
const uidOf = (u) => { const m = String(u || '').match(/\/view\/(\d+)|idx=(\d+)/); return m ? (m[1] || m[2]) : ''; };

const marks = [];
const targets = [];
const waiting = list.filter((it) => /^대기/.test(String(it.refetch_status || '')));
for (const it of list) {
  if (/^수집중/.test(String(it.refetch_status || ''))) {
    marks.push({ Id: it.Id, refetch_status: `실패 · ${stamp} · 지난 수집이 끝나지 않음(크롤러 중단 추정) — 다시 요청하세요` });
  }
}
for (const it of waiting) {
  const uid = uidOf(it.court_url);
  if (!uid) { marks.push({ Id: it.Id, refetch_status: `실패 · ${stamp} · 상세번호(court_url) 없음` }); continue; }
  if (targets.length >= MAX) continue;   // 나머지는 '대기' 그대로 → 다음날
  const has = (v) => !!(v && String(v).trim() && String(v).trim() !== '정보 없음');
  targets.push({ Id: it.Id, uid, complex_name: it.complex_name, area_m2: it.area_m2,
    had: { doc_spec_text: has(it.doc_spec_text), doc_survey_text: has(it.doc_survey_text), doc_appraisal_text: has(it.doc_appraisal_text),
           doc_registry_text: has(it.doc_registry_text), doc_ledger_text: has(it.doc_ledger_text), real_trade_history: has(it.real_trade_history) } });
  marks.push({ Id: it.Id, refetch_status: `수집중 · ${stamp} 시작` });
}
return [{ json: { marks, targets, uids: targets.map((t) => t.uid), left: Math.max(0, waiting.length - MAX) } }];
