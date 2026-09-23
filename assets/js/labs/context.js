/* ============================================================
   实验室二：上下文预算
   ------------------------------------------------------------
   【哪些是实测，哪些是推算 —— 界面上也分开标注】
   实测（来自真实数据）：
     系统提示、工具定义（逐个可开关）、当前提问
   推算（按样本平均长度 × 数量）：
     检索片段、对话历史
   参数（读者自己设定，默认值取常见量级）：
     每轮工具返回体积、输出预留

   之所以要推算，是因为真实 Agent 的负载远大于本实验室的样本：
   一次工具返回动辄数百到数千 token，几十轮下来就是几十万 token。
   如果只按样本里那几条短消息算，永远碰不到窗口上限，
   读者也就看不到「撑爆」是怎么发生的。
   ============================================================ */

import { $, esc, fmt, pct, clamp } from '../ui.js';
import { estimateTokens, ESTIMATOR_NOTE } from '../tokens.js';
import { AGENT_SYSTEM_PROMPT } from '../data/traces.js';
import {
  MODELS, TOOLS, RETRIEVAL_DOCS, HISTORY_TURNS, CURRENT_TURN,
  DEFAULT_OUTPUT_RESERVE, EFFECTIVE_CONTEXT_NOTE
} from '../data/budget.js';

/* 样本实测的平均长度 */
const AVG_DOC = RETRIEVAL_DOCS.length
  ? Math.round(RETRIEVAL_DOCS.reduce((a, d) => a + estimateTokens(`${d.title} ${d.text}`), 0) / RETRIEVAL_DOCS.length)
  : 0;

const AVG_TURN = HISTORY_TURNS.length
  ? Math.round(HISTORY_TURNS.reduce((a, t) => a + estimateTokens(t.content), 0) / HISTORY_TURNS.length)
  : 0;

/* 系统提示与实验室一用的是同一份，长度直接实测 */
const SYS_TOKENS = estimateTokens(AGENT_SYSTEM_PROMPT);

/** 默认状态：均衡档，先让人看到「正常情况长什么样」 */
const state = {
  modelId: 'l',
  tools: new Set(TOOLS.map((t) => t.name)),
  docCount: 3,
  turnCount: 10,
  obsPerTurn: 400,
  outputReserve: DEFAULT_OUTPUT_RESERVE
};

/* ---------------- 计算 ---------------- */

function compute() {
  const model = MODELS.find((m) => m.id === state.modelId) || MODELS[2];

  const sys = SYS_TOKENS;
  const tools = TOOLS.filter((t) => state.tools.has(t.name))
    .reduce((a, t) => a + estimateTokens(`${t.name} ${t.description} ${JSON.stringify(t.parameters)}`), 0);
  const retrieval = state.docCount * AVG_DOC;
  const history = state.turnCount * (AVG_TURN + state.obsPerTurn);
  const current = estimateTokens(CURRENT_TURN);
  const output = state.outputReserve;

  const used = sys + tools + retrieval + history + current + output;
  const window = model.window;
  const spare = window - used;

  return {
    model, sys, tools, retrieval, history, current, output, used, window, spare,
    segments: [
      { key: 'system', name: '系统提示', value: sys, cls: 's-system', measured: true },
      { key: 'tools', name: '工具定义', value: tools, cls: 's-tools', measured: true },
      { key: 'retrieval', name: '检索片段', value: retrieval, cls: 's-retrieval', measured: false },
      { key: 'history', name: '对话历史与工具返回', value: history, cls: 's-history', measured: false },
      { key: 'current', name: '当前提问', value: current, cls: 's-current', measured: true },
      { key: 'output', name: '输出预留', value: output, cls: 's-output', measured: false }
    ]
  };
}

/* ---------------- 渲染 ---------------- */

