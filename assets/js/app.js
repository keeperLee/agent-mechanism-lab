/* ============================================================
   入口：路由、主题、实验室挂载
   ------------------------------------------------------------
   零依赖，hash 路由。每个实验室是一个独立模块，进入时挂载、
   离开时卸载 —— 实验室一有自动播放定时器，不清理会在切页后
   继续跑，属于必须处理的泄漏。
   ============================================================ */

import { $, $$, esc } from './ui.js';
import * as reactLab from './labs/react.js';
import * as contextLab from './labs/context.js';
import * as retrievalLab from './labs/retrieval.js';
import { ESTIMATOR_NOTE } from './tokens.js';

const THEME_KEY = 'agent-mechanism-lab:theme';

/* ============================================================
   实验室清单：导航、首页卡片、教学要点都在这里定义
   ============================================================ */

const LABS = [
  {
    id: 'react',
    num: '01',
    nav: 'ReAct 循环',
    cardTitle: 'ReAct 循环',
    cardQ: '模型在哪一步才「看到」工具结果？',
    cardDesc: '把一次完整的工具调用循环逐步播放出来：每轮的原始输出、谁真正执行了工具、上下文如何累积。',
    tags: ['单步回放', '原始提示词', '上下文增长'],
    title: 'ReAct 循环单步执行与回放',
    lede: '一次完整的工具调用循环，逐步播放。重点不是「模型很聪明」，而是「哪一段是模型写的、哪一段是程序写的」。',
    teach: [
      '模型只输出<b>调用请求</b>，Observation 由宿主程序执行工具后写入 —— 这是最常被误解的一环。',
      '循环的终止条件是模型自己给出 Final Answer，而不是调用次数用尽。',
      '<b>系统提示与工具定义每一轮都要重发</b>，是固定开销；对话累积才是随轮数增长的变量。',
      '工具报错不是异常流程：结构化的错误信息本身就是模型的修复指令。'
    ],
    controlsId: 'rlControls',
    stageId: 'rlStage',
    lab: reactLab
  },
  {
    id: 'context',
    num: '02',
    nav: '上下文预算',
    cardTitle: '上下文预算',
    cardQ: '窗口到底被什么吃掉了？',
    cardDesc: '拆开系统提示、工具定义、检索片段、对话历史与输出预留，看哪一项在偷偷膨胀，以及撑爆时会发生什么。',
    tags: ['逐项拆解', '工具 schema 成本', '超限演示'],
    title: '上下文预算可视化',
    lede: '把一块有限的窗口拆成六份，拖动参数看占用怎么变。同时看清哪些数字是实测的、哪些是按参数推算的。',
    teach: [
      '工具定义是<b>每一轮都要付</b>的固定成本。关掉一个用不上的工具，省下的是 N 轮的总和。',
      '一次工具返回常是几百到几千 token，而且会在后续每一轮里被反复重发 —— 这项最容易被低估。',
      '输出也要占窗口。不预留，回答会在生成中途被截断。',
      '<b>填满窗口不是目标。</b>长上下文存在中段注意力衰减，有效范围通常明显小于标称窗口。'
    ],
    controlsId: 'cbControls',
    stageId: 'cbStage',
    lab: contextLab
  },
  {
    id: 'retrieval',
    num: '03',
    nav: '检索与融合',
    cardTitle: '检索与 RRF 融合',
    cardQ: '两路召回结果不一样，该信谁？',
    cardDesc: '真实运行的 BM25 与语义召回并排对比，再用 RRF 融合。看融合把谁拉了上来、又为什么只用名次不用分数。',
    tags: ['真实 BM25', '同义词扩展', 'RRF 明细'],
    title: '两路召回与 RRF 融合',
    lede: '两路召回各有盲区：一路只认字面，一路能认语义但会引入噪声。融合的价值就在把两边的长处拼起来。',
    teach: [
      'BM25 与语义召回的排名差异不是 bug，而是<b>融合存在的理由</b>。',
      'RRF 只用名次，<b>完全不用分数</b> —— 因为不同通道的分数不可比，归一化本身就会改变结论。',
      'k 越小，头部名次的权重差距越大；k 越大融合越稳、也越钝。',
      '本实验室的「语义通道」由<b>手工同义词表</b>提供泛化能力，并非真的 embedding 模型 —— 融合那一层的数学完全一样。'
    ],
    controlsId: 'rtControls',
    stageId: 'rtStage',
    lab: retrievalLab,
    wide: true
  }
];

let current = null;

/* ============================================================
   主题
   ============================================================ */

function applyTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (_) { /* 隐私模式下会抛 */ }
  if (!saved) {
    saved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = saved;
  const btn = $('#themeBtn');
  if (btn) {
    btn.textContent = saved === 'dark' ? '☀' : '☾';
    btn.setAttribute('aria-label', saved === 'dark' ? '切换到浅色主题' : '切换到深色主题');
  }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* 忽略 */ }
  applyTheme();
}

