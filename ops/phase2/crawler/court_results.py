"""
법원 매각결과 표본 수집 (2026-11-13, 2단계)

우리 수집 필터(최저가 2억 이하·일 30건)와 무관하게, 같은 지역의 주거용 물건 중
지정한 매각기일 범위에 매각·유찰된 물건의 결과를 가볍게 모은다.
서류·PDF·사진·실거래·AI 분석은 하지 않는다 (상세 HTML 1장만 읽음).

n8n 30분 HTTP 타임아웃을 피하기 위해 app.py에서 작업(job)으로 실행:
  POST /court-results            → {"job_id": ...} 즉시 반환
  GET  /court-results/<job_id>   → {"status": "running"|"done"|"error", "items": [...]}
"""
import asyncio
import datetime
import logging
import os
import re

from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

from crawler.myauction_tracker import parse_case_header

logger = logging.getLogger(__name__)

TIME_BUDGET_SEC = 12 * 60          # 이 시간을 넘기면 모은 것만 반환
MAX_ITEMS_DEFAULT = 150
STATUS_KEYWORDS = ('불허', '미납', '매각', '유찰', '변경', '취하', '정지', '기각', '진행')
STATUS_LABEL = {'불허': '매각불허가', '미납': '대금미납', '진행': '진행중'}
RESIDENTIAL_CODES = ['101', '102', '103', '104', '105', '106', '107']


class CourtResultsException(Exception):
    pass


def _num(text):
    m = re.search(r'([\d,]{4,})', text or '')
    return int(m.group(1).replace(',', '')) if m else 0


def split_address(addr: str) -> dict:
    """'경상남도 창원시 성산구 사파동 114-7 …' → sgg='창원시 성산구', emd='사파동'"""
    toks = (addr or '').split()
    sgg, emd = '', ''
    if len(toks) >= 2:
        sgg = toks[1]
        rest = toks[2:]
        if rest and rest[0].endswith('구'):
            sgg = f"{sgg} {rest[0]}"
            rest = rest[1:]
        for t in rest:
            if re.search(r'(동|읍|면|가)$', t) and not re.match(r'^\d', t):
                emd = t
                break
    return {'sgg': sgg, 'emd': emd}


def parse_detail_html(html: str) -> dict:
    """상세 페이지 1장에서 결과에 필요한 값만 추출 (트래커와 같은 규칙)"""
    soup = BeautifulSoup(html, 'html.parser')
    out = {'address': '', 'appraisal_price': 0, 'area_m2': 0.0, 'usage': '',
           'schedule': [], 'sale_price': 0, 'bidder_count': 0}

    for h2 in soup.select('h2'):
        if '타경' in h2.get_text():
            t = h2.get_text()
            out.update(parse_case_header(t))
            m = re.search(r'(\d{4})\s*타경\s*(\d+)', t)
            out['case_no'] = f"{m.group(1)}타경{m.group(2)}" if m else ''
            u = re.search(r'\[([^\]]+)\]', t)
            if u:
                out['usage'] = u.group(1)
            break

    for th in soup.find_all('th'):
        label = th.get_text(strip=True)
        td = th.find_next_sibling(['td'])
        if not td:
            continue
        val = td.get_text(' ', strip=True)
        if '소재지' in label and not out['address']:
            out['address'] = re.sub(r'\[.*?\]', '', val).strip()
        elif '감정가' in label and not out['appraisal_price']:
            out['appraisal_price'] = _num(val)
        elif '면적' in label and not out['area_m2']:
            m = re.search(r'([\d.]+)\s*㎡', val) or re.search(r'([\d.]+)', val)
            if m:
                try:
                    out['area_m2'] = float(m.group(1))
                except ValueError:
                    pass

    plan = soup.select_one('#plan_sale')
    rows = plan.select('table.tbl_detail tr') if plan else []
    for tr in rows:
        cells = tr.find_all(['td', 'th'])
        if len(cells) < 4:
            continue
        txt = ' '.join(c.get_text(strip=True) for c in cells)
        dm = re.search(r'(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})', txt)
        if not dm:
            continue
        date = f"{dm.group(1)}-{dm.group(2).zfill(2)}-{dm.group(3).zfill(2)}"
        status_cell = cells[5].get_text(strip=True) if len(cells) >= 6 else cells[-1].get_text(strip=True)
        status = next((kw for kw in STATUS_KEYWORDS if kw in status_cell), '')
        round_m = re.match(r'^\s*(\d+)\s*$', cells[1].get_text(strip=True)) if len(cells) > 1 else None
        out['schedule'].append({
            'date': date,
            'round': int(round_m.group(1)) if round_m else None,
            'min_price': _num(cells[3].get_text()) if len(cells) > 3 else 0,
            'status': STATUS_LABEL.get(status, status),
        })

    success = soup.select_one('#success_man')
    if success:
        pink = success.select_one('span.pink')
        if pink:
            out['sale_price'] = _num(pink.text)
        blu = success.select('span.suc_blu')
        if blu:
            bm = re.search(r'\d+', blu[0].text)
            out['bidder_count'] = int(bm.group()) if bm else 0
    return out