function renderBar(c) {
  // 超限时按 used 缩放，让「超出窗口」这件事在视觉上真的溢出来
  const span = Math.max(c.window, c.used) || 1;
  const over = c.used > c.window;

  const segs = c.segments.map((s) => {
    const w = (s.value / span) * 100;
    if (w <= 0) return '';
    // 太窄就不写文字，否则会糊成一团
    const label = w > 7 ? fmt(s.value) : '';
    return `<div class="cb-seg ${s.cls}" style="width:${w.toFixed(3)}%" title="${esc(s.name)}：${fmt(s.value)} token">${label}</div>`;
  }).join('');

  const spareW = c.spare > 0 ? (c.spare / span) * 100 : 0;
  const spareBar = spareW > 0
    ? `<div class="cb-seg s-spare" style="width:${spareW.toFixed(3)}%"></div>`
    : '';

  // 超限时标出窗口上限的位置。整条是按「实际占用」缩放的，
  // 没有这条竖线，读者只看到一条满格的红条，判断不出究竟超了多少。
  const limitMark = over
    ? `<i class="cb-limit" style="left:${((c.window / c.used) * 100).toFixed(3)}%"
         title="窗口上限 ${fmt(c.window)} token"></i>`
    : '';

  return `
    <div class="cb-window${over ? ' is-over' : ''}">
      <span class="mono" style="width:74px;flex:none">${esc(c.model.name)}</span>
      <div class="cb-window-track">${segs}${spareBar}${limitMark}</div>
      <span class="mono" style="width:74px;flex:none;text-align:right" data-window>${fmt(c.window)}</span>
    </div>`;
}

function renderLegend(c) {
  const rows = c.segments.map((s) => `
    <div class="cb-legend-row">
      <span class="cb-swatch ${s.cls}"></span>
      <span class="cb-legend-name">
        ${esc(s.name)}
        <span class="tag" style="margin-left:6px">${s.measured ? '实测' : '推算'}</span>
      </span>
      <span class="cb-legend-val">${fmt(s.value)}</span>
      <span class="cb-legend-pct">${pct(s.value, c.window)}</span>
    </div>`).join('');

  const spareCls = c.spare < 0 ? 'is-over' : 'is-spare';
  const spareRow = `
    <div class="cb-legend-row ${spareCls}" style="${c.spare < 0 ? 'color:var(--danger)' : ''}">
      <span class="cb-legend-name">${c.spare < 0 ? '超出窗口' : '剩余可用'}</span>
      <span class="cb-legend-val">${c.spare < 0 ? '+' + fmt(-c.spare) : fmt(c.spare)}</span>
      <span class="cb-legend-pct">${c.spare < 0 ? '—' : pct(c.spare, c.window)}</span>
    </div>`;

  return `<div class="cb-legend">${rows}${spareRow}</div>`;
}

function renderStats(c) {
  const util = c.window ? (c.used / c.window) * 100 : 0;
  const utilCls = c.spare < 0 ? 'is-danger' : util > 70 ? 'is-warn' : 'is-ok';
  const fixed = c.sys + c.tools;

  return `
    <div class="stats">
      <div class="stat">
        <div class="stat-label">已占用</div>
        <div class="stat-value ${utilCls}" data-used>${fmt(c.used)}</div>
        <div class="stat-sub">窗口 ${fmt(c.window)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">${c.spare < 0 ? '超出' : '剩余'}</div>
        <div class="stat-value ${c.spare < 0 ? 'is-danger' : 'is-ok'}" data-spare>${fmt(Math.abs(c.spare))}</div>
        <div class="stat-sub">${c.spare < 0 ? '放不下，必须裁' : '可留给后续轮次'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">固定开销占比</div>
        <div class="stat-value" data-fixed-pct>${pct(fixed, c.used)}</div>
        <div class="stat-sub">系统提示 + 工具定义</div>
      </div>
      <div class="stat">
        <div class="stat-label">每一轮的重发成本</div>
        <div class="stat-value" data-fixed-cost>${fmt(fixed)}</div>
        <div class="stat-sub">轮次越多乘得越狠</div>
      </div>
    </div>`;
}

