"""5단계 · 실거래만 다시 받기 (2026-11-15)

진행중 물건 중 real_trade_history 가 '정보 없음'인 물건을 상세번호(uid)로 다시 받는다.
- 상세 HTML의 auctionv('1', ...) 인자로 POST /auction/pageview.php (Referer 필수) → #mainDiv1 매매, #mainDiv2 전월세
- 기존 myauction.py 의 extract_auctionv_form / parse_real_trade_table / trim_real_trade_text 를 그대로 쓴다
- 반환: {uid: {"status": ok|empty|no_form|http_xxx|error, "text": 표 텍스트, "chars": n}}
"""
import asyncio
import logging
import os

from playwright.async_api import async_playwright

from crawler.myauction import (
    BROWSER_SESSION_MS, MY_AUCTION_BASE, extract_auctionv_form, parse_real_trade_table, trim_real_trade_text,
)

logger = logging.getLogger(__name__)


async def fetch_real_trades(uids, progress=None, time_budget=15 * 60):
    my_id = os.environ.get("MY_AUCTION_ID")
    my_pw = os.environ.get("MY_AUCTION_PW")
    ws_url = os.environ.get("BROWSERLESS_WS_URL", "ws://browserless:3000")
    ws_url += ("&" if "?" in ws_url else "?") + f"timeout={BROWSER_SESSION_MS}"
    if not my_id or not my_pw:
        raise RuntimeError("마이옥션 ID 또는 PW가 설정되지 않았습니다.")

    out = {}
    started = asyncio.get_event_loop().time()
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(ws_url, timeout=180000)
        try:
            context = await browser.new_context(viewport={"width": 1920, "height": 1080})
            page = await context.new_page()
            page.on("dialog", lambda d: asyncio.create_task(d.accept()))
            await page.goto(f"{MY_AUCTION_BASE}/member/login.php", wait_until="domcontentloaded")
            await page.fill('input[name="login_id"]', my_id)
            await page.fill('input[name="login_pw"]', my_pw)
            await page.click("#btn_login")
            await asyncio.sleep(3)

            for i, uid in enumerate(uids):
                if asyncio.get_event_loop().time() - started > time_budget:
                    logger.warning(f"[real-trade] 시간 예산 초과, {i}/{len(uids)}건에서 멈춤")
                    break
                uid = str(uid).strip()
                item_url = f"{MY_AUCTION_BASE}/view/{uid}"
                try:
                    res = await page.request.get(item_url, headers={"Referer": f"{MY_AUCTION_BASE}/auction/search.php"}, timeout=30000)
                    html = await res.text()
                    form = extract_auctionv_form(html, "1")
                    if not form:   # 원본 HTML에 호출이 없으면 실제로 열어서 다시
                        await page.goto(item_url, wait_until="domcontentloaded", timeout=30000)
                        html = await page.content()
                        form = extract_auctionv_form(html, "1")
                    if not form:
                        out[uid] = {"status": "no_form", "text": "", "chars": 0}
                        continue
                    rt = await page.request.post(f"{MY_AUCTION_BASE}/auction/pageview.php", form=form,
                                                 headers={"Referer": item_url, "X-Requested-With": "XMLHttpRequest"}, timeout=30000)
                    if not rt.ok:
                        out[uid] = {"status": f"http_{rt.status}", "text": "", "chars": 0}
                        continue
                    body = await rt.body()
                    try:
                        rt_html = body.decode("utf-8")
                    except UnicodeDecodeError:
                        rt_html = body.decode("euc-kr", errors="replace")
                    text = trim_real_trade_text(parse_real_trade_table(rt_html))
                    out[uid] = {"status": "ok" if "계약일" in text else "empty", "text": text, "chars": len(text)}
                except Exception as e:
                    logger.warning(f"[real-trade] {uid} 실패: {e}")
                    out[uid] = {"status": "error", "text": "", "chars": 0, "error": str(e)[:200]}
                if progress is not None:
                    progress.update(done=i + 1, total=len(uids))
                await asyncio.sleep(0.5)
        finally:
            await browser.close()
    return out
