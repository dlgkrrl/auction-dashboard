import asyncio
import os
import re
import logging
import datetime
from playwright.async_api import async_playwright
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

# 상세페이지 제목(h2) 앞머리 → 정식 법원명 (예: "울산 경매3계2025 타경 123[아파트]")
COURT_SHORT_MAP = {
    "창원": "창원지방법원",
    "마산": "창원지방법원 마산지원",
    "진주": "창원지방법원 진주지원",
    "통영": "창원지방법원 통영지원",
    "밀양": "창원지방법원 밀양지원",
    "거창": "창원지방법원 거창지원",
    "울산": "울산지방법원",
    "부산": "부산지방법원",
}


def parse_case_header(h2_text: str) -> dict:
    """h2 제목에서 법원 약칭·정식명, 물건번호를 뽑는다. 예: '창원 경매9계2025 타경 575(5)[근린상가]'"""
    t = (h2_text or "").strip()
    short_m = re.match(r'^\s*(\S+?)\s*경매', t)
    short = short_m.group(1) if short_m else ""
    item_m = re.search(r'타경\s*\d+\s*\((\d+)\)', t)
    return {
        "court_short": short,
        "court": COURT_SHORT_MAP.get(short, ""),
        "item_no": item_m.group(1) if item_m else "1",
    }


class TrackerException(Exception):
    def __init__(self, message, current_url=None):
        super().__init__(message)
        self.current_url = current_url


def _extract_detail_links(soup: BeautifulSoup, court_keys: list[str] = None, sno: str = "", tno: str = "") -> list[str]:
    """
    검색 결과 페이지에서 상세 페이지 링크를 수집합니다.
    court_keys(예: ['서울남부', '남부'], ['창원'])가 주어진 경우,
    검색 목록 테이블 행(tr/td)에서 법원명과 사건번호를 사전 확인하여
    타겟 법원의 상세 페이지 링크만 우선 추출합니다.
    """
    seen = set()
    filtered_links = []
    all_links = []

    def _normalize(href: str) -> str:
        if not href:
            return ""
        if href.startswith("/"):
            return "https://www.my-auction.co.kr" + href
        elif not href.startswith("http"):
            if href.startswith("view/"):
                return "https://www.my-auction.co.kr/" + href
            else:
                return "https://www.my-auction.co.kr/auction/" + href
        return href

    # 1. 목록 테이블 행(tr) 단위에서 court_keys / 사건번호 포함 여부 사전 검사
    if court_keys:
        for tr in soup.select('table tr'):
            tr_text = tr.get_text()
            if any(k in tr_text for k in court_keys):
                if sno and tno:
                    if f"{sno}-{tno}" not in tr_text and f"{sno}타경{tno}" not in tr_text and tno not in tr_text:
                        continue
                for a in tr.select('a[href*="auction_detail"], a[href*="idx="], a[href*="view/"]'):
                    href = _normalize(a.get('href', ''))
                    if href and href not in seen:
                        seen.add(href)
                        filtered_links.append(href)

    if filtered_links:
        return filtered_links

    # 2. 사전 필터링 실패 시 일반 다중 전략 수집 (폴백)
    def _add(href: str):
        full = _normalize(href)
        if full and full not in seen:
            seen.add(full)
            all_links.append(full)

    for a in soup.select('a[href*="auction_detail"]'):
        _add(a.get('href', ''))
    for a in soup.select('a[href*="idx="]'):
        _add(a.get('href', ''))
    for a in soup.select('a[href*="view/"]'):
        _add(a.get('href', ''))

    if not all_links:
        for tag in soup.find_all(onclick=True):
            onclick = tag.get('onclick', '')
            ids = re.findall(r'\d{4,}', onclick)
            for id_ in ids:
                _add(f"/auction/auction_detail.php?idx={id_}")

    return all_links


