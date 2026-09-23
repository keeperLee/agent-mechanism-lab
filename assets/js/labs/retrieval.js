/* ============================================================
   实验室三：两路召回与 RRF 融合
   ============================================================ */

import { $, esc, clamp } from '../ui.js';
import {
  createIndex, searchBM25, searchSemantic, reciprocalRankFusion, scoreFusion,
  tokenize, expandQuery, RRF_K
} from '../bm25.js';
import { CORPUS, SYNONYMS, PRESET_QUERIES } from '../data/corpus.js';

const index = createIndex(CORPUS);
const byId = new Map(CORPUS.map((c) => [c.id, c]));

const state = {
  query: PRESET_QUERIES[0].query,
  presetPoint: PRESET_QUERIES[0].point,
  k: RRF_K,
  mode: 'rrf',        // 'rrf' | 'score'
  topK: 6,
  focusId: null
};

/* ---------------- 计算 ---------------- */

function run() {
  const bm25 = searchBM25(index, state.query, state.topK);
  const sem = searchSemantic(index, state.query, SYNONYMS, state.topK);

  const lists = [
    { name: 'BM25 字面匹配', items: bm25 },
    { name: '语义近似匹配', items: sem }
  ];

  const rrf = reciprocalRankFusion(lists, state.k);
  const score = scoreFusion(lists);
  const fused = state.mode === 'rrf' ? rrf : score;

  // 每个文档被哪几路找到，用来标「独家命中」
  const inBm25 = new Set(bm25.map((r) => r.id));
  const inSem = new Set(sem.map((r) => r.id));
  const both = new Set([...inBm25].filter((id) => inSem.has(id)));

  return {
    bm25, sem, rrf, score, fused, inBm25, inSem, both,
    expanded: [...expandQuery(state.query, SYNONYMS).keys()],
    queryTokens: tokenize(state.query)
  };
}

/* ---------------- 渲染 ---------------- */

function renderItem(r, opts) {
  const { cls = '', showMath = false, inBoth = false, contributions = null, maxScore, rankOffset = 0 } = opts;
  const doc = byId.get(r.id);
  const rank = (opts.rank !== undefined ? opts.rank : 0) + 1;
  const width = maxScore ? (r.score / maxScore) * 100 : 0;

  const math = showMath && contributions ? `
    <div class="rt-math">
      ${contributions.map((c) => `<span class="term">${esc(c.list)} 第${c.rank}名 → 1/(${state.k}+${c.rank}) = ${c.term.toFixed(4)}</span>`).join('<br>')}
      <br>合计 <span class="sum">${r.score.toFixed(4)}</span>
      ${contributions.length === 1 ? '<span class="miss"> · 只有一路命中</span>' : ''}
    </div>` : '';

  return `
    <div class="rt-item ${cls}${inBoth ? ' is-in-fused' : ''}" data-focus="${esc(r.id)}" role="button" tabindex="0">
      <div class="rt-item-top">
        <span class="rt-rank">${rank}</span>
        <span class="rt-title">${esc(doc ? doc.title : r.id)}</span>
        <span class="rt-score">${r.score.toFixed(showMath ? 4 : 3)}</span>
      </div>
      ${maxScore ? `<div class="rt-bar"><i style="width:${width.toFixed(1)}%"></i></div>` : ''}
      <div class="rt-id">${esc(r.id)}</div>
      ${math}
    </div>`;
}

function renderColumn({ cls, title, sub, items, showMath = false, maxScore, inBothSet = null }) {
  if (!items.length) {
    return `<div class="rt-col ${cls}">
      <div class="rt-col-head"><h3>${esc(title)}</h3><span class="sub">${esc(sub)}</span></div>
      <div class="rt-empty">没有任何命中</div>
    </div>`;
  }
  return `<div class="rt-col ${cls}">
    <div class="rt-col-head"><h3>${esc(title)}</h3><span class="sub">${esc(sub)}</span></div>
    <div class="rt-list">
      ${items.map((r, i) => renderItem(r, {
    rank: i,
    maxScore,
    showMath,
    contributions: r.contributions,
    inBoth: inBothSet ? inBothSet.has(r.id) : false
  })).join('')}
    </div>
  </div>`;
}

