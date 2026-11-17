// 프론트엔드 점검: 폭별 가로 넘침 / 짧은 글자 줄바꿈 / 잘림
const { chromium } = require('playwright-core');
const fs = require('fs');
const D = process.argv[2] || require('path').join(__dirname, 'out'); require('fs').mkdirSync(D, { recursive: true });
const WIDTHS = [320, 360, 390, 414, 768, 1024, 1280, 1440];

const probe = () => {
  const W = innerWidth;
  const name = (e) => {
    let s = e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : '');
    const p = e.closest('[id]'); if (p && p !== e) s = '#' + p.id + ' › ' + s;
    return s;
  };
  const inScroll = (e) => { let p = e.parentElement; while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (/(auto|scroll|hidden)/.test(o)) return name(p); p = p.parentElement; } return null; };
  const visible = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const overflow = [], scrollers = new Set(), wraps = [], clipped = [];
  document.querySelectorAll('body *').forEach(e => {
    if (!visible(e)) return;
    const r = e.getBoundingClientRect();
    if (r.right > W + 1) { const sc = inScroll(e); if (sc) scrollers.add(sc); else overflow.push(name(e) + ` (오른쪽 ${Math.round(r.right)}px)`); }
    // 짧은 글자가 2줄 이상: 버튼·뱃지·라벨·표 머리·칩 등 (직접 텍스트가 있는 요소)
    const own = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    const text = (e.innerText || '').trim().replace(/\s+/g, ' ');
    if (own && text.length <= 24 && !/\n/.test(e.innerText.trim())) {
      const cs = getComputedStyle(e);
      let lh = parseFloat(cs.lineHeight); if (isNaN(lh)) lh = parseFloat(cs.fontSize) * 1.25;
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const lines = Math.round((r.height - pad) / lh);
      if (lines >= 2 && cs.display !== 'block' || (lines >= 2 && /^(BUTTON|A|SPAN|TH|TD|LABEL|LI)$/.test(e.tagName)) || (lines >= 2 && /label|title|badge|chip|btn|tab|val|stat/.test(e.className))) {
        if (lines >= 2) wraps.push(`${name(e)} "${text}" ${lines}줄 (폭 ${Math.round(r.width)}px)`);
      }
    }
    // 잘림: overflow hidden 인데 내용이 더 넓음 (말줄임 표시 없이)
    const cs = getComputedStyle(e);
    if (cs.overflowX === 'hidden' && e.scrollWidth > e.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && (e.innerText || '').trim()) clipped.push(`${name(e)} 내용 ${e.scrollWidth}px > 보이는 ${e.clientWidth}px`);
  });
  const uniq = (a) => [...new Set(a)];
  return { scrollWidth: document.documentElement.scrollWidth, W, overflow: uniq(overflow).slice(0, 25), scrollers: [...scrollers], wraps: uniq(wraps).slice(0, 60), clipped: uniq(clipped).slice(0, 20) };
};

(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const report = {};
  for (const w of WIDTHS) {
    const p = await b.newPage({ viewport: { width: w, height: 900 } });
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(process.env.URL || 'http://localhost:8765/', { waitUntil: 'networkidle' }); await p.waitForTimeout(2200);
    const main = await p.evaluate(probe);
    await p.screenshot({ path: `${D}/a_${w}_main.png`, fullPage: true });
    await p.evaluate(() => openDetailModal(2)); await p.waitForTimeout(700);
    const modal = await p.evaluate(probe);
    await p.screenshot({ path: `${D}/a_${w}_modal.png` });
    await p.evaluate(() => switchDocTab('roi')); await p.waitForTimeout(400);
    const roi = await p.evaluate(probe);
    await p.screenshot({ path: `${D}/a_${w}_roi.png` });
    await p.evaluate(() => closeModal());
    let stats = null;
    try { await p.evaluate(() => openStatsModal()); await p.waitForTimeout(600); stats = await p.evaluate(probe); await p.screenshot({ path: `${D}/a_${w}_stats.png` }); await p.evaluate(() => closeStatsModal()); } catch (e) { stats = { error: e.message }; }
    let prof = null;
    try { await p.evaluate(() => openProfileModal()); await p.waitForTimeout(400); prof = await p.evaluate(probe); await p.screenshot({ path: `${D}/a_${w}_profile.png` }); } catch (e) { prof = { error: e.message }; }
    report[w] = { errs, main, modal, roi, stats, prof };
    await p.close();
  }
  fs.writeFileSync(`${D}/audit.json`, JSON.stringify(report, null, 1));
  for (const w of WIDTHS) {
    const r = report[w];
    console.log(`\n=== ${w}px  페이지 폭 ${r.main.scrollWidth} ${r.errs.length ? 'JS오류 ' + r.errs.join('|') : ''}`);
    for (const k of ['main', 'modal', 'roi', 'stats', 'prof']) {
      const x = r[k]; if (!x || x.error) { console.log(k, x && x.error); continue; }
      console.log(`[${k}] 넘침 ${x.overflow.length} · 줄바꿈 ${x.wraps.length} · 잘림 ${x.clipped.length} · 가로스크롤칸 ${x.scrollers.join(', ')}`);
    }
  }
  await b.close();
})();
