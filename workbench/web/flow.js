/* 新流程：四阶段导航 + 上传屏 + 免费拆解屏。对照 Claude Design 画板「爆款复刻工作台 · 交互与界面重设计」的
 * Main、FreeReport 两张。③ 内容拆解、④ 复刻成片暂时沿用原有面板，下一批按 KeyGate、Replicate 画板改。
 *
 * 和 app.js 共用全局：P、STATUS、projectList、$、$$、esc、fmt、fileUrl、updateHtml、api、refresh、toast、guard、
 * openSettings、openProject、newProject、workflowState、operationErrors、operationKey。 */
"use strict";

const FLOW_STAGES = [
  { id: "upload", label: "上传素材" },
  { id: "free", label: "免费拆解" },
  { id: "content", label: "内容拆解", paid: true },
  { id: "replicate", label: "复刻成片", paid: true },
];
const FREE_STEPS = [["probe", "读视频信息"], ["transcribe", "识别台词"], ["boundaries", "切分镜头"], ["forensics", "认拍摄方式"]];
const VERDICT_CLASS = { live: "实拍", ai: "AI 生成", graphic: "图文动画" };
const stageChoice = new Map();   // pid → 用户点选的阶段
const freePicked = new Map();    // pid → 免费结果里选中的镜号

const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.6 8.4l2.8 2.8 6-6.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
const ICON_LOCK = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="2.2" y="5.2" width="7.6" height="5.4" rx="1.2" stroke="currentColor" stroke-width="1.3"></rect><path d="M4.1 5.2V3.9a1.9 1.9 0 013.8 0v1.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"></path></svg>';
const ICON_DONE_DOT = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="#e8f2ec"></circle><path d="M4.8 8.2l2.2 2.2 4.2-4.6" stroke="#2f6f55" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
const ICON_ARROW = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.4 8h9.2m0 0L9.2 4.6M12.6 8L9.2 11.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
const ICON_DOWNLOAD = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.6v7.2m0 0l2.8-2.8M8 9.8L5.2 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M3 11.4v2h10v-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg>';

// ---------- 阶段 ----------
function hasAnyKey() {
  return !!(STATUS && (STATUS.jimmy || Object.values(STATUS.providers || {}).some((v) => v && v.ready)));
}
function freeDone() {
  const a = P?.analysis || {};
  return !!a.free_finished || (["free_done", "done", "partial"].includes(a.status) && a.steps?.boundaries?.status === "done");
}
function freeRunning() {
  const a = P?.analysis || {};
  return a.status === "running" && !a.free_finished;
}
function contentStarted() {
  const a = P?.analysis || {};
  return !!P?.breakdown || (a.status === "running" && !!a.free_finished) || ["done", "partial"].includes(a.status);
}
function stageDone(id) {
  if (!P) return false;
  const rows = workflowState();
  return { upload: !!P.source, free: freeDone(), content: rows[1].done, replicate: rows[4].done }[id];
}
function stageLocked(id) {
  return { upload: false, free: !P?.source, content: !freeDone(), replicate: !stageDone("content") }[id];
}
function autoStage() {
  if (!P?.source) return "upload";
  if (!freeDone() || !contentStarted()) return "free";
  return stageDone("content") ? "replicate" : "content";
}
function currentStage() {
  const chosen = stageChoice.get(P?.id);
  return chosen && !stageLocked(chosen) ? chosen : autoStage();
}
function setStage(id) {
  if (!P || stageLocked(id)) return;
  stageChoice.set(P.id, id);
  renderFlow();
  window.scrollTo({ top: 0 });
}

function renderStageNav(stage) {
  const parts = [];
  FLOW_STAGES.forEach((s, i) => {
    const done = stageDone(s.id), locked = stageLocked(s.id), current = s.id === stage;
    const cls = current ? "is-current" : locked ? "is-locked" : done ? "is-done" : "is-open";
    const mark = current ? `<span class="num">${i + 1}</span>` : locked ? ICON_LOCK : done ? ICON_CHECK : `<span class="num">${i + 1}</span>`;
    const title = locked ? (s.id === "free" ? "先上传视频" : s.id === "content" ? "先完成免费拆解" : "先完成内容拆解") : "";
    parts.push(`<button type="button" class="stage ${cls}" data-stage-go="${s.id}" ${locked ? 'aria-disabled="true"' : ""} ${current ? 'aria-current="step"' : ""} title="${esc(title)}">${mark}${esc(s.label)}</button>`);
    if (i === 1) parts.push('<span class="stage-divider" aria-hidden="true"><span class="dash"></span><span>这之后<br>才要 Key</span></span>');
    else if (i < FLOW_STAGES.length - 1) parts.push(`<span class="stage-line ${done ? "done" : ""}" aria-hidden="true"></span>`);
  });
  updateHtml($("#stageNav"), P ? parts.join("") : "");
}

