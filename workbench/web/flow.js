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
const VERDICT_CLASS = { live: "实拍", ai: "AI 生成", graphic: "图文动画", unsure: "待确认" };
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
// 后台任务已经报错、但项目状态还停在 running（写状态没成功等）：按失败处理，别一直转圈
function analyzeJobError() {
  const job = P?.jobs?.analyze;
  return job && job.state === "error" && P?.analysis?.status === "running" ? (job.error || "拆解没有完成") : "";
}
function freeRunning() {
  const a = P?.analysis || {};
  return a.status === "running" && !a.free_finished && !analyzeJobError();
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
  updateHtml(box, originCard(P.origin) + (P.source ? `<div class="upload-next"><p>视频已经放好了。${freeDone() ? "免费拆解也做完了。" : "下一步在你的电脑上免费拆解它。"}</p>
    <button type="button" class="ghost" data-pick-source>换一个视频</button>
    <button type="button" data-stage-go="free">${label} ${ICON_ARROW}</button></div>` : ""));
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
  if (st.status === "running" && analyzeJobError()) return "没完成";
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
  if (id === "forensics") return Object.entries(VERDICT_CLASS).filter(([k]) => k !== "unsure" || (P.analysis?.forensics?.counts || {}).unsure)
    .map(([k, l]) => `${l} ${(P.analysis?.forensics?.counts || {})[k] || 0}`).join(" · ");
  return "";
}
function freeStepItem([id, label]) {
  let st = P.analysis?.steps?.[id]?.status || "pending";
  if (st === "running" && analyzeJobError()) st = "failed";
  const tone = { done: "done", running: "running", skipped: "skipped", failed: "failed" }[st] || "pending";
  const icon = st === "done" ? ICON_DONE_DOT : `<span class="dot ${tone}" aria-hidden="true"></span>`;
  const quick = id === "transcribe" && st === "skipped" && /还没装/.test(P.analysis?.steps?.[id]?.note || "") ? asrQuickHtml() : "";
  return `<li class="free-step ${tone}"><div class="free-step-head"><span class="free-step-name">${icon}${label}</span><span class="tag-free">免费</span></div>
    <p>${freeStepSummary(id)}</p>${quick}</li>`;
}
// 台词因为没装识别模型被跳过：就地给一个「下载 → 重新拆解」的按钮，不用钻进设置
let asrQuickLoading = false;
function asrQuickHtml() {
  if (!asrModels) {
    if (!asrQuickLoading) { asrQuickLoading = true; setTimeout(loadAsrModels, 0); }
    return '<div class="asr-quick" data-asr-quick><span class="hint">正在检查识别模型…</span></div>';
  }
  const running = asrModels.tiers.find((t) => t.state === "running");
  if (running) {
    const pct = Math.round((running.progress || 0) * 100);
    return `<div class="asr-quick" data-asr-quick><span class="asr-progress"><span style="width:${pct}%"></span></span><small>正在下载「${esc(running.name)}」识别模型 ${pct}%，下完就能把台词补上</small></div>`;
  }
  if (asrModels.tiers.some((t) => t.installed)) {
    return '<div class="asr-quick" data-asr-quick><button type="button" class="small" data-free-start>识别模型装好了，重新拆解把台词补上</button></div>';
  }
  const tier = asrModels.tiers.find((t) => t.id === "small") || asrModels.tiers[0];
  const failed = asrModels.tiers.find((t) => t.error);
  return `<div class="asr-quick" data-asr-quick>${failed ? `<p class="asr-error">上次没下完：${esc(failed.error)}</p>` : ""}<button type="button" class="small" data-asr="download" data-tier="${esc(tier.id)}">下载识别模型（${esc(tier.size)}，免费）</button></div>`;
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
      <p>全部在你的电脑上跑：读视频信息、识别台词、切分镜头、认拍摄方式。<b>不花钱，不用填 Key。</b>${freeEta()}</p>
      <ol class="free-start-list">${FREE_STEPS.map(([, l], i) => `<li><span class="step-no">${i + 1}</span>${l}</li>`).join("")}</ol>
      <details class="free-advanced" data-detail-key="free-advanced"><summary>高级选项</summary>
        <label class="check"><input type="checkbox" id="freeSkipAsr"> 跳过识别台词（视频里没人说话）</label>
        <label class="file-inline">已有字幕文件？用它代替识别台词 <input type="file" id="freeSrtInput" accept=".srt,.txt"></label>
      </details>
      <button type="button" class="big-cta" data-free-start>开始免费拆解 ${ICON_ARROW}</button>
    </div>
  </section>${originCard(P.origin)}`;
}
function freeEta() {
  const sec = Number(P.source?.probe?.duration) || 0;
  if (sec > 120) return `这条视频有 ${Math.round(sec / 60)} 分钟，识别台词会久一些，大概要 ${Math.max(3, Math.round(sec / 60))}–${Math.max(6, Math.round(sec / 30))} 分钟，可以先去忙别的。`;
  return "一分钟以内的视频，一般 1–3 分钟拆完。";
}
function renderFreeProgress() {
  const a = P.analysis || {}, jobErr = analyzeJobError(), failed = a.status === "failed" || !!jobErr;
  const err = failed ? `<div class="free-error"><b>拆解没有完成</b><p>${esc(a.error || jobErr || "")}</p><button type="button" data-free-start>重新拆解</button></div>` : "";
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
          ${v?.confirmed_by === "model" ? `<p class="unsure-note confirmed">内容拆解时大模型看图确认：${esc(v.model_why || VERDICT_CLASS[v.class])}</p>` : ""}
          ${v?.class === "unsure" ? '<p class="unsure-note">只看像素分不清这一镜是实拍还是 AI 生成（平台压缩会抹掉判断用的细节）。做内容拆解时，会让大模型看图再确认。</p>' : ""}
          ${v ? `<h3>${v.class === "unsure" ? "看到的特征" : "凭什么这么判断"}</h3><ul class="chips">${(v.tags || []).map((t) => `<li>${esc(t)}</li>`).join("") || "<li>没有特别明显的特征</li>"}</ul>
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
  else if (freeRunning() || a.status === "failed" || analyzeJobError()) html = renderFreeProgress();
  else html = renderFreeStart();
  updateHtml(box, html);
}

