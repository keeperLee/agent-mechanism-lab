/* ============================================================
   实验室一：ReAct 循环单步执行与回放
   ============================================================ */

import { $, esc, fmt, pct, clamp } from '../ui.js';
import {
  TRACES, AGENT_SYSTEM_PROMPT
} from '../data/traces.js';
import {
  estimateTokens, estimateValueTokens, estimateToolTokens, MESSAGE_OVERHEAD
} from '../tokens.js';

let traceIndex = 0;
let stepIndex = -1;       // -1 = 只显示用户提问，还没开始循环
let timer = null;
let showSystem = false;

/** 把模型输出里的 ReAct 标记涂上颜色。先转义再包装，避免 XSS */
function formatModelOutput(text) {
  return esc(text)
    .replace(/^(Action Input:)/gm, '<span class="c-act">$1</span>')
    .replace(/^(Action:)/gm, '<span class="c-act">$1</span>')
    .replace(/^(Thought:)/gm, '<span class="c-think">$1</span>')
    .replace(/^(Final Answer:)/gm, '<span class="c-final">$1</span>');
}

function jsonBlock(obj) {
  return esc(JSON.stringify(obj, null, 2));
}

/**
 * 计算走到第 step 步时的上下文构成。
 *
 * 【这个函数的教学价值】
 * 它把「多轮对话为什么贵」算了出来：系统提示和工具定义是**固定开销**，
 * 每一轮都要重发；而对话累积随步数线性增长。
 * stepIndex = -1 表示只发出了系统提示、工具定义和用户提问。
 */
function contextAt(trace, step) {
  const sys = estimateTokens(trace.systemPrompt);
  const tools = trace.tools.reduce((a, t) => a + estimateToolTokens(t), 0);

  let conv = MESSAGE_OVERHEAD + estimateTokens(trace.userMessage);
  for (let i = 0; i <= step && i < trace.steps.length; i += 1) {
    const s = trace.steps[i];
    conv += MESSAGE_OVERHEAD + estimateTokens(s.modelOutput);
    if (s.observation) conv += MESSAGE_OVERHEAD + estimateValueTokens(s.observation);
  }

  return { sys, tools, conv, total: sys + tools + conv };
}

/* ---------------- 渲染 ---------------- */

function renderTrack(trace) {
  const items = trace.steps.map((s, i) => {
    const kindLabel = s.kind === 'final' ? '答' : String(i + 1);
    const cls = i === stepIndex ? ' is-current' : (i < stepIndex ? ' is-done' : '');
    return `
      <button class="rl-track-item${cls}" type="button" data-goto="${i}"
        aria-current="${i === stepIndex ? 'true' : 'false'}">
        <span class="rl-track-dot">${kindLabel}</span>
        <span>${esc(s.kind === 'final' ? '给出结论' : s.action.name)}</span>
      </button>`;
  }).join('');

  const counter = stepIndex === -1
    ? `未开始 · 共 ${trace.steps.length} 步`
    : `第 ${stepIndex + 1} / ${trace.steps.length} 步`;

  return `<div class="rl-track-wrap">
    <div class="rl-track" role="tablist" aria-label="循环步骤">
      <button class="rl-track-item${stepIndex === -1 ? ' is-current' : ''}" type="button" data-goto="-1"
        aria-current="${stepIndex === -1 ? 'true' : 'false'}">
        <span class="rl-track-dot">起</span><span>用户提问</span>
      </button>
      <span class="rl-track-sep">›</span>
      ${items}
    </div>
    <span class="rl-track-count">${counter}</span>
  </div>`;
}

/**
 * 起点卡片：循环开始前，窗口里到底有什么。
 * 这一步以前是缺的 —— 直接从「第 1 步」开始看，读者不知道模型在被要求选工具之前
 * 手里握着什么，「工具定义是一笔固定开销」也就没有落点。
 */
