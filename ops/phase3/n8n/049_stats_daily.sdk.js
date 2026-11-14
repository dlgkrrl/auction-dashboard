import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const cred = { nocoDbApiToken: { id: 'lh3tnFIzojQ5Uqea', name: 'NocoDB account' } };
const daily = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.2, config: { name: '매일 05:00', parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 5 * * *' }] } } } });
const manual = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: '수동 실행' } });

const fetchResults = node({ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: {
  name: '결과 조회',
  parameters: { method: 'GET', url: 'http://nocodb_app:8080/api/v1/db/data/noco/pwmyhpb0tu3b4m6/mprok558sdzbp7k',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'nocoDbApiToken',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'fields', value: 'Id,court,sgg,emd,complex_name,result_type,loss_count,actual_bid_rate,min_price_rate,bidder_count,bid_date,is_share,is_bulk,is_outlier,loss_count_suspect' },
      { name: 'limit', value: '1000' } ] },
    options: { pagination: { pagination: {
      paginationMode: 'updateAParameterInEachRequest',
      parameters: { parameters: [{ type: 'qs', name: 'offset', value: '={{ $pageCount * 1000 }}' }] },
      paginationCompleteWhen: 'other', completeExpression: '={{ $response.body.pageInfo.isLastPage }}',
      limitPagesFetched: true, maxRequests: 30 } } } },
  credentials: cred } });

const compute = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: '통계 계산', parameters: { jsCode: "// 049 · 결과 테이블 → 통계 (단계, 범위, 유찰 구간) 1행\n// 입력: '결과 조회'(페이지별 { list }) / 출력: 100행씩 { rows, run_id, summary }\n// 제외: is_outlier·is_share·is_bulk·loss_count_suspect, 최근 24개월 밖\nconst pages = $input.all().map((i) => i.json);\nconst all = pages.flatMap((p) => p.list || []);\nconst isTrue = (v) => v === true || v === 1 || v === '1' || v === 'true';\nconst kst = new Date(Date.now() + 9 * 3600e3);\nconst today = kst.toISOString().slice(0, 10);\nconst from = new Date(kst.getTime() - 730 * 86400e3).toISOString().slice(0, 10);\nconst runId = kst.toISOString().slice(0, 16).replace(/[-:T]/g, '');\nconst d10 = (v) => String(v || '').replace(/\\./g, '-').slice(0, 10);\n\nconst rows = all.filter((r) => !isTrue(r.is_outlier) && !isTrue(r.is_share) && !isTrue(r.is_bulk) && !isTrue(r.loss_count_suspect)\n  && (r.result_type === '매각' || r.result_type === '유찰') && d10(r.bid_date) >= from && d10(r.bid_date) <= today);\n\nconst binOf = (n) => Math.min(Math.max(Number(n) || 0, 0), 4);   // 4 = 4회 이상\nconst clean = (s) => String(s || '').trim();\n// 단계별 범위 키\nfunction scopes(r) {\n  const court = clean(r.court), sgg = clean(r.sgg), emd = clean(r.emd), cx = clean(r.complex_name);\n  const out = [{ level: '전체', scope: '전체', court: '', sgg: '', emd: '', complex_name: '' }];\n  if (court) out.push({ level: '법원', scope: court, court, sgg: '', emd: '', complex_name: '' });\n  if (sgg) out.push({ level: '시군구', scope: sgg, court, sgg, emd: '', complex_name: '' });\n  if (sgg && emd) out.push({ level: '읍면동', scope: `${sgg} ${emd}`, court, sgg, emd, complex_name: '' });\n  // 단지: 이름이 '3층301호'·'외 1필지'처럼 단지명이 아닌 값은 제외\n  if (sgg && cx && cx.length >= 2 && !/^\\d|^제?\\d+층|필지|^[가-힣]?동$|^\\d+호$/.test(cx)) {\n    out.push({ level: '단지', scope: `${sgg} ${cx}`, court, sgg, emd, complex_name: cx });\n  }\n  return out;\n}\n\nconst groups = new Map();\nfor (const r of rows) {\n  const bin = binOf(r.loss_count);\n  for (const s of scopes(r)) {\n    const key = `${s.level}|${s.scope}|${bin}`;\n    if (!groups.has(key)) groups.set(key, { ...s, loss_bin: bin, rates: [], mins: [], over: [], bidders: [], fail: 0, dates: [] });\n    const g = groups.get(key);\n    g.dates.push(d10(r.bid_date));\n    if (r.result_type === '유찰') { g.fail++; continue; }\n    const rate = Number(r.actual_bid_rate);\n    if (!(rate > 0)) continue;\n    g.rates.push(rate);\n    const mr = Number(r.min_price_rate);\n    if (mr > 0) { g.mins.push(mr); g.over.push(rate / mr); }\n    const b = Number(r.bidder_count);\n    if (b > 0) g.bidders.push(b);\n  }\n}\n\nconst q = (arr, p) => {   // 선형 보간 분위수\n  if (!arr.length) return null;\n  const v = [...arr].sort((a, b) => a - b);\n  const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);\n  return v[lo] + (v[hi] - v[lo]) * (i - lo);\n};\nconst r1 = (x, k = 1) => (x == null ? null : Math.round(x * 10 ** k) / 10 ** k);\nconst computedAt = new Date().toISOString();\nconst out = [];\nfor (const g of groups.values()) {\n  const n = g.rates.length;\n  if (n === 0 && g.fail === 0) continue;\n  g.dates.sort();\n  out.push({\n    level: g.level, scope: g.scope, court: g.court, sgg: g.sgg, emd: g.emd, complex_name: g.complex_name, loss_bin: g.loss_bin,\n    n_sold: n, n_fail: g.fail, sale_ratio: r1(n / (n + g.fail) * 100),\n    rate_median: r1(q(g.rates, 0.5)), rate_q1: r1(q(g.rates, 0.25)), rate_q3: r1(q(g.rates, 0.75)),\n    min_rate_median: r1(q(g.mins, 0.5)), over_min_median: r1(q(g.over, 0.5), 2),\n    bidders_avg: g.bidders.length ? r1(g.bidders.reduce((a, b) => a + b, 0) / g.bidders.length) : null,\n    period_from: g.dates[0], period_to: g.dates[g.dates.length - 1], run_id: runId, computed_at: computedAt,\n  });\n}\nconst summary = { run_id: runId, results: all.length, used: rows.length, stats_rows: out.length,\n  by_level: out.reduce((m, r) => ((m[r.level] = (m[r.level] || 0) + 1), m), {}) };\nconst chunks = [];\nfor (let i = 0; i < out.length; i += 100) chunks.push({ json: { rows: out.slice(i, i + 100), run_id: runId, summary } });\nreturn chunks.length ? chunks : [{ json: { rows: [], run_id: runId, summary } }];\n" } } });

