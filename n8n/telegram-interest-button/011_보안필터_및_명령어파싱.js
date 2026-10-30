const update = $input.first().json;

// ── 인라인 버튼 콜백 (신규 물건 알림의 [⭐ 관심물건 추가] 버튼) ──
if (update.callback_query) {
  const cq = update.callback_query;
  const cqChatId = String(cq.message?.chat?.id || '');
  const cqUserId = String(cq.from?.id || '');
  if (!['6449313439'].includes(cqChatId)) {
    return [{ json: { command: 'UNAUTHORIZED', chat_id: cqChatId } }];
  }
  const m = String(cq.data || '').match(/^fav:([0-9가-힣()\-]{4,40})$/);
  if (!m) {
    return [{ json: { command: 'UNKNOWN', command_group_1: 'NONE', command_group_2: 'NONE', chat_id: cqChatId, callback_query_id: cq.id } }];
  }
  return [{
    json: {
      command: 'ADD_INTEREST',
      command_group_1: 'SINGLE_ITEM',
      command_group_2: 'ADD_INTEREST',
      case_no: m[1],
      memo_text: null,
      interest_level: null,
      chat_id: cqChatId,
      user_id: cqUserId,
      raw_text: cq.data,
      callback_query_id: cq.id
    }
  }];
}

const msg = update.message;
const rawText = (msg?.text || '').trim();
const chatId = String(msg?.chat?.id || '');
const userId = String(msg?.from?.id || '');

const ALLOWED_CHAT_IDS = [
  '6449313439'
];

if (!ALLOWED_CHAT_IDS.includes(chatId)) {
  return [{ json: { command: 'UNAUTHORIZED', chat_id: chatId } }];
}

const sanitized = rawText
  .replace(/[<>'"`;\\]/g, '')
  .replace(/\s+/g, ' ')
  .slice(0, 200)
  .trim();

function validateCaseNo(caseNo) {
  if (!caseNo) return false;
  const cleaned = caseNo.replace(/\s/g, '');
  return /^\d{4}[가-힣]{2,4}\d{3,6}$/.test(cleaned);
}

function validateLevel(levelStr) {
  const n = parseInt(levelStr, 10);
  return (!isNaN(n) && n >= 1 && n <= 3) ? n : null;
}

const patterns = [
  { regex: /^\/관심\s+(\S+)$/, command: 'ADD_INTEREST' },
  { regex: /^\/해제\s+(\S+)$/, command: 'REMOVE_INTEREST' },
  { regex: /^\/관심목록$/, command: 'LIST_INTEREST' },
  { regex: /^\/메모\s+(\S+)\s+(.{1,100})$/, command: 'ADD_MEMO' },
  { regex: /^\/물건\s+(\S+)$/, command: 'GET_DETAIL' },
  { regex: /^\/관심도\s+(\S+)\s+([1-3])$/, command: 'SET_LEVEL' },
  { regex: /^\/파싱오류목록$/, command: 'LIST_PARSE_FAIL' },
  { regex: /^\/입찰가\s+(\S+)$/, command: 'GET_BID_PRICE' },
  { regex: /^\/pdf상태\s+(\S+)$/, command: 'GET_PDF_STATUS' },
  { regex: /^\/낙찰통계\s+(\S+)$/, command: 'GET_STATS' },
  { regex: /^\/갭분석\s+(\S+)$/, command: 'GET_GAP_ANALYSIS' },
  { regex: /^\/도움$/, command: 'HELP' }
];

for (const p of patterns) {
  const m = sanitized.match(p.regex);
  if (!m) continue;

  const caseNoRaw = m[1] || null;
  const caseNoRequired = ['ADD_INTEREST', 'REMOVE_INTEREST', 'ADD_MEMO', 'GET_DETAIL', 'SET_LEVEL', 'GET_BID_PRICE', 'GET_PDF_STATUS', 'GET_GAP_ANALYSIS'];
  if (caseNoRequired.includes(p.command) && caseNoRaw) {
    if (!validateCaseNo(caseNoRaw)) {
      return [{
        json: {
          command: 'INVALID_CASE_NO',
          chat_id: chatId,
          raw_input: caseNoRaw,
          message: `❌ 사건번호 형식이 올바르지 않습니다.\n입력값: \`${caseNoRaw}\`\n예) \`2024타경15821\``
        }
      }];
    }
  }

  let interestLevel = null;
  if (p.command === 'SET_LEVEL') {
    interestLevel = validateLevel(m[2]);
    if (!interestLevel) {
      return [{
        json: {
          command: 'INVALID_LEVEL',
          chat_id: chatId,
          message: '❌ 관심도는 1~3 사이 숫자여야 합니다.\n예) /관심도 2024타경15821 3'
        }
      }];
    }
  }

  let memoText = null;
  if (p.command === 'ADD_MEMO') {
    memoText = (m[2] || '').slice(0, 100);
  }

  const cmd = p.command;
  let commandGroup1 = '';
  if (['ADD_INTEREST', 'REMOVE_INTEREST', 'ADD_MEMO', 'GET_DETAIL', 'SET_LEVEL', 'GET_BID_PRICE', 'GET_PDF_STATUS'].includes(cmd)) {
    commandGroup1 = 'SINGLE_ITEM';
  } else if (['GET_STATS', 'GET_GAP_ANALYSIS', 'HELP'].includes(cmd)) {
    commandGroup1 = 'STATS_OR_GAP_OR_HELP';
  } else {
    commandGroup1 = cmd;
  }

  let commandGroup2 = '';
  if (['GET_DETAIL', 'SET_LEVEL', 'GET_BID_PRICE', 'GET_PDF_STATUS'].includes(cmd)) {
    commandGroup2 = 'NEXT';
  } else {
    commandGroup2 = cmd;
  }

  return [{
    json: {
      command: p.command,
      command_group_1: commandGroup1,
      command_group_2: commandGroup2,
      case_no: caseNoRaw,
      memo_text: memoText,
      interest_level: interestLevel,
      chat_id: chatId,
      user_id: userId,
      raw_text: sanitized
    }
  }];
}

return [{ json: { command: 'UNKNOWN', command_group_1: 'HELP', command_group_2: 'UNKNOWN', chat_id: chatId, raw_text: sanitized } }];
