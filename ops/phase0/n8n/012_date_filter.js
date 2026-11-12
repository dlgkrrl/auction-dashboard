// 012 · 오늘 날짜 필터 (2026-11-12 0단계 개편)
// - 01:00 KST 실행: 오늘 매각기일은 결과가 없으므로 어제까지만 추적
// - 지분·여러 호수 일괄 물건은 추적 제외
// - 기일이 3일 넘게 지났는데 결과가 안 잡히는 물건(기일변경 후 미정 등)은 7일에 한 번만 재확인
const list = $input.first().json.list || [];

const DAY = 24 * 60 * 60 * 1000;
const STALE_DAYS = 3;
const RECHECK_DAYS = 7;

const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
const todayStr = kstNow.toISOString().split('T')[0];
const staleCut = new Date(kstNow.getTime() - STALE_DAYS * DAY).toISOString().split('T')[0];

const toKstDateStr = (val) => {
  if (!val) return '';
  const str = String(val).trim();
  if (/^\d{4}[-.]\d{2}[-.]\d{2}$/.test(str)) return str.replace(/\./g, '-');
  const d = new Date(val);
  if (isNaN(d.getTime())) return str;
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
};
const parseTs = (v) => {
  if (!v) return null;
  const s = String(v).trim().replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
  return isNaN(d.getTime()) ? null : d;
};

const targets = list.filter((item) => {
  if (item.is_share || item.is_bulk) return false;
  const itemDateStr = toKstDateStr(item.bid_date || item.입찰기일 || item.매각기일);
  if (!itemDateStr || itemDateStr >= todayStr) return false;
  if (itemDateStr < staleCut) {
    const last = parseTs(item.last_checked);
    if (last && Date.now() - last.getTime() < RECHECK_DAYS * DAY) return false;
  }
  return true;
});

if (targets.length === 0) return [];
return [{ json: { list: targets } }];