// ---------- ③ 内容拆解（设计稿 KeyGate + 内容拆解进度/结果） ----------
const KEY_TABS = {
  viraltok: {
    name: "三方渠道 ViralTok", badge: "推荐", keyLabel: "ViralTok API Key",
    desc: "如果你不想研究模型这些事，用这个。开通一个账号充值就能用，读片子、画新分镜、生成视频三样都走同一个 Key。",
    hint: "一个 Key 把读片子、生图、生视频全包了，不用分别开通。",
    covers: [[true, "读片子、出复刻方案", "按量计费"], [true, "画新分镜图", "按张计费"], [true, "生成分段视频", "按秒计费"]],
  },
  doubao: {
    name: "豆包 · 火山方舟", badge: "国内直连", keyLabel: "火山方舟 API Key",
    desc: "字节的大模型平台，国内网络直连最稳。一个 Key 全包：豆包读片子、Seedream 画分镜、Seedance 生成视频。新账号一般有免费额度。",
    hint: "在火山方舟控制台创建 API Key；Seedream、Seedance 要先在「开通管理」里点开通。",
    covers: [[true, "读片子、出复刻方案", "豆包，按量计费"], [true, "画新分镜图", "Seedream，按张计费"], [true, "生成分段视频", "Seedance，按秒计费"]],
  },
  qwen: {
    name: "通义千问 · 阿里云百炼", badge: "国内直连", keyLabel: "阿里云百炼 API Key",
    desc: "阿里云的大模型平台，国内网络直连。一个 Key 全包：千问读片子、万相画分镜、万相生成视频（10 秒以内还能照着原片动作拍）；同一个 Key 也能用百炼里的 DeepSeek、可灵。",
    hint: "在阿里云百炼控制台「API Key」里创建；新账号每个模型都有免费额度。",
    covers: [[true, "读片子、出复刻方案", "千问，按量计费"], [true, "画新分镜图", "万相 2.7 图像，按张计费"], [true, "生成分段视频", "万相 2.7，按秒计费"]],
  },
  custom: {
    name: "我已经有 Key 了", badge: "", keyLabel: "API Key",
    desc: "手上已经有 OpenAI、智谱、Kimi、DeepSeek，或其他 OpenAI 兼容接口的 Key 就填这里。生成视频要另配一家（火山方舟、阿里云百炼、三方渠道等，在设置里选）。",
    hint: "",
    covers: null,  // 按下面选的渠道算
  },
};
const CUSTOM_KINDS = {
  openai: { label: "OpenAI 官方", hint: "OpenAI 官方的 Key。也能画分镜图。", image: true, read: true },
  zhipu: { label: "智谱 GLM", hint: "智谱开放平台（open.bigmodel.cn）的 Key，默认用能看图的 GLM-4.6V。", image: false, read: true },
  kimi: { label: "Kimi（月之暗面）", hint: "月之暗面开放平台的 Key，默认用能看图的 Kimi K2.5。", image: false, read: true },
  deepseek: { label: "DeepSeek 官方", hint: "DeepSeek 开放平台的 Key。DeepSeek 看不了图：读片子要另配能看图的模型，它适合写脚本、改台词，最便宜。", image: false, read: false },
  custom: { label: "其他 OpenAI 兼容接口", hint: "填接口地址、Key 和模型名。任何兼容 OpenAI 格式的接口都行，读片子要选能看图的模型。", image: false, read: true },
};
const keyTabState = new Map();   // pid → {tab, kind, busy, error}

function analysisRoute() {
  const r = routeFor("analysis") || {};
  return { channel: r.channel, model: r.model, ready: !!STATUS?.providers?.[r.channel]?.ready };
}
const contentStarting = new Map();   // pid → 点下开始的时间：任务登记为运行中之前，也别再显示「开始」按钮
function contentRunning() {
  const a = P?.analysis || {};
  if (a.status === "running" && a.free_finished) { contentStarting.delete(P.id); return true; }
  const t = contentStarting.get(P?.id);
  if (t && Date.now() - t < 15000 && a.status !== "failed") return true;
  contentStarting.delete(P?.id);
  return false;
}
// 某一步现在用的渠道有没有 Key（生图、生视频的渠道名和推理的 Key 对应起来）
function stepKeyReady(step) {
  const r = routeFor(step) || {};
  if (["minimax", "imgcompat"].includes(r.channel)) return true;
  const k = { official: "openai", third_party: "jimmy", ark: "doubao", bailian: "qwen", kling: "qwen" }[r.channel] || r.channel;
  return !!STATUS?.providers?.[k]?.ready;
}
function keyCovers(tab, kind) {
  if (tab !== "custom") return KEY_TABS[tab].covers;
  return [[CUSTOM_KINDS[kind].read, "读片子、出复刻方案", CUSTOM_KINDS[kind].read ? "按你的渠道计价" : "看不了图，需另配"],
    [CUSTOM_KINDS[kind].image, "画新分镜图", CUSTOM_KINDS[kind].image ? "按张计费" : "需另配渠道"],
    [false, "生成分段视频", "需在设置里另配一家"]];
}
function renderKeyGate() {
  const st = keyTabState.get(P.id) || { tab: "viraltok", kind: "openai" };
  const t = KEY_TABS[st.tab], kind = CUSTOM_KINDS[st.kind];
  const covers = keyCovers(st.tab, st.kind).map(([ok, step, note]) =>
    `<li><span class="cover-mark ${ok ? "ok" : ""}">${ok ? "✓" : "—"}</span><span class="cover-step">${step}</span><span class="cover-note">${note}</span></li>`).join("");
  const customFields = st.tab === "custom" ? `
      <div class="key-field"><label for="keyKind">哪一家的 Key</label>
        <select id="keyKind" data-key-kind>${Object.entries(CUSTOM_KINDS).map(([k, v]) => `<option value="${k}" ${k === st.kind ? "selected" : ""}>${v.label}</option>`).join("")}</select></div>
      ${st.kind === "custom" ? `<div class="key-field"><label for="keyBase">接口地址</label><input id="keyBase" data-key-input placeholder="https://…/v1" autocomplete="off" value="${esc(st.values?.keyBase || "")}"></div>
      <div class="key-field"><label for="keyModel">用哪个模型读片子</label><input id="keyModel" data-key-input placeholder="模型名，例如 gpt-5.6-sol" autocomplete="off" value="${esc(st.values?.keyModel || "")}"></div>` : ""}` : "";
  const hint = st.tab === "custom" ? kind.hint : t.hint;
  return `<div class="keygate">
    <div class="keygate-head"><span class="keygate-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M14.6 9.4a3.6 3.6 0 10-4 4l-.8.8H8v2.4H5.6V19H3v-2.6l7.6-7.6z" stroke="#2f6f55" stroke-width="1.6" stroke-linejoin="round"></path><circle cx="16.4" cy="7.6" r="1.1" fill="#2f6f55"></circle></svg></span>
      <div><h1>再往下，需要一个会读片子的模型</h1>
      <p>刚才那一步已经把「这条片子是怎么拍的」弄清楚了，全程免费。但要知道它<strong>为什么抓人</strong>、台词该怎么改、哪一镜能换成你的店和你的人，得让大模型把片子读一遍——这部分按量计费，所以 Key 填在你自己手里。</p></div></div>
    <div class="keygate-card">
      <div class="keygate-tabs" role="tablist" aria-label="选择模型渠道">${Object.entries(KEY_TABS).map(([id, v]) =>
        `<button type="button" role="tab" aria-selected="${id === st.tab}" class="${id === st.tab ? "on" : ""}" data-key-tab="${id}">${esc(v.name)}${v.badge ? `<span class="tab-badge">${esc(v.badge)}</span>` : ""}</button>`).join("")}</div>
      <div class="keygate-panel" role="tabpanel">
        <p class="keygate-desc">${esc(t.desc)}</p>
        ${customFields}
        <div class="key-field"><label for="keyValue">${esc(st.tab === "custom" ? (CUSTOM_KINDS[st.kind]?.label || "") + " API Key" : t.keyLabel)}</label>
          <input id="keyValue" data-key-input type="password" placeholder="粘贴到这里" autocomplete="off" value="${esc(st.values?.keyValue || "")}"><span class="hint">${esc(hint)}</span>
          ${typeof keyHelpHtml === "function" ? keyHelpHtml(st.tab === "custom" ? st.kind : st.tab) : ""}</div>
        <div class="covers"><div class="covers-head">这个 Key 能管到哪几步</div><ul>${covers}</ul></div>
        <p class="hint">每一步以后都能在设置里单独换，比如写脚本用 DeepSeek、生视频换可灵。</p>
      </div>
    </div>
    <div class="keygate-safe"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.9l5 2.2v3.5c0 3.1-2 5.3-5 6.2-3-.9-5-3.1-5-6.2V4.1l5-2.2z" stroke="#2f6f55" stroke-width="1.4" stroke-linejoin="round"></path><path d="M5.9 8.1l1.5 1.5 2.8-3.1" stroke="#2f6f55" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path></svg>
      <p>Key 只保存在这台电脑上，不会上传，也不会写进项目文件。换电脑要重新填一次。</p></div>
    ${st.error ? `<div class="keygate-error" role="alert">${esc(st.error)}</div>` : ""}
    <div class="keygate-actions"><button type="button" class="big-cta" data-key-save ${st.busy ? "disabled" : ""}>${st.busy ? "正在检查 Key…" : "保存并开始内容拆解"} ${st.busy ? "" : ICON_ARROW}</button>
      <button type="button" class="link-btn" data-stage-go="free">先不填，回去导出免费结果</button></div>
  </div>`;
}
function keySettingsBody(st) {
  const key = $("#keyValue")?.value.trim();
  if (!key) throw new Error("先把 Key 粘贴进来");
  if (st.tab === "viraltok") return [{ JIMMY_API_KEY: key, DEFAULT_LLM: "jimmy", ROUTE_ANALYSIS: "jimmy", ROUTE_SCRIPT: "jimmy" }, "jimmy"];
  // 一家全包：生图、生视频原来没配好 Key 的，顺手换成这一家；已经能用的不动
  const fill = (image, video) => ({
    ...(stepKeyReady("storyboard_image") ? {} : { ROUTE_STORYBOARD_IMAGE: image, ROUTE_CAMERA_IMAGE: image }),
    ...(stepKeyReady("video") ? {} : { ROUTE_VIDEO: video }),
  });
  if (st.tab === "doubao") return [{ DOUBAO_API_KEY: key, DEFAULT_LLM: "doubao", ROUTE_ANALYSIS: "doubao", ROUTE_SCRIPT: "doubao",
    ...fill("ark:doubao-seedream-4-5-251128", "ark:doubao-seedance-2-0-260128") }, "doubao"];
  if (st.tab === "qwen") return [{ QWEN_API_KEY: key, DEFAULT_LLM: "qwen", ROUTE_ANALYSIS: "qwen", ROUTE_SCRIPT: "qwen",
    ...fill("bailian:wan2.7-image-pro", "bailian:wan2.7-r2v") }, "qwen"];
  if (st.kind === "zhipu") return [{ ZHIPU_API_KEY: key, ROUTE_ANALYSIS: "zhipu", ROUTE_SCRIPT: "zhipu" }, "zhipu"];
  if (st.kind === "kimi") return [{ KIMI_API_KEY: key, ROUTE_ANALYSIS: "kimi", ROUTE_SCRIPT: "kimi" }, "kimi"];
  if (st.kind === "openai") return [{ OPENAI_API_KEY: key, ROUTE_ANALYSIS: "openai", ROUTE_SCRIPT: "openai" }, "openai"];
  if (st.kind === "deepseek") {
    if (!analysisRoute().ready) throw new Error("DeepSeek 看不了图，读不了片子。先在上面选一个能看图的（通义千问、豆包、三方渠道都行）；DeepSeek 以后可以在设置里专门用来写脚本、改台词。");
    return [{ DEEPSEEK_API_KEY: key, ROUTE_SCRIPT: "deepseek" }, "deepseek"];
  }
  const base = $("#keyBase")?.value.trim(), model = $("#keyModel")?.value.trim();
  if (!base || !model) throw new Error("接口地址和模型名都要填");
  return [{ CUSTOM_API_KEY: key, CUSTOM_BASE_URL: base, CUSTOM_MODEL: model, ROUTE_ANALYSIS: "custom", ROUTE_SCRIPT: "custom" }, "custom"];
}
async function saveKeyAndStart() {
  const pid = P.id, st = { ...(keyTabState.get(pid) || { tab: "viraltok", kind: "openai" }) };
  let body, channel;
  try { [body, channel] = keySettingsBody(st); }
  catch (e) { keyTabState.set(pid, { ...st, error: e.message }); renderContentStage(); return; }
  keyTabState.set(pid, { ...st, busy: true, error: "" }); renderContentStage();
  try {
    await api("POST", "settings", body);
    const test = await api("POST", "settings/test-connection", { channel });
    if (test.status !== "可用") {
      const why = test.detail || { "key 无效": "这个 Key 用不了，检查一下有没有复制完整", "额度不足": "Key 是对的，但账户余额不够了，充值后再试" }[test.status] || "连不上这个渠道，检查一下网络或接口地址";
      throw new Error(why + "。Key 已经保存，改好后再点一次就行。");
    }
    STATUS = await api("GET", "status");
    delete P.resolved_routes;
    keyTabState.set(pid, { ...st, busy: false, error: "" });
    if (P?.id === pid) await startContent(false);
  } catch (e) {
    keyTabState.set(pid, { ...st, busy: false, error: e.message || String(e) });
    if (P?.id === pid) renderContentStage();
  }
}
async function startContent(confirmFirst = true) {
  const pid = P.id, r = analysisRoute();
  if (confirmFirst && !await pageConfirm(`内容拆解会用「${publicText(providerLabel(r.channel, STATUS?.providers?.[r.channel]))}」读一遍整条片子，按用量计费。现在开始？`)) return;
  operationErrors.delete(operationKey("analyze"));
  contentStarting.set(pid, Date.now());
  try { await api("POST", `projects/${pid}/analyze`, { ...requestRoute("analysis", $("#analyzeProvider")), mode: "content" }); }
  catch (e) { contentStarting.delete(pid); throw e; }
  if (P?.id !== pid) return;
  stageChoice.set(pid, "content");
  toast("开始内容拆解");
  await refresh(true);
}

