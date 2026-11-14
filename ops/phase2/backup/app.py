import asyncio
import threading
import traceback
import os
import logging
from flask import Flask, request, jsonify
from crawler.myauction import crawl_my_auction, CrawlerException
from crawler.myauction_tracker import track_my_auction_results, TrackerException

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
app = Flask(__name__)

# 크롤링 동시 실행 방지 (대시보드 버튼 + 스케줄 실행이 겹치면 브라우저/메모리 부하가 두 배가 되어 NAS가 멈출 수 있음)
crawl_lock = threading.Lock()

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok"})

@app.route('/crawl', methods=['POST'])
def crawl():
    if not crawl_lock.acquire(blocking=False):
        return jsonify({
            "success": False,
            "error": "이미 크롤링이 실행 중입니다. 끝난 뒤 다시 시도하세요."
        }), 429
    try:
        return _crawl()
    finally:
        crawl_lock.release()


def _crawl():
    try:
        data = request.get_json() or {}

        # ── 마이옥션 전용 지역 코드 변환 ──────────────────────────────
        # n8n 검색설정 노드는 국토부 lawdCd(sdCd=48, sggCd=48250 등)를 사용하므로
        # 마이옥션 address1_01/02 value로 변환해야 함
        MY_AUCTION_SD_MAP = {
            "48": "4",   # 경상남도
            "11": "10",  # 서울
            "41": "3",   # 경기
            "28": "12",  # 인천
            "26": "9",   # 부산
            "31": "11",  # 울산
            "27": "7",   # 대구
            "30": "8",   # 대전
            "29": "6",   # 광주
        }
        MY_AUCTION_SGG_MAP = {
            # 김해시 / 양산시 / 거제시 / 진주시 / 밀양시 / 사천시 / 통영시
            "48250": ["168"], "250": ["168"], "김해시": ["168"], "김해": ["168"], "168": ["168"],  # 김해시
            "48330": ["173"], "330": ["173"], "양산시": ["173"], "양산": ["173"], "173": ["173"],  # 양산시
            "48310": ["165"], "310": ["165"], "거제시": ["165"], "거제": ["165"], "165": ["165"],  # 거제시
            "48170": ["177"], "170": ["177"], "진주시": ["177"], "진주": ["177"], "177": ["177"],  # 진주시
            "48270": ["333"], "270": ["333"], "밀양시": ["333"], "밀양": ["333"], "333": ["333"],  # 밀양시
            "48240": ["171"], "240": ["171"], "사천시": ["171"], "사천": ["171"], "171": ["171"],  # 사천시
            "48220": ["180"], "220": ["180"], "통영시": ["180"], "통영": ["180"], "180": ["180"],  # 통영시

            # 창원시 각 구 (마이옥션 실제 코드)
            "48121": ["7957"], "121": ["7957"], "의창구": ["7957"],       # 창원시 의창구
            "48123": ["7947"], "123": ["7947"], "성산구": ["7947"],       # 창원시 성산구
            "48125": ["7949"], "125": ["7949"], "마산합포구": ["7949"],   # 창원시 마산합포구
            "48127": ["7952"], "127": ["7952"], "마산회원구": ["7952"],   # 창원시 마산회원구
            "48129": ["7954"], "129": ["7954"], "진해구": ["7954"],       # 창원시 진해구
            
            # 창원시 전체
            "48120": ["179"], "120": ["179"], "창원시": ["179"], "창원": ["179"], "179": ["179"],
        }

        raw_sdCd  = str(data.get("sdCd",  "48"))
        raw_sggCd = data.get("sggCd", "250")

        sdCd = MY_AUCTION_SD_MAP.get(raw_sdCd, raw_sdCd)

        # 다중 시/군/구 파싱
        sggCd = []
        if isinstance(raw_sggCd, list):
            sgg_inputs = [str(x).strip() for x in raw_sggCd if str(x).strip()]
        else:
            sgg_inputs = [x.strip() for x in str(raw_sggCd).split(",") if x.strip()]

        for item in sgg_inputs:
            if item in MY_AUCTION_SGG_MAP:
                sggCd.extend(MY_AUCTION_SGG_MAP[item])
            elif item:
                # 매핑 실패: 원시 코드를 그냥 넣으면 의도치 않은 지역이 검색될 수 있으므로 무시
                # 새 지역을 추가하려면 MY_AUCTION_SGG_MAP에 코드를 등록하세요
                import logging as _log
                _log.getLogger(__name__).warning(
                    f"SGG 코드 매핑 실패: '{item}' — MY_AUCTION_SGG_MAP에 없음, 무시됨 "
                    f"(새 지역 추가 시 app.py의 MY_AUCTION_SGG_MAP에 등록 필요)"
                )
        # ──────────────────────────────────────────────────────────────

        cortOfcCd = data.get("cortOfcCd", "B000210")
        usage_lcl = data.get("usageLcl",  "건물")
        usage_mcl = data.get("usageMcl",  "주거용건물")
        usage_scl = data.get("usageScl",  "아파트")
        start_date = data.get("termStartDt", "")
        end_date   = data.get("termEndDt",   "")

        # 감정가 상한 (n8n에서 lwsDspslPrcMax로 넘기거나 maxAppraisalAmt으로 넘겨도 수용)
        max_appraisal_amt = data.get("maxAppraisalAmt") or data.get("lwsDspslPrcMax")
        if max_appraisal_amt:
            max_appraisal_amt = int(max_appraisal_amt)

        # 최대 수집 건수 (n8n에서 maxItems / max_items 파라미터 전달 수용)
        max_items = data.get("maxItems") or data.get("max_items")
        if max_items:
            max_items = int(max_items)

        # NocoDB 사전 중복 필터링 설정 (환경변수 기반)
        nocodb_url         = os.environ.get("NOCODB_URL", "http://nocodb_app:8080")
        nocodb_token       = os.environ.get("NOCODB_TOKEN", "")
        nocodb_project_id  = os.environ.get("NOCODB_PROJECT_ID", "pwmyhpb0tu3b4m6")
        nocodb_table_id    = os.environ.get("NOCODB_TABLE_ID", "mfim9xo11ob6gp9")

        results = asyncio.run(
            crawl_my_auction(
                sdCd, sggCd, cortOfcCd,
                start_date, end_date,
                usage_lcl, usage_mcl, usage_scl,
                max_appraisal_amt=max_appraisal_amt,
                max_items=max_items,
                nocodb_url=nocodb_url,
                nocodb_token=nocodb_token,
                nocodb_project_id=nocodb_project_id,
                nocodb_table_id=nocodb_table_id,
            )
        )
        
        return jsonify({
            "success": True,
            "count": len(results),
            "data": results
        })

    except CrawlerException as ce:
        tb = traceback.format_exc()
        print(tb)
        return jsonify({
            "success": False,
            "error": str(ce),
            "current_url": ce.current_url,
            "traceback": tb
        }), 500
    except Exception as e:
        tb = traceback.format_exc()
        print(tb)
        return jsonify({
            "success": False,
            "error": str(e),
            "traceback": tb
        }), 500