function render() {
  const d = run();
  const fusedTop = d.fused.slice(0, state.topK);
  const maxBm25 = d.bm25.length ? d.bm25[0].score : 1;
  const maxSem = d.sem.length ? d.sem[0].score : 1;
  const maxFuse = d.fused.length ? d.fused[0].score : 1;

  const onlyBm25 = d.bm25.filter((r) => !d.inSem.has(r.id));
  const onlySem = d.sem.filter((r) => !d.inBm25.has(r.id));

  // 名次变化：融合前后的名次差，用来直观展示「融合把谁拉上来了」
  const beforeRank = (id) => {
    const ib = d.bm25.findIndex((r) => r.id === id);
    const is = d.sem.findIndex((r) => r.id === id);
    const ranks = [ib, is].filter((x) => x >= 0).map((x) => x + 1);
    return ranks.length ? Math.min(...ranks) : '—';
  };

  const switcher = state.mode === 'score' ? d.score : d.rrf;
  const otherMode = state.mode === 'score' ? d.rrf : d.score;
  const topChanged = switcher.length && otherMode.length && switcher[0].id !== otherMode[0].id;

  $('#rtStage').innerHTML = `
    <div class="panel">
      <div class="panel-head">
        查询
        <span class="hint">语料 ${CORPUS.length} 段 · 切分 ${state.topK}</span>
      </div>
      <div class="panel-body">
        <div class="rt-query">
          <input type="text" id="rtInput" value="${esc(state.query)}" placeholder="输入查询，例如：幻觉怎么缓解">
          <div class="rt-presets">
            ${PRESET_QUERIES.map((p) => `<button type="button" data-q="${esc(p.query)}">${esc(p.label)}</button>`).join('')}
          </div>
        </div>
        <div style="margin-top:12px;font-size:12.5px;color:var(--text-3)">
          分词结果：<span class="mono">${d.queryTokens.length ? esc(d.queryTokens.join(' | ')) : '（空）'}</span>
          <br>
          同义词扩展后参与打分的词：<span class="mono">${d.expanded.length ? esc(d.expanded.join(' | ')) : '（无）'}</span>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        两路召回与融合
        <span class="hint">高亮边框 = 两路都命中</span>
      </div>
      <div class="panel-body">
        <div class="rt-grid">
          ${renderColumn({
    cls: 'rt-col-bm25', title: '第一路 · BM25 字面', sub: `${d.bm25.length} 条`,
    items: d.bm25, maxScore: maxBm25
  })}
          ${renderColumn({
    cls: 'rt-col-vec', title: '第二路 · 语义近似', sub: `${d.sem.length} 条`,
    items: d.sem, maxScore: maxSem
  })}
          ${renderColumn({
    cls: 'rt-col-fuse',
    title: state.mode === 'rrf' ? '融合 · RRF' : '融合 · 朴素分数相加',
    sub: `${d.fused.length} 条`,
    items: fusedTop,
    showMath: false,
    maxScore: maxFuse,
    inBothSet: d.both
  })}
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">融合明细</div>
      <div class="panel-body">
        <div class="rt-list">
          ${fusedTop.map((r, i) => renderItem({ ...r, rank: i }, {
    cls: '',
    showMath: true,
    contributions: r.contributions,
    inBoth: d.both.has(r.id),
    maxScore: maxFuse
  })).join('')}
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">这次检索说明了什么</div>
      <div class="panel-body">
        <div class="cb-legend" style="margin-bottom:14px">
          <div class="cb-legend-row">
            <span class="cb-legend-name">只有 BM25 找到</span>
            <span class="cb-legend-val">${onlyBm25.length ? esc(onlyBm25.map((r) => r.id).join(', ')) : '无'}</span>
          </div>
          <div class="cb-legend-row">
            <span class="cb-legend-name">只有语义通道找到</span>
            <span class="cb-legend-val">${onlySem.length ? esc(onlySem.map((r) => r.id).join(', ')) : '无'}</span>
          </div>
          <div class="cb-legend-row">
            <span class="cb-legend-name">两路都找到</span>
            <span class="cb-legend-val">${d.both.size ? esc([...d.both].join(', ')) : '无'}</span>
          </div>
          <div class="cb-legend-row">
            <span class="cb-legend-name">融合结果第 1 名</span>
            <span class="cb-legend-val">${fusedTop.length ? esc(`${fusedTop[0].id} · ${byId.get(fusedTop[0].id).title}`) : '无'}</span>
          </div>
        </div>

        <div class="rt-verdict">
          <span>🔍</span>
          <div>
            <b>观察点：</b>${esc(state.presetPoint || '自由输入查询，观察两路召回的差异。')}
          </div>
        </div>

        ${topChanged ? `
          <div class="rt-verdict" style="margin-top:12px;border-left-color:var(--warn);background:var(--warn-soft)">
            <span>⚠️</span>
            <div>
              <b>换用「朴素分数相加」后第 1 名变了：</b>
              ${esc(otherMode[0].id)} → ${esc(switcher[0].id)}。不同通道的分数分布不可比，
              归一化本身就是一个会改变结论的操作 —— 这就是 RRF 只用名次的原因。
            </div>
          </div>` : `
          <div class="rt-verdict" style="margin-top:12px">
            <span>✓</span>
            <div>
              这次查询下，「朴素分数相加」与 RRF 给出的第 1 名相同。
              两者并非总是一致 —— 换几个查询试试，分数分布的形态会改变结论。
              这正是分数融合需要额外校准、而 RRF 不需要的原因。
            </div>
          </div>`}
      </div>
    </div>

    ${state.focusId ? (() => {
    const doc = byId.get(state.focusId);
    if (!doc) return '';
    return `
      <div class="panel">
        <div class="panel-head">
          片段原文 · ${esc(doc.id)}
          <span class="hint">点击右侧关闭</span>
          <button class="btn btn-sm" type="button" data-close-focus style="margin-left:8px">关闭</button>
        </div>
        <div class="panel-body">
          <div style="font-size:14px;font-weight:620;margin-bottom:8px">${esc(doc.title)}</div>
          <div class="rt-snippet">${esc(doc.text)}</div>
          <div style="margin-top:10px;font-size:12px;color:var(--text-3)">
            被 BM25 命中：${d.inBm25.has(doc.id) ? '是' : '否'} ·
            被语义通道命中：${d.inSem.has(doc.id) ? '是' : '否'} ·
            融合名次：${(() => {
      const i = fusedTop.findIndex((r) => r.id === doc.id);
      return i >= 0 ? `第 ${i + 1} 名` : '未进前 ' + state.topK;
    })()} ·
            单路最好名次：${beforeRank(doc.id)}
          </div>
        </div>
      </div>`;
  })() : ''}
  `;

  $('#rtControls').innerHTML = renderControls(d, { onlyBm25, onlySem, topChanged, otherMode, switcher });
  bind();
}