// ---------- ① 上传：最近的项目 ----------
function projectBadge(p) {
  if (p.analysis === "running") return ["拆解中", "busy"];
  if (p.analysis === "free_done") return ["免费拆解已完成", "ok"];
  if (["done", "partial"].includes(p.analysis)) return ["内容拆解已完成", "ok"];
  if (p.has_source) return ["已上传视频", ""];
  return ["等待上传视频", ""];
}
function renderRecentProjects() {
  const box = $("#recentProjects");
  if (!box) return;
  const list = (projectList || []).filter((p) => !p.derived_from).slice(0, 6);
  updateHtml(box, `<h2>最近的项目</h2>${list.map((p) => {
    const [label, tone] = projectBadge(p), cur = p.id === P?.id;
    const day = p.created_at ? new Date(String(p.created_at).replace(" ", "T")) : null;
    return `<button type="button" class="recent-item ${cur ? "is-current" : ""}" data-open-recent="${esc(p.id)}">
      <span class="recent-thumb" aria-hidden="true"></span>
      <span class="recent-text"><b>${esc(p.name || "未命名项目")}</b><span class="badge ${tone}">${label}</span>
      <small>${day && !isNaN(day) ? `${day.getMonth() + 1} 月 ${day.getDate()} 日` : ""}${cur ? " · 当前项目" : ""}</small></span></button>`;
  }).join("")}<button type="button" class="recent-new" data-flow-new>＋ 新建项目</button>`);
}

function renderUploadNext() {
  const box = $("#uploadNext");
  if (!box || !P) return;
  const label = freeDone() ? "看免费拆解结果" : freeRunning() ? "看拆解进度" : "开始免费拆解";
  updateHtml(box, P.source ? `<div class="upload-next"><p>视频已经放好了。${freeDone() ? "免费拆解也做完了。" : "下一步在你的电脑上免费拆解它。"}</p>
    <button type="button" class="ghost" data-pick-source>换一个视频</button>
    <button type="button" data-stage-go="free">${label} ${ICON_ARROW}</button></div>` : "");
}

// ---------- ② 免费拆解 ----------
function mmss(t) {
  t = Math.max(0, Number(t) || 0);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
}
function shotCaption(shot) {
  const segs = (P.analysis?.transcript || []).filter((s) => {
    const mid = (Number(s.start) + Number(s.end)) / 2;
    return mid >= shot.start && mid < shot.end && String(s.text || "").trim();
  });
  return segs.map((s) => String(s.text).trim()).join(" ");
}
function verdictBadge(v) {
  return v ? `<span class="verdict ${esc(v.class)}">${esc(VERDICT_CLASS[v.class] || v.class_zh)}</span>` : "";
}
function freeStepSummary(id) {
  const st = P.analysis?.steps?.[id] || {}, out = st.output || {};
  if (st.status === "running") return `正在进行${st.progress ? " · " + esc(st.progress) : "…"}`;
  if (st.status === "failed") return `没完成：${esc(st.note || "")}`;
  if (st.status === "skipped") return `已跳过：${esc(st.note || "")}`;
  if (st.status !== "done") return "等待中";
  if (id === "probe") return `${fmt(out.duration, 0)} 秒 · ${out.width}×${out.height} · ${fmt(out.fps, 0)}fps · ${out.audio_stream_count ? "有音轨" : "无音轨"}`;
  if (id === "transcribe") return out.words ? `逐词对齐，共 ${out.words} 个词` : `${out.sentences || 0} 句台词`;
  if (id === "boundaries") {
    const shots = P.analysis?.shots || [];
    const avg = shots.length ? shots.reduce((n, s) => n + (s.end - s.start), 0) / shots.length : 0;
    return `${shots.length} 个镜头，平均 ${fmt(avg, 1)} 秒`;
  }
  if (id === "forensics") return Object.entries(VERDICT_CLASS).map(([k, l]) => `${l} ${(P.analysis?.forensics?.counts || {})[k] || 0}`).join(" · ");
  return "";
}
function freeStepItem([id, label]) {
  const st = P.analysis?.steps?.[id]?.status || "pending";
  const tone = { done: "done", running: "running", skipped: "skipped", failed: "failed" }[st] || "pending";
  const icon = st === "done" ? ICON_DONE_DOT : `<span class="dot ${tone}" aria-hidden="true"></span>`;
  return `<li class="free-step ${tone}"><div class="free-step-head"><span class="free-step-name">${icon}${label}</span><span class="tag-free">免费</span></div>
    <p>${freeStepSummary(id)}</p></li>`;
}
function freeElapsed() {
  const a = P.analysis || {};
  const sec = a.free_finished && a.started ? Math.max(0, a.free_finished - a.started) : 0;
  if (!sec) return "";
  return sec >= 60 ? `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒` : `${Math.round(sec)} 秒`;
}

