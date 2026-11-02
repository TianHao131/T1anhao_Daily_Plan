(function() {
  'use strict';
  const $ = id => document.getElementById(id);
  const site = window.ACCOUNT_SITE;
  const config = window.NAV_CLOUD_CONFIG;
  const query = new URLSearchParams(location.search), hash = new URLSearchParams(location.hash.slice(1));
  const incomingRecovery = hash.get('type') === 'recovery';
  const linkError = hash.has('error') || hash.has('error_code') || query.has('error') || query.has('error_code');
  const mode = query.get('mode') || 'change';
  const recoveryKey = 'password-recovery:' + (site?.storageKey || 'navigation');
  let client, user = null, recoveryConfirmed = false, recovery = false, busy = false, completed = false, checkEpoch = 0;
  function message(text, kind = '') { $('account-message').textContent = text; $('account-message').dataset.kind = kind; }
  function hideForms() {
    for (const id of ['account-login-needed', 'account-request-section', 'account-change-section', 'account-complete', 'account-retry']) $(id).hidden = true;
  }
  function clearSecrets() {
    for (const id of ['account-current', 'account-new', 'account-confirm', 'account-nonce']) $(id).value = '';
  }
  function clearMarker() { try { sessionStorage.removeItem(recoveryKey); } catch {} }
  function rememberRecovery(session) {
    if (!session?.user?.id) return;
    recoveryConfirmed = true;
    try { sessionStorage.setItem(recoveryKey, session.user.id); } catch {}
    // Remove credentials from the visible URL once the SDK has consumed them.
    history.replaceState(null, '', location.pathname + '?mode=reset');
  }
  function showRequest(text = '') {
    hideForms(); $('account-request-section').hidden = false;
    $('account-title').textContent = '找回密码';
    message(text);
  }
  function setBusy(value) {
    busy = value;
    document.querySelectorAll('form button').forEach(button => button.disabled = value);
  }
  function options(storageKey, temporary = false) {
    const auth = {persistSession: !temporary, autoRefreshToken: !temporary, detectSessionInUrl: !temporary};
    if (storageKey) auth.storageKey = storageKey;
    return {auth, global: {fetch: async (url, init = {}) => {
      const controller = new AbortController(), abort = () => controller.abort();
      if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, {once: true});
      const timer = setTimeout(abort, 12000);
      try { return await fetch(url, {...init, signal: controller.signal}); }
      finally { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
    }}};
  }
  function friendly(error) {
    if (error?.code === 'same_password') return '新密码不能与原密码相同。';
    if (error?.code === 'weak_password') return '新密码不符合账号的密码要求，请换一个更长的密码。';
    if (error?.status === 429 || /rate_limit/.test(error?.code || '')) return '操作过于频繁，请稍后再试。';
    if (['session_not_found', 'refresh_token_not_found', 'bad_jwt', 'user_not_found'].includes(error?.code)) return '登录或验证已失效，请重新登录或申请重置邮件。';
    if (error?.code === 'reauthentication_not_valid') return '邮箱验证码不正确或已过期，请重新申请重置邮件。';
    return '操作未完成，请检查网络后重试。';
  }
  async function inspect() {
    if (busy || completed || !client) return;
    const epoch = ++checkEpoch;
    hideForms(); message('正在检查登录状态…');
    try {
      const initialized = await client.auth.initialize();
      if (epoch !== checkEpoch) return;
      if (linkError || (initialized.error && (incomingRecovery || mode === 'reset'))) {
        clearMarker(); recovery = false;
        history.replaceState(null, '', location.pathname + '?mode=forgot');
        showRequest('验证链接无法使用或已过期，请重新申请重置邮件。'); return;
      }
      if (mode === 'forgot' && !incomingRecovery && !recoveryConfirmed) { showRequest(); return; }
      if (initialized.error) {
        $('account-login-needed').hidden = false; $('account-retry').hidden = false;
        message('登录状态检查未完成，请返回网站登录，或检查网络后重试。', 'error'); return;
      }
      if (incomingRecovery && !recoveryConfirmed) {
        clearMarker(); showRequest('未能确认重置链接，请重新申请邮件并打开最新链接。'); return;
      }
      const result = await client.auth.getUser();
      if (epoch !== checkEpoch) return;
      if (result.error || !result.data?.user) {
        user = null; clearMarker(); hideForms();
        if (incomingRecovery || mode === 'reset') showRequest('重置验证已失效，请重新申请邮件。');
        else {
          $('account-login-needed').hidden = false; $('account-retry').hidden = false;
          message(result.error && (!result.error.status || result.error.status >= 500) ? '无法检查登录状态，请检查连接后重试。' : '当前未登录。');
        }
        return;
      }
      user = result.data.user;
      let marker = null; try { marker = sessionStorage.getItem(recoveryKey); } catch {}
      recovery = recoveryConfirmed || (mode === 'reset' && marker === user.id);
      if (mode === 'reset' && !recovery) { showRequest('请先从重置邮件中打开有效链接。'); return; }
      hideForms(); $('account-change-section').hidden = false;
      $('account-title').textContent = recovery ? '设置新密码' : '修改密码';
      $('account-change-title').textContent = recovery ? '邮箱验证已完成' : '修改密码';
      $('account-user').textContent = user.email || '已验证的账号';
      $('account-current-wrap').hidden = recovery; $('account-current').required = !recovery;
      message(recovery ? '请设置新密码，两个网站将共用这个密码。' : '先验证当前密码，再保存新密码。');
    } catch { message('无法检查登录状态，请检查网络后重试。', 'error'); $('account-retry').hidden = false; }
  }
  $('account-request-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !client || !$('account-request-form').reportValidity()) return;
    setBusy(true); message('正在申请重置邮件…');
    try {
      const redirectTo = new URL('account.html', location.href).href;
      const {error} = await client.auth.resetPasswordForEmail($('account-email').value.trim(), {redirectTo});
      if (error) { message(friendly(error), 'error'); return; }
      message('如果该邮箱已注册，会收到重置邮件。请查看收件箱或垃圾邮件，打开最新邮件中的链接设置新密码。', 'success');
    } catch { message('邮件申请未完成，请检查网络后重试。', 'error'); }
    finally { setBusy(false); }
  });
  $('account-change-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || completed || !client || !user || !$('account-change-form').reportValidity()) return;
    const next = $('account-new').value, previous = $('account-current').value;
    if (next.length < 8) { message('新密码至少需要 8 个字符。', 'error'); return; }
    if (next !== $('account-confirm').value) { message('两次输入的新密码不一致。', 'error'); return; }
    if (!recovery && !previous) { message('请输入当前密码。', 'error'); return; }
    if (!recovery && next === previous) { message('新密码不能与当前密码相同。', 'error'); return; }
    const expectedUserId = user.id;
    setBusy(true); message(recovery ? '正在设置新密码…' : '正在验证当前密码…');
    let verifier = null, changed = false;
    try {
      const checked = await client.auth.getUser();
      if (checked.error || checked.data?.user?.id !== expectedUserId) {
        message('当前账号或验证已发生变化，请重新登录后再试。', 'error'); return;
      }
      let auth, verifiedSession = null;
      verifier = window.supabase.createClient(config.url, config.publishableKey,
        options('password-check-' + Date.now() + '-' + Math.random().toString(36).slice(2), true));
      if (!recovery) {
        // A non-persistent client verifies the old password without replacing
        // either website's saved session when the verification fails.
        const result = await verifier.auth.signInWithPassword({email: checked.data.user.email, password: previous});
        if (result.error) {
          message(result.error.code === 'invalid_credentials' ? '当前密码不正确，请重新输入。' : friendly(result.error), 'error'); return;
        }
        if (result.data?.user?.id !== expectedUserId || !result.data.session) {
          message('账号验证未通过，请重新登录后再试。', 'error'); return;
        }
        auth = verifier.auth; verifiedSession = result.data.session;
      } else {
        // Freeze the verified recovery session, so another tab changing accounts
        // cannot redirect this in-flight password update to a different user.
        const active = await client.auth.getSession();
        if (active.error || active.data?.session?.user?.id !== expectedUserId) {
          message('重置验证已变化，请重新打开邮件中的有效链接。', 'error'); return;
        }
        const copied = await verifier.auth.setSession({access_token: active.data.session.access_token,
          refresh_token: active.data.session.refresh_token});
        if (copied.error || copied.data?.user?.id !== expectedUserId || !copied.data.session) {
          message('重置验证未通过，请重新申请邮件。', 'error'); return;
        }
        auth = verifier.auth; verifiedSession = copied.data.session;
      }
      message('正在保存新密码…');
      const attributes = {password: next};
      if (!recovery) attributes.current_password = previous;
      if (recovery && $('account-nonce').value.trim()) attributes.nonce = $('account-nonce').value.trim();
      const {error} = await auth.updateUser(attributes);
      if (error) {
        if (error.code === 'reauthentication_needed' && recovery) {
          const verification = await auth.reauthenticate();
          if (verification.error) { message(friendly(verification.error), 'error'); return; }
          $('account-nonce-wrap').hidden = false; $('account-nonce').required = true;
          message('账号需要再次验证。请填写邮箱验证码，并重新输入新密码后提交。'); return;
        }
        message(friendly(error), 'error'); return;
      }
      changed = true; completed = true; checkEpoch++; clearMarker();
      // Keep the newly verified session for the current site only. Do not log
      // out the temporary client after copying its session (that revokes it).
      let sessionSaved = true;
      if (verifiedSession) {
        try {
          const saved = await client.auth.setSession({access_token: verifiedSession.access_token, refresh_token: verifiedSession.refresh_token});
          sessionSaved = !saved.error;
        } catch { sessionSaved = false; }
      }
      hideForms(); $('account-complete').hidden = false;
      message(sessionSaved ? '密码已更新。导航网和每日任务网都使用新密码；其他设备如提示登录失效，请重新登录。' :
        '密码已更新。当前登录状态未能恢复，请返回网站，使用新密码重新登录。', 'success');
    } catch {
      if (changed) { completed = true; hideForms(); $('account-complete').hidden = false; message('密码已更新，请返回网站使用新密码登录。', 'success'); }
      else message('未能确认密码修改结果，请检查网络；如果原密码无法登录，可尝试新密码或通过邮件重置。', 'error');
    } finally { clearSecrets(); verifier?.auth.stopAutoRefresh(); setBusy(false); }
  });
  $('account-retry').onclick = inspect;
  window.addEventListener('pagehide', clearSecrets);
  try {
    if (!site || !config?.url || !config?.publishableKey || !window.supabase) throw Error('账号组件未加载，请刷新页面重试。');
    client = window.supabase.createClient(config.url, config.publishableKey, options(site.storageKey));
    client.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') { rememberRecovery(session); setTimeout(inspect, 0); }
      else if (event === 'SIGNED_OUT') {
        checkEpoch++; user = null; recovery = false; clearMarker(); clearSecrets();
        if (!completed) { hideForms(); $('account-login-needed').hidden = false; message('登录已退出，请返回网站重新登录。'); }
      }
    });
    inspect();
  } catch (error) { hideForms(); message(error.message || '账号组件未加载，请刷新页面重试。', 'error'); }
})();