const CONTENT_STEPS = [["overview", "整片理解", "看懂整条片子讲什么、为什么抓人"], ["close", "逐段细读", "每一段谁在做什么、说什么、商品什么时候出现"],
  ["pack", "拆解卡片", "整理成人物、场景、分镜、台词等 7 张卡"], ["storyboard", "原片分镜", "按镜头截图，9 格一张"]];
function contentStepItem([id, label, what]) {
  const st = P.analysis?.steps?.[id] || {};
  const tone = { done: "done", running: "running", partial: "skipped", failed: "failed", skipped: "done" }[st.status] || "pending";
  const icon = tone === "done" ? ICON_DONE_DOT : `<span class="dot ${tone}" aria-hidden="true"></span>`;
  const note = st.status === "running" ? `正在进行${st.progress ? " · " + esc(st.progress) : "…"}` : st.status === "failed" ? esc(st.note || "没完成")
    : st.status === "partial" ? "部分段落没读完，可以重新拆解" : esc(what);
  return `<li class="free-step ${tone}"><div class="free-step-head"><span class="free-step-name">${icon}${label}</span><span class="tag-paid">计费</span></div><p>${note}</p></li>`;
}
function renderContentStart() {
  const r = analysisRoute();
  return `<div class="content-start">
    <h1>内容拆解</h1>
    <p>用「${esc(publicText(providerLabel(r.channel, STATUS?.providers?.[r.channel])))}」把整条片子读一遍，会直接用上一步免费拆好的台词、镜头和拍摄方式，不用再等一遍。按用量计费。</p>
    <ol class="free-steps">${CONTENT_STEPS.map(contentStepItem).join("")}</ol>
    <div class="keygate-actions"><button type="button" class="big-cta" data-content-start>开始内容拆解 ${ICON_ARROW}</button>
      <button type="button" class="link-btn" data-flow-settings>换一个模型</button></div>
  </div>`;
}
function renderContentProgress() {
  const a = P.analysis || {}, failed = a.status === "failed";
  return `<div class="free-layout">
    <aside class="free-aside"><h2>${failed ? "内容拆解没有完成" : "正在做这几件事"}</h2><ol class="free-steps">${CONTENT_STEPS.map(contentStepItem).join("")}</ol></aside>
    <section class="free-main">${failed ? `<div class="free-error"><b>内容拆解没有完成</b><p>${esc(publicText(a.error || ""))}</p>
      <button type="button" data-content-start>重新拆解</button> <button type="button" class="ghost" data-flow-settings>检查 Key 和模型</button></div>`
      : `<div class="free-wait"><span class="spinner" aria-hidden="true"></span><h2>大模型正在读这条片子…</h2><p>一般几分钟。台词、镜头沿用了免费拆解的结果，没有重跑。</p></div>`}</section>
  </div>`;
}
const FRIENDLY_DOCS = [["台词表.srt", "字幕文件（按句）"], ["ANALYSIS.md", "整片理解"], ["TIMELINE.md", "逐段细读"],
  ["拍摄方式.md", "拍摄方式"], ["逐词时间轴.csv", "逐词时间轴（表格）"]];