async def _setup_search(page, sd_code, sgg_codes, date_from, date_to, aresult):
    """검색 폼: 지역(마이옥션 코드) + 주거용 + 매각기일 범위 + 현재상태"""
    await page.goto("https://www.my-auction.co.kr/auction/search.php", wait_until="domcontentloaded", timeout=30000)
    await page.click('input[name="stc"][value="1"]')
    await asyncio.sleep(0.5)
    await page.locator('select[name="address1_01"]').select_option(value=str(sd_code))
    await asyncio.sleep(0.5)
    added = 0
    for code in sgg_codes:
        for _ in range(3):
            await page.locator('select[name="address1_02"]').select_option(value=str(code))
            await asyncio.sleep(0.5)
            btn = page.locator('a[onclick*="searchea"]')
            if await btn.count() == 0:
                break
            await btn.first.click()
            await asyncio.sleep(0.8)
            n = await page.evaluate("() => { const s = document.querySelector('span#searchea'); return s ? s.children.length : 0; }")
            if n > added:
                added = n
                break
    if added == 0:
        raise CourtResultsException("지역 필터 설정 실패 (span#searchea 비어있음) — 전체 지역 검색 방지를 위해 중단")

    await page.evaluate("""(codes) => {
        document.querySelectorAll('input[name="usage_code"]').forEach(cb => {
            if (codes.includes(cb.value)) { cb.checked = true; cb.dispatchEvent(new Event('change', {bubbles: true})); }
        });
    }""", RESIDENTIAL_CODES)
    await page.evaluate(f"document.getElementById('ipdate1').value = '{date_from}'")
    await page.evaluate(f"document.getElementById('ipdate2').value = '{date_to}'")
    await page.locator('select[name="aresult"]').select_option(value=aresult)
    await asyncio.sleep(0.5)
    async with page.expect_navigation(wait_until="domcontentloaded", timeout=30000):
        await page.locator('button', has_text='검색').last.click()
    await asyncio.sleep(1.0)


async def _collect_uids(page, started, max_items):
    uids, page_num = [], 1
    while True:
        found = await page.evaluate(r"""() => {
            const out = []; const seen = new Set();
            document.querySelectorAll('a').forEach(a => {
                const h = a.href || a.getAttribute('href') || '';
                const m = h.match(/view\/(\d+)/) || h.match(/idx=(\d+)/);
                if (m && !seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
            });
            return out;
        }""")
        new = [u for u in found if u not in uids]
        uids.extend(new)
        logger.info(f"CourtResults: 목록 {page_num}쪽 {len(new)}건 (누계 {len(uids)})")
        if not new or len(uids) >= max_items:
            break
        if asyncio.get_event_loop().time() - started > TIME_BUDGET_SEC / 3:
            logger.warning("CourtResults: 목록 시간 상한 도달")
            break
        nxt = page.locator(f"a[href*='page={page_num + 1}']")
        if await nxt.count() == 0:
            break
        async with page.expect_navigation(wait_until="domcontentloaded", timeout=30000):
            await nxt.first.click()
        await asyncio.sleep(1.0)
        page_num += 1
    return uids[:max_items]