const hasRows = node({ type: 'n8n-nodes-base.if', version: 2.2, config: { name: '넣을 행 있음', parameters: {
  conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    conditions: [{ leftValue: '={{ ($json.rows || []).length > 0 }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and' }, options: {} } } });

const insert = node({ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: {
  name: '통계 입력',
  parameters: { method: 'POST', url: 'http://nocodb_app:8080/api/v1/db/data/bulk/noco/pwmyhpb0tu3b4m6/mmzvy0moer7p7hq',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'nocoDbApiToken',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.rows) }}', options: {} },
  credentials: cred } });

const delOld = node({ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: {
  name: '이전 계산분 삭제', executeOnce: true,
  parameters: { method: 'DELETE', url: 'http://nocodb_app:8080/api/v1/db/data/bulk/noco/pwmyhpb0tu3b4m6/mmzvy0moer7p7hq/all',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'nocoDbApiToken',
    sendQuery: true, queryParameters: { parameters: [{ name: 'where', value: "={{ '(run_id,neq,' + $('통계 계산').first().json.run_id + ')' }}" }] }, options: {} },
  credentials: cred } });

export default workflow('auction-phase3-stats-daily', '049.[DAILY] 경매 낙찰 통계 집계 (05:00)')
  .add(daily).to(fetchResults).to(compute).to(hasRows.onTrue(insert.to(delOld)))
  .add(manual).to(fetchResults);