function renderContentDone() {
  const a = P.analysis || {}, ov = P.breakdown?.overview || {}, vl = P.breakdown?.viralLogic || {};
  const docs = FRIENDLY_DOCS.filter(([name]) => a.docs?.[name]);
  const ready = stageDone("content");
  const lines = [["一句话", ov.summary || ov.logline], ["钩子", vl.hook], ["结构", vl.structure]].filter(([, v]) => v);
  return `<div class="content-done">
    <div class="free-done-card"><div class="free-done-title">${ICON_DONE_DOT}<h1>内容拆解${a.status === "partial" ? "部分完成" : "完成"}</h1></div>
      ${lines.length ? `<dl class="content-summary">${lines.map(([k, v]) => `<dt>${k}</dt><dd>${esc(publicText(v))}</dd>`).join("")}</dl>` : "<p>拆解卡片和原片分镜在下面。</p>"}
      ${docs.length ? `<div class="content-docs"><span>可以带走：</span>${docs.map(([name, label]) => `<a class="doc-link" href="${fileUrl(a.docs[name])}" download="${esc(name)}">${ICON_DOWNLOAD}${label}</a>`).join("")}</div>` : ""}</div>
    <div class="keygate-actions">${ready ? `<button type="button" class="big-cta" data-stage-go="replicate">继续：复刻成片 ${ICON_ARROW}</button>`
      : '<span class="hint">原片分镜还没生成好，生成完就能进入复刻。</span>'}
      <button type="button" class="link-btn" data-content-start>重新拆一次（会产生费用）</button></div>
  </div>`;
}
function renderContentStage() {
  const box = $("#keyGateLite");
  if (!box || !P) return;
  const a = P.analysis || {}, r = analysisRoute();
  let view;
  if (P.breakdown && !contentRunning()) view = "done";
  else if (contentRunning() || (a.status === "failed" && a.free_finished && a.content_started)) view = "progress";
  else if (!r.ready) view = "gate";
  else view = "start";
  updateHtml(box, { gate: renderKeyGate, start: renderContentStart, progress: renderContentProgress, done: renderContentDone }[view]());
  $("#step-2").hidden = view !== "done";
  $("#step-2").classList.toggle("content-results", view === "done");
}

// ---------- ④ 复刻成片：三个小步骤 + 素材条 + 用量 ----------
const REP_STEPS = [["cast", "选角换品", "#step-3"], ["compare", "对照修改", "#step-4"], ["final", "成片", "#step-5"]];
const repChoice = new Map();   // pid → 用户点选的小步骤
const PAID_RE = /重新生成分段方案|生成分段方案|生成视频|生成新分镜|重画|全部生成|批量裂变|按方案修改|重新生成这一段|确认付费|开始内容拆解|重新拆一次|保存并开始内容拆解/;
const ROLE_NAME = { person_identity: "人物", product_truth: "商品", voice_identity: "声线" };

function repDone(id) {
  const rows = workflowState();
  return { cast: rows[2].done, compare: rows[3].done, final: rows[4].done }[id];
}
function repLocked(id) {
  return { cast: false, compare: !repDone("cast"), final: !repDone("compare") && !P?.final_preview }[id];
}
function currentRep() {
  const chosen = repChoice.get(P?.id);
  if (chosen && !repLocked(chosen)) return chosen;
  return REP_STEPS.map(([id]) => id).find((id) => !repDone(id) && !repLocked(id)) || "final";
}
function usageSummary() {
  const rows = (P?.usage || []).filter((r) => r.kind !== "preview");
  const sum = (unit) => rows.filter((r) => r.billing?.unit === unit).reduce((n, r) => n + Number(r.billing?.amount || 0), 0);
  const points = sum("点"), seconds = sum("秒"), calls = rows.filter((r) => r.kind === "reason" && r.ok !== false).length;
  const parts = [];
  if (points) parts.push(`三方渠道 ${Number(points.toFixed(2))} 点`);
  if (seconds) parts.push(`视频 ${Math.round(seconds)} 秒`);
  if (calls) parts.push(`大模型 ${calls} 次`);
  return parts.length ? `本项目已用 ${parts.join(" · ")}` : "";
}
function renderUsagePill(stage) {
  const pill = $("#usagePill");
  if (!pill) return;
  const text = P && ["content", "replicate"].includes(stage) ? usageSummary() : "";
  pill.hidden = !text;
  pill.textContent = text;
  pill.title = text ? "按各渠道返回的用量统计，单价以你的渠道账户为准" : "";
}
function renderRepHead() {
  const box = $("#repHead");
  if (!box || !P) return;
  const cur = currentRep(), idx = REP_STEPS.findIndex(([id]) => id === cur);
  const next = REP_STEPS[idx + 1];
  updateHtml(box, `<nav class="rep-steps" aria-label="复刻步骤">${REP_STEPS.map(([id, label], i) => {
      const done = repDone(id), locked = repLocked(id), on = id === cur;
      return `<button type="button" class="rep-step ${on ? "is-current" : done ? "is-done" : locked ? "is-locked" : ""}" data-rep-go="${id}" ${locked ? 'aria-disabled="true" title="先完成前一步"' : ""}>
        <span class="num">${done && !on ? "✓" : i + 1}</span>${label}</button>${i < REP_STEPS.length - 1 ? '<span class="rep-line" aria-hidden="true"></span>' : ""}`;
    }).join("")}</nav>
    <div class="rep-head-side"><span class="paid-legend"><span class="paid-dot" aria-hidden="true"></span>带红点的按钮会花钱</span>
      ${next && repDone(cur) && !repLocked(next[0]) ? `<button type="button" class="small" data-rep-go="${next[0]}">下一步：${next[1]} ${ICON_ARROW}</button>` : ""}</div>`);
}
function renderRepAssets() {
  const box = $("#repAssets");
  if (!box || !P) return;
  const list = (P.assets || []).filter((a) => (a.roles || []).some((r) => ROLE_NAME[r]));
  updateHtml(box, `<span class="rep-assets-title">这个项目的素材</span>${list.map((a) => {
      const role = ROLE_NAME[(a.roles || []).find((r) => ROLE_NAME[r])];
      const pic = a.type === "audio" || role === "声线"
        ? '<span class="asset-wave" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 2.4v9.2M4.2 4.6v4.8M9.8 4.6v4.8M1.8 6.2v1.6M12.2 6.2v1.6" stroke="#5c6560" stroke-width="1.3" stroke-linecap="round"></path></svg></span>'
        : `<img src="${fileUrl(a.file)}" alt="" loading="lazy">`;
      return `<span class="asset-chip">${pic}${esc(role)} · ${esc(a.label || "未命名")}</span>`;
    }).join("") || '<span class="hint">还没有素材：放几张你的人物照片、商品照片进来</span>'}
    <button type="button" class="asset-add" data-pick-asset>＋ 加照片</button>
    <button type="button" class="asset-add" data-pick-audio>＋ 加声线</button>
    <button type="button" class="asset-add" data-library-project>从素材库选</button>
    <span class="rep-assets-note">素材只存在本机，可以在素材库里复用到别的项目</span>`);
}
function markPaidButtons() {
  $$("#workspace button, #fissionPanel button").forEach((b) => {
    const t = b.textContent || "";
    b.classList.toggle("paid", PAID_RE.test(t) && !/免费|取消|不用/.test(t));
  });
}
function renderReplicate(stage) {
  if (stage !== "replicate") { delete $("#workspace").dataset.sub; return; }
  const sub = currentRep();
  $("#workspace").dataset.sub = sub;
  renderRepHead();
  renderRepAssets();
  // 「选角换品」完成后旧逻辑会把它折叠成一行摘要；在新流程里它就是当前这一屏，始终展开
  if (sub === "cast") $("#step-3")?.classList.remove("is-collapsed");
}

