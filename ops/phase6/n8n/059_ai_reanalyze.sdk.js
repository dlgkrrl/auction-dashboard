import { workflow, node, trigger, expr } from "@n8n/workflow-sdk";

const start = trigger({ type: "n8n-nodes-base.scheduleTrigger", version: 1.2, config: { name: "10분마다",
  parameters: { rule: { interval: [{ field: "cronExpression", expression: "*/10 * * * *" }] } } } });

const fetchItems = node({ type: "n8n-nodes-base.httpRequest", version: 4.2, config: {
  name: "재분석 요청 조회",
  parameters: { method: "GET", url: "http://nocodb_app:8080/api/v1/db/data/noco/pwmyhpb0tu3b4m6/mfim9xo11ob6gp9",
    authentication: "predefinedCredentialType", nodeCredentialType: "nocoDbApiToken",
    sendQuery: true, queryParameters: { parameters: [
      { name: "where", value: "(ai_reanalyze_status,like,대기%)" },
      { name: "fields", value: "Id,case_no,ai_reanalyze_status,doc_spec_text,doc_survey_text,doc_appraisal_text,doc_registry_text,doc_ledger_text,real_trade_history" },
      { name: "limit", value: "3" } ] }, options: {} },
  credentials: { nocoDbApiToken: { id: "lh3tnFIzojQ5Uqea", name: "NocoDB account" } } } });

const pick = node({ type: "n8n-nodes-base.code", version: 2, config: { name: "대상 고르기", parameters: { jsCode: "// 059 · AI 재분석 대기 물건 → Dify 입력 (한 번에 3건, 10분마다)\n// 대시보드 [🤖 AI 권리분석 다시] 또는 058 서류 재수집 뒤 ai_reanalyze_status = '대기 · …'\nconst list = ($input.first().json.list) || [];\nconst doc = (v) => (v && String(v).trim() ? String(v) : '정보 없음');\nreturn list\n  .filter((it) => /^대기/.test(String(it.ai_reanalyze_status || '')))\n  .slice(0, 3)\n  .map((it) => ({\n    json: {\n      Id: it.Id,\n      case_no: it.case_no || '',\n      inputs: {\n        doc_spec_text: doc(it.doc_spec_text),\n        doc_survey_text: doc(it.doc_survey_text),\n        doc_appraisal_text: doc(it.doc_appraisal_text),\n        doc_ledger_text: doc(it.doc_ledger_text),\n        doc_registry_text: doc(it.doc_registry_text),\n        real_trade_history: doc(it.real_trade_history),\n      },\n    },\n  }));\n" } } });

const dify = node({ type: "n8n-nodes-base.httpRequest", version: 4.2, config: {
  name: "Dify 재분석",
  onError: "continueRegularOutput",
  parameters: { method: "POST", url: "http://dify_api:5001/v1/chat-messages",
    authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth",
    sendBody: true, specifyBody: "json",
    jsonBody: expr("{{ JSON.stringify({ inputs: $json.inputs, query: '사건번호 ' + $json.case_no + '의 권리분석을 시작해', response_mode: 'blocking', user: 'auction-bot' }) }}"),
    options: { timeout: 180000 } },
  credentials: { httpHeaderAuth: { id: "dcwG43puGTbHStOO", name: "Dify - 경매 권리분석" } } } });

