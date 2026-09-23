#!/usr/bin/env node
/* ============================================================
   浏览器交互回归测试
   ------------------------------------------------------------
   用 Chrome DevTools Protocol 驱动一个真实浏览器，点真实按钮、
   读真实计算样式。静态检查查不到的东西都在这里：

     · 实验室能不能真的挂载（容器 id 写错时页面不报错，只是空白）
     · 拖动参数后数字有没有变（事件绑定漏了就会毫无反应）
     · 切页时上一个实验室有没有被卸载（定时器泄漏）
     · 深色主题是否落盘并跨刷新保持
     · 全程有没有未捕获的 JS 异常

   需要本机有 Chrome / Edge / Chromium。找不到浏览器时以返回码 2
   退出，CI 会当作「跳过」处理而不是失败。

   用法：
     node scripts/e2e.mjs --base http://127.0.0.1:5173
     CHROME_PATH=/path/to/chrome node scripts/e2e.mjs
   ============================================================ */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ---------------- 配置 ---------------- */

/** 同时支持 --base=URL 与 --base URL 两种写法 */
function argValue(name) {
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return null;
}

const BASE = argValue('--base') || process.env.E2E_BASE || 'http://127.0.0.1:5173';
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跨平台找浏览器 */
function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

/* ---------------- 结果统计 ---------------- */

let pass = 0;
let fail = 0;
const failures = [];