function renderFreeStart() {
  return `<section class="free-start">
    <video src="${fileUrl(P.source.file)}" controls preload="metadata"></video>
    <div class="free-start-body">
      <h1>免费拆解这条视频</h1>
      <p>全部在你的电脑上跑：读视频信息、识别台词、切分镜头、认拍摄方式。<b>不花钱，不用填 Key。</b>纯 CPU 一般 1–3 分钟。</p>
      <ol class="free-start-list">${FREE_STEPS.map(([, l], i) => `<li><span class="step-no">${i + 1}</span>${l}</li>`).join("")}</ol>
      <details class="free-advanced" data-detail-key="free-advanced"><summary>高级选项</summary>
        <label class="check"><input type="checkbox" id="freeSkipAsr"> 跳过识别台词（视频里没人说话）</label>
        <label class="file-inline">已有字幕文件？用它代替识别台词 <input type="file" id="freeSrtInput" accept=".srt,.txt"></label>
      </details>
      <button type="button" class="big-cta" data-free-start>开始免费拆解 ${ICON_ARROW}</button>
    </div>
  </section>`;
}
function renderFreeProgress() {
  const a = P.analysis || {}, failed = a.status === "failed";
  const err = failed ? `<div class="free-error"><b>拆解没有完成</b><p>${esc(a.error || "")}</p><button type="button" data-free-start>重新拆解</button></div>` : "";
  return `<div class="free-layout">
    <aside class="free-aside"><h2>正在做这四件事</h2><ol class="free-steps">${FREE_STEPS.map(freeStepItem).join("")}</ol></aside>
    <section class="free-main">${err || `<div class="free-wait"><span class="spinner" aria-hidden="true"></span>
      <h2>正在你的电脑上拆解…</h2><p>不用守着，可以先去忙别的。拆完会自动显示结果。</p></div>`}</section>
  </div>`;
}
function renderFreeReport() {
  const a = P.analysis || {}, shots = a.shots || [];
  const verdicts = Object.fromEntries(((a.forensics || {}).shots || []).map((v) => [v.index, v]));
  let picked = freePicked.get(P.id);
  if (!shots.some((s) => s.index === picked)) picked = shots[0]?.index;
  const sel = shots.find((s) => s.index === picked);
  const v = sel && verdicts[sel.index];
  const caption = sel ? shotCaption(sel) : "";
  const elapsed = freeElapsed();
  const zip = a.free?.zip;
  const detail = sel ? `<div class="shot-detail">
      <div class="shot-detail-head"><h2>镜头 ${sel.index}</h2><span class="range">${mmss(sel.start)}–${mmss(sel.end)}</span>${verdictBadge(v)}</div>
      <div class="shot-detail-body">
        <img class="shot-detail-thumb" src="${fileUrl(sel.frame)}" alt="镜头 ${sel.index} 截图">
        <div class="shot-detail-text">
          <h3>这一镜的台词</h3><p>${caption ? esc(caption) : '<span class="hint">（这一镜没有台词）</span>'}</p>
          ${v ? `<h3>凭什么这么判断</h3><ul class="chips">${(v.tags || []).map((t) => `<li>${esc(t)}</li>`).join("") || "<li>没有特别明显的特征</li>"}</ul>
          <details class="why-more" data-detail-key="why-${sel.index}"><summary>看完整依据</summary><ul>${(v.evidence || []).map((e) => `<li>${esc(e)}</li>`).join("")}</ul></details>`
          : `<h3>拍摄方式</h3><p class="hint">${esc(a.steps?.forensics?.note || "这次没有做认拍摄方式")}</p>`}
        </div>
      </div></div>` : "";
  return `<div class="free-layout">
    <aside class="free-aside">
      <div class="free-done-card"><div class="free-done-title">${ICON_DONE_DOT}<h1>拆解完成</h1></div>
        <p>${elapsed ? `耗时 ${elapsed}，` : ""}全程在你的电脑上跑完，<strong>没有产生任何费用</strong>。</p></div>
      <h2>做了这四件事</h2><ol class="free-steps">${FREE_STEPS.map(freeStepItem).join("")}</ol>
      <button type="button" class="ghost small" data-free-start>重新拆解</button>
    </aside>
    <section class="free-main">
      ${detail}
      <div class="shot-grid-head"><h2>${shots.length} 个镜头</h2><span class="hint">点一个看它的判定依据</span></div>
      <ul class="shot-grid">${shots.map((s) => `<li><button type="button" class="shot-card ${s.index === picked ? "is-picked" : ""}" data-free-shot="${s.index}">
        <img loading="lazy" src="${fileUrl(s.frame)}" alt=""><span class="shot-card-foot"><span class="range">${mmss(s.start)}–${mmss(s.end)}</span>${verdictBadge(verdicts[s.index])}</span></button></li>`).join("")}</ul>
    </section>
  </div>
  <footer class="free-footer">
    <div><h2>到这里就够用了？把结果带走</h2><p>拆解报告、字幕文件、分镜图都能直接导出，不用填任何 Key。</p></div>
    <div class="free-footer-actions">
      ${zip ? `<a class="btn-outline" href="${fileUrl("analysis/" + zip)}" download="免费拆解包.zip">${ICON_DOWNLOAD}导出报告 · 字幕 · 分镜图</a>`
            : '<span class="hint">这份结果是旧版本拆的，没有导出包。点左边「重新拆解」即可生成。</span>'}
      <button type="button" class="next-cta" data-stage-go="content"><span>继续做复刻方案 ${ICON_ARROW}</span><small>这一步开始要填 Key，会产生费用</small></button>
    </div>
  </footer>`;
}
function renderFreeStage() {
  const box = $("#freeStage");
  if (!box || !P) return;
  const a = P.analysis || {};
  let html;
  if (!P.source) html = `<div class="free-empty"><p>先上传对标视频。</p><button type="button" data-stage-go="upload">去上传</button></div>`;
  else if (freeDone()) html = renderFreeReport();
  else if (freeRunning() || a.status === "failed") html = renderFreeProgress();
  else html = renderFreeStart();
  updateHtml(box, html);
}

