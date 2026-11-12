import os
import re
import asyncio
import base64
import logging
import io
import datetime
import urllib.parse
import fitz  # PyMuPDF
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError
from crawler.myauction_tracker import parse_case_header

logger = logging.getLogger(__name__)

class CrawlerException(Exception):
    def __init__(self, message, current_url=None):
        super().__init__(message)
        self.current_url = current_url

def parse_detail_html(html_content):
    soup = BeautifulSoup(html_content, 'html.parser')
    
    # 스크립트와 스타일 태그 제거 (Base64 인코딩된 이미지나 스크립트 데이터 제거)
    for element in soup(["script", "style", "noscript"]):
        element.decompose()
        
    text_content = soup.get_text(separator="\n", strip=True)
    
    # 연속된 빈 줄 제거
    text_content = re.sub(r'\n+', '\n', text_content)
    
    # 안전장치: 너무 거대한 문서일 경우 10만자로 자르기 (약 100KB~200KB)
    if len(text_content) > 100000:
        text_content = text_content[:100000] + "\n...[내용이 너무 길어 생략되었습니다]..."
        
    return text_content

def parse_real_trade_table(html_content):
    """마이옥션 실거래가 테이블 파싱.
    - div#dtl_stock 중복 ID 문제 해결: mainDiv1/mainDiv2 및 전체 table 대상 탐색
    - 더보기(silmore2) 숨김 행(trhidden*, style="display:none") 전건 수집
    - colspan 행(더보기 버튼 등) 자동 제외
    """
    soup = BeautifulSoup(html_content, 'html.parser')

    def _extract_table_rows(table):
        """테이블에서 모든 행(숨겨진 행 포함) 추출.
        - display:none 행(trhidden*)도 포함 (BS4는 style 무시하고 모두 파싱)
        - colspan 속성을 가진 td가 있는 행은 제외 (더보기/구분선 등 오염 행)
        """
        rows = []
        for tr in table.find_all('tr'):
            tds = tr.find_all(['th', 'td'])
            # colspan 행 제외: 더보기 버튼, 구분선 행 등
            if any(td.get('colspan') for td in tds):
                continue
            cells = [td.get_text(strip=True) for td in tds]
            if cells:
                rows.append('\t'.join(cells))
        return rows

    def _is_trade_table(table):
        """실거래가 테이블 여부 확인 (계약일 헤더 존재 여부).
        BeautifulSoup은 <tbody>를 자동 삽입하므로 table.find('tr')가
        tbody 내부의 첫 tr을 반환하지 못할 수 있음 → find_all로 안전하게 접근.
        """
        all_trs = table.find_all('tr')
        if not all_trs:
            return False
        header_row = all_trs[0]
        headers = [td.get_text(strip=True) for td in header_row.find_all(['th', 'td'])]
        # 임차인 현황, 권리관계, 명도비용 등 실거래가와 무관한 테이블 제외
        if any(any(bad in h for bad in ['임차인', '권리자', '성립일자', '명도비용']) for h in headers):
            return False
        TRADE_KEYWORDS = ['계약일', '거래금액', '거래일', '보증금', '월세']
        return any(any(kw in h for kw in TRADE_KEYWORDS) for h in headers)

    valid_tables_text = []

    # 1. mainDiv1(매매), mainDiv2(전월세) 직접 탐색 (가장 정확)
    for div_id in ['mainDiv1', 'mainDiv2']:
        div = soup.find(id=div_id)
        if div:
            for table in div.find_all('table'):
                if _is_trade_table(table):
                    rows = _extract_table_rows(table)
                    has_valid_rows = any(
                        not ('거래내역이 없습니다' in r or '내역이 없습니다' in r)
                        for r in rows[1:]
                    )
                    if rows and (has_valid_rows or not valid_tables_text):
                        valid_tables_text.append('\n'.join(rows))

    # 2. 폴백: mainDiv1/2가 없거나 못 찾은 경우 전체 soup에서 탐색
    if not valid_tables_text:
        for table in soup.find_all('table'):
            if _is_trade_table(table):
                rows = _extract_table_rows(table)
                has_valid_rows = any(
                    not ('거래내역이 없습니다' in r or '내역이 없습니다' in r)
                    for r in rows[1:]
                )
                if rows and (has_valid_rows or not valid_tables_text):
                    valid_tables_text.append('\n'.join(rows))

    if valid_tables_text:
        return '\n\n'.join(valid_tables_text)

    return ""


MY_AUCTION_BASE = "https://www.my-auction.co.kr"
NURI_FILE_BASE = "https://file2.nuriauction.com"
REAL_TRADE_MAX_CHARS = 30000  # NocoDB 텍스트 필드 / Dify 입력 크기 고려
OCR_MAX_PAGES = 8             # 스캔 PDF OCR 페이지 상한 (NAS 메모리/CPU 고려, 핵심 내용은 앞쪽)
OCR_DPI = 150
# Browserless 세션 제한(ms). 서류 순차 처리+OCR로 물건당 ~1분이라 10분이면 12건쯤에서 끊겼음 (2026-11-03)
BROWSER_SESSION_MS = 1800000  # browserless TIMEOUT·n8n 호출 타임아웃(30분)과 맞춤
CRAWL_TIME_BUDGET_SEC = 26 * 60  # 이 시간을 넘기면 상세 수집을 멈추고 모은 것만 반환 (n8n 30분 타임아웃 전)
# 목록 순환 상한 (2026-11-10): 11/06~ 목록을 558페이지까지 돌다 26분을 다 써 상세 0건 → n8n 30분 타임아웃
LIST_TIME_BUDGET_SEC = 10 * 60
LIST_MAX_DUP_PAGES = 2  # 새 물건 없이 이미 본 물건만 나오는 페이지가 연속 N번이면 목록 끝으로 판단


_OK_SYMBOLS = set('㎡·ㆍ※■□○●◎△▲▶→①②③④⑤⑥⑦⑧⑨⑩「」『』“”‘’…・')


def _weird_char_ratio(text: str) -> float:
    """한글/영숫자/한자/일반 기호가 아닌 문자 비율 (ToUnicode 없는 폰트로 깨진 텍스트 감지용)."""
    chars = [c for c in text if not c.isspace()]
    if not chars:
        return 1.0
    bad = sum(1 for c in chars if not (
        c.isascii() or '\uac00' <= c <= '\ud7a3' or '\u4e00' <= c <= '\u9fff'
        or '\u3000' <= c <= '\u303f' or '\uff00' <= c <= '\uffef' or '\u3131' <= c <= '\u318e'
        or '\u00a0' <= c <= '\u00ff'      # Latin-1 기호 (×, °, © 등)
        or '\u2000' <= c <= '\u27bf'      # 구두점·로마숫자·화살표·수학·도형 기호
        or '\u3200' <= c <= '\u33ff'      # ㈜, ㎡, ㎜ 등 CJK 호환 기호
        or c in _OK_SYMBOLS))
    return bad / len(chars)


def pdf_page_needs_ocr(text: str) -> bool:
    """페이지 텍스트가 거의 없거나(스캔 이미지) 깨진 문자 비율이 높으면 OCR 대상."""
    nonspace = sum(1 for c in text if not c.isspace())
    return nonspace < 30 or (_weird_char_ratio(text) > 0.03 and nonspace * _weird_char_ratio(text) >= 5)


def extract_pdf_text_with_ocr(pdf_doc, max_ocr_pages: int = OCR_MAX_PAGES) -> tuple:
    """페이지별로 원문 텍스트를 쓰되, 스캔/깨짐 페이지만 Tesseract(kor+eng) OCR로 대체.
    이미지에 tesseract-ocr, tesseract-ocr-kor 설치 및 TESSDATA_PREFIX 필요. 반환: (text, ocr_page_count)"""
    parts = []
    ocr_count = 0
    for pg in range(len(pdf_doc)):
        page = pdf_doc[pg]
        text = page.get_text()
        if ocr_count < max_ocr_pages and pdf_page_needs_ocr(text):
            tp = page.get_textpage_ocr(language="kor+eng", dpi=OCR_DPI, full=True)
            text = page.get_text(textpage=tp)
            ocr_count += 1
        parts.append(text)
    return "".join(parts), ocr_count


def build_nuri_pdf_url(item_uid: str, db_name: int, db_sel: int | None = None) -> str:
    """irea.nuriauction.com 공시자료 PDF URL 생성.
    db_name=1 → 등기부(건물), db_name=1&db_sel=2 → 등기부(토지), db_name=2 → 건축물대장.
    (요청 시 Referer 헤더 필수 — 없으면 빈 응답)
    """
    raw = f"idx={item_uid}&db_name={db_name}"
    if db_sel is not None:
        raw += f"&db_sel={db_sel}"
    raw += "&title=M Y A U C T I O N"
    encoded = base64.b64encode(raw.encode()).decode() + "||"
    return f"https://irea.nuriauction.com/aceeair.php?idx={encoded}"