function renderStart(trace) {
  const c = contextAt(trace, -1);
  const tools = trace.tools.map((t) => `
    <div class="rl-tool">
      <span class="mono">${esc(t.name)}</span>
      <span class="rl-tool-cost">${fmt(estimateToolTokens(t))} token</span>
    </div>`).join('');

  return `
    <section class="rl-step is-active">
      <header class="rl-step-head">
        <span class="rl-kind">起点</span>
        <span class="rl-step-title">循环开始前：窗口里有什么</span>
        <span class="rl-step-meta">合计 ${fmt(c.total)} token</span>
      </header>
      <div class="rl-step-body">
        <div class="rl-field">
          <div class="rl-field-label">用户提问 <span class="val">由用户输入</span></div>
          <div class="rt-snippet">${esc(trace.userMessage)}</div>
        </div>
        <div class="rl-pair">
          <div class="rl-field">
            <div class="rl-field-label">系统提示 <span class="val">${fmt(c.sys)} token</span></div>
            <pre class="code is-capped">${esc(trace.systemPrompt)}</pre>
          </div>
          <div class="rl-field">
            <div class="rl-field-label">
              提供给模型的工具
              <span class="val">${trace.tools.length} 个 · ${fmt(c.tools)} token</span>
            </div>
            <div class="rl-tools">${tools}</div>
          </div>
        </div>
        <div class="cb-note">
          循环开始前只发了三样：系统提示、工具定义、用户提问。
          工具定义既是「模型能做什么」的清单，也是一笔<b>每一轮都要重发</b>的固定开销。
          点「下一步」看模型如何选择。
        </div>
      </div>
    </section>`;
}

/**
 * 单步详情。
 *
 * 这里采用「左右并排」而不是上下堆叠：「模型输出」和它触发的「Observation」
 * 是一次请求与一次响应，并排才能一眼看出因果关系。上下堆叠时读者要来回滚动
 * 才能把两者对上，而且四步全铺开会让页面长到三屏以上。
 */
function renderStep(trace, s, i) {
  const kindText = s.kind === 'final' ? 'final' : 'action';
  const kindCls = s.kind === 'final' ? 'k-final' : 'k-action';

  const response = s.observation
    ? `<div class="rl-field">
         <div class="rl-field-label">
           Observation · 宿主程序写入
           <span class="val">${fmt(estimateValueTokens(s.observation))} token</span>
         </div>
         ${s.isError ? '<div class="tag is-danger" style="margin-bottom:6px">工具返回错误</div>' : ''}
         <pre class="code is-capped">${jsonBlock(s.observation)}</pre>
       </div>`
    : (s.kind === 'final'
      ? `<div class="rl-field">
           <div class="rl-field-label">最终回答 <span class="val">交付给用户</span></div>
           <div class="rt-snippet">${esc(s.answer)}</div>
         </div>`
      : '');

  return `
    <section class="rl-step is-active" data-step="${i}">
      <header class="rl-step-head">
        <span class="rl-kind ${kindCls}">${kindText}</span>
        <span class="rl-step-title">第 ${i + 1} 步${s.kind === 'final' ? '：循环终止' : `：调用 ${esc(s.action.name)}`}</span>
        <span class="rl-step-meta">${fmt(estimateTokens(s.modelOutput))} token</span>
      </header>
      <div class="rl-step-body">
        <div class="rl-pair">
          <div class="rl-field">
            <div class="rl-field-label">模型输出 · 原始内容 <span class="val">由模型生成</span></div>
            <pre class="code is-capped">${formatModelOutput(s.modelOutput)}</pre>
          </div>
          ${response}
        </div>
        ${s.note ? `<div class="cb-note">${esc(s.note)}</div>` : ''}
      </div>
    </section>`;
}

/** 舞台只渲染当前这一屏：起点卡，或某一步的详情 */
function renderDetail(trace) {
  if (stepIndex === -1) return renderStart(trace);
  return renderStep(trace, trace.steps[Math.min(stepIndex, trace.steps.length - 1)], stepIndex);
}

