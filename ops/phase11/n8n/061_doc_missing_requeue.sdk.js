import { workflow, node, trigger, expr } from "@n8n/workflow-sdk";

const start = trigger({ type: "n8n-nodes-base.scheduleTrigger", version: 1.2, config: { name: "매일 02:05",
  parameters: { rule: { interval: [{ field: "cronExpression", expression: "5 2 * * *" }] } } } });

const fetchItems = node({ type: "n8n-nodes-base.httpRequest", version: 4.2, config: {
  name: "매각 전 물건 조회",
  parameters: { method: "GET", url: "http://nocodb_app:8080/api/v1/db/data/noco/pwmyhpb0tu3b4m6/mfim9xo11ob6gp9",
    authentication: "predefinedCredentialType", nodeCredentialType: "nocoDbApiToken",
    sendQuery: true, queryParameters: { parameters: [
      { name: "where", value: "(bid_date,gte,today)" },
      { name: "fields", value: "Id,CreatedAt,court_url,bid_date,refetch_status,doc_spec_text,doc_appraisal_text,doc_registry_text,doc_ledger_text" },
      { name: "limit", value: "1000" } ] }, options: {} },
  credentials: { nocoDbApiToken: { id: "lh3tnFIzojQ5Uqea", name: "NocoDB account" } } } });

const pick = node({ type: "n8n-nodes-base.code", version: 2, config: { name: "빠진 서류 고르기", parameters: { jsCode: "// 061 · 서류 빠진 물건 자동 재요청 (매일 02:05, 058(02:15) 바로 앞)\n// 신건은 처음 올라올 때 감정평가서·매각물건명세서·등기부가 아직 없을 수 있음 → 매각일 전까지 매일 058 대기로 올림\nconst list = ($input.first().json.list) || [];\nconst stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');\nconst today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);\nconst MAX = 10;   // 058 한 번에 10건\nconst since = new Date(Date.now() - 14 * 864e5).toISOString();   // 최근 14일 안에 들어온 물건만 (오래된 물건은 서류가 끝내 없는 경우가 많음)\nconst blank = (v) => !v || !String(v).trim() || String(v).trim() === '정보 없음';\n// 래퍼 메뉴 글자만 들어간 가짜 서류(11-24 이전 크롤러)\nconst menuOnly = (v) => { const t = String(v || ''); return t.length < 800 && /본\\s*정보는\\s*참고용으로/.test(t) && /\\nclose\\n/.test(t); };\nconst bad = (v) => blank(v) || menuOnly(v);\nconst LABEL = { doc_appraisal_text: '감정평가', doc_spec_text: '명세서', doc_registry_text: '등기부', doc_ledger_text: '건축물대장' };\n\nconst busy = list.filter((it) => /^(대기|수집중)/.test(String(it.refetch_status || ''))).length;\nconst room = Math.max(0, MAX - busy);\nconst cands = [];\nfor (const it of list) {\n  if (/^(대기|수집중)/.test(String(it.refetch_status || ''))) continue;\n  if (!it.bid_date || String(it.bid_date).slice(0, 10) < today) continue;\n  if (String(it.CreatedAt || it.created_at || '') < since) continue;\n  if (!/\\/view\\/\\d+/.test(String(it.court_url || ''))) continue;\n  const miss = Object.keys(LABEL).filter((f) => bad(it[f])).map((f) => LABEL[f]);\n  if (miss.length) cands.push({ it, miss });\n}\ncands.sort((a, b) => String(a.it.bid_date).localeCompare(String(b.it.bid_date)));\nconst marks = cands.slice(0, room).map(({ it, miss }) => ({ Id: it.Id, refetch_status: `대기 · ${stamp} 자동(빠진 서류: ${miss.join(', ')})` }));\nif (!marks.length) return [];\nreturn [{ json: { marks, total: cands.length } }];\n" } } });

const markPatch = node({ type: "n8n-nodes-base.httpRequest", version: 4.2, config: {
  name: "재수집 대기 표시",
  parameters: { method: "PATCH", url: "http://nocodb_app:8080/api/v1/db/data/bulk/noco/pwmyhpb0tu3b4m6/mfim9xo11ob6gp9",
    authentication: "predefinedCredentialType", nodeCredentialType: "nocoDbApiToken",
    sendBody: true, specifyBody: "json", jsonBody: expr("{{ JSON.stringify($json.marks) }}"), options: {} },
  credentials: { nocoDbApiToken: { id: "lh3tnFIzojQ5Uqea", name: "NocoDB account" } } } });

export default workflow("auction-phase11-doc-missing-requeue", "061.[DAILY] 서류 빠진 신건 자동 재수집 요청 (02:05)")
  .add(start).to(fetchItems).to(pick).to(markPatch);