/* ============================================================
   视图
   ============================================================ */

function homeView() {
  return `
    <div class="hero wrap">
      <h1>把 Agent 的内部机制拆开看</h1>
      <p class="lede">
        课程和文章讲的是「应该怎么做」。这里讲的是「它到底怎么跑的」——
        用可操作、可回放的方式，把循环、上下文和检索这三处最容易含糊带过的机制摊开。
      </p>
      <ul class="hero-points">
        <li>纯静态 · 不需要 API Key</li>
        <li>BM25 与 RRF 是真实实现</li>
        <li>零依赖 · 无构建步骤</li>
      </ul>

      <div class="callout is-info">
        <span>🧪</span>
        <div>
          <p><strong>这些数据是预置的。</strong>本站是纯静态站点，页面上不会真的调用大模型 ——
          所有执行轨迹都是预先录制好的真实形态数据，用来把机制讲清楚，而不是伪装成在线服务。</p>
          <p><strong>检索部分是真实计算。</strong>BM25 打分、同义词扩展、RRF 融合都在浏览器里现算，
          改一个参数结果就会变。${esc(ESTIMATOR_NOTE)}</p>
        </div>
      </div>
    </div>

    <div class="section wrap">
      <div class="section-head">
        <h2>三个实验室</h2>
        <p>建议按顺序看：先理解循环怎么转，再看它吃掉多少窗口，最后看喂进去的内容是怎么选出来的。</p>
      </div>
      <div class="lab-grid">
        ${LABS.map((l) => `
          <a class="lab-card" href="#/${l.id}">
            <div class="lab-card-top">
              <span class="lab-num">${l.num}</span>
              <div>
                <h3>${esc(l.cardTitle)}</h3>
                <div class="lab-q">${esc(l.cardQ)}</div>
              </div>
            </div>
            <p>${esc(l.cardDesc)}</p>
            <div class="tags">${l.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>
            <div class="card-go">进入实验室 →</div>
          </a>`).join('')}
      </div>
    </div>

    <div class="section wrap">
      <div class="section-head">
        <h2>这里不做什么</h2>
      </div>
      <div class="rt-grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
        <div class="rt-col">
          <div class="rt-col-head"><h3>不教调 API</h3><span class="sub">那是入门内容</span></div>
          <p style="margin:0;font-size:13.4px;color:var(--text-2)">
            怎么发一次请求、怎么解析响应，网上资料已经足够多。
            这里关注的是「连续跑几十轮之后会发生什么」。
          </p>
        </div>
        <div class="rt-col">
          <div class="rt-col-head"><h3>不做框架对比</h3><span class="sub">选型会过时</span></div>
          <p style="margin:0;font-size:13.4px;color:var(--text-2)">
            框架排名几个月一变。机制不会：上下文会累积、工具要重发、
            检索会漏召 —— 这些结论换任何框架都成立。
          </p>
        </div>
        <div class="rt-col">
          <div class="rt-col-head"><h3>不假装能联网</h3><span class="sub">纯静态的边界</span></div>
          <p style="margin:0;font-size:13.4px;color:var(--text-2)">
            没有服务端就没有真实推理。与其造一个假的聊天框，
            不如把真实形态的数据摊开来讲清楚。
          </p>
        </div>
      </div>
    </div>`;
}

function labView(lab) {
  return `
    <header class="lab-head wrap-lab">
      <div class="crumb"><a href="#/">实验室</a> / ${esc(lab.nav)}</div>
      <h1>${esc(lab.title)}</h1>
      <p class="lede">${esc(lab.lede)}</p>
      <ul class="teach">${lab.teach.map((t) => `<li>${t}</li>`).join('')}</ul>
    </header>
    <div class="lab-body wrap-lab${lab.wide ? ' is-wide' : ''}">
      <div class="lab-controls" id="${lab.controlsId}"></div>
      <div class="rl-stage" id="${lab.stageId}"></div>
    </div>`;
}

/* ============================================================
   路由
   ============================================================ */

function route() {
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  const lab = LABS.find((l) => l.id === hash);

  // 切换前一定要卸载：实验室一有自动播放定时器
  if (current && current.lab && current.lab.unmount) current.lab.unmount();
  current = lab || null;

  const root = $('#viewRoot');
  if (!lab) {
    root.innerHTML = homeView();
    document.title = 'Agent 机制可视化实验室';
  } else {
    root.innerHTML = labView(lab);
    document.title = `${lab.title} · Agent 机制可视化实验室`;
    lab.lab.mount();
  }

  $$('[data-nav]').forEach((a) => {
    const active = a.dataset.nav === (lab ? lab.id : '');
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  window.scrollTo({ top: 0, behavior: 'auto' });
}

function boot() {
  applyTheme();

  $('#themeBtn').addEventListener('click', toggleTheme);
  window.addEventListener('hashchange', route);
  route();

  const boot = $('#boot');
  if (boot) boot.hidden = true;
}

boot();