const parse = node({ type: "n8n-nodes-base.code", version: 2, config: { name: "결과 파싱", parameters: { jsCode: "// 059 · Dify 응답 → 물건 PATCH 행 (010 'Dify 결과 파싱'과 같은 규칙, 권리분석 칸만 바꿈)\n// 입력: 'Dify 재분석' HTTP 응답(항목마다), 짝이 되는 '대상 고르기' 항목(같은 순서)\nconst targets = $('대상 고르기').all().map((x) => x.json);\nconst stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');\nconst DANGER_KW = ['유치권', '대항력', '법정지상권', '인수', '가처분', '위반건축', '공유'];\nconst CAUTION_KW = ['임차인', '전세', '점유', '분쟁', '선순위'];\nconst safeNum = (v) => {\n  if (v === undefined || v === null || v === '') return -1;\n  const n = Number(String(v).replace(/[^0-9.]/g, ''));\n  return isNaN(n) ? -1 : n;\n};\n\nconst rows = [];\n$input.all().forEach((res, i) => {\n  const t = targets[i];\n  if (!t) return;\n  const j = res.json || {};\n  if (j.error || (!j.answer && !j.text && !j.body)) {\n    const msg = String((j.error && (j.error.message || j.error)) || '응답 없음').slice(0, 120);\n    rows.push({ Id: t.Id, ai_reanalyze_status: `실패 · ${stamp} · Dify 오류: ${msg}` });\n    return;\n  }\n  let raw = j.answer || j.text || j.body || '';\n  if (typeof raw === 'string' && raw.includes('data:')) {\n    let gathered = '';\n    for (const line of raw.split('\\n')) {\n      const tr = line.trim();\n      if (!tr.startsWith('data:')) continue;\n      try { const p = JSON.parse(tr.replace(/^data:\\s*/, '')); if (p.answer) gathered += p.answer; } catch (_) { /* message_end 등 */ }\n    }\n    if (gathered) raw = gathered;\n  }\n  const cleaned = String(raw).replace(/```json\\s*/gi, '').replace(/```\\s*/g, '').trim();\n  let ai, parseOk = false;\n  try { ai = JSON.parse(cleaned); parseOk = true; } catch (_) {\n    const fd = DANGER_KW.filter((k) => cleaned.includes(k));\n    const fc = CAUTION_KW.filter((k) => cleaned.includes(k));\n    ai = fd.length ? { risk: '위험', summary: `위험요소: ${fd.join(', ')}`, recommend: '입찰비권고', flags: fd }\n      : fc.length ? { risk: '주의', summary: `주의사항: ${fc.join(', ')}`, recommend: '검토필요', flags: fc }\n      : { risk: '안전', summary: 'AI 파싱 실패 — 직접 확인 필요', recommend: '수동확인필요', flags: [] };\n  }\n  const flags = JSON.stringify(ai.pdf_risk_flags || []);\n  rows.push({\n    Id: t.Id,\n    ai_risk: ai.risk || '분석실패',\n    ai_summary: ai.summary || '',\n    ai_recommend: ai.recommend || '수동확인필요',\n    ai_flags: (ai.flags || []).join(', '),\n    tenant_deposit_total: safeNum(ai.tenant_deposit_total),\n    senior_lien_total: safeNum(ai.senior_lien_total),\n    cancellation_standard: ai.cancellation_standard || '',\n    inherited_amount: safeNum(ai.inherited_amount),\n    tenant_count: safeNum(ai.tenant_count),\n    pdf_risk_flags: flags,\n    docs_risk_flags: flags,\n    parsing_status: parseOk ? 'ok' : 'partial',\n    ai_reanalyze_status: `완료 · ${stamp} · ${ai.risk || '분석실패'}${parseOk ? '' : ' (JSON 아님, 키워드로 판단)'}`,\n  });\n});\nreturn [{ json: { rows } }];\n" } } });

const save = node({ type: "n8n-nodes-base.httpRequest", version: 4.2, config: {
  name: "분석 저장",
  parameters: { method: "PATCH", url: "http://nocodb_app:8080/api/v1/db/data/bulk/noco/pwmyhpb0tu3b4m6/mfim9xo11ob6gp9",
    authentication: "predefinedCredentialType", nodeCredentialType: "nocoDbApiToken",
    sendBody: true, specifyBody: "json", jsonBody: expr("{{ JSON.stringify($json.rows) }}"), options: {} },
  credentials: { nocoDbApiToken: { id: "lh3tnFIzojQ5Uqea", name: "NocoDB account" } } } });

export default workflow("auction-phase6-ai-reanalyze", "059.[POLL] 경매 AI 권리분석 재요청 (대시보드, 10분마다)")
  .add(start).to(fetchItems).to(pick).to(dify).to(parse).to(save);