function check(cond, label, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

/* ---------------- CDP 客户端 ---------------- */

class CDP {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
    this.pageErrors = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error(`无法连接调试端口：${this.url}`));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      // 页面里的未捕获异常要收集起来 —— 最后的「零异常」断言靠它
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.pageErrors.push(d.exception?.description || d.text || '未捕获异常');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.pageErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    };
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面内异常：${d.exception?.description || d.text}`);
    }
    return r.result.value;
  }

  /** 页面内返回 JSON 字符串，这里解析成对象 */
  async json(expr) {
    const raw = await this.evaluate(expr);
    try { return JSON.parse(raw); } catch (_) {
      throw new Error(`页面返回值不是合法 JSON：${String(raw).slice(0, 160)}`);
    }
  }

  async goto(url, waitMs = 1200) {
    await this.send('Page.navigate', { url });
    await sleep(waitMs);
  }
}

/* ---------------- 启动浏览器 ---------------- */

const browserPath = findBrowser();
if (!browserPath) {
  console.log('');
  console.log('  ⚠ 没有找到 Chrome / Edge / Chromium，跳过浏览器交互回归测试。');
  console.log('    可用 CHROME_PATH 环境变量指定浏览器路径。');
  console.log('');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'aml-e2e-'));
const child = spawn(browserPath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  'about:blank'
], { stdio: 'ignore' });

let cdp = null;

function cleanup() {
  try { if (cdp && cdp.ws) cdp.ws.close(); } catch (_) { /* 忽略 */ }
  try { child.kill(); } catch (_) { /* 忽略 */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

/** 等调试端口就绪，拿到页面级 WebSocket 地址 */
async function waitForTarget(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('浏览器调试端口在 20 秒内没有就绪');
}

/* ============================================================
   开始
   ============================================================ */

console.log('');
console.log('  Agent 机制可视化实验室 · 浏览器交互回归');
console.log(`  目标地址 ${BASE}`);
console.log('  ' + '─'.repeat(60));

try {
  cdp = new CDP(await waitForTarget());
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /* 必须显式设定桌面视口。无头浏览器默认是 800×600，窄到会触发响应式折叠，
     「请求与响应左右并排」这类断言会失败，而失败原因和被测代码毫无关系 ——
     这种「环境导致的假失败」最耗时，因为它看起来像真的坏了。 */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
  });

  /* ---------- 场景 1：首页 ---------- */
  await cdp.goto(`${BASE}/#/`, 1500);

  const home = await cdp.json(`(() => {
    const cards = [...document.querySelectorAll('.lab-card')];
    return JSON.stringify({
      cards: cards.length,
      titles: cards.map(c => c.querySelector('h3')?.textContent || ''),
      navCount: document.querySelectorAll('.topnav a[data-nav]').length,
      hasHero: !!document.querySelector('.hero h1'),
      bootHidden: document.getElementById('boot')?.hidden === true,
      title: document.title
    });
  })()`);

  console.log('');
  console.log('  场景 1 · 首页');
  check(home.cards === 3, '三个实验室卡片全部渲染', `实际 ${home.cards} 张`);
  check(home.titles.length === 3 && home.titles.every(Boolean), '每张卡片都有标题', home.titles.join(' / '));
  check(home.navCount === 4, '顶栏导航齐备（首页 + 3 个实验室）', `实际 ${home.navCount} 项`);
  check(home.hasHero, '首页主标题已渲染');
  check(home.bootHidden, '启动占位已移除，不会卡在「正在加载」');
  check(/机制/.test(home.title), '页面标题正确', home.title);

  /* ---------- 场景 2：实验室一 ReAct ---------- */
  await cdp.goto(`${BASE}/#/react`, 1600);

  /* 舞台一次只渲染当前一步。这里读的字段都是为了验证「单步聚焦」真的成立 ——
     尤其是页面高度必须不随步数增长，那正是「太长、不方便查看」的修复点。 */
  const RL_STATE = `(() => {
    const num = (sel) => Number((document.querySelector(sel)?.textContent || '0').replace(/[^0-9]/g, ''));
    const pair = document.querySelector('#rlStage .rl-pair');
    const next = document.querySelector('[data-act="next"]');
    const prev = document.querySelector('[data-act="prev"]');
    return JSON.stringify({
      page: document.documentElement.scrollHeight,
      track: document.querySelectorAll('#rlStage .rl-track-item').length,
      detailCards: document.querySelectorAll('#rlStage .rl-detail .rl-step').length,
      kind: (document.querySelector('#rlStage .rl-kind')?.textContent || '').trim(),
      title: (document.querySelector('#rlStage .rl-step-title')?.textContent || '').trim(),
      counter: (document.querySelector('#rlStage .rl-track-count')?.textContent || '').trim(),
      isStart: !!document.querySelector('#rlStage .rl-tools'),
      toolCount: document.querySelectorAll('#rlStage .rl-tool').length,
      codes: document.querySelectorAll('#rlStage .rl-detail pre.code').length,
      capped: document.querySelectorAll('#rlStage pre.code.is-capped').length,
      pairCols: pair ? getComputedStyle(pair).gridTemplateColumns.split(' ').length : 0,
      ctxTotal: num('[data-ctx-total]'),
      nextExists: !!next, nextDisabled: next ? next.disabled === true : null,
      prevExists: !!prev, prevDisabled: prev ? prev.disabled === true : null
    });
  })()`;

  const rInit = await cdp.json(RL_STATE);

  console.log('');
  console.log('  场景 2 · 实验室一 · ReAct 循环（单步聚焦）');
  check(rInit.track === 5, '步骤轨道含起点共 5 个节点', `实际 ${rInit.track}`);
  check(rInit.detailCards === 1, '舞台一次只渲染当前一步', `实际 ${rInit.detailCards} 个详情卡`);
  check(rInit.isStart && rInit.kind === '起点', '初始停在起点卡片');
  check(rInit.toolCount === 4, '起点卡列出本轮全部可用工具', `${rInit.toolCount} 个`);
  check(rInit.capped >= 1, '代码块带限高，单个长 JSON 不会独撑页面', `${rInit.capped} 个限高块`);
  check(rInit.prevExists && rInit.prevDisabled, '起点时「上一步」已禁用');
  check(rInit.nextExists && !rInit.nextDisabled, '起点时「下一步」可用');
  check(rInit.pairCols === 2, '桌面下请求与响应左右两栏并排', `${rInit.pairCols} 栏`);

  // 逐步前进，记录页面高度、标题、上下文 token
  const series = [];
  for (let i = 0; i < 4; i += 1) {
    await cdp.evaluate(`document.querySelector('[data-act="next"]').click()`);
    await sleep(320);
    series.push(await cdp.json(RL_STATE));
  }

  check(series.every((s) => s.detailCards === 1), '每步都只渲染一个详情卡，不随步数堆积',
    series.map((s) => s.detailCards).join(','));
  check(new Set(series.map((s) => s.title)).size === 4, '四步的标题各不相同',
    series.map((s) => s.title.slice(0, 10)).join(' | '));

  const heights = [rInit.page, ...series.map((s) => s.page)];
  const spread = Math.max(...heights) - Math.min(...heights);
  check(spread < 400, '页面高度基本不随步数变化（「太长」的修复点）',
    `${heights.join(' → ')}px，波动 ${spread}px`);

  const tokens = series.map((s) => s.ctxTotal);
  check(tokens.every((v, i) => i === 0 || v > tokens[i - 1]), '上下文 token 随步数单调递增',
    tokens.join(' → '));

  check(series[0].codes >= 2, '执行步同时展示模型输出与 Observation', `${series[0].codes} 个代码块`);
  check(series[3].nextExists && series[3].nextDisabled, '走到末步后「下一步」自动禁用');
  check(/循环终止/.test(series[3].title), '末步标题标明循环终止', series[3].title);
  check(series[3].codes >= 1, '末步展示最终回答');

  /* 切换轨迹：轨道与详情都要重置，并且新轨迹的报错步要能显示错误标签 */
  await cdp.evaluate(`document.querySelectorAll('#rlTraceSeg button')[1].click()`);
  await sleep(460);
  const rSwitch = await cdp.json(RL_STATE);
  check(rSwitch.track === 4, '切换到轨迹二后轨道变为 4 个节点（起点 + 3 步）', `实际 ${rSwitch.track}`);
  check(rSwitch.isStart, '切换轨迹后回到起点，不残留上一条的进度');
  check(rSwitch.detailCards === 1, '切换后仍只有一张详情卡');

  await cdp.evaluate(`document.querySelector('#rlStage [data-goto="0"]').click()`);
  await sleep(340);
  const errTag = await cdp.evaluate(
    `(document.querySelector('#rlStage .tag.is-danger')?.textContent || '').trim()`
  );
  const errored = await cdp.json(RL_STATE);
  check(!!errTag, '轨迹二的报错步展示「工具返回错误」标签', errTag);
  check(/^第 1 \//.test(errored.counter), '轨道计数器同步到当前步', errored.counter);

  /* 键盘 ← → 也要能切换。用真实按键事件，测的是挂在 document 上的那个监听 */
  const kbBefore = (await cdp.json(RL_STATE)).counter;
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39
    });
  }
  await sleep(340);
  const kbAfter = (await cdp.json(RL_STATE)).counter;
  check(kbBefore !== kbAfter, '← → 键可切换步骤', `${kbBefore} → ${kbAfter}`);

  /* 自动播放：再次点击要能停下来（定时器泄漏会在这里露出来） */
  await cdp.evaluate(`document.querySelector('[data-act="autoplay"]').click()`);
  await sleep(160);
  const playingText = await cdp.evaluate(`document.querySelector('[data-act="autoplay"]').textContent.trim()`);
  await cdp.evaluate(`document.querySelector('[data-act="autoplay"]').click()`);
  await sleep(160);
  const pausedText = await cdp.evaluate(`document.querySelector('[data-act="autoplay"]').textContent.trim()`);
  check(playingText === '暂停', '点击后进入播放态', playingText);
  check(pausedText === '自动播放', '再次点击可暂停', pausedText);

  /* ---------- 场景 3：实验室二 上下文预算 ---------- */
  await cdp.goto(`${BASE}/#/context`, 1500);

  const cInit = await cdp.json(`(() => {
    const legend = [...document.querySelectorAll('#cbStage .cb-legend-row')];
    const num = (el) => Number((el?.textContent || '0').replace(/[^0-9]/g, ''));
    return JSON.stringify({
      segments: document.querySelectorAll('#cbStage .cb-seg').length,
      legendRows: legend.length,
      used: num(document.querySelector('[data-used]')),
      tools: num(document.querySelector('[data-tool-cost]')),
      over: !!document.querySelector('#cbStage .cb-window.is-over'),
      hasEstimatorNote: /估算/.test(document.body.textContent)
    });
  })()`);

  console.log('');
  console.log('  场景 3 · 实验室二 · 上下文预算');
  check(cInit.segments >= 5, '堆叠条包含多段占用', `${cInit.segments} 段`);
  check(cInit.legendRows >= 6, '逐项拆解列出全部构成', `${cInit.legendRows} 行`);
  check(cInit.used > 0 && cInit.tools > 0, '已占用与工具定义开销都已算出',
    `已占用 ${cInit.used} · 工具定义 ${cInit.tools}`);
  check(!cInit.over, '均衡预设下没有超限');
  check(cInit.hasEstimatorNote, '页面上明确标注了「估算」而不是假装精确');

  // 「塞满」预设应当触发超限
  await cdp.evaluate(`document.querySelector('#cbPresetSeg [data-preset="full"]').click()`);
  await sleep(420);
  const cFull = await cdp.json(`(() => JSON.stringify({
    over: !!document.querySelector('#cbStage .cb-window.is-over'),
    notice: !!document.querySelector('#cbStage .cb-note'),
    legendRows: document.querySelectorAll('#cbStage .cb-legend-row').length
  }))()`);
  check(cFull.over, '「塞满」预设触发超限状态（整条变红）');
  check(cFull.notice, '超限时给出明确的取舍提示');

  // 关掉一个工具：工具定义与「每一轮的重发成本」都要下降
  await cdp.evaluate(`document.querySelector('#cbPresetSeg [data-preset="balanced"]').click()`);
  await sleep(360);

  const READ_COSTS = `(() => {
    const num = (sel) => Number((document.querySelector(sel)?.textContent || '0').replace(/[^0-9]/g, ''));
    return JSON.stringify({
      tools: num('[data-tool-cost]'),
      fixed: num('[data-fixed-cost]'),
      used: num('[data-used]'),
      spare: num('[data-spare]'),
      window: num('[data-window]')
    });
  })()`;

  const costBefore = await cdp.json(READ_COSTS);
  await cdp.evaluate(`(() => {
    const cb = document.querySelector('#cbControls [data-tool]');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(380);
  const costAfter = await cdp.json(READ_COSTS);

  check(costAfter.tools > 0 && costAfter.tools < costBefore.tools, '关掉一个工具后工具定义开销下降',
    `${costBefore.tools} → ${costAfter.tools}`);
  check(costAfter.fixed < costBefore.fixed, '每一轮的重发成本同步下降（固定开销按轮数乘）',
    `${costBefore.fixed} → ${costAfter.fixed}`);
  check(costAfter.used < costBefore.used, '已占用总量随之下降', `${costBefore.used} → ${costAfter.used}`);

  // 换窗口档位：内容不变，剩余空间应大幅缩小
  await cdp.evaluate(`document.querySelector('#cbModelSeg [data-model="s"]').click()`);
  await sleep(400);
  const small = await cdp.json(READ_COSTS);

  check(small.window === 8192, '可切换到小窗口档', String(small.window));
  check(small.used === costAfter.used, '换档位不改变内容占用（只改窗口）', String(small.used));
  check(small.spare < costAfter.spare, '窗口变小后剩余空间随之缩小 —— 档位确实参与计算',
    `${costAfter.spare} → ${small.spare}`);

  /* ---------- 场景 4：实验室三 检索与融合 ---------- */
  await cdp.goto(`${BASE}/#/retrieval`, 1600);

  const tInit = await cdp.json(`(() => JSON.stringify({
    cols: document.querySelectorAll('#rtStage .rt-grid .rt-col').length,
    bm25: document.querySelectorAll('#rtStage .rt-col-bm25 .rt-item').length,
    sem: document.querySelectorAll('#rtStage .rt-col-vec .rt-item').length,
    fuse: document.querySelectorAll('#rtStage .rt-col-fuse .rt-item').length,
    math: /1\\/\\(60\\+/.test(document.body.textContent),
    queryTokens: document.body.textContent.includes('分词结果')
  }))()`);

  console.log('');
  console.log('  场景 4 · 实验室三 · 检索与融合');
  check(tInit.cols === 3, '三列（两路召回 + 融合）并排渲染', `${tInit.cols} 列`);
  check(tInit.bm25 >= 1, 'BM25 列有命中结果', `${tInit.bm25} 条`);
  check(tInit.sem >= 1, '语义列有命中结果', `${tInit.sem} 条`);
  check(tInit.fuse >= 1, '融合列有结果', `${tInit.fuse} 条`);
  check(tInit.math, '融合明细把 1/(k+rank) 的算式摊开了');
  check(tInit.queryTokens, '展示了分词与同义词扩展的结果');

  // 换预设查询，结果必须变化
  const firstTop = await cdp.evaluate(`document.querySelector('#rtStage .rt-col-fuse .rt-item .rt-title')?.textContent || ''`);
  await cdp.evaluate(`document.querySelectorAll('#rtStage [data-q]')[1].click()`);
  await sleep(420);
  const secondTop = await cdp.evaluate(`document.querySelector('#rtStage .rt-col-fuse .rt-item .rt-title')?.textContent || ''`);
  check(firstTop && secondTop && firstTop !== secondTop, '切换预设查询后融合第一名发生变化', `${firstTop} → ${secondTop}`);

  // 逐项拆解：独家命中统计
  const exclusives = await cdp.json(`(() => {
    const rows = [...document.querySelectorAll('#rtStage .cb-legend-row')];
    const get = (label) => rows.find(r => r.textContent.includes(label))?.querySelector('.cb-legend-val')?.textContent || '';
    return JSON.stringify({
      onlyBm25: get('只有 BM25 找到'),
      onlySem: get('只有语义通道找到'),
      both: get('两路都找到'),
      top: get('融合结果第 1 名')
    });
  })()`);
  check(exclusives.onlySem && exclusives.onlySem !== '无', '存在「只有语义通道找到」的文档', exclusives.onlySem);
  check(!!exclusives.top, '给出了融合第 1 名的可读标注', exclusives.top);

  // 切换融合方式
  await cdp.evaluate(`document.querySelector('#rtModeSeg [data-mode="score"]').click()`);
  await sleep(380);
  const modeSwitched = await cdp.evaluate(`document.querySelector('#rtStage .rt-col-fuse .rt-col-head h3').textContent`);
  check(/朴素|分数/.test(modeSwitched), '可切换到「朴素分数相加」做对照', modeSwitched);
  await cdp.evaluate(`document.querySelector('#rtModeSeg [data-mode="rrf"]').click()`);
  await sleep(320);

  // k 值影响融合结果
  const kBefore = await cdp.evaluate(`document.querySelector('#rtControls .ctrl-label .val').textContent`);
  await cdp.evaluate(`(() => {
    const s = document.getElementById('rtK');
    s.value = '5';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(320);
  const kAfter = await cdp.evaluate(`document.querySelector('#rtControls .ctrl-label .val').textContent`);
  const mathNow = await cdp.evaluate(`/1\\/\\(5\\+/.test(document.body.textContent)`);
  check(kBefore !== kAfter, 'RRF 常数 k 可调', `${kBefore} → ${kAfter}`);
  check(mathNow, '融合明细中的算式随 k 值同步更新');

  // 点击片段查看原文
  await cdp.evaluate(`document.querySelector('#rtStage .rt-col-bm25 .rt-item').click()`);
  await sleep(360);
  const focusOpen = await cdp.evaluate(`!!document.querySelector('[data-close-focus]')`);
  check(focusOpen, '点击检索结果可展开片段原文');
  await cdp.evaluate(`document.querySelector('[data-close-focus]').click()`);
  await sleep(320);
  const focusClosed = await cdp.evaluate(`!document.querySelector('[data-close-focus]')`);
  check(focusClosed, '片段原文面板可关闭');

  /* ---------- 场景 5：主题与切页清理 ---------- */
  await cdp.goto(`${BASE}/#/react`, 1400);
  await cdp.evaluate(`document.querySelector('[data-act="autoplay"]').click()`);
  await sleep(200);

  const themeBefore = await cdp.evaluate(`document.documentElement.dataset.theme`);
  await cdp.evaluate(`document.getElementById('themeBtn').click()`);
  await sleep(240);
  const themeAfter = await cdp.evaluate(`document.documentElement.dataset.theme`);
  const stored = await cdp.evaluate(`localStorage.getItem('agent-mechanism-lab:theme')`);

  // 播放中切走：上一页的定时器必须被清掉，否则会继续操作已卸载的 DOM
  await cdp.goto(`${BASE}/#/retrieval`, 1400);
  await sleep(1800);
  const afterNav = await cdp.json(`(() => JSON.stringify({
    onRetrieval: !!document.querySelector('#rtStage .rt-col'),
    noReactStage: !document.querySelector('#rlStage'),
    theme: document.documentElement.dataset.theme
  }))()`);

  await cdp.goto(`${BASE}/#/`, 1400);
  const themePersist = await cdp.evaluate(`document.documentElement.dataset.theme`);

  console.log('');
  console.log('  场景 5 · 主题与切页清理');
  check(themeBefore !== themeAfter, '主题按钮可切换深浅色', `${themeBefore} → ${themeAfter}`);
  check(stored === themeAfter, '主题写入 localStorage', String(stored));
  check(afterNav.onRetrieval && afterNav.noReactStage, '切换实验室后上一个页面已完全卸载');
  check(themePersist === themeAfter, '主题在页面重载后保持');

  /* ---------- 场景 6：窄屏不得横向溢出 ----------
     手机上内容被切掉一条边，静态检查完全查不出来，
     但这是最容易被用户第一眼发现的缺陷。 */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });

  const OVERFLOW_PROBE = `(() => {
    const de = document.documentElement;
    const over = de.scrollWidth - de.clientWidth;
    let worst = null;
    if (over > 1) {
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.right > de.clientWidth + 1 && (!worst || r.right > worst.right)) {
          const cls = typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\\s+/).join('.')
            : '';
          worst = { right: Math.round(r.right), sel: el.tagName.toLowerCase() + cls };
        }
      }
    }
    return JSON.stringify({ over, viewport: de.clientWidth, scrollWidth: de.scrollWidth, worst });
  })()`;

  /* 另一类很隐蔽的布局 bug：把管左右内边距的 .wrap / .wrap-lab 与用了
     padding 简写的 .hero / .section / .lab-head / .lab-body 加在同一个元素上，
     简写会把左右内边距一起清零，内容贴着视口边缘。截图里看着像缩放问题，
     很容易被放过去，所以直接断言计算样式。 */
  const PADDING_PROBE = `(() => {
    const targets = ['.hero', '.section', '.site-foot .wrap', '.lab-head', '.lab-body'];
    const bad = [];
    for (const sel of targets) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.offsetWidth < 320) continue;
        const cs = getComputedStyle(el);
        const left = parseFloat(cs.paddingLeft) || 0;
        const right = parseFloat(cs.paddingRight) || 0;
        if (left < 8) bad.push(sel + ' 左内边距 ' + left + 'px');
        if (right < 8) bad.push(sel + ' 右内边距 ' + right + 'px');
      }
    }
    return JSON.stringify({ bad });
  })()`;

  /* 窄屏下正文与控制面板的先后次序：控制面板在手机上有一屏多高，
     排在前面会把正文整个推到下面。 */
  const ORDER_PROBE = `(() => {
    const body = document.querySelector('.lab-body');
    if (!body) return JSON.stringify({ applies: false });
    const stage = body.querySelector('.rl-stage');
    const controls = body.querySelector('.lab-controls');
    return JSON.stringify({
      applies: !!stage && !!controls,
      stageFirst: !!stage && !!controls
        && stage.getBoundingClientRect().top < controls.getBoundingClientRect().top
    });
  })()`;

  console.log('');
  console.log('  场景 6 · 窄屏（390px）横向溢出与容器内边距');
  const pages = [['#/', '首页'], ['#/react', '实验室一'], ['#/context', '实验室二'], ['#/retrieval', '实验室三']];
  for (const [hash, label] of pages) {
    await cdp.goto(`${BASE}/${hash}`, 1500);
    const o = await cdp.json(OVERFLOW_PROBE);
    check(o.over <= 1, `${label} 在 390px 下不横向溢出`,
      o.over > 1 ? `溢出 ${o.over}px，最右元素 ${o.worst ? o.worst.sel : '未知'}` : `视口 ${o.viewport}px`);

    const p = await cdp.json(PADDING_PROBE);
    check(p.bad.length === 0, `${label} 容器左右内边距未被 padding 简写清零`,
      p.bad.slice(0, 2).join(' | '));

    // 窄屏下正文必须排在控制面板之前
    const ord = await cdp.json(ORDER_PROBE);
    if (ord.applies) {
      check(ord.stageFirst, `${label} 窄屏下正文排在控制面板之前`);
    }
  }

  /* 代码块限高是「超长输出不会把页面撑破」的兜底，必须真的会生效。
     正常视口高度下它根本不触发，所以要专门用矮视口把它逼出来 ——
     否则这个兜底坏了也没人知道。 */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 600, deviceScaleFactor: 1, mobile: false
  });
  await cdp.goto(`${BASE}/#/react`, 1600);
  // 轨迹选择在切页后是保留的，所以显式选回轨迹一：只有它的第 1 步
  // Observation 足够长，才会触发限高
  await cdp.evaluate(`document.querySelectorAll('#rlTraceSeg button')[0].click()`);
  await sleep(420);
  await cdp.evaluate(`document.querySelector('[data-act="next"]').click()`);
  await sleep(460);
  const clamped = await cdp.json(`(() => {
    const codes = [...document.querySelectorAll('#rlStage .rl-detail pre.code')];
    const last = codes[codes.length - 1];
    if (!last) return JSON.stringify({ exists: false });
    const cs = getComputedStyle(last);
    return JSON.stringify({
      exists: true,
      cap: cs.maxHeight,
      overflow: cs.overflowY,
      scrolls: last.scrollHeight > last.clientHeight + 1,
      full: last.scrollHeight,
      visible: Math.round(last.getBoundingClientRect().height),
      blocks: codes.length,
      counter: (document.querySelector('#rlStage .rl-track-count')?.textContent || '').trim()
    });
  })()`);
  check(clamped.exists && clamped.scrolls && clamped.overflow === 'auto',
    '矮视口下代码块限高生效并转为内滚（兜底不是摆设）',
    clamped.exists
      ? `${clamped.counter} · ${clamped.blocks} 个块 · max-height=${clamped.cap} · 全文 ${clamped.full}px → 可见 ${clamped.visible}px`
      : '没有代码块');

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.goto(`${BASE}/#/`, 1200);

  /* ---------- 场景 7：无 JS 异常 ---------- */
  check(cdp.pageErrors.length === 0, '全流程零未捕获异常',
    cdp.pageErrors.length ? cdp.pageErrors.slice(0, 2).join(' | ').slice(0, 200) : '');

} catch (err) {
  console.log('');
  console.log(`  ✗ 测试执行中断：${err.message}`);
  fail += 1;
}

/* ---------------- 汇总 ---------------- */

console.log('');
console.log('  ' + '─'.repeat(60));
console.log(`  通过 ${pass} 项 · 失败 ${fail} 项`);

if (fail) {
  console.log('');
  console.log('  失败清单：');
  for (const f of failures) console.log(`    · ${f}`);
  console.log('');
  cleanup();
  process.exit(1);
}

console.log('');
console.log('  ✓ 全部交互断言通过');
console.log('');
cleanup();
process.exit(0);
