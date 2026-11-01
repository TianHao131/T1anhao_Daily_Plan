(function() {
  'use strict';
  const $ = id => document.getElementById(id);
  const app = window.DailyApp, sync = window.DailySync;
  let client, engine = null, epoch = 0, pendingView = false, viewBase = sync.empty();
  let editLock = null;
  const message = text => { $('cloud-auth-message').textContent = text; };
  function status(text, kind = '') {
    $('cloud-status').textContent = text;
    $('cloud-status').dataset.kind = kind;
    if ($('daily-app').hidden) message(text);
  }
  function closeConflict() {
    if ($('cloud-conflict').open) $('cloud-conflict').close();
    $('daily-app').inert = false;
  }
  function lock() {
    epoch++;
    if (editLock) { editLock.cancelled = true; editLock.release?.(); editLock = null; }
    engine?.stop(); engine = null; pendingView = false; viewBase = sync.empty();
    $('daily-app').hidden = true; $('cloud-auth').hidden = false; closeConflict();
    $('cloud-account').textContent = ''; app.reset();
  }
  async function claimTab(userId) {
    if (!navigator.locks) return true;
    if (editLock?.userId === userId) return editLock.ready;
    if (editLock) { editLock.cancelled = true; editLock.release?.(); editLock = null; }
    const request = {userId, cancelled: false};
    editLock = request;
    request.ready = new Promise(resolve => {
      navigator.locks.request('daily-checkin-edit:' + userId, {ifAvailable: true}, async handle => {
        if (!handle || request.cancelled) {
          if (editLock === request) editLock = null;
          resolve(false); return;
        }
        await new Promise(release => { request.release = release; resolve(true); });
      }).catch(() => { if (editLock === request) editLock = null; resolve(false); });
    });
    return request.ready;
  }
  function showConflict(conflicts) {
    $('cloud-conflict-list').replaceChildren();
    for (const conflict of conflicts.slice(0, 40)) {
      const li = document.createElement('li'); li.textContent = conflict; $('cloud-conflict-list').appendChild(li);
    }
    if (conflicts.length > 40) {
      const li = document.createElement('li'); li.textContent = '另有 ' + (conflicts.length - 40) + ' 处冲突'; $('cloud-conflict-list').appendChild(li);
    }
    $('daily-app').inert = true;
    if (!$('cloud-conflict').open) $('cloud-conflict').showModal();
  }
  function applyView(data, force = false) {
    if (!force && app.busy()) { pendingView = true; return; }
    if (!sync.same(app.snapshot(), data)) app.apply(data);
    viewBase = sync.clone(data); pendingView = false;
  }
  function flushView() {
    if (pendingView && engine && !engine.conflict && !app.busy()) applyView(engine.state.data);
  }
  window.DailyCloud = {
    get ready() { return !!engine?.ready && !engine?.conflict; },
    commit(data) {
      if (!engine?.commit(data, viewBase)) return false;
      viewBase = sync.clone(engine.state.data); pendingView = false;
      return sync.clone(viewBase);
    }
  };
  function adapter(userId) {
    const table = () => client.from('daily_checkin_state');
    return {
      async read() {
        const {data, error} = await table().select('data,revision').eq('user_id', userId).maybeSingle();
        if (error) throw Error(error.code === 'PGRST205' ? '每日任务数据库尚未初始化，请先运行每日任务初始化脚本。' : '云端暂时无法读取，请检查连接或重新登录。');
        return data || {data: sync.empty(), revision: null};
      },
      async write(data, revision) {
        const query = revision === null ? table().insert({user_id: userId, data}) :
          table().update({data}).eq('user_id', userId).eq('revision', revision);
        const result = await query.select('data,revision').maybeSingle();
        if (result.error?.code === '23505') return null;
        if (result.error) throw Error('云端保存未完成，本机内容已保留，请检查连接或重新登录。');
        return result.data;
      }
    };
  }
  async function resume() {
    if (!client) return;
    const token = ++epoch;
    message('正在恢复登录状态…');
    try {
      const sessionResult = await client.auth.getSession();
      if (token !== epoch) return;
      const cachedUser = sessionResult.data?.session?.user;
      if (!cachedUser) {
        if (engine) lock();
        message(sessionResult.error ? '无法恢复登录，请检查网络后重试。' : '请登录每日任务同步账号；以后会自动保持登录。'); return;
      }
      const result = await client.auth.getUser();
      if (token !== epoch) return;
      const networkFailure = result.error && (!result.error.status || result.error.status >= 500);
      const user = result.data?.user || (networkFailure ? cachedUser : null);
      if (!user) {
        if (engine) lock();
        message('登录状态已失效，请重新登录。'); return;
      }
      if (engine?.userId === user.id) { engine.sync(); return; }
      if (!await claimTab(user.id)) {
        message('每日任务已在另一个标签页打开。请关闭那个标签页，再点击这里的“重试连接”。'); return;
      }
      if (token !== epoch) return;
      engine?.stop(); app.reset(); viewBase = sync.empty();
      const next = new sync.Engine({
        userId: user.id, remote: adapter(user.id), storage: localStorage,
        onChange(data) {
          if (engine !== next) return;
          if (next.ready) { $('cloud-auth').hidden = true; $('daily-app').hidden = false; }
          applyView(data);
        },
        onStatus(text, kind) { if (engine === next) status(text, kind); },
        onConflict(conflicts) { if (engine === next) showConflict(conflicts); }
      });
      if (result.error && !next.ready) {
        next.stop(); message('暂时无法连接云端，且这台设备还没有缓存。请联网后重试。'); return;
      }
      engine = next;
      $('cloud-account').textContent = user.email || '已登录';
      function reveal() {
        if (!next.ready || engine !== next) return;
        const opening = $('daily-app').hidden;
        $('cloud-auth').hidden = true; $('daily-app').hidden = false;
        if (opening) applyView(next.state.data, true);
        if (next.conflict) { status('存在未处理的同步冲突。', 'conflict'); showConflict(next.conflict.conflicts); }
      }
      reveal();
      if (result.error) status('暂时无法连接云端，已打开本机缓存。修改会暂存在本机。', 'pending');
      else { await next.sync(); reveal(); }
    } catch { if (token === epoch) message('连接未完成，请检查网络后点击重试。'); }
  }
  $('cloud-login-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!client || !$('cloud-login-form').reportValidity()) return;
    const button = $('cloud-login-form').querySelector('button'); button.disabled = true;
    message('正在登录…');
    try {
      const {error} = await client.auth.signInWithPassword({email: $('cloud-email').value.trim(), password: $('cloud-password').value});
      $('cloud-password').value = '';
      if (error) { message('登录未成功，请检查每日任务的同步账号、密码及网络。'); return; }
      await resume();
    } catch { message('暂时无法登录，请检查网络后重试。'); }
    finally { button.disabled = false; }
  });
  $('cloud-retry').onclick = () => client ? resume() : location.reload();
  $('cloud-sync-now').onclick = () => { flushView(); engine?.sync(); };
  $('cloud-sign-out').onclick = async () => {
    if (engine?.state.dirty && !confirm('本机还有未同步的修改，已保存在此账号的缓存中。确定退出？')) return;
    lock();
    try {
      const {error} = await client.auth.signOut({scope: 'local'});
      message(error ? '页面已锁定，但退出未完成，请检查连接后重试。' : '已退出。下次请使用原账号登录。');
    } catch { message('页面已锁定，请检查连接后重试退出。'); }
  };
  $('cloud-conflict').addEventListener('cancel', e => e.preventDefault());
  $('cloud-conflict-export').onclick = () => {
    // Export the exact saved local draft, including edits made during a sync request.
    if (engine) { const data = engine.conflict?.local || engine.state.data; app.apply(data); viewBase = sync.clone(data); }
    app.exportBackup();
  };
  for (const [button, choice] of [['cloud-keep-local', 'local'], ['cloud-keep-remote', 'remote']]) {
    $(button).onclick = () => { if (engine?.resolve(choice)) { closeConflict(); applyView(engine.state.data, true); } };
  }
  const kick = () => { flushView(); if (engine) engine.sync(); else resume(); };
  window.addEventListener('online', kick);
  window.addEventListener('focus', () => { if (client) kick(); });
  window.addEventListener('offline', () => { if (engine) status('网络已断开，修改会暂存在本机。', 'pending'); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && client) kick(); });
  document.addEventListener('focusout', () => setTimeout(flushView, 100));
  document.addEventListener('submit', () => setTimeout(flushView, 0));
  setInterval(() => { if (!document.hidden) { flushView(); engine?.sync(); } }, 20000);
  setInterval(flushView, 1000);
  // Web Locks keep two tabs from overwriting the same browser cache. Other
  // computers/browsers still sync concurrently through database revision checks.
  window.addEventListener('beforeunload', event => {
    if (engine?.state.dirty) { event.preventDefault(); event.returnValue = ''; }
  });
  try {
    const config = window.NAV_CLOUD_CONFIG;
    if (!window.supabase || !config?.url || !config?.publishableKey) throw Error('同步组件未加载，请刷新后重试。');
    client = window.supabase.createClient(config.url, config.publishableKey, {
      auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'daily-checkin-auth-v1'},
      global: {fetch: async (url, options = {}) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, {once: true});
        const timer = setTimeout(abort, 12000);
        try { return await fetch(url, {...options, signal: controller.signal}); }
        finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
      }}
    });
    client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') { lock(); message('登录已退出，请重新登录。'); }
      else if (event === 'SIGNED_IN' && session) setTimeout(resume, 0);
    });
    resume();
  } catch (error) { message(error.message || '同步组件未加载，请刷新后重试。'); }
})();