function renderControls(d, extra) {
  return `
    <div class="panel is-sticky">
      <div class="panel-head">融合参数</div>
      <div class="panel-body">

        <div class="ctrl">
          <div class="ctrl-label">融合方式</div>
          <div class="seg" id="rtModeSeg">
            <button type="button" data-mode="rrf" aria-pressed="${state.mode === 'rrf'}">RRF</button>
            <button type="button" data-mode="score" aria-pressed="${state.mode === 'score'}">分数相加</button>
          </div>
          <p class="ctrl-note">
            RRF 只看名次、不看分数；分数相加要先归一化，而归一化依赖分数分布，
            换一个查询就可能变。切换看看结论会不会变。
          </p>
        </div>

        <div class="ctrl">
          <div class="ctrl-label">RRF 常数 k <span class="val">${state.k}</span></div>
          <input type="range" id="rtK" min="1" max="100" step="1" value="${state.k}"
            ${state.mode === 'score' ? 'disabled' : ''}>
          <p class="ctrl-note">
            k 越小，头部名次的权重差距越大。原论文用 60，取值偏大意味着
            「第 1 名和第 5 名差不多重要」—— 融合因此更稳，但也更钝。
          </p>
        </div>

        <div class="ctrl">
          <div class="ctrl-label">返回条数 <span class="val">${state.topK}</span></div>
          <input type="range" id="rtTopK" min="3" max="10" step="1" value="${state.topK}">
        </div>

        <div class="ctrl">
          <div class="ctrl-label">当前结果</div>
          <div class="cb-legend">
            <div class="cb-legend-row">
              <span class="cb-legend-name">BM25 命中</span>
              <span class="cb-legend-val">${d.bm25.length}</span>
            </div>
            <div class="cb-legend-row">
              <span class="cb-legend-name">语义命中</span>
              <span class="cb-legend-val">${d.sem.length}</span>
            </div>
            <div class="cb-legend-row">
              <span class="cb-legend-name">仅 BM25 独家</span>
              <span class="cb-legend-val">${extra.onlyBm25.length}</span>
            </div>
            <div class="cb-legend-row">
              <span class="cb-legend-name">仅语义独家</span>
              <span class="cb-legend-val">${extra.onlySem.length}</span>
            </div>
          </div>
          <p class="ctrl-note">
            两路都命中同一个文档，说明它在字面与语义上都相关 —— 这类结果
            最值得优先送进上下文。
          </p>
        </div>

      </div>
    </div>`;
}

/* ---------------- 交互 ---------------- */

function bind() {
  const input = $('#rtInput');
  if (input) {
    input.addEventListener('input', () => {
      state.query = input.value;
      state.presetPoint = '';
      // 输入过程中不重排整个面板，避免光标丢失；用防抖把重绘延后
      clearTimeout(bind._t);
      bind._t = setTimeout(() => render(), 260);
    });
  }

  document.querySelectorAll('[data-q]').forEach((b) => {
    b.addEventListener('click', () => {
      const preset = PRESET_QUERIES.find((p) => p.query === b.dataset.q);
      state.query = b.dataset.q;
      state.presetPoint = preset ? preset.point : '';
      render();
    });
  });

  document.querySelectorAll('#rtModeSeg button').forEach((b) => {
    b.addEventListener('click', () => { state.mode = b.dataset.mode; render(); });
  });

  const k = $('#rtK');
  if (k) k.addEventListener('input', () => { state.k = clamp(Number(k.value), 1, 100); render(); });

  const tk = $('#rtTopK');
  if (tk) tk.addEventListener('input', () => { state.topK = clamp(Number(tk.value), 3, 10); render(); });

  document.querySelectorAll('[data-focus]').forEach((node) => {
    const go = () => { state.focusId = node.dataset.focus; render(); };
    node.addEventListener('click', go);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });

  const close = document.querySelector('[data-close-focus]');
  if (close) close.addEventListener('click', () => { state.focusId = null; render(); });
}

export function mount() {
  render();
}

export function unmount() {
  clearTimeout(bind._t);
}
