// 0단계 일회성 보정: 진행중 물건의 법원(매각물건명세서 첫머리 기준) · 지분 · 여러 호수 일괄 표시
// 입력: NocoDB 목록 { list: [...] } / 출력: 바꿀 행만 [{ Id, ...변경필드 }]
const list = ($input.first().json.list) || [];
const SHARE_RE = /지분\s*매각|공유\s*지분|매각\s*지분/;
const BULK_RE = /일괄\s*매각/;
const MULTI_UNIT_ADDR_RE = /외\s*\d+\s*개?\s*호/;
const UNIT_TYPES_RE = /아파트|다세대|빌라|연립|오피스텔|도시형/;

function courtFromSpec(spec) {
  const head = String(spec || '').slice(0, 400).replace(/\s+/g, '');
  const m = head.match(/([가-힣]{2})지방법원([가-힣]{2}지원)?/);
  if (!m) return '';
  return m[2] ? `${m[1]}지방법원 ${m[2]}` : `${m[1]}지방법원`;
}

const patches = [];
for (const it of list) {
  const spec = String(it.doc_spec_text || '');
  const loc = String(it.location || '');
  const patch = {};

  let court = courtFromSpec(spec);
  if (!court && /양산시/.test(loc)) court = '울산지방법원';
  if (court && court !== it.court) patch.court = court;

  const isShare = SHARE_RE.test(spec.replace(/[ \t]+/g, ' '));
  const units = new Set((spec.match(/제?\s*\d{1,4}\s*호/g) || []).map((s) => s.replace(/\D/g, '')));
  const isUnitType = UNIT_TYPES_RE.test(String(it.usage || '') + ' ' + String(it.complex_name || '')) || /\d+\s*호/.test(loc);
  const isBulk = MULTI_UNIT_ADDR_RE.test(loc) || (BULK_RE.test(spec) && isUnitType && units.size >= 2);

  if (isShare && !it.is_share) patch.is_share = true;
  if (isBulk && !it.is_bulk) patch.is_bulk = true;
  if ((isShare || isBulk) && !it.is_hidden) patch.is_hidden = true; // status는 선택형(제외 옵션 없음) → 숨김 처리

  if (Object.keys(patch).length) patches.push({ Id: it.Id, ...patch, __case: it.case_no });
}
return patches.map((p) => ({ json: p }));
