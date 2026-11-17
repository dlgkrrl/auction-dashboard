// ─────────────────────────────────────────────────────
// API 로그인 (functions/_middleware.js) — 401이면 비밀번호를 받아 세션 쿠키를 만든 뒤 한 번 재시도
// ─────────────────────────────────────────────────────
let loginPromise = null;

function askLogin(message) {
  if (loginPromise) return loginPromise;
  loginPromise = new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.6);display:flex;align-items:center;justify-content:center;padding:16px';
    wrap.innerHTML = `
      <form style="background:#fff;color:#111827;border-radius:14px;padding:22px;width:100%;max-width:340px;box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:inherit">
        <div style="font-size:var(--fs-lg);font-weight:800;margin-bottom:6px">🔒 대시보드 로그인</div>
        <div class="login-msg" style="font-size:var(--fs-md);color:#6b7280;margin-bottom:14px"></div>
        <input type="password" autocomplete="current-password" placeholder="비밀번호" required
          style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:var(--fs-lg)">
        <button type="submit" style="margin-top:12px;width:100%;padding:11px;border:0;border-radius:8px;background:#7c3aed;color:#fff;font-weight:700;font-size:var(--fs-lg);cursor:pointer">로그인</button>
      </form>`;
    const form = wrap.querySelector('form');
    const msg = wrap.querySelector('.login-msg');
    const input = wrap.querySelector('input');
    msg.textContent = message || '데이터를 보려면 비밀번호를 입력하세요.';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: input.value }),
        });
        if (res.ok) {
          wrap.remove();
          loginPromise = null;
          resolve(true);
          return;
        }
        msg.textContent = res.status === 503
          ? '서버 인증 설정(DASHBOARD_PASSWORD/SECRET)이 없습니다.'
          : '비밀번호가 맞지 않습니다.';
      } catch (err) {
        msg.textContent = '로그인 요청 실패: ' + err.message;
      }
      btn.disabled = false;
      input.select();
    });
    document.body.appendChild(wrap);
    input.focus();
  });
  return loginPromise;
}

async function apiFetch(url, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  let res = await fetch(url, opts);
  if (res.status === 401) {
    await askLogin();
    res = await fetch(url, opts);
    if (res.status === 401) {
      // 로그인은 됐는데 세션 쿠키가 통과하지 못함 → 원인 진단 결과를 화면에 표시
      try {
        const diag = await (await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })).json();
        console.warn('[auth] 로그인 후에도 401', diag);
        alert('로그인 후에도 401입니다. 이 내용을 알려주세요:\n' + JSON.stringify(diag, null, 2));
      } catch (e) { /* 진단 실패는 무시 */ }
    }
  }
  return res;
}
