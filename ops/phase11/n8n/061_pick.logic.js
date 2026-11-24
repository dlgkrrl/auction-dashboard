// 061 · 서류 빠진 물건 자동 재요청 (매일 02:05, 058(02:15) 바로 앞)
// 신건은 처음 올라올 때 감정평가서·매각물건명세서·등기부가 아직 없을 수 있음 → 매각일 전까지 매일 058 대기로 올림
const list = ($input.first().json.list) || [];
const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const MAX = 10;   // 058 한 번에 10건
const since = new Date(Date.now() - 14 * 864e5).toISOString();   // 최근 14일 안에 들어온 물건만 (오래된 물건은 서류가 끝내 없는 경우가 많음)
const blank = (v) => !v || !String(v).trim() || String(v).trim() === '정보 없음';
// 래퍼 메뉴 글자만 들어간 가짜 서류(11-24 이전 크롤러)
const menuOnly = (v) => { const t = String(v || ''); return t.length < 800 && /본\s*정보는\s*참고용으로/.test(t) && /\nclose\n/.test(t); };
const bad = (v) => blank(v) || menuOnly(v);
const LABEL = { doc_appraisal_text: '감정평가', doc_spec_text: '명세서', doc_registry_text: '등기부', doc_ledger_text: '건축물대장' };

const busy = list.filter((it) => /^(대기|수집중)/.test(String(it.refetch_status || ''))).length;
const room = Math.max(0, MAX - busy);
const cands = [];
for (const it of list) {
  if (/^(대기|수집중)/.test(String(it.refetch_status || ''))) continue;
  if (!it.bid_date || String(it.bid_date).slice(0, 10) < today) continue;
  if (String(it.CreatedAt || it.created_at || '') < since) continue;
  if (!/\/view\/\d+/.test(String(it.court_url || ''))) continue;
  const miss = Object.keys(LABEL).filter((f) => bad(it[f])).map((f) => LABEL[f]);
  if (miss.length) cands.push({ it, miss });
}
cands.sort((a, b) => String(a.it.bid_date).localeCompare(String(b.it.bid_date)));
const marks = cands.slice(0, room).map(({ it, miss }) => ({ Id: it.Id, refetch_status: `대기 · ${stamp} 자동(빠진 서류: ${miss.join(', ')})` }));
if (!marks.length) return [];
return [{ json: { marks, total: cands.length } }];