def extract_auctionv_form(html_content: str, mode: str) -> dict | None:
    """상세 HTML의 auctionv('mode','v_listN', str..str8) 호출에서 pageview.php POST 폼 데이터 추출."""
    m = re.search(rf"auctionv\(\s*'{re.escape(mode)}'\s*,\s*'[^']*'\s*,(.*?)\)\s*;", html_content)
    if not m:
        return None
    args = re.findall(r"'([^']*)'", m.group(1))
    keys = ['str', 'str2', 'str3', 'str4', 'str5', 'str6', 'str7', 'str8']
    form = {k: (args[i] if i < len(args) else '') for i, k in enumerate(keys)}
    form['mode'] = mode
    return form


def trim_real_trade_text(text: str, max_chars: int = REAL_TRADE_MAX_CHARS) -> str:
    """실거래가 텍스트가 너무 길면 표(매매/전월세)별로 헤더 + 최근 거래 위주로 자름.
    마이옥션 표는 계약일 내림차순(최근 먼저)이므로 앞쪽 행을 유지한다.
    """
    if len(text) <= max_chars:
        return text
    blocks = text.split('\n\n')
    budget = max_chars // len(blocks)
    trimmed = []
    for block in blocks:
        lines = block.split('\n')
        kept = [lines[0]]
        size = len(lines[0])
        for line in lines[1:]:
            if size + len(line) + 1 > budget:
                break
            kept.append(line)
            size += len(line) + 1
        omitted = len(lines) - len(kept)
        if omitted > 0:
            kept.append(f"...[이전 거래 {omitted}건 생략]")
        trimmed.append('\n'.join(kept))
    return '\n\n'.join(trimmed)


def extract_photo_urls(pic_view_html: str) -> list:
    """pic_view.php HTML의 view_img('../admin/data/...jpg') 경로를 원본 이미지 절대 URL 리스트로 변환."""
    urls = []
    for path in re.findall(r"view_img\('([^']+)'\)", pic_view_html):
        abs_url = urllib.parse.urljoin(f"{NURI_FILE_BASE}/auction/", path)
        if abs_url not in urls:
            urls.append(abs_url)
    return urls


def extract_extra_judgement_urls(wrapper_html: str) -> list:
    """감정평가서 팝업 내 추가 감정평가서(PDF_Judgement_N.pdf) 링크 추출."""
    urls = []
    for href in re.findall(r'href="([^"]*PDF_Judgement_\d+\.pdf)"', wrapper_html):
        abs_url = urllib.parse.urljoin(f"{MY_AUCTION_BASE}/auction/", href)
        if abs_url not in urls:
            urls.append(abs_url)
    return urls