async def collect_court_results(sd_code, sgg_codes, date_from, date_to,
                                statuses=('매각', '유찰'), max_items=MAX_ITEMS_DEFAULT, progress=None):
    """지역·기일 범위·현재상태별로 검색해 상세 결과를 모은다. progress(dict)가 있으면 진행 상황 기록."""
    my_id = os.environ.get("MY_AUCTION_ID")
    my_pw = os.environ.get("MY_AUCTION_PW")
    ws_url = os.environ.get("BROWSERLESS_WS_URL", "ws://browserless:3000")
    ws_url += ("&" if "?" in ws_url else "?") + "timeout=900000"
    if not my_id or not my_pw:
        raise CourtResultsException("마이옥션 ID 또는 PW가 설정되지 않았습니다.")

    started = asyncio.get_event_loop().time()
    items, seen = [], set()
    progress = progress if progress is not None else {}

    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(ws_url, timeout=180000)
        try:
            context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
            page = await context.new_page()
            page.on("dialog", lambda d: asyncio.create_task(d.accept()))

            await page.goto("https://www.my-auction.co.kr/member/login.php", wait_until="domcontentloaded", timeout=30000)
            await page.fill('input[name="login_id"]', my_id)
            await page.fill('input[name="login_pw"]', my_pw)
            await page.click('#btn_login')
            await asyncio.sleep(3)
            if "login" in page.url.lower():
                raise CourtResultsException("마이옥션 로그인 실패")

            for aresult in statuses:
                await _setup_search(page, sd_code, sgg_codes, date_from, date_to, aresult)
                uids = await _collect_uids(page, started, max_items)
                progress[f'list_{aresult}'] = len(uids)
                for uid in uids:
                    if uid in seen:
                        continue
                    seen.add(uid)
                    if asyncio.get_event_loop().time() - started > TIME_BUDGET_SEC:
                        logger.warning(f"CourtResults: 시간 예산 초과 → {len(items)}건 반환")
                        progress['truncated'] = True
                        return items
                    if not browser.is_connected():
                        progress['truncated'] = True
                        return items
                    try:
                        await asyncio.sleep(1.0)  # NAS·사이트 부하 완화
                        await page.goto(f"https://www.my-auction.co.kr/view/{uid}", wait_until="domcontentloaded", timeout=30000)
                        d = parse_detail_html(await page.content())
                    except Exception as e:
                        logger.warning(f"CourtResults: [{uid}] 상세 실패 {e}")
                        continue
                    d['detail_uid'] = uid
                    d['searched_status'] = aresult
                    d['loss_count_now'] = sum(1 for r in d['schedule'] if r['status'] == '유찰')
                    d.update(split_address(d.get('address', '')))
                    items.append(d)
                    progress['done'] = len(items)
        finally:
            await browser.close()
    return items


def to_events(items, date_from, date_to):
    """상세 결과 → 결과 테이블 이벤트 행(기일 범위 안의 매각·유찰 등). 유찰 횟수는 그 기일 이전 유찰 수."""
    events = []
    for it in items:
        sched = sorted(it.get('schedule', []), key=lambda r: r['date'])
        fails_before = 0
        for r in sched:
            status = r['status']
            in_range = date_from <= r['date'] <= date_to
            if in_range and status in ('매각', '유찰', '변경', '매각불허가', '대금미납'):
                appraisal = it.get('appraisal_price') or 0
                ev = {
                    'detail_uid': it['detail_uid'], 'case_no': it.get('case_no', ''),
                    'item_no': it.get('item_no', '1'), 'court': it.get('court', ''),
                    'location': it.get('address', ''), 'sgg': it.get('sgg', ''), 'emd': it.get('emd', ''),
                    'usage': it.get('usage', ''), 'area_m2': it.get('area_m2') or None,
                    'appraisal_price': appraisal or None, 'min_price': r['min_price'] or None,
                    'min_price_rate': round(r['min_price'] / appraisal * 100, 1) if appraisal and r['min_price'] else None,
                    'sale_round': r['round'], 'bid_date': r['date'], 'result_type': status,
                    'loss_count': fails_before,
                }
                if status == '매각' and it.get('sale_price'):
                    ev['actual_bid_price'] = it['sale_price']
                    ev['actual_bid_rate'] = round(it['sale_price'] / appraisal * 100, 1) if appraisal else None
                    ev['bidder_count'] = it.get('bidder_count') or None
                events.append(ev)
            if status == '유찰':
                fails_before += 1
    return events