function renderControls(c) {
  const over = c.used > c.window;

  return `
    <div class="panel is-sticky">
      <div class="panel-head">预算构成 <span class="hint">拖动即时重算</span></div>
      <div class="panel-body">

        <div class="ctrl">
          <div class="ctrl-label">窗口档位</div>
          <div class="seg" id="cbModelSeg">
            ${MODELS.map((m) => `<button type="button" data-model="${m.id}"
              aria-pressed="${m.id === state.modelId}">${esc(m.name.replace('窗口档', ''))}</button>`).join('')}
          </div>
          <p class="ctrl-note">${esc(c.model.note)}</p>
        </div>

        <div class="ctrl">
          <div class="ctrl-label">预设 <span class="val">${over ? '已超限' : '正常'}</span></div>
          <div class="seg" id="cbPresetSeg">
            <button type="button" data-preset="min">极简</button>
            <button type="button" data-preset="balanced">均衡</button>
            <button type="button" data-preset="full">塞满</button>
          </div>
        </div>

        <div class="ctrl">
          <div class="ctrl-label">工具定义 <span class="val" data-tool-cost>${fmt(c.tools)}</span></div>
          ${TOOLS.map((t) => {
            const cost = estimateTokens(`${t.name} ${t.description} ${JSON.stringify(t.parameters)}`);
            return `
              <label class="switch-row">
                <input type="checkbox" data-tool="${esc(t.name)}" ${state.tools.has(t.name) ? 'checked' : ''}>
                <span class="switch-track"></span>
                <span class="switch-text mono">${esc(t.name)}</span>
                <span class="switch-cost">${fmt(cost)}</span>
              </label>`;
          }).join('')}
          <p class="ctrl-note">
            工具 schema 每一轮都会随请求重发。关掉一个用不上的工具，
            省下的是<b>每一轮</b>的成本，不是一次性的。
          </p>
        </div>

        <div class="ctrl">
          <div class="ctrl-label">检索片段数 <span class="val">${state.docCount} 段 × ${AVG_DOC}</span></div>
          <input type="range" id="cbDocs" min="0" max="20" step="1" value="${state.docCount}">
          <p class="ctrl-note">按语料实测平均长度 ${AVG_DOC} token/段 推算。</p>
        </div>

        <div class="ctrl">
          <div class="ctrl-label">对话轮数 <span class="val">${state.turnCount} 轮</span></div>
          <input type="range" id="cbTurns" min="0" max="60" step="1" value="${state.turnCount}">
          <p class="ctrl-note">样本实测平均 ${AVG_TURN} token/轮（不含工具返回）。</p>
        </div>

        <div class="ctrl">
          <div class="ctrl-label">每轮工具返回 <span class="val">${fmt(state.obsPerTurn)}</span></div>
          <input type="range" id="cbObs" min="0" max="3000" step="50" value="${state.obsPerTurn}">
          <p class="ctrl-note">
            这一项最容易被低估：一次真实工具返回是几百到几千 token 的 JSON，
            而它会在后续每一轮里被反复重发。默认 400 已经是偏保守的取值。
          </p>
        </div>

        <div class="ctrl">
          <div class="ctrl-label">输出预留 <span class="val">${fmt(state.outputReserve)}</span></div>
          <input type="range" id="cbOut" min="200" max="4000" step="100" value="${state.outputReserve}">
          <p class="ctrl-note">回答本身也要占窗口，不预留就会在生成中途被截断。</p>
        </div>

      </div>
    </div>`;
}

/* ---------------- 主渲染 ---------------- */