async def crawl_my_auction(sdCd, sggCd, cortOfcCd, start_date, end_date, usage_lcl="건물", usage_mcl="주거용건물", usage_scl="아파트", max_appraisal_amt=None, max_items=None,
                          nocodb_url=None, nocodb_token=None, nocodb_project_id=None, nocodb_table_id=None):
    my_id = os.environ.get("MY_AUCTION_ID")
    my_pw = os.environ.get("MY_AUCTION_PW")
    ws_url = os.environ.get("BROWSERLESS_WS_URL", "ws://browserless:3000")
    
    # Browserless 기본 타임아웃(30초) 방지를 위해 파라미터 강제 추가 (10분)
    if "?" in ws_url:
        ws_url += f"&timeout={BROWSER_SESSION_MS}"
    else:
        ws_url += f"?timeout={BROWSER_SESSION_MS}"

    if not my_id or not my_pw:
        raise CrawlerException("마이옥션 ID 또는 PW가 설정되지 않았습니다.")

    logger.info(f"Browserless({ws_url}) 웹소켓 연결 시도 중...")
    crawl_started = asyncio.get_event_loop().time()
    results = []

    async with async_playwright() as p:
        browser = None
        try:
            # Connect to Browserless
            # CONCURRENT=1이라 트래커 등 다른 세션이 쓰는 중이면 대기열에서 기다림 → 연결 대기 3분
            browser = await p.chromium.connect_over_cdp(ws_url, timeout=180000)
            context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
            page = await context.new_page()

            # Handle unexpected dialogs automatically
            page.on("dialog", lambda dialog: asyncio.create_task(dialog.accept()))

            logger.info("마이옥션 로그인 페이지 접속...")
            await page.goto("https://www.my-auction.co.kr/member/login.php", wait_until="domcontentloaded")

            logger.info("로그인 수행 중...")
            await page.fill('input[name="login_id"]', my_id)
            await page.fill('input[name="login_pw"]', my_pw)
            
            await page.click('#btn_login')
            await asyncio.sleep(3) # 리다이렉트 및 쿠키 세팅 대기

            # --- 1. 검색 페이지 이동 및 폼 세팅 ---
            logger.info("경매 검색 페이지 접속...")
            await page.goto("https://www.my-auction.co.kr/auction/search.php", wait_until="domcontentloaded")

            # 지역 선택 (stc=1 지역 라디오 클릭)
            await page.click('input[name="stc"][value="1"]')
            await asyncio.sleep(0.5)  # 셀렉트박스 렌더링 대기

            # 시/도 선택 (address1_01: 경상남도="4", 서울="10", 경기="3" 등)
            if sdCd:
                try:
                    await page.locator('select[name="address1_01"]').select_option(value=str(sdCd))
                    await asyncio.sleep(0.5)  # 시/군/구 목록 동적 로딩 대기
                except Exception as e:
                    logger.warning(f"시/도 셀렉트 선택 실패 (sdCd={sdCd}): {e}")

            # ── 마이옥션 내부 시/군/구 코드 → 한글 주소 키워드 매핑 ─────────────────
            # 허용 지역 확장 시 이 딕셔너리에만 항목 추가하면 됨
            SGG_CODE_KEYWORDS: dict[str, list[str]] = {
                # 창원시 (전체 및 각 구)
                "179": ["창원"],
                "7957": ["창원", "의창구"],
                "7947": ["창원", "성산구"],
                "7949": ["창원", "마산합포구", "마산"],
                "7952": ["창원", "마산회원구", "마산"],
                "7954": ["창원", "진해구", "진해"],
                # 경남 주요 시/군
                "168": ["김해"],
                "173": ["양산"],
                "165": ["거제"],
                "177": ["진주"],
                "333": ["밀양"],
                "171": ["사천"],
                "180": ["통영"],
                "166": ["거창"],
                "167": ["고성"],
                "169": ["남해"],
                "172": ["산청"],
                "176": ["의령"],
                "181": ["하동"],
                "182": ["함안"],
                "183": ["함양"],
                "184": ["합천"],
                "334": ["창녕"],
            }

            # 실제 sgg_list 기반으로 허용 키워드 동적 빌드 (주소 기반 방어 필터용)
            allowed_region_kw: list[str] = []

            # 시/군/구 다중 선택 및 추가 버튼(searchea) 클릭
            if sggCd:
                if isinstance(sggCd, (list, tuple, set)):
                    sgg_list = [str(x).strip() for x in sggCd if str(x).strip()]
                elif isinstance(sggCd, str):
                    sgg_list = [x.strip() for x in sggCd.split(",") if x.strip()]
                else:
                    sgg_list = [str(sggCd)]

                # 중복 제거 (순서 보존)
                sgg_list = list(dict.fromkeys(sgg_list))

                # 허용 키워드 빌드 (주소 기반 필터 방어선용)
                for code in sgg_list:
                    kws = SGG_CODE_KEYWORDS.get(code)
                    if kws:
                        allowed_region_kw.extend(kw for kw in kws if kw not in allowed_region_kw)
                if allowed_region_kw:
                    logger.info(f"주소 기반 허용 키워드 설정: {allowed_region_kw}")
                else:
                    logger.warning("sgg_list 코드에 대응하는 허용 키워드 없음 — 주소 필터 비활성")

                MAX_RETRY = 2  # 지역 추가 버튼 클릭 최대 재시도 횟수
                _add_success_count = 0  # 성공적으로 클릭된 횟수

                for code in sgg_list:
                    for attempt in range(MAX_RETRY + 1):
                        try:
                            await page.locator('select[name="address1_02"]').select_option(value=str(code))
                            await asyncio.sleep(0.5)  # 셀렉트 반영 대기 (속도 개선 후 0.3→0.5)

                            # 추가 버튼 클릭 (a[onclick*="searchea"])
                            btn_add = page.locator('a[onclick*="searchea"]')
                            if await btn_add.count() > 0:
                                await btn_add.first.click()
                                await asyncio.sleep(0.8)  # JS 목록 추가 완료 대기 (0.3→0.8)

                                # DOM 검증: span#searchea에 지역 태그가 추가됐는지 확인
                                # (select[name]이 아닌 span#searchea가 실제 컨테이너)
                                added_count = await page.evaluate("""
                                    () => {
                                        const span = document.querySelector('span#searchea');
                                        return span ? span.children.length : 0;
                                    }
                                """)
                                if added_count > 0:
                                    _add_success_count += 1
                                    logger.info(
                                        f"\uc2dc/\uad70/\uad6c \ucd94\uac00 \uc644\ub8cc: code={code} "
                                        f"(\ub204\uc801 {added_count}\uac1c, \uc2dc\ub3c4 {attempt+1})"
                                    )
                                    break  # 성공
                                else:
                                    logger.warning(
                                        f"\uc2dc/\uad70/\uad6c \ucd94\uac00 \ubbf8\ubc18\uc601: code={code} "
                                        f"(\uc2dc\ub3c4 {attempt+1}/{MAX_RETRY+1})"
                                    )
                                    if attempt < MAX_RETRY:
                                        await asyncio.sleep(0.5)  # 재시도 전 추가 대기
                            else:
                                logger.warning(f"추가 버튼을 찾을 수 없음: code={code}")
                                break  # 버튼 자체가 없으면 재시도 무의미
                        except Exception as e:
                            logger.warning(
                                f"시/군/구 선택/추가 실패 (sggCd={code}, 시도 {attempt+1}): {e}"
                            )
                            if attempt < MAX_RETRY:
                                await asyncio.sleep(0.5)

                if _add_success_count > 0:
                    logger.info(f"\uc2dc/\uad70/\uad6c \ud074\ub9ad \uc644\ub8cc: \uc804\uccb4 {len(sgg_list)}\uac1c \ucf54\ub4dc \uc911 {_add_success_count}\uac1c \ud074\ub9ad\uc131\uacf5")
                else:
                    logger.warning(f"\uc2dc/\uad70/\uad6c \ucd94\uac00 \ubc84\ud2bc \ud074\ub9ad\uc774 \ubaa8\ub450 \uc2e4\ud328\ud568 — \uc8fc\uc18c \ud544\ud130\ub85c \ub300\uccb4 \uc218\uc9d1\uc9c4\ud589")

            # 주거용 부동산 체크박스 선택
            RESIDENTIAL_CODES = ['101', '102', '103', '104', '105', '106', '107']
            if usage_mcl == "주거용건물":
                # Step 1: 부모 체크박스 클릭 (check_Usage() JS 트리거 시도)
                try:
                    parent_cb = page.locator('input[name="usage_code"][value=""]').first
                    if await parent_cb.count() > 0:
                        await parent_cb.click()
                        await asyncio.sleep(1)  # JS check_Usage() 실행 대기
                except Exception:
                    pass

                # Step 2: 실제 체크 수 검증 후 미적용시 evaluate()로 강제 설정 (Fallback)
                checked_count = await page.evaluate("""
                    () => {
                        const codes = ['101','102','103','104','105','106','107'];
                        return Array.from(document.querySelectorAll('input[name="usage_code"]'))
                            .filter(cb => codes.includes(cb.value) && cb.checked).length;
                    }
                """)
                if checked_count == 0:
                    logger.warning("주거용 check_Usage() JS 미작동 → evaluate()로 직접 강제 체크")
                    await page.evaluate("""
                        () => {
                            const codes = ['101','102','103','104','105','106','107'];
                            document.querySelectorAll('input[name="usage_code"]').forEach(cb => {
                                if (codes.includes(cb.value)) {
                                    cb.checked = true;
                                    cb.dispatchEvent(new Event('change', {bubbles: true}));
                                }
                            });
                        }
                    """)
                    checked_count = len(RESIDENTIAL_CODES)
                logger.info(f"주거용 체크박스 설정 완료: {checked_count}개 선택")
            else:
                USAGE_CODE_MAP = {
                    "아파트": "101", "다세대": "102", "다가구": "103",
                    "오피스텔": "104", "연립": "105", "다돈": "106",
                }
                code = USAGE_CODE_MAP.get(usage_scl)
                if code:
                    cb = page.locator(f'input[name="usage_code"][value="{code}"]')
                    if await cb.count() > 0 and not await cb.is_checked():
                        await cb.click()
                    logger.info(f"{usage_scl}({code}) 체크박스 설정 완료")

            # court_name은 이후 item_data 구성에 사용하기 위해 유지
            COURT_MAPPING = {
                "B000210": "창원지방법원", "B000100": "서울중앙지방법원",
                "B000101": "서울동부지방법원", "B000102": "서울남부지방법원",
                "B000103": "서울북부지방법원", "B000104": "서울서부지방법원",
                "B000110": "의정부지방법원", "B000111": "고양지원",
                "B000112": "남양주지원", "B000120": "인천지방법원",
                "B000121": "부천지원", "B000130": "수원지방법원",
                "B000131": "성남지원", "B000132": "여주지원",
                "B000133": "평택지원", "B000134": "안산지원",
                "B000135": "안양지원", "B000140": "춘천지방법원",
                "B000141": "강릉지원", "B000142": "원주지원",
                "B000143": "속초지원", "B000144": "영월지원",
                "B000150": "청주지방법원", "B000151": "충주지원",
                "B000152": "제천지원", "B000153": "영동지원",
                "B000160": "대전지방법원", "B000161": "홍성지원",
                "B000162": "논산지원", "B000163": "천안지원",
                "B000164": "공주지원", "B000165": "서산지원",
                "B000170": "대구지방법원", "B000171": "안동지원",
                "B000172": "경주지원", "B000173": "김천지원",
                "B000174": "상주지원", "B000175": "의성지원",
                "B000176": "영덕지원", "B000177": "포항지원",
                "B000178": "대구서부지원", "B000180": "부산지방법원",
                "B000181": "부산동부지원", "B000182": "부산서부지원",
                "B000190": "울산지방법원", "B000200": "창원지방법원",
                "B000201": "마산지원", "B000202": "진주지원",
                "B000203": "통영지원", "B000204": "밀양지원",
                "B000205": "거창지원", "B000220": "광주지방법원",
                "B000221": "목포지원", "B000222": "장흥지원",
                "B000223": "순천지원", "B000224": "해남지원",
                "B000230": "전주지방법원", "B000231": "군산지원",
                "B000232": "정읍지원", "B000233": "남원지원",
                "B000240": "제주지방법원",
            }
            court_name = COURT_MAPPING.get(cortOfcCd, "창원지방법원")
            
            # 기간 설정
            if start_date:
                # 2026-07-07 format -> 2026-07-07
                clean_start = start_date.replace(".", "-").strip()
                if len(clean_start) == 8: # 20260707
                    clean_start = f"{clean_start[:4]}-{clean_start[4:6]}-{clean_start[6:]}"
                await page.evaluate(f"document.getElementById('ipdate1').value = '{clean_start}'")
                
            if end_date:
                clean_end = end_date.replace(".", "-").strip()
                if len(clean_end) == 8:
                    clean_end = f"{clean_end[:4]}-{clean_end[4:6]}-{clean_end[6:]}"
                await page.evaluate(f"document.getElementById('ipdate2').value = '{clean_end}'")

            # ── 검색 전 지역 필터 사전 검증 ──────────────────────────────────────
            if sggCd:
                # span#searchea: 모이옵션에서 지역 태그가 주가되는 실제 DOM 콘테이너
                pre_search_region_count = await page.evaluate("""
                    () => {
                        const span = document.querySelector('span#searchea');
                        return span ? span.children.length : 0;
                    }
                """)
                if pre_search_region_count == 0:
                    logger.error(
                        "지역 필터가 하나도 적용되지 않음 (span#searchea 비어있음) — "
                        "전체 지역 검색 시 통영 등 비허용 지역 물건이 "
                        "수집될 수 있어 중단합니다."
                    )
                    raise CrawlerException("지역 필터 설정 실패: span#searchea에 항목이 없음")
                logger.info(f"지역 필터 사전 검증 완료: {pre_search_region_count}개 지역 선택됨")

            # 검색 제출
            await asyncio.sleep(0.5)  # 체크박스 반영 대기
            async with page.expect_navigation(wait_until="domcontentloaded"):
                # 검색 버튼 클릭 (frmChk가 자동 호출되어 usage_code_all 세팅 후 submit)
                await page.locator('button', has_text='검색').last.click()

            # --- 2. 검색 결과 파싱 (NocoDB 사전 중복 필터링 포함) ---
            logger.info("검색 결과 리스트 파싱 (NocoDB 사전 중복 필터링 활성화)...")

            # ── 헬퍼 함수 ──────────────────────────────────────────────────
            def _parse_list_case_no(raw: str) -> str:
                """목록 페이지 사건번호 변환: '2025-11698' → '2025타경11698'"""
                m = re.match(r'^(\d{4})-(\d+)$', raw.strip())
                return f"{m.group(1)}타경{m.group(2)}" if m else raw.strip()

            async def _batch_nocodb_lookup(case_no_list: list) -> dict:
                """NocoDB에서 사건번호 목록으로 기존 레코드 일괄 조회 (court_url 포함)"""
                if not nocodb_url or not nocodb_token or not case_no_list:
                    return {}
                try:
                    where_val = ",".join(case_no_list)
                    api_url = f"{nocodb_url.rstrip('/')}/api/v1/db/data/noco/{nocodb_project_id}/{nocodb_table_id}"
                    resp = await page.request.get(
                        api_url,
                        headers={"xc-token": nocodb_token},
                        params={
                            "where": f"(case_no,in,{where_val})",
                            "limit": str(len(case_no_list) + 10)
                        }
                    )
                    if resp.ok:
                        body = await resp.json()
                        records = body.get("list", [])
                        return {r["case_no"].strip(): r for r in records if r.get("case_no")}
                    else:
                        logger.warning(f"NocoDB 사전 조회 실패: HTTP {resp.status}")
                except Exception as _e:
                    logger.warning(f"NocoDB 사전 조회 오류 (비중단): {_e}")
                return {}
            # ────────────────────────────────────────────────────────────────

            NEED = max_items or 30  # 목표 수집 건수
            target_uids: list[str] = []  # 상세 수집 대상 view ID
            retry_uids: list[str] = []  # 기존이나 분석미완료 → 신규를 먼저 채운 뒤 남는 자리에만
            seen_uids: set[str] = set()
            page_num = 1
            dup_pages = 0
            use_nocodb = bool(nocodb_url and nocodb_token and nocodb_project_id and nocodb_table_id)
            if use_nocodb:
                logger.info(f"NocoDB 사전 중복 필터 활성화 (프로젝트={nocodb_project_id}, 테이블={nocodb_table_id})")
            else:
                logger.warning("NocoDB 정보 미설정 → 사전 필터 없이 전체 수집")

            while len(target_uids) < NEED:
                logger.info(f"[{page_num}페이지] 목록 파싱 중... (목표: {NEED}건, 현재: {len(target_uids)}건)")

                # 목록 페이지에서 (uid, case_no_raw, address_raw, usage_raw, appraisal_amt, min_bid_amt) 추출
                page_pairs = await page.evaluate(r"""
                () => {
                    const pairs = [];
                    const seen = new Set();
                    document.querySelectorAll("a").forEach(el => {
                        const href = el.href || el.getAttribute('href') || '';
                        const m = href.match(/view\/(\d+)/) || href.match(/idx=(\d+)/);
                        if (!m) return;
                        const uid = m[1];
                        if (seen.has(uid)) return;
                        seen.add(uid);

                        // tr 컨테이너 확보
                        const tr = el.closest('tr');
                        if (!tr) {
                            pairs.push({ uid, caseNoRaw: '', addressRaw: '', usageRaw: '', appraisalAmt: 0, minBidAmt: 0 });
                            return;
                        }

                        const trText = tr.innerText || tr.textContent || '';

                        // 1. 사건번호 (YYYY-NNNNN)
                        // 사건번호가 4자리 미만(2025-794, 2026-6)인 경우도 잡도록 1~6자리 허용 (날짜 2026-11-03은 제외)
                        const cm = trText.match(/(?:^|[^\d-])((?:19|20)\d{2}-\d{1,6})(?![\d-])/);
                        const caseNoRaw = cm ? cm[1] : '';

                        // 2. 주소 (시/도 + 시군구 패턴)
                        let addressRaw = '';
                        const _SIDO = [
                            '경상남도','경상북도','부산광역시','울산광역시',
                            '서울특별시','경기도','강원도','충청남도',
                            '충청북도','전라남도','전라북도','세종특별자치시',
                            '인천광역시','대구광역시','대전광역시','광주광역시',
                            '제주특별자치도'
                        ];
                        const _SGU = ['시', '군', '구'];
                        for (const _s of _SIDO) {
                            const _i = trText.indexOf(_s);
                            if (_i === -1) continue;
                            const _after = trText.substring(_i + _s.length).trim();
                            let _sgu = '';
                            for (let _j = 1; _j <= 7 && _j < _after.length; _j++) {
                                if (_SGU.includes(_after.charAt(_j))) {
                                    _sgu = _after.substring(0, _j + 1);
                                    break;
                                }
                            }
                            if (_sgu) { addressRaw = _s + ' ' + _sgu; break; }
                        }

                        // 3. 용도 (아파트, 다세대, 다가구, 오피스텔 등)
                        const USAGE_KW = ['아파트', '다세대', '다가구', '오피스텔', '연립', '단독주택', '공동주택'];
                        let usageRaw = '';
                        for (const td of tr.querySelectorAll('td')) {
                            const t = (td.innerText || td.textContent || '').trim();
                            for (const kw of USAGE_KW) {
                                if (t.includes(kw)) { usageRaw = kw; break; }
                            }
                            if (usageRaw) break;
                        }

                        // 4. 감정가 / 최저가 (td.tbl_auction_right)
                        let appraisalAmt = 0, minBidAmt = 0;
                        const priceTd = tr.querySelector('td.tbl_auction_right');
                        if (priceTd) {
                            // 감정가: font-weight:bold span
                            const boldSpan = Array.from(priceTd.querySelectorAll('span'))
                                .find(s => s.style && (s.style.fontWeight === 'bold' || s.style.fontWeight >= 700));
                            if (boldSpan) {
                                const raw = boldSpan.textContent.replace(/[^\d]/g, '');
                                if (raw) appraisalAmt = parseInt(raw, 10);
                            }
                            // 최저가: span.blue
                            const blueSpan = priceTd.querySelector('span.blue');
                            if (blueSpan) {
                                const raw = blueSpan.textContent.replace(/[^\d]/g, '');
                                if (raw) minBidAmt = parseInt(raw, 10);
                            }
                        }

                        pairs.push({ uid, caseNoRaw, addressRaw, usageRaw, appraisalAmt, minBidAmt });
                    });
                    return pairs;
                }
                """)

                # uid 중복 제거 및 seen_uids 등록 (필터 여부 무관하게 먼저 등록)
                all_new = [
                    (p['uid'], p['caseNoRaw'], p.get('addressRaw', ''),
                     p.get('usageRaw', ''), p.get('appraisalAmt', 0), p.get('minBidAmt', 0))
                    for p in page_pairs if p['uid'] not in seen_uids
                ]
                for uid, *_ in all_new:
                    seen_uids.add(uid)

                # 페이지네이션이 같은 목록을 반복하는 경우(마지막 페이지 이후 등) 종료
                if page_pairs and not all_new:
                    dup_pages += 1
                    if dup_pages >= LIST_MAX_DUP_PAGES:
                        logger.info(f"[{page_num}페이지] 새 물건 없는 반복 페이지 {dup_pages}회 연속 → 목록 수집 종료")
                        break
                else:
                    dup_pages = 0

                # ── 1차-A: 목록 단계 주소 지역 필터 ─────────────────────────────
                if allowed_region_kw:
                    pre_filtered = []
                    for uid, cnr, addr_raw, usage_raw, appr, minb in all_new:
                        if addr_raw and not any(kw in addr_raw for kw in allowed_region_kw):
                            logger.info(
                                f"[{page_num}페이지/목록] uid={uid} "
                                f"주소 사전 스킵: addr='{addr_raw}'"
                            )
                        else:
                            pre_filtered.append((uid, cnr, usage_raw, appr, minb))
                    if len(all_new) > len(pre_filtered):
                        logger.info(
                            f"[{page_num}페이지] 목록 단계 지역 필터: "
                            f"{len(all_new)}건 → {len(pre_filtered)}건 "
                            f"(스킵 {len(all_new)-len(pre_filtered)}건)"
                        )
                    filtered_after_region = pre_filtered
                else:
                    filtered_after_region = [(uid, cnr, ur, ap, mb) for uid, cnr, _, ur, ap, mb in all_new]

                # ── 1차-B: 목록 단계 가격 & 용도 필터 (보수적 통과 원칙) ───────────
                LIST_USAGE_FILTER_MAP = {
                    "아파트":    ["아파트", "공동주택"],
                    "다세대":   ["다세대", "빌라"],
                    "다가구":   ["다가구"],
                    "오피스텔": ["오피스텔"],
                    "연립":     ["연립"],
                }
                list_filtered = []
                for uid, cnr, usage_raw, appr, minb in filtered_after_region:
                    # 가격 필터 (파싱 실패=0이면 보수적으로 통과시켜 상세에서 검증)
                    check_price = minb if minb > 0 else appr
                    if max_appraisal_amt and check_price > 0 and check_price > max_appraisal_amt:
                        logger.info(
                            f"[{page_num}페이지/목록] uid={uid} "
                            f"가격 사전 스킵: {check_price:,}원 > 상한 {max_appraisal_amt:,}원"
                        )
                        continue

                    # 용도 필터 (파싱 실패=빈값이면 보수적으로 통과시켜 상세에서 검증)
                    if usage_scl and usage_scl in LIST_USAGE_FILTER_MAP and usage_raw:
                        u_kws = LIST_USAGE_FILTER_MAP[usage_scl]
                        if not any(kw in usage_raw for kw in u_kws):
                            logger.info(
                                f"[{page_num}페이지/목록] uid={uid} "
                                f"용도 사전 스킵: usage='{usage_raw}' (허용={u_kws})"
                            )
                            continue

                    list_filtered.append((uid, cnr))

                if len(filtered_after_region) > len(list_filtered):
                    logger.info(
                        f"[{page_num}페이지] 목록 단계 가격/용도 필터: "
                        f"{len(filtered_after_region)}건 → {len(list_filtered)}건 "
                        f"(스킵 {len(filtered_after_region)-len(list_filtered)}건)"
                    )

                new_pairs = list_filtered

                if len(new_pairs) > 0:
                    logger.info(f"[{page_num}페이지] {len(new_pairs)}건 필터 통과 항목 추출")

                    if use_nocodb:
                        # 사건번호 변환 및 NocoDB 일괄 조회
                        uid_to_case: dict[str, str] = {}
                        case_nos: list[str] = []
                        for uid, raw in new_pairs:
                            cn = _parse_list_case_no(raw) if raw else ''
                            uid_to_case[uid] = cn
                            if cn:
                                case_nos.append(cn)

                        db_records = await _batch_nocodb_lookup(case_nos)
                        logger.info(f"[{page_num}페이지] NocoDB 조회 결과: {len(db_records)}건 기존 레코드")

                        # 필터링: 신규 + 분석미완료 물건만 target에 추가
                        skip_count = 0
                        for uid, raw in new_pairs:
                            if len(target_uids) >= NEED:
                                break
                            case_no = uid_to_case.get(uid, '')
                            db_rec = db_records.get(case_no) if case_no else None

                            if db_rec is None:
                                # 신규 물건 → 항상 수집
                                target_uids.append(uid)
                                logger.debug(f"[{case_no or uid}] 신규 → 수집 대상")
                            else:
                                # 기존 물건: AI 분석 완료 여부 확인
                                ai_risk = (db_rec.get('ai_risk') or '').strip()
                                already_analyzed = bool(ai_risk and ai_risk != '분석실패')
                                if already_analyzed:
                                    skip_count += 1
                                    logger.debug(f"[{case_no}] 기존 (분석완료: {ai_risk}) → 스킵")
                                else:
                                    retry_uids.append(uid)
                                    logger.info(f"[{case_no}] 기존이나 분석미완료 (ai_risk='{ai_risk}') → 재수집 후보")

                        logger.info(f"[{page_num}페이지] NocoDB 스킵 {skip_count}건 | 수집대상 누계 {len(target_uids)}건 / 목표 {NEED}건")
                    else:
                        # NocoDB 미설정 시 전체 수집
                        for uid, _ in new_pairs:
                            if len(target_uids) >= NEED:
                                break
                            target_uids.append(uid)
                        logger.info(f"[{page_num}페이지] 수집대상 누계 {len(target_uids)}건 / 목표 {NEED}건")
                else:
                    logger.info(f"[{page_num}페이지] 필터 통과 물건 없음 (현재 누계: {len(target_uids)}건 / 목표 {NEED}건) → 다음 페이지 탐색")

                # 목표 달성 시 페이지 순환 종료
                if len(target_uids) >= NEED:
                    logger.info(f"목표 {NEED}건 달성 → 페이지 순환 종료")
                    break

                # 페이지에 물건 링크(page_pairs) 자체가 전혀 없는 경우 (완전 빈 검색 결과)
                if not page_pairs:
                    logger.info(f"[{page_num}페이지] 검색 결과 링크 없음 → 페이지 순환 종료")
                    break

                # 목록 순환 시간 상한 → 상세 수집 시간 확보
                if asyncio.get_event_loop().time() - crawl_started > LIST_TIME_BUDGET_SEC:
                    logger.warning(f"목록 순환 시간 상한 {LIST_TIME_BUDGET_SEC}s 도달 ({page_num}페이지) → 목록 수집 종료, 상세 수집으로 진행")
                    break

                # 다음 페이지 이동 (현재 페이지에서 건진 것이 없더라도 다음 페이지가 있으면 계속 진행)
                target_page = page_num + 1
                try:
                    next_btn = page.locator(f"a[href*='page={target_page}']")
                    if await next_btn.count() == 0:
                        # 10단위 다음 버튼 (ytb_next 또는 ytb_next02 등)
                        next_btn = page.locator("#youtube_number a.ytb_next, #youtube_number a.ytb_next02, a.next")

                    if await next_btn.count() > 0:
                        logger.info(f"[{target_page}페이지] 이동 중...")
                        async with page.expect_navigation(wait_until="domcontentloaded"):
                            await next_btn.first.click()
                        await asyncio.sleep(1.0)
                        page_num += 1
                    else:
                        logger.info(f"마지막 페이지({page_num}) 도달 (다음 페이지 버튼 없음) → 목록 수집 종료")
                        break
                except Exception as e:
                    logger.warning(f"다음 페이지 이동 실패 ({target_page}페이지): {e}")
                    break

            logger.info(f"전체 {page_num}페이지 순환 완료 — 상세 수집 대상: {len(target_uids)}건")

            # 신규 우선, 남는 자리에 분석미완료 재수집 후보
            target_uids += [u for u in retry_uids if u not in target_uids][:max(0, NEED - len(target_uids))]
            logger.info(f"상세 수집 대상 확정: {len(target_uids)}건 (재수집 후보 {len(retry_uids)}건 중 일부 포함)")

            # 안전 상한
            if max_items and len(target_uids) > max_items:
                target_uids = target_uids[:max_items]
            
            # --- 3. 각 물건 상세 들어가서 서류 팝업 파싱 ---
            # 상세 페이지 이동 타임아웃 물건은 큐 끝에서 60초 쉰 뒤 1회 재시도 (사이트 일시 무응답 대비)
            detail_queue = list(target_uids)
            goto_failed_once = set()
            retry_wait_done = False
            qi = 0
            while qi < len(detail_queue):
                uid = detail_queue[qi]
                qi += 1
                if uid in goto_failed_once and not retry_wait_done:
                    retry_wait_done = True
                    if CRAWL_TIME_BUDGET_SEC - (asyncio.get_event_loop().time() - crawl_started) < 240:
                        logger.info("남은 시간 부족 → 재시도 대기 생략")
                    else:
                        logger.info(f"상세 이동 실패 {len(goto_failed_once)}건 재시도 전 60초 대기...")
                        await asyncio.sleep(60)
                # Browserless 연결 끊김 방어 (tracker.py와 동일 패턴, TargetClosedError 방지)
                if asyncio.get_event_loop().time() - crawl_started > CRAWL_TIME_BUDGET_SEC:
                    logger.warning(f"Crawl: 시간 예산 {CRAWL_TIME_BUDGET_SEC}s 초과 → 지금까지 수집된 {len(results)}건 반환.")
                    break
                if not browser.is_connected():
                    logger.warning(f"Crawl: Browserless 연결 끊김 (uid={uid}). 지금까지 수집된 {len(results)}건 반환.")
                    break

                logger.info(f"물건 ID [{uid}] 상세 페이지 진입...")
                await asyncio.sleep(1.0)  # 항목 간 1초 딜레이 (NAS 부하 방지)
                item_url = f"https://www.my-auction.co.kr/view/{uid}"
                try:
                    await page.goto(item_url, wait_until="domcontentloaded", timeout=30000)
                except Exception as goto_err:
                    if uid not in goto_failed_once:
                        goto_failed_once.add(uid)
                        detail_queue.append(uid)
                        logger.error(f"[{uid}] 상세 페이지 이동 실패 ({goto_err}). 마지막에 1회 재시도.")
                    else:
                        logger.error(f"[{uid}] 상세 페이지 재시도도 실패 ({goto_err}). 해당 물건 스킵.")
                    continue
                
                # 기본 정보 추출 (예: 제목에서 타경번호 추출)
                title = await page.title()
                
                case_no_match = re.search(r'(\d+타경\d+)', title)
                case_no = case_no_match.group(1) if case_no_match else ""
                
                obj_no_match = re.search(r'\((\d+)\)', title)
                obj_no = obj_no_match.group(1) if obj_no_match else "1"
                
                item_data = {
                    "saNo": case_no,
                    "objNo": obj_no,
                    "court": court_name,
                    "url": item_url,
                    "address": "",
                    "appraisalAmt": 0,
                    "minBidAmt": 0,
                    "area": "0",
                    "failCount": "0",
                    "bidDate": "",
                    "usage": "",
                    "docs": {},
                    "photo_urls": []
                }
                
                # 메인 페이지 파싱 (기본 메타데이터 및 실거래가)
                try:
                    main_html = await page.content()
                    soup = BeautifulSoup(main_html, 'html.parser')

                    # 용도: 제목에서 직접 추출 (가장 신뢰도 높음)
                    # 예: "2025타경539 [다가구주택 경매]" → "다가구주택"
                    _tm = re.search(r'\[([^\]]+?)\s*경매\]', title)
                    if _tm and not item_data["usage"]:
                        item_data["usage"] = _tm.group(1)

                    # 법원: 검색 조건 코드(cortOfcCd)가 아니라 상세 제목(h2)의 실제 관할로 기록
                    # 예) 양산 물건은 창원지법 검색에도 나오지만 실제 사건은 "울산 경매…" (울산지방법원)
                    for _h2 in soup.select('h2'):
                        if '타경' in _h2.get_text():
                            _hdr = parse_case_header(_h2.get_text())
                            if _hdr["court"]:
                                item_data["court"] = _hdr["court"]
                            elif _hdr["court_short"]:
                                logger.warning(f"[{uid}] 법원 약칭 매핑 없음: '{_hdr['court_short']}' → '{court_name}' 유지")
                            if _hdr["item_no"] and obj_no_match is None:
                                item_data["objNo"] = _hdr["item_no"]
                            break

                    # th/td 기반 메타데이터 추출
                    for th in soup.find_all('th'):
                        th_text = th.get_text(strip=True)
                        # 다음 형제 요소 또는 부모의 다음 형제(td, div 등) 찾기
                        td = th.find_next_sibling(['td', 'div', 'span'])
                        if not td:
                            parent_td = th.find_parent(['th', 'td'])
                            if parent_td:
                                td = parent_td.find_next_sibling(['td', 'th'])
                        if not td:
                            continue
                        
                        td_text = td.get_text(separator=" ", strip=True)
                        
                        if '소재지' in th_text and not item_data["address"]:
                            # "[도로명]" 등의 불필요한 텍스트 제거
                            clean_addr = re.sub(r'\[.*?\]', '', td_text).strip()
                            item_data["address"] = clean_addr
                        elif '감정가' in th_text and item_data["appraisalAmt"] == 0:
                            m = re.search(r'([\d,]{4,})', td_text)
                            if m: item_data["appraisalAmt"] = int(m.group(1).replace(",", ""))
                        elif '최저가' in th_text and item_data["minBidAmt"] == 0:
                            m = re.search(r'([\d,]{4,})', td_text)
                            if m: item_data["minBidAmt"] = int(m.group(1).replace(",", ""))
                        elif '면적' in th_text and item_data["area"] == "0":
                            m = re.search(r'([\d\.]+)', td_text)
                            if m: item_data["area"] = m.group(1)
                        elif ('유찰' in th_text or '진행상태' in th_text) and item_data["failCount"] == "0":
                            m = re.search(r'유찰\s*(\d+)', td_text)
                            if m: item_data["failCount"] = m.group(1)
                        elif '기일' in th_text and not item_data["bidDate"]:
                            # "2024. 07. 08" 처럼 점+공백 혼합 형식도 허용
                            m = re.search(r'(\d{4})[\-\.\s]+(\d{1,2})[\-\.\s]+(\d{1,2})', td_text)
                            if m:
                                y, mo, d = m.group(1), m.group(2).zfill(2), m.group(3).zfill(2)
                                item_data["bidDate"] = f"{y}-{mo}-{d}"
                        elif re.search(r'용도', th_text) and not item_data["usage"]:
                            item_data["usage"] = td_text

                    # ── 기일내역 테이블 파싱 (bidDate & failCount) ─────────────────
                    # 마이옥션은 헤더(rows=1)와 데이터(rows=N) 테이블이 분리되어 있음
                    # 날짜(YYYY-MM-DD)와 상태 키워드가 같은 행에 있는 테이블을 탐색
                    _today = datetime.date.today()
                    _sched_fail = 0
                    _next_date_obj = None   # 가장 가까운 미래 기일
                    _last_date_obj = None   # 가장 최신 과거 기일 (폴백)
                    _next_date_str = ""
                    _last_date_str = ""
                    STATUS_KEYWORDS = ['유찰','매각','변경','진행','취하','정지','기각']

                    for _tbl in soup.find_all('table'):
                        _rows = _tbl.find_all('tr')
                        _is_sched = False
                        for _tr in _rows:
                            # td와 th 모두 허용 (마이옥션은 혼용)
                            _cells = _tr.find_all(['td', 'th'])
                            if len(_cells) < 4:
                                continue
                            _rt = _tr.get_text(separator='|', strip=True)
                            if re.search(r'\d{4}-\d{2}-\d{2}', _rt) and \
                               any(kw in _rt for kw in STATUS_KEYWORDS):
                                _is_sched = True
                                break
                        if not _is_sched:
                            continue

                        # 기일내역 데이터 테이블 파싱
                        for _tr in _rows:
                            _cells = _tr.find_all(['td', 'th'])
                            if len(_cells) < 4:
                                continue
                            _rt = _tr.get_text(separator='|', strip=True)
                            _dm = re.search(r'(\d{4})-(\d{2})-(\d{2})', _rt)
                            if not _dm:
                                continue
                            try:
                                _d = datetime.date(int(_dm.group(1)), int(_dm.group(2)), int(_dm.group(3)))
                            except ValueError:
                                continue
                            _ds = f"{_dm.group(1)}-{_dm.group(2)}-{_dm.group(3)}"
                            _status_text = _cells[-1].get_text(strip=True)

                            if _d >= _today:
                                if _next_date_obj is None or _d < _next_date_obj:
                                    _next_date_obj = _d
                                    _next_date_str = _ds
                            else:
                                if '유찰' in _status_text:
                                    _sched_fail += 1
                                if _last_date_obj is None or _d > _last_date_obj:
                                    _last_date_obj = _d
                                    _last_date_str = _ds
                        break

                    if _next_date_str:
                        item_data["bidDate"] = _next_date_str
                        logger.info(f"기일 테이블에서 다음 매각기일 추출: {_next_date_str}")
                    elif _last_date_str and not item_data["bidDate"]:
                        item_data["bidDate"] = _last_date_str
                        logger.info(f"기일 테이블에서 최근 과거 기일 추출(폴백): {_last_date_str}")

                    if _sched_fail > 0:
                        item_data["failCount"] = str(_sched_fail)
                        logger.info(f"기일 테이블에서 유찰횟수 추출: {_sched_fail}회")

                    text_content = soup.get_text(separator=" ", strip=True)
                    if item_data["appraisalAmt"] == 0:
                        m = re.search(r'감정가\s*[:\s]*([\d,]+)', text_content)
                        if m: item_data["appraisalAmt"] = int(m.group(1).replace(",", ""))
                    if item_data["minBidAmt"] == 0:
                        m = re.search(r'최저가\s*[:\s]*\([\d%]+\)\s*([\d,]+)', text_content)
                        if not m: m = re.search(r'최저가\s*[:\s]*([\d,]+)', text_content)
                        if m: item_data["minBidAmt"] = int(m.group(1).replace(",", ""))
                    if item_data["area"] == "0":
                        m = re.search(r'(?:전용|건물)면적\s*[:\s]*([\d\.]+)\s*㎡', text_content)
                        if m: item_data["area"] = m.group(1)
                    if not item_data["bidDate"]:
                        m = re.search(
                            r'(?:입찰|매각|경매|기일)[^\d]*(\d{4})[\-\.\s]+(\d{1,2})[\-\.\s]+(\d{1,2})',
                            text_content
                        )
                        if m:
                            y, mo, d = m.group(1), m.group(2).zfill(2), m.group(3).zfill(2)
                            item_data["bidDate"] = f"{y}-{mo}-{d}"
                            logger.info(f"백업 정규식으로 bidDate 추출: {item_data['bidDate']}")

                    # 리뉴얼 후 실거래가는 페이지 로드 뒤 auctionv('1',...) → POST /auction/pageview.php 로 채워짐
                    # (응답 0.3~6초, Referer 필수) → 직접 요청해서 파싱
                    item_data["docs"]["real_trade_history"] = ""
                    _rt_form = extract_auctionv_form(main_html, '1')
                    if _rt_form:
                        try:
                            _rt_res = await page.request.post(
                                f"{MY_AUCTION_BASE}/auction/pageview.php",
                                form=_rt_form,
                                headers={"Referer": item_url, "X-Requested-With": "XMLHttpRequest"},
                                timeout=30000,
                            )
                            if _rt_res.ok:
                                _rt_bytes = await _rt_res.body()
                                try:
                                    _rt_html = _rt_bytes.decode('utf-8')
                                except UnicodeDecodeError:
                                    _rt_html = _rt_bytes.decode('euc-kr', errors='replace')
                                item_data["docs"]["real_trade_history"] = parse_real_trade_table(_rt_html)
                                logger.info(f"[{uid}] 실거래가 pageview.php 수집: {len(item_data['docs']['real_trade_history'])}자")
                            else:
                                logger.warning(f"[{uid}] 실거래가 pageview.php HTTP {_rt_res.status}")
                        except Exception as rt_e:
                            logger.warning(f"[{uid}] 실거래가 pageview.php 요청 실패: {rt_e}")
                    else:
                        logger.info(f"[{uid}] auctionv('1') 호출을 찾지 못함 — 기존 방식으로 시도")
                    if not item_data["docs"]["real_trade_history"]:
                        item_data["docs"]["real_trade_history"] = parse_real_trade_table(main_html)
                    # 실거래가가 비어있으면 JS 렌더링 대기 후 재시도
                    if not item_data["docs"]["real_trade_history"]:
                        logger.info("실거래가 테이블 JS 렌더링 대기 중 (최대 3초)...")
                        try:
                            # 스크롤로 lazy-load 트리거 + 대기
                            await page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
                            await asyncio.sleep(0.5)
                            # 문서 전체에서 mainDiv1/mainDiv2 또는 tbl_detail 테이블의 데이터 행 확인
                            await page.wait_for_function(
                                """
                                () => {
                                    const trs = document.querySelectorAll('#mainDiv1 table tr, #mainDiv2 table tr, table.tbl_detail tr');
                                    for (const tr of trs) {
                                        const tds = tr.querySelectorAll('td:not([colspan])');
                                        if (tds.length >= 4) return true;
                                    }
                                    return false;
                                }
                                """,
                                timeout=3000
                            )
                            rendered_html = await page.content()
                            item_data["docs"]["real_trade_history"] = parse_real_trade_table(rendered_html)
                            if item_data["docs"]["real_trade_history"]:
                                logger.info("실거래가 테이블 JS 렌더링 후 수집 성공")
                            else:
                                logger.warning("실거래가 JS 렌더링 후에도 파싱 실패 (데이터 없음 또는 구조 불일치)")
                        except Exception as wait_e:
                            logger.debug(f"실거래가 렌더링 대기 종료 (타임아웃/테이블 없음): {wait_e}")
                    item_data["docs"]["real_trade_history"] = trim_real_trade_text(item_data["docs"]["real_trade_history"])
                except Exception as e:
                    logger.error(f"메타데이터 파싱 실패: {e}")
                    item_data["docs"]["real_trade_history"] = ""
                
                # ── 2차 Early Return: 5종 서류 다운로드 전 즉시 차단 ─────────────────
                # 목록 단계에서 파싱 실패로 넘어온 경우 상세 메타 파싱 후 여기서 즉시 차단
                _check_price_2 = item_data["minBidAmt"] if item_data.get("minBidAmt", 0) > 0 else item_data.get("appraisalAmt", 0)
                if max_appraisal_amt and _check_price_2 > 0 and _check_price_2 > max_appraisal_amt:
                    logger.info(
                        f"[{uid}] 2차 가격 차단 (서류 다운 전): {_check_price_2:,}원 > 상한 {max_appraisal_amt:,}원"
                    )
                    continue

                _item_usage_2 = item_data.get("usage", "")
                DETAIL_USAGE_MAP = {
                    "아파트":    ["아파트", "공동주택"],
                    "다세대":   ["다세대", "빌라"],
                    "다가구":   ["다가구"],
                    "오피스텔": ["오피스텔"],
                    "연립":     ["연립"],
                }
                if usage_scl and usage_scl in DETAIL_USAGE_MAP:
                    _u_kws = DETAIL_USAGE_MAP[usage_scl]
                    if _item_usage_2:
                        if not any(kw in _item_usage_2 for kw in _u_kws):
                            logger.info(
                                f"[{uid}] 2차 용도 차단 (서류 다운 전): usage='{_item_usage_2}' (허용={_u_kws})"
                            )
                            continue
                    else:
                        title_lower = title.lower()
                        UNWANTED_KEYWORDS = ["업무시설", "근린생활", "공장", "창고", "토지", "임야", "상가", "숙박"]
                        if any(kw in title for kw in UNWANTED_KEYWORDS):
                            logger.info(f"[{uid}] 2차 타이틀 기반 차단 (서류 다운 전): title='{title}'")
                            continue

                if allowed_region_kw and item_data.get("address"):
                    if not any(kw in item_data["address"] for kw in allowed_region_kw):
                        logger.info(
                            f"[{uid}] 2차 지역 차단 (서류 다운 전): address='{item_data['address']}' (허용={allowed_region_kw})"
                        )
                        continue
                # ────────────────────────────────────────────────────────────────────────
                
                # 팝업 서류들 직접 추출 로직
                doc_types = {
                    "building_ledger": "aceeair",      # 건축물대장
                    "appraisal": "judgement",          # 감정평가서
                    "sale_spec": "mul",                # 매각물건명세서
                    "status_survey": "status",         # 현황조사서
                    "registry": "aceeaea1",            # 등기부등본(건물)
                    "registry_land": "aceeaea2"        # 등기부등본(토지) — 토지 등기가 있는 물건만
                }
                
                # ── 파일별 파싱 헬퍼 함수 ─────────────────────────────────────
                def _parse_pdf_bytes(pdf_bytes: bytes, label: str) -> str:
                    """PDF 바이너리에서 텍스트 추출"""
                    try:
                        pdf_doc = fitz.open("pdf", pdf_bytes)
                        text = ""
                        for pg in range(len(pdf_doc)):
                            text += pdf_doc[pg].get_text()
                        # 감정평가서/건축물대장: 스캔 이미지거나 글자가 깨진 페이지만 OCR로 대체
                        if label.startswith('appraisal') or label == 'building_ledger':
                            try:
                                ocr_text, ocr_pages = extract_pdf_text_with_ocr(pdf_doc)
                                if ocr_pages:
                                    logger.info(f"[{label}] OCR {ocr_pages}쪽 적용 (원문 {len(text)}자 → {len(ocr_text)}자)")
                                    text = ocr_text
                            except Exception as oe:
                                logger.warning(f"[{label}] OCR 실패, 원문 유지: {oe}")
                        pdf_doc.close()
                        if len(text) > 100000:
                            text = text[:100000] + "\n...[생략]..."
                        return text
                    except Exception as ex:
                        logger.error(f"[{label}] PDF 파싱 오류: {ex}")
                        return ""

                async def _fetch_pdf_and_parse(pdf_url: str, label: str) -> str:
                    """PDF URL을 가져와서 텍스트 주운다."""
                    try:
                        res = await page.request.get(
                            pdf_url,
                            timeout=20000,
                            headers={"Referer": item_url}
                        )
                        if not res.ok:
                            logger.warning(f"[{label}] PDF fetch 실패: HTTP {res.status}")
                            return ""
                        pdf_bytes = await res.body()
                        if not pdf_bytes.startswith(b'%PDF-'):
                            logger.warning(f"[{label}] PDF 아님 (시작: {pdf_bytes[:8]!r})")
                            return ""
                        return _parse_pdf_bytes(pdf_bytes, label)
                    except Exception as ex:
                        logger.error(f"[{label}] PDF 다운로드 오류: {ex}")
                        return ""

                def _build_nuri_pdf_url(item_uid: str, doc_val: str) -> str:
                    """이레아누리옵션 PDF URL 직접 생성."""
                    raw = f"idx={item_uid}&db_name=1&title=M Y A U C T I O N"
                    encoded = base64.b64encode(raw.encode()).decode() + "||"
                    return f"https://irea.nuriauction.com/{doc_val}.php?idx={encoded}"

                async def _process_single_doc(doc_key: str, doc_val: str) -> tuple[str, str]:
                    """단일 서류 수집 (비동기 병렬 처리용)"""
                    logger.info(f"[{doc_key}] 파싱 시작...")
                    try:
                        # 리뉴얼 후: nuri aceeair.php 의 db_name 으로 서류 구분 (db_name=1 등기부, 2 건축물대장)
                        _nuri_args = {
                            'building_ledger': (2, None),
                            'registry': (1, None),
                            'registry_land': (1, 2),
                        }.get(doc_key)
                        if _nuri_args:
                            pdf_url = build_nuri_pdf_url(uid, *_nuri_args)
                            result = await _fetch_pdf_and_parse(pdf_url, doc_key)
                            if result:
                                return doc_key, result
                            if doc_key == 'registry_land':
                                return doc_key, ""
                            logger.info(f"[{doc_key}] 직접 URL 실패 — wrapper 파싱 폴백")

                        doc_url = f"https://www.my-auction.co.kr/auction/auction_detail_view.php?type={doc_val}&idx={uid}"
                        response = await page.request.get(doc_url, timeout=20000)
                        if not response.ok:
                            return doc_key, ""

                        wrapper_bytes = await response.body()
                        try:
                            wrapper_html = wrapper_bytes.decode('utf-8')
                        except UnicodeDecodeError:
                            wrapper_html = wrapper_bytes.decode('euc-kr', errors='replace')

                        if "history.back();" in wrapper_html or ("닫기" in wrapper_html and len(wrapper_html) < 500):
                            return doc_key, ""

                        wrapper_soup = BeautifulSoup(wrapper_html, 'html.parser')
                        iframe_tag = wrapper_soup.find('iframe')
                        if iframe_tag and iframe_tag.get('src'):
                            iframe_src = iframe_tag['src']
                            if iframe_src.startswith("/"):
                                iframe_url = f"https://www.my-auction.co.kr{iframe_src}"
                            elif not iframe_src.startswith("http"):
                                iframe_url = f"https://www.my-auction.co.kr/auction/{iframe_src}"
                            else:
                                iframe_url = iframe_src

                            # PDF.js viewer 인 경우 file= 파라미터 추출 후 직접 PDF 호출
                            if 'viewer.html' in iframe_url or 'pdfjs' in iframe_url:
                                qs = urllib.parse.parse_qs(urllib.parse.urlparse(iframe_url).query)
                                file_url = qs.get('file', [None])[0]
                                if file_url:
                                    file_url = urllib.parse.unquote(file_url)
                                    parsed_res = await _fetch_pdf_and_parse(file_url, doc_key)
                                    return doc_key, parsed_res
                                return doc_key, ""
                            else:
                                iframe_res = await page.request.get(iframe_url, timeout=15000)
                                if iframe_res.ok:
                                    iframe_bytes = await iframe_res.body()
                                    if iframe_bytes.startswith(b'%PDF-'):
                                        # 중복 다운로드 없이 즉시 메모리 파싱
                                        pdf_text = _parse_pdf_bytes(iframe_bytes, doc_key)
                                        if doc_key == 'appraisal':
                                            # 추가 감정평가서(PDF_Judgement_N.pdf)는 팝업 메뉴 링크로만 노출됨
                                            for n, extra_url in enumerate(extract_extra_judgement_urls(wrapper_html), 1):
                                                extra_text = await _fetch_pdf_and_parse(extra_url, f"{doc_key}_{n}")
                                                if extra_text:
                                                    pdf_text += f"\n\n[감정평가서{n}]\n{extra_text}"
                                        return doc_key, pdf_text
                                    else:
                                        try:
                                            iframe_html = iframe_bytes.decode('utf-8')
                                        except UnicodeDecodeError:
                                            iframe_html = iframe_bytes.decode('euc-kr', errors='replace')
                                        parsed = parse_detail_html(iframe_html)
                                        return doc_key, parsed if len(parsed) > 200 else ""
                                else:
                                    logger.warning(f"[{doc_key}] iframe 요청 실패: {iframe_res.status}")
                                    return doc_key, ""
                        else:
                            found_text = ""
                            for sel in ['div.view_body', 'div.cont_area', 'div#contents', 'article', 'div.dtl_cont']:
                                el = wrapper_soup.select_one(sel)
                                if el:
                                    t = el.get_text(separator="\n", strip=True)
                                    if len(t) > 200:
                                        found_text = t
                                        break
                            if not found_text:
                                parsed = parse_detail_html(wrapper_html)
                                if len(parsed) > 200:
                                    found_text = parsed
                            return doc_key, found_text
                    except Exception as e:
                        logger.error(f"[{doc_key}] 파싱 실패: {e}")
                        return doc_key, ""

                # NAS 메모리 피크를 줄이기 위해 서류는 동시 처리하지 않고 하나씩 처리
                for dk, dv in doc_types.items():
                    _, res_content = await _process_single_doc(dk, dv)
                    item_data["docs"][dk] = res_content

                # 추가 감정평가서(PDF_Judgement_N.pdf) 이어 붙이기
                try:
                    _jw = await page.request.get(
                        f"{MY_AUCTION_BASE}/auction/auction_detail_view.php?type={doc_types['appraisal']}&idx={uid}",
                        timeout=20000,
                    )
                    if _jw.ok:
                        _jw_bytes = await _jw.body()
                        try:
                            _jw_html = _jw_bytes.decode('utf-8')
                        except UnicodeDecodeError:
                            _jw_html = _jw_bytes.decode('euc-kr', errors='replace')
                        for _n, _extra_url in enumerate(extract_extra_judgement_urls(_jw_html), start=1):
                            _extra_text = await _fetch_pdf_and_parse(_extra_url, f"appraisal_extra{_n}")
                            if _extra_text:
                                item_data["docs"]["appraisal"] = (
                                    (item_data["docs"].get("appraisal") or "")
                                    + f"\n\n===== 추가 감정평가서 {_n} =====\n" + _extra_text
                                ).strip()
                except Exception as je:
                    logger.warning(f"[{uid}] 추가 감정평가서 수집 실패: {je}")

                # 물건사진 원본 URL 수집 (이미지 자체는 받지 않음)
                try:
                    _pic_res = await page.request.get(
                        f"{NURI_FILE_BASE}/auction/pic_view.php?idx={uid}&picname=pic_0.jpg",
                        timeout=15000,
                        headers={"Referer": item_url},
                    )
                    if _pic_res.ok:
                        _pic_bytes = await _pic_res.body()
                        try:
                            _pic_html = _pic_bytes.decode('utf-8')
                        except UnicodeDecodeError:
                            _pic_html = _pic_bytes.decode('euc-kr', errors='replace')
                        item_data["photo_urls"] = extract_photo_urls(_pic_html)
                        logger.info(f"[{uid}] 물건사진 {len(item_data['photo_urls'])}장")
                except Exception as pe:
                    logger.warning(f"[{uid}] 물건사진 수집 실패: {pe}")
                
                # 최저가(또는 감정가) 상한 초과 시 메모리에서 스킵 (방어 필터)
                check_price = item_data["minBidAmt"] if item_data.get("minBidAmt", 0) > 0 else item_data.get("appraisalAmt", 0)
                if max_appraisal_amt and check_price > max_appraisal_amt:
                    logger.info(
                        f"[{uid}] 가격 {check_price:,}원 > 상한 {max_appraisal_amt:,}원, 스킵"
                    )
                    continue

                # ── 용도 필터링 (수집 후 최종 방어선) ─────────────────────────
                # usage_scl이 지정된 경우, 물건 용도가 일치하지 않으면 스킵
                USAGE_FILTER_MAP = {
                    "아파트":    ["아파트", "공동주택"],
                    "다세대":   ["다세대", "빌라"],
                    "다가구":   ["다가구"],
                    "오피스텔": ["오피스텔"],
                    "연립":     ["연립"],
                }
                if usage_scl and usage_scl in USAGE_FILTER_MAP:
                    usage_keywords = USAGE_FILTER_MAP[usage_scl]
                    item_usage = item_data.get("usage", "")
                    # 용도가 아예 비어있으면 일단 통과 (title에서 유형 파싱 시도)
                    if item_usage:
                        matched = any(kw in item_usage for kw in usage_keywords)
                        if not matched:
                            logger.info(
                                f"[{uid}] 용도 불일치 스킵: usage='{item_usage}' (허용={usage_keywords})"
                            )
                            continue
                    else:
                        # 타이틀에서 물건 유형 추출 시도
                        title_lower = title.lower()
                        UNWANTED_KEYWORDS = ["업무시설", "근린생활", "공장", "창고", "토지", "임야", "상가", "숙박"]
                        if any(kw in title for kw in UNWANTED_KEYWORDS):
                            logger.info(f"[{uid}] 타이틀 기반 불일치 스킵: title='{title}'")
                            continue

                # ── 주소 기반 지역 필터 (최종 방어선) ───────────────────────────────
                # sgg_list 기반으로 동적 생성된 allowed_region_kw로 주소 검사
                # sggCd가 지정되지 않았거나 allowed_region_kw가 비어있으면 필터 비활성
                if allowed_region_kw and item_data.get("address"):
                    item_address = item_data["address"]
                    if not any(kw in item_address for kw in allowed_region_kw):
                        logger.info(
                            f"[{uid}] 주소 기반 지역 필터 스킵: address='{item_address}' "
                            f"(허용={allowed_region_kw})"
                        )
                        continue

                results.append(item_data)

            return results

        except Exception as e:
            logger.error(f"크롤링 중 오류: {e}")
            raise
        finally:
            if browser:
                await browser.close()
            logger.info("Browserless 웹소켓 연결 종료")