// ---------- ③ 内容拆解前的 Key 提示（完整的 Key 引导屏在下一批） ----------
function renderKeyGateLite() {
  const box = $("#keyGateLite");
  if (!box || !P) return;
  updateHtml(box, hasAnyKey()
    ? `<div class="gate-note"><b>内容拆解会调用大模型，按用量计费。</b> 它会看懂整片和每一段的人物、动作、商品，出 7 张拆解卡，后面做复刻方案要用。</div>`
    : `<section class="gate-card">
        <h1>下一步要用「会读片子的大模型」，需要先填 Key</h1>
        <p>免费拆解只认出了「拍了什么、怎么拍的」。要做复刻方案，得让大模型看懂整片在讲什么、每段谁在做什么、商品什么时候出现——这一步会产生费用，所以需要你自己的 Key。Key 只保存在这台电脑上。</p>
        <div class="gate-actions"><button type="button" data-flow-settings>去填 Key</button><button type="button" class="ghost" data-stage-go="free">先回到免费结果</button></div>
      </section>`);
  $("#step-2").hidden = !hasAnyKey();
}

// ---------- 总入口 ----------
function renderFlow() {
  if (!P) { updateHtml($("#stageNav"), ""); return; }
  const stage = currentStage();
  $("#workspace").dataset.stage = stage;
  renderStageNav(stage);
  renderRecentProjects();
  renderUploadNext();
  renderFreeStage();
  renderKeyGateLite();
}

async function submitFreeAnalyze() {
  const pid = P.id;
  operationErrors.delete(operationKey("analyze"));
  const file = $("#freeSrtInput")?.files?.[0];
  const body = { mode: "free", skip_asr: !!$("#freeSkipAsr")?.checked, srt_text: file ? await file.text() : null };
  await api("POST", `projects/${pid}/analyze`, body);
  if (P?.id !== pid) return;
  stageChoice.set(pid, "free");
  toast("开始免费拆解");
  await refresh(true);
}

document.addEventListener("click", async (e) => {
  const toggle = $("#statusToggle");
  if (toggle?.getAttribute("aria-expanded") === "true" && !e.target.closest(".top-actions")) toggle.setAttribute("aria-expanded", "false");
  const go = e.target.closest("[data-stage-go]");
  if (go) { e.preventDefault(); if (go.getAttribute("aria-disabled") !== "true") setStage(go.dataset.stageGo); return; }
  const shot = e.target.closest("[data-free-shot]");
  if (shot && P) { freePicked.set(P.id, Number(shot.dataset.freeShot)); renderFreeStage(); return; }
  if (e.target.closest("[data-free-start]")) {
    const a = P?.analysis || {};
    if (a.status === "running") return;
    if (freeDone() && !await pageConfirm("重新拆解会覆盖这次的免费拆解结果，继续？")) return;
    guard(submitFreeAnalyze);
    return;
  }
  const recent = e.target.closest("[data-open-recent]");
  if (recent) { if (recent.dataset.openRecent !== P?.id) openProject(recent.dataset.openRecent); return; }
  if (e.target.closest("[data-flow-new]")) { newProject(); return; }
  if (e.target.closest("[data-flow-settings]")) { openSettings(); return; }
  if (e.target.closest("[data-pick-source]")) { $("#sourceInput")?.click(); return; }
});
