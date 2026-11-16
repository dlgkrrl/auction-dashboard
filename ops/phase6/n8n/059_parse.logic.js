// 059 · Dify 응답 → 물건 PATCH 행 (010 'Dify 결과 파싱'과 같은 규칙, 권리분석 칸만 바꿈)
// 입력: 'Dify 재분석' HTTP 응답(항목마다), 짝이 되는 '대상 고르기' 항목(같은 순서)
const targets = $('대상 고르기').all().map((x) => x.json);
const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
const DANGER_KW = ['유치권', '대항력', '법정지상권', '인수', '가처분', '위반건축', '공유'];
const CAUTION_KW = ['임차인', '전세', '점유', '분쟁', '선순위'];
const safeNum = (v) => {
  if (v === undefined || v === null || v === '') return -1;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? -1 : n;
};

const rows = [];
$input.all().forEach((res, i) => {
  const t = targets[i];
  if (!t) return;
  const j = res.json || {};
  if (j.error || (!j.answer && !j.text && !j.body)) {
    const msg = String((j.error && (j.error.message || j.error)) || '응답 없음').slice(0, 120);
    rows.push({ Id: t.Id, ai_reanalyze_status: `실패 · ${stamp} · Dify 오류: ${msg}` });
    return;
  }
  let raw = j.answer || j.text || j.body || '';
  if (typeof raw === 'string' && raw.includes('data:')) {
    let gathered = '';
    for (const line of raw.split('\n')) {
      const tr = line.trim();
      if (!tr.startsWith('data:')) continue;
      try { const p = JSON.parse(tr.replace(/^data:\s*/, '')); if (p.answer) gathered += p.answer; } catch (_) { /* message_end 등 */ }
    }
    if (gathered) raw = gathered;
  }
  const cleaned = String(raw).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  let ai, parseOk = false;
  try { ai = JSON.parse(cleaned); parseOk = true; } catch (_) {
    const fd = DANGER_KW.filter((k) => cleaned.includes(k));
    const fc = CAUTION_KW.filter((k) => cleaned.includes(k));
    ai = fd.length ? { risk: '위험', summary: `위험요소: ${fd.join(', ')}`, recommend: '입찰비권고', flags: fd }
      : fc.length ? { risk: '주의', summary: `주의사항: ${fc.join(', ')}`, recommend: '검토필요', flags: fc }
      : { risk: '안전', summary: 'AI 파싱 실패 — 직접 확인 필요', recommend: '수동확인필요', flags: [] };
  }
  const flags = JSON.stringify(ai.pdf_risk_flags || []);
  rows.push({
    Id: t.Id,
    ai_risk: ai.risk || '분석실패',
    ai_summary: ai.summary || '',
    ai_recommend: ai.recommend || '수동확인필요',
    ai_flags: (ai.flags || []).join(', '),
    tenant_deposit_total: safeNum(ai.tenant_deposit_total),
    senior_lien_total: safeNum(ai.senior_lien_total),
    cancellation_standard: ai.cancellation_standard || '',
    inherited_amount: safeNum(ai.inherited_amount),
    tenant_count: safeNum(ai.tenant_count),
    pdf_risk_flags: flags,
    docs_risk_flags: flags,
    parsing_status: parseOk ? 'ok' : 'partial',
    ai_reanalyze_status: `완료 · ${stamp} · ${ai.risk || '분석실패'}${parseOk ? '' : ' (JSON 아님, 키워드로 판단)'}`,
  });
});
return [{ json: { rows } }];