// ---------- 首页 ----------
function hasUnsavedEdits() {
  return !!(P && (dirty.script || dirty.rep || dirty.breakdown || (typeof directorDrafts !== "undefined" && directorDrafts.get(P.id)?.dirty)));
}
function homeStatus(p) {
  if (p.analysis === "running") return ["拆解中", "busy", "看进度"];
  if (p.has_final) return ["已出片", "ok", "打开"];
  if (p.has_breakdown) return ["内容拆解已完成", "ok", "继续复刻"];
  if (p.analysis === "free_done") return ["免费拆解已完成", "ok", "看结果"];
  if (p.has_source) return ["视频已放好", "", "开始拆解"];
  return ["还没放视频", "", "放视频"];
}
function renderHome() {
  const box = $("#homeBody");
  if (!box) return;
  const list = (projectList || []).filter((p) => !p.derived_from);
  const day = (v) => { const d = v ? new Date(String(v).replace(" ", "T")) : null; return d && !isNaN(d) ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : ""; };
  const recent = list.length ? `<div class="home-recent-head"><h2>最近的项目</h2><span class="hint">共 ${list.length} 个</span></div>
    <ul class="home-recent">${list.slice(0, 12).map((p) => {
      const [label, tone, action] = homeStatus(p);
      const thumb = p.thumb ? `<img src="/files/${esc(p.id)}/${esc(p.thumb)}" alt="" loading="lazy">` : '<span class="home-thumb-empty" aria-hidden="true"></span>';
      return `<li><button type="button" class="home-card" data-open-recent="${esc(p.id)}">
        <span class="home-thumb">${thumb}</span>
        <span class="home-card-text"><b>${esc(p.name || "未命名项目")}</b><span class="badge ${tone}">${label}</span>
        <small>${p.origin ? `来自${esc(p.origin)} · ` : ""}${day(p.created_at)}${p.shots ? ` · ${p.shots} 个镜头` : ""}</small></span>
        <span class="home-card-go">${action} ${ICON_ARROW}</span></button></li>`;
    }).join("")}</ul>` : `<p class="home-empty">还没有项目。可以从上面找一条同行的爆款开始。</p>`;
  updateHtml(box, renderFindViral() + `<p class="home-upload-entry"><button type="button" class="ghost" data-flow-new>自己放一条视频进来</button></p>` + recent);
  const city = $("#fvCity"); if (city && !city.value) city.value = storeGet("vrc.fvCity") || "";
  maybeOpenAbout();
  syncFindViralEmbed();
}