function renderControls(trace) {
  const atEnd = stepIndex >= trace.steps.length - 1;
  const c = contextAt(trace, stepIndex);
  const REF = 32768;   // 用中窗口档做参照，只为了给出「占了多少」的量感

  return `
    <div class="panel is-sticky">
      <div class="panel-head">执行控制 <span class="hint">${esc(trace.badge)}</span></div>
      <div class="panel-body">
        <div class="ctrl">
          <div class="ctrl-label">轨迹</div>
          <div class="seg" id="rlTraceSeg">
            ${TRACES.map((t, i) => `<button type="button" data-trace="${i}"
              aria-pressed="${i === traceIndex}">${esc(t.title)}</button>`).join('')}
          </div>
          <p class="ctrl-note">用户提问：${esc(trace.userMessage)}</p>
        </div>

        <div class="ctrl">
          <div class="ctrl-label">播放</div>
          <div class="btn-row">
            <button class="btn" type="button" data-act="prev" ${stepIndex < 0 ? 'disabled' : ''}>← 上一步</button>
            <button class="btn btn-primary" type="button" data-act="next" ${atEnd ? 'disabled' : ''}>下一步 →</button>
          </div>
          <div class="btn-row" style="margin-top:8px">
            <button class="btn" type="button" data-act="autoplay">${timer ? '暂停' : '自动播放'}</button>
            <button class="btn" type="button" data-act="reset">回到起点</button>
          </div>
          <p class="ctrl-note">
            舞台一次只显示当前这一步，用 <span class="mono">←</span> <span class="mono">→</span>
            键也能切换。点上方轨道的任意节点可直接跳过去。
          </p>
        </div>

        <div class="ctrl">
          <div class="ctrl-label">
            上下文累积
            <span class="val" data-ctx-total>${fmt(c.total)} token</span>
          </div>
          <div class="rl-ctx">
            <div class="rl-ctx-bar">
              <i class="s-system" style="width:${(c.sys / c.total * 100).toFixed(2)}%"></i>
              <i class="s-tools" style="width:${(c.tools / c.total * 100).toFixed(2)}%"></i>
              <i class="s-history" style="width:${(c.conv / c.total * 100).toFixed(2)}%"></i>
            </div>
          </div>
          <div class="cb-legend" style="margin-top:8px">
            <div class="cb-legend-row">
              <span class="cb-swatch s-system"></span>
              <span class="cb-legend-name">系统提示</span>
              <span class="cb-legend-val">${fmt(c.sys)}</span>
            </div>
            <div class="cb-legend-row">
              <span class="cb-swatch s-tools"></span>
              <span class="cb-legend-name">工具定义</span>
              <span class="cb-legend-val">${fmt(c.tools)}</span>
            </div>
            <div class="cb-legend-row">
              <span class="cb-swatch s-history"></span>
              <span class="cb-legend-name">对话累积</span>
              <span class="cb-legend-val">${fmt(c.conv)}</span>
            </div>
            <div class="cb-legend-row is-spare">
              <span class="cb-legend-name">占中窗口档（32K）</span>
              <span class="cb-legend-val">${pct(c.total, REF)}</span>
            </div>
          </div>
          <p class="ctrl-note">
            系统提示与工具定义是<b>每一轮都要重发</b>的固定开销，
            对话累积则随步数线性增长。${stepIndex === -1
    ? '循环还没开始，此刻窗口里只有固定开销与用户提问。'
    : `走到第 ${stepIndex + 1} 步时，固定开销已占 ${pct(c.sys + c.tools, c.total)}。`}
          </p>
        </div>

        <div class="ctrl">
          <label class="switch-row">
            <input type="checkbox" id="rlShowSys" ${showSystem ? 'checked' : ''}>
            <span class="switch-track"></span>
            <span class="switch-text">展开系统提示词</span>
          </label>
          ${showSystem ? `<pre class="code" style="margin-top:8px">${esc(trace.systemPrompt)}</pre>` : ''}
        </div>
      </div>
    </div>`;
}

