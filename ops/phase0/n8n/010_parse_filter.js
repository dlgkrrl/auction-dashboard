const input = $input.first().json;
const cfg   = $('검색 설정').first().json;

// API 실패 처리
if (!input.success || !input.data) {
  return [{
    json: {
      __parseFailed:  true,
      __parseError:   'api_failed',
      __parseDetail:  input.error || JSON.stringify(input).slice(0, 300)
    }
  }];
}

let items = input.data || [];

if (items.length === 0) {
  return [{
    json: {
      __parseFailed:  true,
      __parseError:   'empty_result',
      __parseDetail:  '조회된 경매 물건이 없습니다.'
    }
  }];
}

// 필터 설정
const filterMaxPrice = cfg.lwsDspslPrcMax ? Number(cfg.lwsDspslPrcMax) : 0;
const filterMinPrice = cfg.lwsDspslPrcMin ? Number(cfg.lwsDspslPrcMin) : 0;
const filterAreaMin  = cfg.objctArDtsMin  ? Number(cfg.objctArDtsMin)  : 0;
const filterAreaMax  = cfg.objctArDtsMax  ? Number(cfg.objctArDtsMax)  : 0;

// 지분매각·여러 호수 일괄매각 제외 (2026-11-12, 사용자 결정: 지분 전부 / 일괄은 여러 호수 묶음만)
const SHARE_RE = /지분\s*매각|공유\s*지분|매각\s*지분/;
const BULK_RE = /일괄\s*매각/;
const MULTI_UNIT_ADDR_RE = /외\s*\d+\s*개?\s*호/;
const UNIT_TYPES_RE = /아파트|다세대|빌라|연립|오피스텔|도시형/;
function excludeReason(item) {
  const spec = String((item.docs && item.docs.sale_spec) || '').replace(/[ \t]+/g, ' ');
  const addr = String(item.address || '');
  if (SHARE_RE.test(spec)) return 'share';
  const units = new Set((spec.match(/제?\s*\d{1,4}\s*호/g) || []).map(function (s) { return s.replace(/\D/g, ''); }));
  const isUnitType = UNIT_TYPES_RE.test(String(item.usage || '')) || /\d+\s*호/.test(addr);
  if (MULTI_UNIT_ADDR_RE.test(addr) || (BULK_RE.test(spec) && isUnitType && units.size >= 2)) return 'bulk';
  return '';
}

// 물건 정규화 + 필터링
const filtered = items.filter(function(item) {
  if (excludeReason(item)) { return false; }
  // 가격 필터
  const price = Number(item.minBidAmt) || 0;
  if (filterMaxPrice > 0 && price > filterMaxPrice) { return false; }
  if (filterMinPrice > 0 && price < filterMinPrice) { return false; }

  // 면적 필터 (item.area 우선, 없으면 address에서 추출)
  if (filterAreaMin > 0 || filterAreaMax > 0) {
    let areaNum = parseFloat(item.area || '0');
    if (isNaN(areaNum) || areaNum === 0) {
      const areaMatch = item.address.match(/([0-9.]+)\s*㎡/);
      if (areaMatch) areaNum = parseFloat(areaMatch[1]);
    }
    if (!isNaN(areaNum) && areaNum > 0) {
      if (filterAreaMin > 0 && areaNum < filterAreaMin) { return false; }
      if (filterAreaMax > 0 && areaNum > filterAreaMax) { return false; }
    }
  }
  return true;
});

if (filtered.length === 0) {
  return [{
    json: {
      __parseFailed:  false,
      __parseError:   'filtered_out',
      __parseDetail:  items.length + '건 조회됐지만 필터 조건에 맞는 물건 없음'
    }
  }];
}