def _parse_court_filter(court: str) -> list[str]:
    """
    법원명 문자열에서 상세 파싱 및 검색결과 필터링용 키워드 리스트를 반환합니다.
    전국 모든 지방법원 및 지원(서울중앙/동부/남부/북부/서부, 부산동부/서부, 대구서부, 의정부, 남양주, 안산, 천안 등) 지원.
    """
    if not court:
        return []

    c = court.strip()

    prefix_map = {
        "서울중앙": ["서울중앙", "중앙"],
        "서울동부": ["서울동부", "동부"],
        "서울남부": ["서울남부", "남부"],
        "서울북부": ["서울북부", "북부"],
        "서울서부": ["서울서부", "서부"],
        "부산동부": ["부산동부", "동부"],
        "부산서부": ["부산서부", "서부"],
        "대구서부": ["대구서부", "서부"],
    }
    for key, val in prefix_map.items():
        if key in c:
            return val

    if "지원" in c:
        last_word = c.split(" ")[-1]
        branch_name = last_word.replace("지원", "").strip()
        main_city = c.split(" ")[0].replace("지방법원", "").replace("법원", "").strip()
        if branch_name:
            # 지원 사건은 화면에 지원명(예: 마산)으로 표시되지만, 본원명이 같이 나오는 경우도 있어 둘 다 허용
            return [branch_name] + ([main_city] if main_city and main_city != branch_name else [])

    clean_city = c.split(" ")[0].replace("지방법원", "").replace("법원", "").strip()
    return [clean_city] if clean_city else [c]