function renderMechanism(trace) {
  return `
    <div class="panel">
      <div class="panel-head">这条流水线里，谁在做哪一段</div>
      <div class="panel-body">
        <div class="rt-grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
          <div class="rt-col">
            <div class="rt-col-head"><h3>模型</h3><span class="sub">负责「表达」</span></div>
            <p style="margin:0;font-size:13px;color:var(--text-2)">
              读懂当前划痕板，决定下一步查什么、用什么参数，或者给出结论。
              <b>它不执行任何工具</b>。
            </p>
          </div>
          <div class="rt-col">
            <div class="rt-col-head"><h3>宿主程序</h3><span class="sub">负责「执行」</span></div>
            <p style="margin:0;font-size:13px;color:var(--text-2)">
              解析调用请求、做参数校验与鉴权、真正去查数据，再把结果作为
              Observation 写回对话。所有副作用都在这一侧。
            </p>
          </div>
          <div class="rt-col">
            <div class="rt-col-head"><h3>循环控制</h3><span class="sub">负责「何时停」</span></div>
            <p style="margin:0;font-size:13px;color:var(--text-2)">
              模型输出 Final Answer 即终止；否则把 Observation 追加进对话再来一轮。
              真实系统还必须设最大轮数与超时上限。
            </p>
          </div>
        </div>
        <div class="rt-verdict" style="margin-top:14px">
          <span>💡</span>
          <div>
            <b>最容易被误解的一点：</b>
            Observation 不是模型「想」出来的，是宿主程序查出来的。
            把它当成模型输出，就会得出「模型知道实时数据」这个错误结论 ——
            而它只知道被喂进上下文的那部分。
          </div>
        </div>
      </div>
    </div>`;
}

function render() {
  const trace = TRACES[traceIndex];
  $('#rlStage').innerHTML = `
    ${renderTrack(trace)}
    <div class="rl-detail">${renderDetail(trace)}</div>
    ${renderMechanism(trace)}
  `;
  $('#rlControls').innerHTML = renderControls(trace);
  bind();
}

/* ---------------- 交互 ---------------- */

function setStep(n) {
  const trace = TRACES[traceIndex];
  stepIndex = clamp(n, -1, trace.steps.length - 1);
  if (stepIndex >= trace.steps.length - 1) stopAuto();
  render();
}

function stopAuto() {
  if (timer) { clearInterval(timer); timer = null; }
}

function bind() {
  const trace = TRACES[traceIndex];

  document.querySelectorAll('#rlTraceSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      stopAuto();
      traceIndex = Number(b.dataset.trace);
      stepIndex = -1;
      render();
    });
  });

  document.querySelectorAll('[data-goto]').forEach((b) => {
    b.addEventListener('click', () => { stopAuto(); setStep(Number(b.dataset.goto)); });
  });

  const act = (name, fn) => {
    const node = document.querySelector(`[data-act="${name}"]`);
    if (node) node.addEventListener('click', fn);
  };

  act('next', () => { stopAuto(); setStep(stepIndex + 1); });
  act('prev', () => { stopAuto(); setStep(stepIndex - 1); });
  act('reset', () => { stopAuto(); setStep(-1); });

  act('autoplay', () => {
    if (timer) { stopAuto(); render(); return; }
    if (stepIndex >= trace.steps.length - 1) stepIndex = -1;
    timer = setInterval(() => {
      if (stepIndex >= TRACES[traceIndex].steps.length - 1) { stopAuto(); render(); return; }
      stepIndex += 1;
      render();
    }, 1400);
    render();
  });

  const sys = $('#rlShowSys');
  if (sys) sys.addEventListener('change', () => { showSystem = sys.checked; render(); });
}

/* 键盘左右切换。
   这个监听必须挂在 document 上只注册一次 —— bind() 每次重绘都会执行，
   把监听写在 bind() 里会随每次重绘不断堆积，切页后也不释放。 */
function onKeydown(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  // 光标在输入控件里时不要劫持方向键
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); stopAuto(); setStep(stepIndex + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); stopAuto(); setStep(stepIndex - 1); }
}

export function mount() {
  stopAuto();
  stepIndex = -1;
  document.addEventListener('keydown', onKeydown);
  render();
}

export function unmount() {
  stopAuto();
  document.removeEventListener('keydown', onKeydown);
}