return filtered.map(function(item) {
  // 면적 추출 (item.area 우선, 없으면 address에서 추출) 및 소수점 2자리 반올림
  let area = item.area || '';
  if (!area) {
    const areaMatch = item.address.match(/([0-9.]+)\s*㎡/);
    if (areaMatch) area = areaMatch[1];
  }
  if (area) {
    area = Math.round(parseFloat(area) * 100) / 100;
  }
  
  // 주소 정제 (괄호 제거 전 bracket [집합건물...] Suffix 제거)
  const addressForParsing = (item.address || '').replace(/\s*\[[^\]]+\]\s*$/, '').trim();

  // 유찰 횟수 숫자만
  let lossCount = (item.failCount || '').replace(/[^0-9]/g, '');
  if (!lossCount) lossCount = '0';

  // 단지명 추출 헬퍼 함수
  const extractComplexName = (address) => {
    if (!address) return '';
    let name = '';
    const parenMatch = address.match(/\(([^)]+)\)/);
    if (parenMatch) {
      const parts = parenMatch[1].split(',');
      const val = parts.length > 1 ? parts[1] : parts[0];
      name = val.replace(/\s*\d+동.*/, '').trim();
    } else {
      const cleanAddr = address.replace(/\s+\d+동.*/, '').trim();
      const tokens = cleanAddr.split(/\s+/);
      let startIdx = 3;
      if (tokens.length > 3) {
        if (/^\d/.test(tokens[3]) || tokens[3].includes('-')) {
          startIdx = 4;
        }
        if (tokens.length > 4 && (/^\d/.test(tokens[4]) || tokens[4].includes('-'))) {
          startIdx = 5;
        }
      }
      if (startIdx < tokens.length) {
        name = tokens.slice(startIdx).join(' ');
      }
    }

    if (name) {
      name = name
        .replace(/\s+제?(?:지하\s*)?\d+호\s*$/, '')
        .replace(/\s+제?(?:지하\s*)?\d+층(?:\s*제?\d+호)?\s*$/, '')
        .replace(/\s+[A-Za-z0-9가-힣]+동(?:\s+제?(?:지하\s*)?\d+층)?(?:\s*제?\d+호)?\s*$/, '')
        .trim();
    }
    return name;
  };

  // 층 추출 헬퍼 함수
  const extractFloor = (address) => {
    if (!address) return '';
    const match = address.match(/(?:지하\s*)?\d+층/);
    return match ? match[0] : '';
  };

  // 동 추출 헬퍼 함수
  const extractDong = (address) => {
    if (!address) return '';
    const match = address.match(/\s+(\d+|[A-Z])동(?:\s|$)/i);
    return match ? match[1] + '동' : '';
  };

  const complexName = extractComplexName(addressForParsing);
  const floorName = extractFloor(addressForParsing);
  const dongName = extractDong(addressForParsing);

  // 네이버 검색 키워드 조립 헬퍼 함수
  const getSearchKey = (address) => {
    if (!address) return '';
    const complex = extractComplexName(address);
    if (complex) {
      const tokens = address.replace(/,/g, ' ').split(/\s+/);
      let prefix = '';
      if (tokens.length >= 2) {
        prefix = tokens[0] + ' ' + tokens[1] + ' ';
      }
      return prefix + complex;
    }
    return address
      .replace(/\([^)]+\)/g, '')
      .replace(/\s+제?(?:지하\s*)?\d+호\s*$/, '')
      .replace(/\s+제?(?:지하\s*)?\d+층(?:\s*제?\d+호)?\s*$/, '')
      .replace(/\s+[A-Za-z0-9가-힣]+동(?:\s+제?(?:지하\s*)?\d+층)?(?:\s*제?\d+호)?\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const searchKey = getSearchKey(addressForParsing);
  const naverUrl = "https://m.land.naver.com/search/result/" + encodeURIComponent(searchKey);

  const courtUrl = item.url || '';

  // ── Dify 텍스트 전처리 함수 ─────────────────────────────────
  function cleanDocText(raw, docType) {
    if (!raw || typeof raw !== 'string') return '정보 없음';
    let text = raw;
    // 1. 연속 구분선 제거
    text = text.replace(/[-─=*]{5,}/g, '');
    // 2. 3줄 이상 빈줄 → 1줄
    text = text.replace(/\n{3,}/g, '\n\n');
    // 3. Page : N 단독행 제거
    text = text.replace(/^\s*Page\s*:\s*\d+\s*$/gm, '');
    // 4. 감정평가서 면책고지문 제거
    text = text.replace(/이\s*(?:감정평가서|명세서|서류|사항)는\s+[^\n]{0,80}(?:사용할\s*수\s*없|목적\s*외)[^\n]*/g, '');
    // 5. 출력일시·고유번호·접수번호 단독행 제거
    text = text.replace(/^(?:출력일시|고유번호|접수번호|등기번호)\s*[:\：]\s*.+$/gm, '');
    // 6. 페이지 번호 단독행 제거
    text = text.replace(/^\s*-?\s*\d+\s*-?\s*$/gm, '');
    // 7. 우편번호 단독행 제거
    text = text.replace(/^\s*\[우\]\s*\d{5,6}\s*$/gm, '');
    // 8. 전화번호·FAX 단독행 제거
    text = text.replace(/^\s*(?:Tel\.?|전화|FAX|팩스)?\s*\d{2,4}[-\s]\d{3,4}[-\s]\d{4}\s*$/gm, '');
    if (docType === 'appraisal') {
      // 감정평가서: 사진용지 섹션 제거
      text = text.replace(/사\s*진\s*용\s*지[\s\S]{0,500}?(?=\n\n|$)/g, '');
      // 감정평가법인 주소/서명 단독행 제거
      text = text.replace(/^.*감정평가(?:법인|사무소).*$/gm, '');
      text = text.replace(/^대표이사\s*[:\：].*$/gm, '');
      // 구분건물 감정평가요항표 헤더행 제거
      text = text.replace(/^\s*\(\d+\)\s*위치 및 주위환경[^\n]*$/gm, '');
    }
    if (docType === 'status_survey') {
      // 현황조사서: 마이옥션 네비게이션 메뉴 텍스트 제거
      const navItems = ['close','인쇄','등기부\\(건물\\)','건축물대장','감정평가서','물건사진','현황조사서','매각물건명세서','문건접수내역','송달처리내역','부동산표시','전자지도','로드뷰','위성지도','지적도','네이버지도','씨:리얼지도','도시계획지도','네이버부동산'];
      const navRe = new RegExp('^(' + navItems.join('|') + ')\\s*$', 'gm');
      text = text.replace(navRe, '');
      text = text.replace(/본\s*정보는\s*참고용으로[^\n]*/g, '');
    }
    if (docType === 'registry') {
      text = text.replace(/^\s*이\s*기\s*재\s*사\s*항\s*$/gm, '[이기재사항]');
    }
    // 최종 연속 빈줄 정리
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim() || '정보 없음';
  }

  // ── Dify 권리분석용 텍스트 조립 (개별 분리) ─────────────────
  const docs = item.docs || {};
  const dify_inputs = {
    sale_spec: cleanDocText(docs.sale_spec, 'sale_spec'),
    status_survey: cleanDocText(docs.status_survey, 'status_survey'),
    appraisal: cleanDocText(docs.appraisal, 'appraisal'),
    building_ledger: cleanDocText(docs.building_ledger, 'building_ledger'),
    registry: cleanDocText(docs.registry, 'registry'),
    real_trade_history: docs.real_trade_history ? cleanDocText(docs.real_trade_history, 'real_trade_history') : '정보 없음'
  };

  return {
    json: {
      __parseFailed:  false,
      사건번호:       item.saNo,
      소재지:         addressForParsing,
      단지명:         complexName, // 추가: 국토부 실거래 매칭 및 캐싱용
      층:             floorName,
      동:             dongName,
      감정평가액:     item.appraisalAmt,
      최저매각가격:   item.minBidAmt,
      매각기일:       item.bidDate,
      유찰횟수:       lossCount,
      용도:           item.usage,
      면적:           area,
      법원:           (item.court === '창원지방법원' && /양산시/.test(addressForParsing)) ? '울산지방법원' : item.court, // 양산 = 울산지법 관할
      물건번호:       item.objNo,
      url:            courtUrl,
      naver_url:      naverUrl,
      dify_inputs:    dify_inputs,
      docs_available: {
        sale_spec:          !!(docs.sale_spec),
        status_survey:      !!(docs.status_survey),
        appraisal:          !!(docs.appraisal),
        building_ledger:    !!(docs.building_ledger),
        registry:           !!(docs.registry),
        real_trade_history: !!(docs.real_trade_history)
      },
      _raw: item
    }
  };
});