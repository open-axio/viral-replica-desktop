/* Code updates use their own dialog and never submit the settings/key form. */
(() => {
  const dialog = document.querySelector('#updateDialog');
  const view = document.querySelector('#updateInfo');
  let state = {}, busy = false, polling = false, justUpdated = false;
  const ACTIVE = ['checking','downloading','installing','rolling_back','restarting'];
  const RUNNING = ['downloading','installing','rolling_back','restarting'];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (_) { return null; } return null; };
  const PHASE_TEXT = {downloading:'正在下载新版本…', installing:'正在备份并替换程序代码…', restarting:'马上好：工作台正在重启，完成后页面会自动刷新', rolling_back:'正在恢复上一个版本…', checking:'正在检查更新…'};
  function notesHtml(entries, title) {
    if (!entries || !entries.length) return '';
    return `<section class="upd-notes"><h3>${escape(title)}</h3>${entries.map(e => `<div class="upd-entry">
      <div class="upd-entry-head"><b>${escape(e.version)}</b>${e.date ? `<small>${escape(e.date)}</small>` : ''}</div>
      <ul>${e.items.map(i => `<li>${escape(i)}</li>`).join('')}</ul></div>`).join('')}</section>`;
  }
  function render() {
    const active = ACTIVE.includes(state.phase);
    const avail = state.available;
    const badge = avail ? `<span class="upd-badge new">有新版本 ${escape(avail.version)}</span>`
      : state.phase === 'idle' && /最新/.test(state.message || '') ? '<span class="upd-badge ok">已是最新</span>' : '';
    let notes = '';
    if (avail) notes = avail.notes?.length ? notesHtml(avail.notes, '这次更新了什么') : '<p class="hint">新版本没有附更新说明。</p>';
    else if (justUpdated || /最新/.test(state.message || '')) notes = notesHtml(state.current_notes, justUpdated ? '已经更新好了，这次更新了：' : '当前版本更新了：');
    const progress = RUNNING.includes(state.phase) ? '<div class="upd-progress" aria-hidden="true"><span></span></div>' : '';
    const message = PHASE_TEXT[state.phase] || state.message || '点「检查更新」看看有没有新版本。';
    view.innerHTML = `<div class="upd-head"><span>当前版本 <b>${escape(state.current_version || '读取中')}</b></span>${badge}</div>
      ${notes}${progress}
      <p role="status" class="upd-status ${state.phase==='error'?'action-error':''}">${escape(message)}</p>`;
    document.querySelector('#checkUpdateBtn').disabled = busy || active;
    const apply = document.querySelector('#applyUpdateBtn');
    apply.hidden = !avail; apply.disabled = busy || active;
    const rollback = document.querySelector('#rollbackUpdateBtn');
    rollback.hidden = !state.can_rollback; rollback.disabled = busy || active;
    document.querySelector('#updateConfirmation').hidden = true;
    document.querySelector('#refreshUpdatedBtn').hidden = state.phase !== 'restarting';
    const btn = document.querySelector('#updatesBtn');
    if (btn && btn.setAttribute) {
      btn.setAttribute('data-has-update', avail ? '1' : '0');
      btn.setAttribute('data-tip', avail ? '软件更新 · 有新版本' : '软件更新');
    }
  }
  async function read() { state = await api('GET', 'updates'); render(); }
  async function poll() {
    if(polling)return; polling=true;
    try {
      for(let i=0;i<300;i++) {
        await new Promise(resolve=>setTimeout(resolve,1000));
        const restarting = state.phase === 'restarting';
        try { await read(); } catch(error) { if(restarting)continue; throw error; }
        if(restarting && state.phase==='idle') { location.reload(); return; }
        if(!RUNNING.includes(state.phase))return;
      }
      state.message='更新等待得比较久，请稍后刷新页面看看；不要重复点更新。'; render();
    } catch(error) { state.message=error.message; render(); }
    finally { polling=false; }
  }
  async function run(action, body={}) {
    busy=true;
    if(action==='check')state={...state,phase:'checking',message:'正在检查更新…',available:null};
    render();
    try { state=await api('POST','updates/'+action,body); render(); }
    catch(error) { state={...state,phase:'error',message:error.message}; render(); }
    finally { busy=false; render(); }
    if(RUNNING.includes(state.phase))poll();
  }
  document.querySelector('#updatesBtn').onclick = async () => {
    justUpdated = false;
    dialog.showModal();
    try { await read(); } catch(error) { state={phase:'error',message:error.message};render(); }
    if(RUNNING.includes(state.phase))poll();
  };
  document.querySelector('#closeUpdateBtn').onclick = () => { justUpdated = false; dialog.close(); };
  document.querySelector('#checkUpdateBtn').onclick = () => run('check');
  for(const [id,action,text] of [
    ['applyUpdateBtn','apply','更新大约 1 分钟：先备份，再替换程序代码，然后自动重启。项目、素材、Key、模型和依赖都会保留。页面里还没保存的修改请先保存。'],
    ['rollbackUpdateBtn','rollback','恢复到上次更新前的程序代码并重启。更新后创建或修改的项目和素材会保留。']]) {
    document.querySelector('#'+id).onclick = () => {
      document.querySelector('#updateConfirmText').textContent=text;
      document.querySelector('#updateConfirmation').hidden=false;
      document.querySelector('#confirmCodeUpdateBtn').onclick=()=>run(action,{sha:state.available?.sha});
    };
  }
  document.querySelector('#cancelCodeUpdateBtn').onclick=()=>{document.querySelector('#updateConfirmation').hidden=true;};
  document.querySelector('#refreshUpdatedBtn').onclick=()=>location.reload();

  // 打开工作台时：刚更新过就说一声更新了什么；再悄悄检查一次有没有新版本。
  // 新版本只自动弹一次（每个版本一次），之后只在右上角按钮上亮红点。
  async function autoCheck() {
    const anotherOpen = () => !!document.querySelector('dialog[open]');
    try {
      await read();
      const last = store('vrc.lastVersion');
      store('vrc.lastVersion', state.current_version || '');
      if (last && state.current_version && last !== state.current_version && state.current_notes?.length && !anotherOpen()) {
        justUpdated = true; render(); dialog.showModal();
        return;   // 刚更新完，先不再查
      }
      if (RUNNING.includes(state.phase)) return;
      state = await api('POST', 'updates/check', {}); render();
      const v = state.available?.version;
      if (v && store('vrc.updateShown') !== v && !anotherOpen()) {
        store('vrc.updateShown', v);
        dialog.showModal();
      }
    } catch (_) { /* 没网、GitHub 慢：不打扰，手动点「检查更新」还能查 */ }
  }
  if (typeof window !== 'undefined' && window.__autoUpdateCheck !== false) setTimeout(autoCheck, 3000);
})();