function render() {
  const c = compute();
  const over = c.used > c.window;

  $('#cbStage').innerHTML = `
    ${over ? `
      <div class="cb-note" style="border-left-color:var(--danger);background:var(--danger-soft)">
        <strong>这份组合放不下了。</strong>
        已占用 ${fmt(c.used)} token，超出 ${esc(c.model.name)} 的 ${fmt(c.window)} 上限
        ${fmt(-c.spare)} token。真实系统到这一步必须做取舍：裁掉旧轮次、压缩工具返回、
        减少检索片段，或者换更大的窗口 —— 而「换更大的窗口」通常是最贵、也最不治本的那个。
      </div>` : ''}

    <div class="panel">
      <div class="panel-head">
        窗口占用
        <span class="hint">token 为估算值，非精确计数</span>
      </div>
      <div class="panel-body">
        ${renderBar(c)}
        ${over ? `<p class="ctrl-note" style="margin-top:10px">
          竖线是窗口上限（${fmt(c.window)} token），它右侧的部分放不下。
        </p>` : ''}
        <div style="margin-top:16px">${renderStats(c)}</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        逐项拆解
        <span class="hint">每项都标注了实测还是推算</span>
      </div>
      <div class="panel-body">
        ${renderLegend(c)}
        <p class="ctrl-note" style="margin-top:12px">${esc(ESTIMATOR_NOTE)}</p>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">三个常见误判</div>
      <div class="panel-body">
        <div class="rt-grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
          <div class="rt-col">
            <div class="rt-col-head"><h3>误区一</h3><span class="sub">窗口大 = 够用</span></div>
            <p style="margin:0;font-size:13px;color:var(--text-2)">
              把档位拖到最大，占用率确实降下来了。但窗口不是免费的 ——
              输入按 token 计价，每一轮都要为整个上下文付费。
              窗口越大，单轮成本越高。
            </p>
          </div>
          <div class="rt-col">
            <div class="rt-col-head"><h3>误区二</h3><span class="sub">工具定义不要钱</span></div>
            <p style="margin:0;font-size:13px;color:var(--text-2)">
              关掉一个工具，看「每一轮的重发成本」掉了多少。
              20 轮对话就是 20 倍。接工具时把「用不上的先别挂」当成纪律。
            </p>
          </div>
          <div class="rt-col">
            <div class="rt-col-head"><h3>误区三</h3><span class="sub">占满才叫用得好</span></div>
            <p style="margin:0;font-size:13px;color:var(--text-2)">
              留白不是为了省，是为了让关键事实突出。越接近上限，
              越该问「哪些内容可以不放进来」，而不是「还能再塞点什么」。
            </p>
          </div>
        </div>
        <div class="rt-verdict" style="margin-top:14px">
          <span>📌</span>
          <div>${esc(EFFECTIVE_CONTEXT_NOTE)}</div>
        </div>
      </div>
    </div>
  `;

  $('#cbControls').innerHTML = renderControls(c);
  bind();
}

/* ---------------- 预设 ---------------- */

const PRESETS = {
  min: { modelId: 's', tools: ['get_order'], docCount: 0, turnCount: 2, obsPerTurn: 0, outputReserve: 500 },
  balanced: { modelId: 'l', tools: TOOLS.map((t) => t.name), docCount: 3, turnCount: 10, obsPerTurn: 400, outputReserve: 800 },
  full: { modelId: 'm', tools: TOOLS.map((t) => t.name), docCount: 20, turnCount: 60, obsPerTurn: 800, outputReserve: 2000 }
};

/* ---------------- 交互 ---------------- */

function bind() {
  document.querySelectorAll('#cbModelSeg button').forEach((b) => {
    b.addEventListener('click', () => { state.modelId = b.dataset.model; render(); });
  });

  document.querySelectorAll('#cbPresetSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      const p = PRESETS[b.dataset.preset];
      if (!p) return;
      Object.assign(state, {
        modelId: p.modelId,
        tools: new Set(p.tools),
        docCount: p.docCount,
        turnCount: p.turnCount,
        obsPerTurn: p.obsPerTurn,
        outputReserve: p.outputReserve
      });
      render();
    });
  });

  document.querySelectorAll('[data-tool]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.tools.add(cb.dataset.tool);
      else state.tools.delete(cb.dataset.tool);
      render();
    });
  });

  const slider = (id, key) => {
    const node = $(`#${id}`);
    if (!node) return;
    node.addEventListener('input', () => {
      state[key] = clamp(Number(node.value), 0, 1e9);
      render();
    });
  };
  slider('cbDocs', 'docCount');
  slider('cbTurns', 'turnCount');
  slider('cbObs', 'obsPerTurn');
  slider('cbOut', 'outputReserve');
}

export function mount() {
  render();
}

export function unmount() { /* 无需清理 */ }
