const cfg = $('검색 설정').first().json;

// YYYY.MM.DD 포맷의 시작일/종료일 (KST 기준)
const today = new Date(new Date().getTime() + (9 * 60 * 60 * 1000));
const fmt = d => d.toISOString().slice(0,10).replace(/-/g, '.');
const start = fmt(today);
const end = new Date(today);
end.setDate(end.getDate() + 90);

const sclMap = {
  '000080201': '아파트',
  '000080202': '단독주택',
  '000080203': '다가구주택',
  '000080204': '연립주택',
  '000080205': '다세대주택',
  '000080206': '기숙사',
  '000080207': '빌라',
  '000080208': '상가주택',
  '000080209': '오피스텔',
  '000080210': '주상복합'
};

const usageLcl = cfg.usageLcl || '건물';
const usageMcl = cfg.usageMcl || '주거용건물';
const usageScl = (cfg.usageScl !== undefined && cfg.usageScl !== null) ? cfg.usageScl : (sclMap[cfg.mclDspslGdsLstUsgCd] || '');

return [{
  json: {
    sdCd: cfg.rprsAdongSdCd || "48",
    sggCd: cfg.rprsAdongSggCd !== undefined ? cfg.rprsAdongSggCd : "250",
    cortOfcCd: "B000210", 
    termStartDt: start,
    termEndDt: fmt(end),
    usageLcl: usageLcl,
    usageMcl: usageMcl,
    usageScl: usageScl,
    lwsDspslPrcMax: cfg.lwsDspslPrcMax,
    maxItems: cfg.maxItems || 30
  }
}];