async def track_my_auction_results(case_nos: list[str], court: str = "",
                                   nocodb_url=None, nocodb_token=None,
                                   nocodb_project_id=None, nocodb_table_id=None) -> list[dict]:
    """
    사건번호 리스트를 받아 마이옥션에서 검색 후 낙찰 결과를 반환합니다.

    - 검색: 로그인 후 GET URL 방식 (search_list.php?aresult=all&sno=&tno=)
    - 법원 필터: 다중 키워드 리스트 매칭
    - case_nos: ['2023타경1234', '2022타경5678', ...]
    """
    my_id = os.environ.get("MY_AUCTION_ID")
    my_pw = os.environ.get("MY_AUCTION_PW")
    ws_url = os.environ.get("BROWSERLESS_WS_URL", "ws://browserless:3000")

    if "?" in ws_url:
        ws_url += "&timeout=600000"
    else:
        ws_url += "?timeout=600000"

    if not my_id or not my_pw:
        raise TrackerException("마이옥션 ID 또는 PW가 설정되지 않았습니다.")

    court_keys = _parse_court_filter(court)
    logger.info(f"Tracker: 요청 사건번호={case_nos}, 법원='{court}', 필터키={court_keys}")

    results = []

    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(ws_url, timeout=180000)  # browserless 대기열(CONCURRENT=1) 대기
        context = await browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            )
        )
        page = await context.new_page()
        page.on("dialog", lambda dialog: asyncio.create_task(dialog.accept()))

        # ── 로그인 ─────────────────────────────────────────────────────
        logger.info("Tracker: 마이옥션 로그인 시작...")
        await page.goto(
            "https://www.my-auction.co.kr/member/login.php",
            wait_until="domcontentloaded", timeout=30000
        )
        await page.fill('input[name="login_id"]', my_id)
        await page.fill('input[name="login_pw"]', my_pw)
        await page.click('#btn_login')
        await asyncio.sleep(3)

        login_url = page.url
        if "login" in login_url.lower():
            logger.error(f"Tracker: 로그인 실패 (현재 URL: {login_url})")
            await browser.close()
            raise TrackerException("마이옥션 로그인 실패", current_url=login_url)

        logger.info(f"Tracker: 로그인 성공 (URL: {login_url})")

        # ── NocoDB 사전 상태 조회 (종결 사건 스킵용) ────────────────────────
        TERMINAL_STATUSES = {'매각', '취하', '기각'}
        db_cache: dict[str, dict] = {}
        use_nocodb = bool(nocodb_url and nocodb_token and nocodb_project_id and nocodb_table_id)

        if use_nocodb:
            try:
                where_val = ",".join(case_nos)
                api_url = f"{nocodb_url.rstrip('/')}/api/v1/db/data/noco/{nocodb_project_id}/{nocodb_table_id}"
                resp = await page.request.get(
                    api_url,
                    headers={"xc-token": nocodb_token},
                    params={"where": f"(case_no,in,{where_val})", "limit": str(len(case_nos) + 10)}
                )
                if resp.ok:
                    body = await resp.json()
                    for r in body.get("list", []):
                        if r.get("case_no"):
                            db_cache[r["case_no"].strip()] = r
                    logger.info(f"Tracker: NocoDB 사전 조회 완료 — {len(db_cache)}건 기존 레코드 확인")
                else:
                    logger.warning(f"Tracker: NocoDB 사전 조회 실패: HTTP {resp.status}")
            except Exception as _e:
                logger.warning(f"Tracker: NocoDB 사전 조회 오류 (비중단): {_e}")
        else:
            logger.info("Tracker: NocoDB 미설정 → 종결 사전 스킵 비활성")

        # ── 사건번호별 처리 ─────────────────────────────────────────────
        for case_no in case_nos:
            # Browserless 연결 끊김 방어 (n8n 타임아웃 등으로 CDP 연결이 끊길 때 TargetClosedError 방지)
            if not browser.is_connected():
                logger.warning("Tracker: Browserless 연결 끊김. 조기 종료.")
                break
            try:
                m = re.search(r'(\d+)타경(\d+)', case_no.replace(' ', ''))
                if not m:
                    logger.warning(f"Tracker: 유효하지 않은 사건번호 형식: {case_no}")
                    continue

                sno = m.group(1)
                tno = m.group(2)

                # ── NocoDB 종결 상태 사전 스킵 ──────────────────────────────
                db_rec = db_cache.get(case_no.strip()) if db_cache else None
                if db_rec:
                    db_status = (db_rec.get('status') or '').strip()
                    if db_status in TERMINAL_STATUSES:
                        logger.info(f"Tracker: [{case_no}] DB 상태='{db_status}' → 이미 종결, Playwright 방문 스킵")
                        results.append({
                            "case_no": case_no,
                            "result": db_status,
                            "actual_bid_price": int(db_rec.get('actual_bid_price') or 0),
                            "bidder_count": 0,
                            "next_bid_date": None,
                            "next_min_price": 0,
                            "is_unchanged": True,
                            "skipped_reason": "already_closed",
                        })
                        continue

                # ── 폼 submit 방식 사용 (GET URL 직접 접근 시 서버 리다이렉트 발생)
                await page.goto(
                    "https://www.my-auction.co.kr/auction/search.php",
                    wait_until="domcontentloaded", timeout=30000
                )
                await asyncio.sleep(1)

                await page.select_option('form[name="frm_top2"] select[name="sno"]', value=sno)
                await page.fill('form[name="frm_top2"] input[name="tno"]', tno)

                logger.info(f"Tracker: [{case_no}] 폼 submit (sno={sno}, tno={tno})")
                async with page.expect_navigation(wait_until="domcontentloaded", timeout=30000):
                    await page.evaluate("document.frm_top2.submit()")
                await asyncio.sleep(2)

                current_url = page.url
                logger.info(f"Tracker: [{case_no}] 검색후 URL = {current_url}")

                html = await page.content()
                soup = BeautifulSoup(html, 'html.parser')

                detail_links = _extract_detail_links(soup, court_keys=court_keys, sno=sno, tno=tno)
                if not detail_links and ("auction_detail" in current_url or "/view/" in current_url):
                    detail_links = [current_url]

                logger.info(
                    f"Tracker: [{case_no}] 상세 링크 {len(detail_links)}개: {detail_links[:5]}"
                )

                if not detail_links:
                    logger.warning(f"Tracker: [{case_no}] 검색 결과 없음 (링크 0개). URL={current_url}")
                    continue

                # ── 각 상세 페이지 파싱 ──────────────────────────────────
                for detail_url in detail_links:
                    # /view/1446963 또는 idx=1446963 형태 모두 지원
                    uid_match = (
                        re.search(r'/view/(\d+)', detail_url)
                        or re.search(r'idx=(\d+)', detail_url)
                    )
                    uid = uid_match.group(1) if uid_match else "?"

                    await page.goto(detail_url, wait_until="domcontentloaded", timeout=30000)
                    await asyncio.sleep(1)

                    detail_html = await page.content()
                    dsoup = BeautifulSoup(detail_html, 'html.parser')

                    # 사건번호 추출: h2(타경 형식) 또는 td(2025-11142 대시 형식) 모두 지원
                    real_case_no = ""
                    header_info = {"court_short": "", "court": "", "item_no": "1"}
                    for h2 in dsoup.select('h2'):
                        if '타경' in h2.text:
                            real_case_no = h2.text.strip().replace(' ', '')
                            header_info = parse_case_header(h2.text)
                            break
                    if not real_case_no:
                        # td 내 'YYYY-NNNNN' 형식 탐색 (단, 날짜 YYYY-MM-DD 제외) → 'YYYY타경NNNNN' 변환
                        dash_pattern = re.compile(r'(\d{4})-(\d+)(?!\s*-\s*\d)')
                        for td_el in dsoup.select('td'):
                            td_text = td_el.get_text().strip()
                            if re.search(r'\d{4}-\d{2}-\d{2}', td_text):
                                continue  # 날짜 형식 스킵
                            dm = dash_pattern.search(td_text)
                            if dm:
                                real_case_no = f"{dm.group(1)}타경{dm.group(2)}"
                                break

                    # 법원 필터링
                    # 1차: 같은 td 안에 사건번호(sno-tno)와 법원명이 함께 있는지 확인 (가장 정확)
                    # 2차: 전체 페이지 텍스트에서 법원키 탐색 (폴백)
                    if court_keys:
                        court_match = False
                        for td_el in dsoup.select('td'):
                            td_text = td_el.get_text()
                            if f"{sno}-{tno}" in td_text and any(k in td_text for k in court_keys):
                                court_match = True
                                break
                        if not court_match:
                            # 폴백: 전체 텍스트 검색
                            court_match = any(k in dsoup.text for k in court_keys) and (
                                f"{sno}-{tno}" in dsoup.text
                                or f"{sno}타경{tno}" in dsoup.text
                            )
                        logger.info(
                            f"Tracker: [{case_no}] idx={uid}, "
                            f"real_case_no='{real_case_no}', "
                            f"법원키={court_keys} 매칭={court_match}"
                        )
                        if not court_match:
                            logger.info(f"Tracker: [{case_no}] idx={uid} → 법원 불일치 스킵")
                            continue

                    # ── 기일내역 파싱 ──────────────────────────────────────
                    result_text = "진행중"
                    actual_bid_price = 0
                    bidder_count = 0
                    next_bid_date = None   # 유찰 후 다음 매각기일
                    next_min_price = 0    # 유찰 후 다음 회차 최저매각가

                    # '불허'(매각불허가)·'미납'(대금미납)은 '매각'보다 먼저 검사해야 낙찰로 잘못 잡히지 않음
                    STATUS_KEYWORDS = ('불허', '미납', '매각', '유찰', '변경', '취하', '정지', '기각', '진행')
                    STATUS_LABEL = {'불허': '매각불허가', '미납': '대금미납'}
                    today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).date()
                    latest_past_date = None  # 오늘 이하 기일 중 가장 최신 날짜 추적용
                    past_fail_dates = set()  # 유찰된 과거 기일 (유찰 횟수 = 이 집합의 크기)
                    last_past_min_price = 0  # 가장 최근 과거 기일의 최저가

                    # ── #plan_sale 테이블 전용 파싱 (폴백: 전체 tr) ────────────────
                    plan_sale = dsoup.select_one('#plan_sale')
                    sale_rows = plan_sale.select('table.tbl_detail tr') if plan_sale else dsoup.select('tr')

                    for tr in sale_rows:
                        cells = tr.find_all(['td', 'th'])
                        if len(cells) < 4:
                            continue

                        row_text = " ".join([c.get_text(strip=True) for c in cells])

                        # 무관 정보 행 스킵 (요약, 인근사례, 실거래가, 등기부, 명도비용 등)
                        if any(bad in row_text for bad in ('사건번호', '물건용도', '물건기본내역', '입찰일사건번호', '계약일', '점유부분', '권리종류', '총 명도비용', '지하철')):
                            continue

                        # 1. 날짜 추출 (YYYY-MM-DD, YYYY.MM.DD 등 지원)
                        dm = re.search(r'(\d{4})[\.\-\s/]+(\d{1,2})[\.\-\s/]+(\d{1,2})', row_text)
                        if not dm:
                            continue

                        try:
                            row_date = datetime.date(int(dm.group(1)), int(dm.group(2)), int(dm.group(3)))
                            row_date_str = f"{dm.group(1)}-{dm.group(2).zfill(2)}-{dm.group(3).zfill(2)}"
                        except ValueError:
                            continue

                        # 2. 상태 추출 (6개 컬럼 테이블인 경우 cells[5] 우선, 폴백으로 역순 탐색)
                        status_found = ""
                        if len(cells) >= 6:
                            col_status = cells[5].get_text(strip=True)
                            for kw in STATUS_KEYWORDS:
                                if kw in col_status:
                                    status_found = kw
                                    break

                        if not status_found:
                            for c in reversed(cells):
                                txt = c.get_text(strip=True)
                                if txt in ('매각기일', '입찰기일', '기일'):
                                    continue
                                for kw in STATUS_KEYWORDS:
                                    if kw in txt:
                                        status_found = kw
                                        break
                                if status_found:
                                    break

                        if not status_found:
                            continue

                        # 3. 최저가 추출 (cells[3] 우선, 폴백으로 row_text 탐색)
                        price_num = 0
                        if len(cells) >= 4:
                            pm = re.search(r'([\d,]{5,})', cells[3].get_text())
                            if pm:
                                price_num = int(pm.group(1).replace(',', ''))
                        if price_num == 0:
                            prices = re.findall(r'[\d,]{5,}', row_text)
                            for pr in prices:
                                p_clean = int(pr.replace(',', ''))
                                if p_clean > 100000:
                                    price_num = p_clean
                                    break

                        # 4. 미래 기일 (row_date > today): 유찰 후 다음 매각기일 및 최저가 보관
                        if row_date > today:
                            if next_bid_date is None or row_date_str < next_bid_date:
                                next_bid_date = row_date_str
                                next_min_price = price_num
                                logger.info(f"Tracker: [{case_no}] 미래기일 감지: date={next_bid_date}, min_price={next_min_price:,}")
                            continue

                        # 5. 과거 또는 오늘 기일 (row_date <= today): 최종 결과 업데이트
                        if status_found == '유찰':
                            past_fail_dates.add(row_date_str)
                        if latest_past_date is None or row_date >= latest_past_date:
                            latest_past_date = row_date
                            last_past_min_price = price_num or last_past_min_price
                            if status_found == '진행':
                                result_text = '진행중'
                            else:
                                result_text = STATUS_LABEL.get(status_found, status_found)

                    # 6. #success_man div에서 낙찰가 + 응찰자 수 최우선 추출 (존재한다면 확실한 매각)
                    #   <span class="pink">67,049,900 (83%)</span>
                    #   입찰 <span class="suc_blu">3</span>명
                    success_div = dsoup.select_one('#success_man')
                    # 불허가·미납·재매각 뒤 유찰 등 최신 기일 상태가 따로 있으면 그것을 우선 (예전 낙찰자 박스가 남아 있을 수 있음)
                    if success_div and result_text in ('매각', '진행중'):
                        result_text = '매각'
                        pink = success_div.select_one('span.pink')
                        if pink:
                            pm = re.search(r'([\d,]{5,})', pink.text)
                            if pm:
                                actual_bid_price = int(pm.group(1).replace(',', ''))
                        suc_blu = success_div.select('span.suc_blu')
                        if suc_blu:
                            bm = re.search(r'\d+', suc_blu[0].text)
                            if bm:
                                bidder_count = int(bm.group())
                        logger.info(
                            f"Tracker: [{case_no}] #success_man 파싱 → "
                            f"낙찰가={actual_bid_price:,}, 응찰자={bidder_count}"
                        )

                    # ── 변화 감지 (DB 상태 대비) ───────────────────────────────
                    is_unchanged = False
                    if db_rec:
                        db_status_str = (db_rec.get('status') or '진행중').strip()
                        db_min_price  = int(db_rec.get('min_price') or 0)
                        status_same   = (result_text == db_status_str or
                                        (result_text == '진행중' and db_status_str == '진행중'))
                        price_same    = (next_min_price == 0 or next_min_price == db_min_price)
                        is_unchanged  = status_same and price_same
                        if is_unchanged:
                            logger.info(
                                f"Tracker: [{case_no}] 변화 없음 "
                                f"(status={result_text}, min_price={next_min_price}) → is_unchanged=True"
                            )

                    item = {
                        "case_no": real_case_no or case_no,
                        "result": result_text,
                        "actual_bid_price": actual_bid_price,
                        "bidder_count": bidder_count,
                        "next_bid_date": next_bid_date,   # 유찰 시 다음 매각기일 (없으면 None)
                        "next_min_price": next_min_price, # 유찰 시 다음 회차 최저매각가 (없으면 0)
                        "is_unchanged": is_unchanged,
                        "skipped_reason": None,
                        # ── 2026-11-12 추가 (n8n 012 매칭·보정용) ──
                        "item_no": header_info["item_no"],          # 물건번호 (다물건 사건 구분)
                        "court": header_info["court"],              # 실제 관할 법원 (양산=울산지방법원)
                        "court_short": header_info["court_short"],
                        "loss_count": len(past_fail_dates),         # 기일표의 과거 '유찰' 수 = 정확한 유찰 횟수
                        "last_min_price": last_past_min_price,      # 가장 최근 과거 기일 최저가
                        "detail_uid": uid,
                    }
                    logger.info(f"Tracker: [{case_no}] idx={uid} 결과 수집 → {item}")
                    results.append(item)

            except TrackerException:
                raise
            except Exception as e:
                logger.error(f"Tracker: [{case_no}] 처리 중 오류 - {e}", exc_info=True)

        await browser.close()

    logger.info(f"Tracker: 전체 완료. 결과 {len(results)}건 반환.")
    return results