@app.route('/track', methods=['POST'])
def track():
    try:
        data = request.get_json() or {}
        case_nos = data.get("case_nos", [])
        court = data.get("court", "")
        
        if not case_nos or not isinstance(case_nos, list):
            return jsonify({"success": False, "error": "Invalid or missing 'case_nos' list"}), 400

        # NocoDB 종결 사전 스킵용 설정
        nocodb_url         = os.environ.get("NOCODB_URL", "http://nocodb_app:8080")
        nocodb_token       = os.environ.get("NOCODB_TOKEN", "")
        nocodb_project_id  = os.environ.get("NOCODB_PROJECT_ID", "pwmyhpb0tu3b4m6")
        nocodb_table_id    = os.environ.get("NOCODB_TABLE_ID", "mfim9xo11ob6gp9")

        results = asyncio.run(track_my_auction_results(
            case_nos, court,
            nocodb_url=nocodb_url,
            nocodb_token=nocodb_token,
            nocodb_project_id=nocodb_project_id,
            nocodb_table_id=nocodb_table_id,
        ))
        
        return jsonify({
            "success": True,
            "count": len(results),
            "data": results
        })

    except TrackerException as ce:
        tb = traceback.format_exc()
        print(tb)
        return jsonify({
            "success": False,
            "error": str(ce),
            "current_url": ce.current_url,
            "traceback": tb
        }), 500
    except Exception as e:
        tb = traceback.format_exc()
        print(tb)
        return jsonify({
            "success": False,
            "error": str(e),
            "traceback": tb
        }), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001)