const ABOUT_SEEN_KEY = "vrc.aboutAutoSeen";
function aboutDialogEl() { return $("#aboutDialog"); }
function aboutIsOpen(d) { return !!(d && (d.open || d.hasAttribute("open"))); }
function openAbout(opts = {}) {
  const d = aboutDialogEl();
  if (!d) return;
  const skip = $("#aboutSkipBtn");
  if (skip) skip.hidden = !opts.auto;
  if (typeof d.showModal === "function") {
    if (!d.open) d.showModal();
  } else {
    d.setAttribute("open", "");
    d.open = true;
  }
  syncFindViralEmbed();
}
function closeAbout() {
  store(ABOUT_SEEN_KEY, "1");
  const d = aboutDialogEl();
  if (!d) return;
  if (typeof d.close === "function") {
    if (d.open) d.close();
  } else {
    d.removeAttribute("open");
    d.open = false;
  }
  syncFindViralEmbed();
}
function maybeOpenAbout() {
  if (P || $("#emptyState")?.hidden) return;
  if (storeGet(ABOUT_SEEN_KEY)) return;
  const d = aboutDialogEl();
  if (aboutIsOpen(d)) return;
  openAbout({ auto: true });
}
$("#aboutDialog")?.addEventListener("close", () => { store(ABOUT_SEEN_KEY, "1"); syncFindViralEmbed(); });
// ---------- 首页：找同行的爆款 ----------
// 桌面版：把平台页嵌进首页当前 Tab 下方，复用 persist:find-viral；搜索、切 Tab、行业词都在这片区域更新，不再新开浏览窗口（build/browse.js）。
// 浏览器里打开的工作台没有内置会话：在新标签页打开平台搜索，下载视频后拖进来。
const FV_PLATFORMS = [
  { id: "douyin", name: "抖音", search: (k) => `https://www.douyin.com/search/${encodeURIComponent(k)}?type=video` },
  { id: "xiaohongshu", name: "小红书", search: (k) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(k)}&source=web_search_result_notes` },
  { id: "bilibili", name: "B站", search: (k) => `https://search.bilibili.com/video?keyword=${encodeURIComponent(k)}` },
];
const FV_INDUSTRIES = [
  ["餐饮", ["烤鱼", "火锅", "烧烤", "小龙虾", "麻辣烫", "奶茶", "咖啡", "烘焙", "早餐"]],
  ["美业", ["美甲", "美发", "美容", "美睫", "按摩"]],
  ["生活服务", ["健身房", "瑜伽", "宠物店", "洗车", "汽车美容", "民宿", "婚纱摄影", "花店"]],
];
let fvPlatform = null;
function fvCurrentPlatform() {
  if (!fvPlatform) fvPlatform = FV_PLATFORMS.some((p) => p.id === storeGet("vrc.fvPlatform")) ? storeGet("vrc.fvPlatform") : "douyin";
  return fvPlatform;
}
function inDesktop() { return !!(window.__browse && window.__browse.available); }
const ICON_FV_BACK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
const ICON_FV_FORWARD = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
const ICON_FV_RELOAD = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
function renderFindViral() {
  const cur = fvCurrentPlatform();
  const desktop = inDesktop();
  const pane = desktop ? `<div class="fv-pane">
      <div class="fv-toolbar">
        <div class="fv-nav">
          <button type="button" class="icon-btn" data-fv-back title="后退" aria-label="后退" disabled>${ICON_FV_BACK}</button>
          <button type="button" class="icon-btn" data-fv-forward title="前进" aria-label="前进" disabled>${ICON_FV_FORWARD}</button>
          <button type="button" class="icon-btn" data-fv-reload title="刷新" aria-label="刷新">${ICON_FV_RELOAD}</button>
        </div>
        <div class="fv-status" id="fvStatus">打开一条视频，看到它在播放了，点「同款复刻」</div>
        <button type="button" class="fv-capture" data-fv-capture>同款复刻</button>
      </div>
      <div class="fv-embed" id="fvEmbed" data-fv-url="" aria-label="平台内容"></div>
    </div>` : "";
  return `<section class="fv" aria-labelledby="fvTitle">
    <div class="fv-head">
      <div><h2 id="fvTitle">找同行的爆款</h2>
        <p class="hint">${desktop ? "在下面刷同行怎么拍。搜索、切平台、点行业词都留在这一页，不会新开窗口。看中了点「同款复刻」就直接建好项目。" : "会在新标签页打开平台搜索。看中的视频下载下来，拖进新项目就行（桌面版可以一键同款复刻）。"}</p></div>
      <div class="fv-tabs" role="group" aria-label="平台">${FV_PLATFORMS.map((p) => `<button type="button" data-fv-platform="${p.id}" aria-pressed="${p.id === cur}">${p.name}</button>`).join("")}</div>
    </div>
    <form class="fv-search" data-fv-form>
      <input id="fvCity" class="fv-city" placeholder="城市（可不填）" aria-label="城市" maxlength="12" autocomplete="off">
      <input id="fvKeyword" placeholder="搜什么？比如：烤鱼店、美甲、探店" aria-label="搜索关键词" maxlength="40" autocomplete="off">
      <button type="submit">去找爆款</button>
    </form>
    <div class="fv-industries">${FV_INDUSTRIES.map(([group, words]) => `<div class="fv-group"><span>${group}</span>${words.map((w) => `<button type="button" class="chip" data-fv-word="${esc(w)}">${esc(w)}</button>`).join("")}</div>`).join("")}</div>
    <form class="fv-link" data-fv-link>
      <span class="fv-link-label">有分享链接？</span>
      <input id="fvLink" placeholder="在抖音 / 小红书 / B站点「分享 → 复制链接」，粘贴到这里" aria-label="分享链接" autocomplete="off">
      <button type="submit" class="ghost">打开</button>
    </form>
    ${pane}
  </section>`;
}
function fvLinkFrom(text) { const m = String(text || "").match(/https?:\/\/[^\s，。,；;"'<>【】]+/); return m ? m[0] : ""; }
let fvAttached = false, fvEmbedObs = null, fvEmbedWired = false;
function hideFindViralEmbed() {
  if (inDesktop() && window.__browse && window.__browse.hide) window.__browse.hide();
}
function anyOverlayOpen() {
  if (aboutIsOpen(aboutDialogEl())) return true;
  if (typeof document.querySelector === "function" && document.querySelector("dialog[open]")) return true;
  const lib = $("#libraryPanel"); if (lib && !lib.hidden) return true;
  const fis = $("#fissionPanel"); if (fis && !fis.hidden) return true;
  const conf = $("#pageConfirmation"); if (conf && !conf.hidden) return true;
  return false;
}
function fvEmbedVisibleBounds() {
  const el = $("#fvEmbed");
  if (!el || typeof el.getBoundingClientRect !== "function") return null;
  const r = el.getBoundingClientRect();
  const vw = (typeof window !== "undefined" && window.innerWidth) || r.right || r.width || 0;
  const vh = (typeof window !== "undefined" && window.innerHeight) || r.bottom || r.height || 0;
  const x = Math.max(0, r.left);
  const y = Math.max(0, r.top);
  const width = Math.min(vw, r.right) - x;
  const height = Math.min(vh, r.bottom) - y;
  if (width < 8 || height < 8) return null;
  return { x, y, width, height };
}
function applyFvState(s) {
  if (!s) return;
  const back = $("[data-fv-back]");
  const forward = $("[data-fv-forward]");
  const embed = $("#fvEmbed");
  const status = $("#fvStatus");
  if (back) back.disabled = !s.canBack;
  if (forward) forward.disabled = !s.canForward;
  if (embed && s.url) embed.setAttribute("data-fv-url", s.url);
  if (status) {
    status.className = "fv-status" + (s.status && s.status.kind ? " " + s.status.kind : "");
    status.textContent = (s.status && s.status.text) || (s.loading ? "加载中…" : "打开一条视频，看到它在播放了，点「同款复刻」");
  }
}
function wireFindViralEmbed() {
  const relayout = () => { if (!P) syncFindViralEmbed(); };
  const el = $("#fvEmbed");
  if (typeof ResizeObserver !== "undefined") {
    if (!fvEmbedObs) fvEmbedObs = new ResizeObserver(relayout);
    try { fvEmbedObs.disconnect(); if (el) fvEmbedObs.observe(el); } catch (_) { /* 测试 DOM 可能没有完整观察器 */ }
  }
  if (fvEmbedWired) return;
  fvEmbedWired = true;
  window.addEventListener("resize", relayout);
  window.addEventListener("scroll", relayout, true);
  for (const id of ["settingsDialog", "updateDialog", "aboutDialog"]) {
    const d = $("#" + id);
    if (d && !d.__fvWired) { d.__fvWired = true; d.addEventListener("close", relayout); }
  }
}
function syncFindViralEmbed() {
  if (!inDesktop() || !window.__browse) return;
  const onHome = !P && $("#emptyState") && !$("#emptyState").hidden && $("#fvEmbed");
  if (!onHome || anyOverlayOpen()) { hideFindViralEmbed(); return; }
  wireFindViralEmbed();
  const bounds = fvEmbedVisibleBounds();
  if (bounds && window.__browse.layout) window.__browse.layout(bounds);
  if (!fvAttached) {
    fvAttached = true;
    const city = ($("#fvCity")?.value || "").trim();
    const kw = ($("#fvKeyword")?.value || "").trim();
    fvOpen({ platform: fvCurrentPlatform(), keyword: kw ? [city, kw].filter(Boolean).join(" ") : undefined });
  }
}
async function fvOpen(opts) {
  if (inDesktop()) {
    try {
      const result = await window.__browse.open(opts);
      if (result && result.url) {
        const embed = $("#fvEmbed");
        if (embed) embed.setAttribute("data-fv-url", result.url);
      }
      const bounds = fvEmbedVisibleBounds();
      if (bounds && window.__browse.layout) await window.__browse.layout(bounds);
    } catch (err) { toast(`没打开：${err.message || err}`, true); }
    return;
  }
  const p = FV_PLATFORMS.find((x) => x.id === opts.platform) || FV_PLATFORMS[0];
  window.open(opts.url || p.search(opts.keyword), "_blank", "noopener");
}
function fvSearch(word) {
  const city = ($("#fvCity")?.value || "").trim();
  const kw = (word || $("#fvKeyword")?.value || "").trim();
  if (!kw) { $("#fvKeyword")?.focus(); toast("先输入要找的行业或关键词，或者点下面的常用行业"); return; }
  store("vrc.fvCity", city);
  if (word && $("#fvKeyword")) $("#fvKeyword").value = word;
  fvOpen({ platform: fvCurrentPlatform(), keyword: [city, kw].filter(Boolean).join(" ") });
}
document.addEventListener("submit", (e) => {
  if (e.target.closest("[data-fv-form]")) { e.preventDefault(); fvSearch(); }
  if (e.target.closest("[data-fv-link]")) {
    e.preventDefault();
    const url = fvLinkFrom($("#fvLink")?.value);
    if (!url) { toast("没认出链接。复制平台「分享」里的链接或整段分享文字，粘贴进来就行", true); return; }
    fvOpen({ url });
    $("#fvLink").value = "";
  }
});
if (window.__browse && window.__browse.onState) window.__browse.onState(applyFvState);
if (window.__browse && window.__browse.onImported) {
  window.__browse.onImported(async (project) => {
    try { await refreshProjectList(); } catch (_) { /* 打开项目时会再读 */ }
    if (project && project.id) {
      if (!project.focus) toast(`已建好项目「${project.name || ""}」，视频已经放好了`);
      if (P?.id !== project.id) await openProject(project.id);
    }
  });
}

// ---------- 项目里的「来源」卡片 ----------
const FV_STAT = { views: "播放", likes: "点赞", comments: "评论", collects: "收藏", shares: "分享", coins: "投币" };
function originCard(o) {
  if (!o) return "";
  const stats = Object.entries(o.stats || {}).filter(([, v]) => v).map(([k, v]) => `<span><b>${esc(v)}</b>${FV_STAT[k] || k}</span>`).join("");
  const comments = (o.comments || []).slice(0, 6);
  const text = o.desc || o.title || "";
  return `<section class="origin-card">
    <header><span class="origin-platform">${esc(o.platform_name || "网页")}</span>
      <b>${esc(o.author ? "@" + o.author : "原视频")}</b>
      ${o.url ? `<button type="button" class="link-btn" data-origin-open="${esc(o.url)}">看原视频 ${ICON_ARROW}</button>` : ""}</header>
    ${o.title && o.desc && o.title !== o.desc ? `<p class="origin-title">${esc(o.title)}</p>` : ""}
    ${text ? `<p class="origin-desc">${esc(text)}</p>` : ""}
    ${stats ? `<div class="origin-stats">${stats}<small>${esc(String(o.captured_at || "").slice(0, 16))} 记录</small></div>` : ""}
    ${comments.length ? `<details class="origin-comments" open><summary>评论区（${comments.length} 条，导入时页面上能看到的）</summary>
      <ul>${comments.map((c) => `<li>${c.user ? `<b>${esc(c.user)}</b>` : ""}<span>${esc(c.text)}</span>${c.likes ? `<small>${esc(c.likes)} 赞</small>` : ""}</li>`).join("")}</ul></details>` : ""}
  </section>`;
}
document.addEventListener("click", (e) => {
  if (inDesktop() && window.__browse && window.__browse.act) {
    if (e.target.closest("[data-fv-back]")) { window.__browse.act("back"); return; }
    if (e.target.closest("[data-fv-forward]")) { window.__browse.act("forward"); return; }
    if (e.target.closest("[data-fv-reload]")) { window.__browse.act("reload"); return; }
    if (e.target.closest("[data-fv-capture]")) { window.__browse.act("capture"); return; }
  }
  const tab = e.target.closest("[data-fv-platform]");
  if (tab) {
    fvPlatform = tab.dataset.fvPlatform;
    store("vrc.fvPlatform", fvPlatform);
    document.querySelectorAll("[data-fv-platform]").forEach((b) => b.setAttribute("aria-pressed", String(b === tab)));
    if (inDesktop()) {
      const city = ($("#fvCity")?.value || "").trim();
      const kw = ($("#fvKeyword")?.value || "").trim();
      fvOpen({ platform: fvPlatform, keyword: kw ? [city, kw].filter(Boolean).join(" ") : undefined });
    }
    return;
  }
  const word = e.target.closest("[data-fv-word]");
  if (word) { fvSearch(word.dataset.fvWord); return; }
  const orig = e.target.closest("[data-origin-open]");
  if (orig) { fvOpen({ url: orig.dataset.originOpen }); }
});

async function showHome() {
  if (hasUnsavedEdits() && !await pageConfirm("还有没保存的修改，回到首页会丢掉这些修改。仍然回到首页？")) {
    renderProjectOptions(P?.id);
    return;
  }
  beginProjectView();
  if (typeof closeBatchBoard === "function") closeBatchBoard();
  P = null; S = null;
  Object.keys(dirty).forEach((k) => (dirty[k] = false));
  $("#workspace").hidden = true;
  $("#emptyState").hidden = false;
  renderFlow();
  window.scrollTo({ top: 0 });
  try { await refreshProjectList(); } catch (_) { /* 列表刷新失败就用旧的 */ }
  renderProjectOptions(null);
  renderHome();
}

// ---------- 设置：识别台词的模型 ----------
let asrModels = null, asrTimer = null;
function renderAsrModels() {
  const box = $("#asrModelsBox");
  if (!box) return;
  if (!asrModels) { updateHtml(box, '<h3>识别台词的模型</h3><p class="hint">正在读取…</p>'); return; }
  const busy = asrModels.tiers.some((t) => t.state === "running");
  updateHtml(box, `<h3>识别台词的模型</h3><p class="hint">越大越准，也越慢、越占硬盘。随时可以换，换了下次拆解就生效。</p>
    <div class="asr-tiers">${asrModels.tiers.map((t) => {
      let action;
      if (t.current && t.installed) action = '<span class="asr-current">正在使用</span>';
      else if (t.state === "running") action = `<span class="asr-progress"><span style="width:${Math.round((t.progress || 0) * 100)}%"></span></span><small>下载中 ${Math.round((t.progress || 0) * 100)}%</small><button type="button" class="link-btn small" data-asr="cancel" data-tier="${t.id}">取消</button>`;
      else if (t.installed) action = `<button type="button" class="ghost small" data-asr="use" data-tier="${t.id}">换成这个</button>`;
      else action = `<button type="button" class="small" data-asr="download" data-tier="${t.id}" ${busy ? "disabled" : ""}>下载并使用</button>`;
      return `<div class="asr-tier ${t.current ? "is-current" : ""}"><div class="asr-tier-head"><b>${esc(t.name)}</b>${t.tag ? `<span class="tab-badge">${esc(t.tag)}</span>` : ""}<span class="hint">${esc(t.size)}</span></div>
        <p>${esc(t.desc)}</p>${t.error ? `<p class="asr-error">${esc(t.error)}</p>` : ""}<div class="asr-action">${action}</div></div>`;
    }).join("")}</div>`);
}
async function loadAsrModels() {
  clearTimeout(asrTimer);
  try { asrModels = await api("GET", "asr-models"); } catch (_) { asrModels = asrModels || null; }
  renderAsrModels();
  const quick = !!document.querySelector("[data-asr-quick]");
  if (quick && P) renderFlow();
  if (($("#settingsDialog")?.open || quick) && asrModels?.tiers.some((t) => t.state === "running")) asrTimer = setTimeout(loadAsrModels, 2000);
}

// ---------- 设置：电脑体检 + 本机模型（Ollama 跑千问） ----------
let localLlm = null, localLlmTimer = null, localLlmBusy = false;
function gb(n) { return n ? `${n} GB` : "—"; }
function renderLocalLlm() {
  const box = $("#localLlmBox");
  if (!box) return;
  if (!localLlm) { updateHtml(box, '<h3>本机模型（免费）</h3><p class="hint">正在检查这台电脑…</p>'); return; }
  const { hardware: hw, recommend: rec, ollama: ol, pull } = localLlm;
  const gpu = hw.gpu ? `${esc(hw.gpu.name)} · ${gb(hw.gpu.vram_gb)} 显存` : hw.apple_silicon ? "苹果芯片（显存和内存共用）" : "没有检测到 NVIDIA 显卡";
  const recModel = localLlm.models.find((m) => m.id === rec.model);
  const verdict = `<ul class="hw-verdict">
      <li><span class="cover-mark ok">✓</span><span>识别台词</span><small>能跑（免费拆解就在用）</small></li>
      <li><span class="cover-mark ${rec.model ? "ok" : ""}">${rec.model ? "✓" : "—"}</span><span>本机大模型</span><small>${esc(rec.speed)}${recModel ? `，推荐 ${esc(recModel.name)}` : ""}</small></li>
      <li><span class="cover-mark">—</span><span>本机生成视频</span><small>${esc(rec.video)}</small></li></ul>`;
  let step;
  if (!ol.running) {
    step = `<div class="local-step"><b>第 1 步：安装 Ollama</b><p class="hint">${ol.installed ? "Ollama 已经装了，但还没打开：打开它（Windows 右下角、Mac 菜单栏会出现它的图标），再点「重新检查」。" : "Ollama 是免费的本机模型运行软件，千问靠它在你电脑上跑。下载安装后打开它，再回来点「重新检查」。"}</p>
      <div class="local-actions">${ol.installed ? "" : `<a class="button" href="${esc(localLlm.download_url)}" target="_blank" rel="noopener">去官网下载 Ollama</a>`}<button type="button" class="ghost" data-local-llm="refresh">重新检查</button></div></div>`;
    // 这台电脑本来就跑不动：别把安装步骤摆在最显眼的地方，收起来给想试的人
    if (!rec.model) step = `<p class="hint">这台电脑跑本机大模型会很慢，用上面的云端模型就好。</p><details class="local-anyway"><summary>还是想试试？</summary>${step}</details>`;
  } else {
    const busy = pull?.state === "running";
    const pct = pull?.total ? Math.round((pull.completed / pull.total) * 100) : 0;
    step = `<div class="asr-tiers">${localLlm.models.map((m) => {
      let action;
      if (m.current) action = '<span class="asr-current">正在使用</span>';
      else if (busy && pull.model === m.id) action = `<span class="asr-progress"><span style="width:${pct}%"></span></span><small>下载中 ${pct}%</small><button type="button" class="link-btn small" data-local-llm="cancel">取消</button>`;
      else if (m.installed) action = `<button type="button" class="small" data-local-llm="use" data-model="${m.id}">用它</button>`;
      else action = `<button type="button" class="small" data-local-llm="pull" data-model="${m.id}" ${busy ? "disabled" : ""}>下载</button>`;
      return `<div class="asr-tier ${m.current ? "is-current" : ""}"><div class="asr-tier-head"><b>${esc(m.name)}</b>${m.id === rec.model ? '<span class="tag">推荐</span>' : ""}<span class="asr-size">${esc(m.size)}</span></div>
        <p>${esc(m.desc)}</p><div class="asr-action">${action}</div></div>`;
    }).join("")}</div>
    ${pull?.state === "failed" ? `<p class="hint warn">下载没完成：${esc(pull.error || "")}。检查网络后再点一次下载，已下好的部分不会重下。</p>` : ""}
    ${localLlm.current ? (() => {
      const all = STATUS?.routes?.analysis?.channel === "ollama";
      return `<div class="local-scope"><span>本机模型用在：</span>
      <button type="button" class="small ${all ? "ghost" : ""}" data-local-llm="scope" data-scope="text" data-model="${esc(localLlm.current)}" aria-pressed="${!all}">只写脚本、改台词（推荐）</button>
      <button type="button" class="small ${all ? "" : "ghost"}" data-local-llm="scope" data-scope="all" data-model="${esc(localLlm.current)}" aria-pressed="${all}">读片子也用它（更慢）</button></div>`;
    })() : ""}`;
  }
  updateHtml(box, `<h3>本机模型（免费）</h3>
    <p class="hint">在你自己的电脑上跑千问：不花钱，但比云端慢、效果也差一截，适合写脚本、改台词这类纯文字的活。</p>
    <div class="hw-line">这台电脑：${gpu} ｜ 内存 ${gb(hw.ram_gb)}</div>${verdict}${step}`);
}
async function loadLocalLlm() {
  clearTimeout(localLlmTimer);
  try { localLlm = await api("GET", "local-llm"); } catch (_) { localLlm = localLlm || null; }
  renderLocalLlm();
  if ($("#settingsDialog")?.open && localLlm?.pull?.state === "running") localLlmTimer = setTimeout(loadLocalLlm, 1500);
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-local-llm]");
  if (!b || localLlmBusy) return;
  const act = b.dataset.localLlm;
  localLlmBusy = true;
  try {
    if (act === "refresh") localLlm = await api("GET", "local-llm");
    else if (act === "cancel") localLlm = await api("POST", "local-llm/cancel", {});
    else if (act === "pull") localLlm = await api("POST", "local-llm/pull", { model: b.dataset.model });
    else if (act === "use" || act === "scope") {
      localLlm = await api("POST", "local-llm/use", { model: b.dataset.model, scope: b.dataset.scope || "text" });
      toast(b.dataset.scope === "all" ? "读片子、写脚本都改用本机千问了" : "写脚本、改台词改用本机千问了，读片子还用原来的模型");
      try { await refresh(true); } catch (_) { /* 设置弹窗里不强求刷新项目 */ }
    }
  } catch (err) { toast(err.message || String(err), true); }
  finally { localLlmBusy = false; }
  renderLocalLlm();
  if (localLlm?.pull?.state === "running") { clearTimeout(localLlmTimer); localLlmTimer = setTimeout(loadLocalLlm, 1500); }
});

// ---------- 总入口 ----------
function renderFlow() {
  document.body.classList.toggle("at-home", !P);
  if (!P) { updateHtml($("#stageNav"), ""); renderHome(); return; }
  hideFindViralEmbed();
  const stage = currentStage();
  $("#workspace").dataset.stage = stage;
  renderStageNav(stage);
  renderRecentProjects();
  renderUploadNext();
  renderFreeStage();
  renderContentStage();
  renderReplicate(stage);
  renderUsagePill(stage);
  markPaidButtons();
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
    if (a.status === "running" && !analyzeJobError()) return;
    if (freeDone() && !await pageConfirm("重新拆解会覆盖这次的免费拆解结果，继续？")) return;
    guard(submitFreeAnalyze);
    return;
  }
  if (e.target.closest("[data-go-home]")) { if (P) showHome(); return; }
  if (e.target.closest("[data-about-open]")) { openAbout({ auto: false }); return; }
  if (e.target.closest("[data-about-close]")) { closeAbout(); return; }
  const recent = e.target.closest("[data-open-recent]");
  if (recent) { if (recent.dataset.openRecent !== P?.id) openProject(recent.dataset.openRecent); return; }
  if (e.target.closest("[data-flow-new]")) { newProject(); return; }
  const diag = e.target.closest("#diagLink");
  if (diag) { diag.href = "/api/diagnostics" + (P?.id ? "?project=" + encodeURIComponent(P.id) : ""); return; }
  const flowSettings = e.target.closest("[data-flow-settings]");
  if (flowSettings) {
    Promise.resolve(openSettings()).then(() => {
      if (flowSettings.hasAttribute("data-open-local") && $("#settingsLocal")) { $("#settingsLocal").open = true; $("#asrModelsBox")?.scrollIntoView({ block: "start" }); }
    });
    loadAsrModels(); loadLocalLlm(); return;
  }
  if (e.target.closest("#settingsBtn")) { hideFindViralEmbed(); loadAsrModels(); loadLocalLlm(); return; }
  const asr = e.target.closest("[data-asr]");
  if (asr) {
    e.preventDefault();
    try { asrModels = await api("POST", `asr-models/${asr.dataset.tier}/${asr.dataset.asr}`); }
    catch (err) { toast(err.message, true); }
    renderAsrModels();
    if (document.querySelector("[data-asr-quick]") && P) renderFlow();
    if (asr.dataset.asr !== "cancel") loadAsrModels();
    return;
  }
  if (e.target.closest("[data-pick-source]")) { $("#sourceInput")?.click(); return; }
  if (e.target.closest("[data-pick-asset]")) { $("#assetInput")?.click(); return; }
  if (e.target.closest("[data-pick-audio]")) { $("#audioInput")?.click(); return; }
  const rep = e.target.closest("[data-rep-go]");
  if (rep && P) { if (rep.getAttribute("aria-disabled") !== "true") { repChoice.set(P.id, rep.dataset.repGo); renderFlow(); window.scrollTo({ top: 0 }); } return; }
  const tab = e.target.closest("[data-key-tab]");
  if (tab && P) { const st = keyTabState.get(P.id) || { kind: "openai" }; keyTabState.set(P.id, { ...st, tab: tab.dataset.keyTab, error: "" }); renderContentStage(); return; }
  if (e.target.closest("[data-key-save]")) { if (!(keyTabState.get(P?.id) || {}).busy) saveKeyAndStart(); return; }
  if (e.target.closest("[data-content-start]")) { if (!contentRunning()) guard(() => startContent(true)); return; }
});

// 输入的 Key 暂存在内存里：页面每次刷新重画时原样放回去，不会被清空
document.addEventListener("input", (e) => {
  const el = e.target.closest?.("[data-key-input]");
  if (el && P) { const st = keyTabState.get(P.id) || { tab: "viraltok", kind: "openai" }; keyTabState.set(P.id, { ...st, values: { ...(st.values || {}), [el.id]: el.value } }); }
});
document.addEventListener("change", (e) => {
  const kind = e.target.closest("[data-key-kind]");
  if (kind && P) { const st = keyTabState.get(P.id) || { tab: "custom" }; keyTabState.set(P.id, { ...st, kind: kind.value, error: "" }); renderContentStage(); }
});
