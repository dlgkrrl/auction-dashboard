// 숫자 표기 한 곳에서: 금액 '1억 2,200만' · 비율 '12.3%' · 배수 '1.23배'
// 원 단위 금액 → '1억 2,200만' (0은 '0원', 음수는 '-')
function fmt(n) {
  if (n === 0) return "0원";
  if (!n || isNaN(n)) return "-";
  const isNeg = n < 0;
  const absN = Math.abs(n);
  const e = Math.floor(absN / 100000000);
  const m = Math.round((absN % 100000000) / 10000);
  let str = "";
  if (e > 0) {
    str = m > 0 ? `${e}억 ${m.toLocaleString()}만` : `${e}억`;
  } else {
    str = `${m.toLocaleString()}만`;
  }
  return isNeg ? `-${str}` : str;
}
// 값이 없거나 0 이하면 '-' (가격 칸용)
function fmtPos(n) { return (!n || isNaN(n) || n <= 0) ? '-' : fmt(n); }
// 만원 단위 숫자 → 같은 표기
function fmtMan(man) { const n = Number(man); return isNaN(n) ? '-' : fmt(n * 10000); }
function fmtPct(v, digits = 1) { return v == null || isNaN(v) ? '-' : `${Number(v).toFixed(digits)}%`; }
function fmtTimes(v, digits = 2) { return v == null || isNaN(v) ? '-' : `${Number(v).toFixed(digits)}배`; }
