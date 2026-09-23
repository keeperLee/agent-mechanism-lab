#!/usr/bin/env node
/* ============================================================
   内容与结构校验（CI 用的同一个脚本）
   ------------------------------------------------------------
   除了「文件在不在、挂载点齐不齐」这类静态检查，这里还做了两件
   更有价值的事：

   ① 算法自检（真实执行，不是看代码）
      BM25 / RRF / token 估算都在 Node 里真跑一遍，断言结果符合
      预期。算法被误改动会立刻失败。

   ② 教学行为断言
      本实验室的价值在于「两路召回会分叉、融合能把独家命中的
      文档拉上来」。这几条行为一旦被改语料改坏，页面看起来还
      正常，但已经不教东西了 —— 所以把它锁进 CI。
   ============================================================ */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const P = (rel) => resolve(ROOT, rel);
const read = (rel) => readFileSync(P(rel), 'utf8').replace(/\r\n/g, '\n');

const C = {
  reset: '\u001b[0m', red: '\u001b[31m', green: '\u001b[32m',
  yellow: '\u001b[33m', dim: '\u001b[2m', bold: '\u001b[1m'
};
const USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const paint = (s, c) => (USE_COLOR ? `${c}${s}${C.reset}` : s);

const problems = [];
const warnings = [];
const passes = [];

const ok = (group, msg) => passes.push({ group, msg });
const fail = (group, msg) => problems.push({ group, msg });
const warn = (group, msg) => warnings.push({ group, msg });

/* ============================================================
   1. 关键文件
   ============================================================ */

const REQUIRED = [
  'index.html', '.nojekyll', 'README.md', 'package.json',
  'assets/css/main.css', 'assets/css/lab.css',
  'assets/js/app.js', 'assets/js/ui.js', 'assets/js/tokens.js', 'assets/js/bm25.js',
  'assets/js/data/traces.js', 'assets/js/data/corpus.js', 'assets/js/data/budget.js',
  'assets/js/labs/react.js', 'assets/js/labs/context.js', 'assets/js/labs/retrieval.js',
  'scripts/serve.mjs', 'scripts/validate.mjs',
  '.github/workflows/ci.yml', '.github/workflows/deploy-pages.yml'
];

{
  // .nojekyll 靠「文件存在」本身生效，内容就该是空的
  const ALLOW_EMPTY = new Set(['.nojekyll']);
  let bad = 0;
  for (const rel of REQUIRED) {
    if (!existsSync(P(rel))) { fail('关键文件', `缺少 ${rel}`); bad += 1; continue; }
    if (!ALLOW_EMPTY.has(rel) && statSync(P(rel)).size === 0) {
      fail('关键文件', `${rel} 是空文件`);
      bad += 1;
    }
  }
  if (!bad) ok('关键文件', `${REQUIRED.length} 个必需文件存在且非空（.nojekyll 靠存在生效，允许为空）`);
}

/* ============================================================
   2. index.html
   ============================================================ */

const html = read('index.html');

{
  const MOUNTS = ['viewRoot', 'themeBtn', 'boot'];
  const missing = MOUNTS.filter((id) => !html.includes(`id="${id}"`));
  if (missing.length) fail('页面结构', `index.html 缺少挂载点：${missing.join(', ')}`);
  else ok('页面结构', `挂载点齐备（${MOUNTS.join(', ')}）`);

  // 主题必须在样式生效前定下来，否则深色模式会闪白
  if (!/documentElement\.dataset\.theme/.test(html) || html.indexOf('dataset.theme') > html.indexOf('main.css')) {
    fail('页面结构', 'index.html 的提前设主题脚本缺失或位置不对：必须出现在引入样式之前，否则深色模式会先闪一下白');
  } else {
    ok('页面结构', '主题在样式生效前已确定，不会闪白');
  }

  // 本地资源必须真实存在，否则线上直接 404
  const refs = [...html.matchAll(/(?:href|src)="([^"#][^"]*)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:)?\/\//.test(u) && !u.startsWith('#'));
  const bad = refs.filter((u) => !existsSync(P(u)));
  if (bad.length) fail('页面资源', `index.html 引用了不存在的本地文件：${bad.join(', ')}`);
  else ok('页面资源', `${refs.length} 处本地引用全部存在`);

  // 外链必须带 rel，避免 tabnabbing
  const unsafe = [...html.matchAll(/<a\s[^>]*target="_blank"[^>]*>/g)]
    .filter((m) => !/rel="[^"]*noopener/.test(m[0]));
  if (unsafe.length) warn('页面资源', `${unsafe.length} 个 target="_blank" 链接没有 rel="noopener"`);
}

/* ============================================================
   3. 实验室注册表与模块的挂载点一致性
   ------------------------------------------------------------
   这里能挡住一类很隐蔽的错误：app.js 里写的 controlsId 与实验室
   模块自己 querySelector 的 id 不一致 —— 页面能打开，但控制面板
   是空的，只有点进去才发现。
   ============================================================ */

const appSrc = read('assets/js/app.js');
const LAB_MODULES = {
  react: 'assets/js/labs/react.js',
  context: 'assets/js/labs/context.js',
  retrieval: 'assets/js/labs/retrieval.js'
};

{
  const ids = [...appSrc.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]);
  const registered = [...new Set(ids)];
  const expected = Object.keys(LAB_MODULES);
  const missing = expected.filter((e) => !registered.includes(e));
  if (missing.length) fail('实验室注册', `app.js 的 LABS 里缺少实验室：${missing.join(', ')}`);
  else ok('实验室注册', `已注册 ${expected.length} 个实验室：${expected.join(', ')}`);

  for (const [id, rel] of Object.entries(LAB_MODULES)) {
    if (!existsSync(P(rel))) continue;
    const src = read(rel);

    for (const fn of ['export function mount', 'export function unmount']) {
      if (!src.includes(fn)) fail('实验室注册', `${rel} 缺少 ${fn.replace('export function ', '')} 导出`);
    }

    // 从模块里取出它实际查询的 id
    const used = new Set([...src.matchAll(/\$\('#([A-Za-z]\w*)'\)/g)].map((m) => m[1]));

    // app.js 里这个实验室声明的两个容器 id。
    // 区块边界必须以下一个实验室的 id 为界 —— 用固定长度截取会溢出到
    // 下一个实验室，把别人的容器 id 也算进来，报出一条假错误。
    const starts = [...appSrc.matchAll(/id: '([a-z]+)'/g)].map((m) => ({ id: m[1], at: m.index }));
    const self = starts.find((s) => s.id === id);
    const next = starts.find((s) => s.at > (self ? self.at : 0));
    const block = self ? appSrc.slice(self.at, next ? next.at : appSrc.length) : '';
    const declared = [...block.matchAll(/(?:controlsId|stageId): '(\w+)'/g)].map((m) => m[1]);

    const notQueried = declared.filter((d) => !used.has(d));
    if (notQueried.length) {
      fail('实验室注册',
        `${id}：app.js 声明了容器 ${notQueried.join(', ')}，但 ${rel} 从未查询它 —— 控制面板或舞台会是空的`);
    }
  }
  if (!problems.some((p) => p.group === '实验室注册')) {
    ok('实验室注册', '每个实验室的容器 id 与模块查询的 id 一致');
  }
}

/* ============================================================
   4. 导入纯模块（不碰 DOM，可以在 Node 里直接跑）
   ============================================================ */

const tokens = await import(pathToFileURL(P('assets/js/tokens.js')).href);
const bm25 = await import(pathToFileURL(P('assets/js/bm25.js')).href);
const tracesData = await import(pathToFileURL(P('assets/js/data/traces.js')).href);
const corpusData = await import(pathToFileURL(P('assets/js/data/corpus.js')).href);
const budgetData = await import(pathToFileURL(P('assets/js/data/budget.js')).href);

/* ============================================================
   5. token 估算自检
   ============================================================ */

{
  const g = 'token 估算';

  // 量级断言：中文约 1 字 1 token，英文约 4 字符 1 token
  const cjk = tokens.estimateTokens('中文测试一下');
  if (cjk !== 6) fail(g, `6 个汉字的估算值应为 6，实际 ${cjk}`);
  const ascii = tokens.estimateTokens('abcdefgh');
  if (ascii !== 2) fail(g, `8 个英文字母的估算值应为 2，实际 ${ascii}`);

  const empty = tokens.estimateTokens('');
  if (empty !== 0) fail(g, `空字符串应估算为 0，实际 ${empty}`);

  // 非字符串要能安全处理，不能抛
  let threw = null;
  try {
    tokens.estimateValueTokens({ a: [1, 2, 3], b: '中文' });
    tokens.estimateValueTokens(null);
    tokens.estimateValueTokens(undefined);
    tokens.estimateValueTokens(12345);
  } catch (e) { threw = e; }
  if (threw) fail(g, `estimateValueTokens 处理非字符串时抛错：${threw.message}`);

  // 估算必须单调：更长的文本不能算出更少的 token
  const a = tokens.estimateTokens('短');
  const b = tokens.estimateTokens('短'.repeat(50));
  if (!(b > a)) fail(g, '估算结果不单调：更长的文本算出了更少的 token');

  if (!problems.some((p) => p.group === g)) {
    ok(g, '中英文字符比例、空输入、非字符串输入与单调性全部符合预期');
  }
}

/* ============================================================
   6. 检索算法自检
   ============================================================ */

const index = bm25.createIndex(corpusData.CORPUS);

{
  const g = '检索算法';

  if (!index.N || !(index.avgdl > 0)) fail(g, '索引未建立：文档数为 0 或平均长度非正');

  // 分词：停用词与跨虚词碎片都该被剔掉
  const toks = bm25.tokenize('幻觉怎么缓解');
  if (toks.includes('怎么')) fail(g, '停用词「怎么」没有被剔除 —— 它会污染检索结果');
  if (toks.some((t) => t.includes('怎') || t.includes('么'))) {
    fail(g, `分词产生了跨虚词碎片：${toks.join(', ')}`);
  }
  if (!toks.includes('幻觉')) fail(g, '分词丢掉了关键词「幻觉」');

  // BM25 必须按键值降序返回，且不得出现 NaN / Infinity
  for (const p of corpusData.PRESET_QUERIES) {
    const r = bm25.searchBM25(index, p.query, 6);
    for (let i = 1; i < r.length; i += 1) {
      if (r[i].score > r[i - 1].score) fail(g, `BM25 结果未按分数降序：查询「${p.query}」`);
    }
    if (r.some((x) => !Number.isFinite(x.score))) fail(g, `BM25 出现了非有限分数：查询「${p.query}」`);
    if (r.some((x) => x.score <= 0)) fail(g, `BM25 返回了非正分数：查询「${p.query}」`);
  }

  // 同义词扩展必须是双向的：说「费用」也要能扩展到「成本」那一组
  const fwd = [...bm25.expandQuery('幻觉怎么缓解', corpusData.SYNONYMS).keys()];
  const rev = [...bm25.expandQuery('编造', corpusData.SYNONYMS).keys()];
  if (!fwd.includes('编造')) fail(g, '同义词扩展未生效：查「幻觉」没有扩展到「编造」');
  if (!rev.includes('幻觉')) fail(g, '同义词扩展不是双向的：查「编造」没有回扩到「幻觉」');

  // RRF 的算术必须精确。构造一个可手算的例子：
  //   x 在第 1 路第 1、第 2 路第 2 → 1/61 + 1/62
  //   y 在第 1 路第 2、第 2 路第 1 → 1/62 + 1/61
  // 两者必然相等 —— RRF 对两路是对称的，这正是不需要校准分数的原因
  const k = 60;
  const fused = bm25.reciprocalRankFusion([
    { name: 'a', items: [{ id: 'x' }, { id: 'y' }] },
    { name: 'b', items: [{ id: 'y' }, { id: 'x' }] }
  ], k);
  const expect = 1 / (k + 1) + 1 / (k + 2);
  const x = fused.find((f) => f.id === 'x');
  const y = fused.find((f) => f.id === 'y');
  if (Math.abs(x.score - expect) > 1e-12) {
    fail(g, `RRF 得分计算错误：期望 ${expect}，实际 ${x.score}`);
  }
  if (Math.abs(x.score - y.score) > 1e-12) {
    fail(g, 'RRF 对两路应当对称：(1,2) 与 (2,1) 的得分必须相等');
  }
  if (x.contributions.length !== 2) fail(g, 'RRF 明细没有记录两个通道的贡献');

  // 只被一路命中的文档，得分必须严格低于两路都命中的
  const oneSide = bm25.reciprocalRankFusion([
    { name: 'a', items: [{ id: 'both' }, { id: 'only' }] },
    { name: 'b', items: [{ id: 'both' }] }
  ], k);
  const b1 = oneSide.find((f) => f.id === 'both');
  const o1 = oneSide.find((f) => f.id === 'only');
  if (!(b1.score > o1.score)) fail(g, 'RRF 未能让「两路都命中」的文档排在「单路命中」之前');

  // 分数归一化不能在分数全等时除零
  const flat = bm25.minMaxNormalize([{ id: 'a', score: 5 }, { id: 'b', score: 5 }]);
  if (flat.some((f) => !Number.isFinite(f.score))) fail(g, 'minMaxNormalize 在分数全等时产生了非有限值');

  if (!problems.some((p) => p.group === g)) {
    ok(g, '分词、BM25 排序、双向同义词扩展、RRF 算术与边界情况全部通过');
  }
}

/* ============================================================
   7. 教学行为断言
   ------------------------------------------------------------
   这几条是「这个实验室还讲不讲得出东西」的底线。
   ============================================================ */

{
  const g = '教学行为';

  // ① 两路召回必须能分叉：存在只被语义通道命中的文档
  const q1 = corpusData.PRESET_QUERIES[0];
  const b1 = bm25.searchBM25(index, q1.query, 6).map((r) => r.id);
  const s1 = bm25.searchSemantic(index, q1.query, corpusData.SYNONYMS, 6).map((r) => r.id);
  const onlySem = s1.filter((id) => !b1.includes(id));
  if (!onlySem.length) {
    fail(g, `预设查询「${q1.query}」两路结果完全相同 —— 融合就无从演示了。语料是否被改得用词趋同？`);
  }

  // ② 融合必须把「独家命中」的文档拉进前列，否则看不出融合的价值
  const fused1 = bm25.reciprocalRankFusion([
    { name: 'bm25', items: b1.map((id) => ({ id })) },
    { name: 'sem', items: s1.map((id) => ({ id })) }
  ], 60).slice(0, 3).map((r) => r.id);
  const rescued = onlySem.filter((id) => fused1.includes(id));
  if (!rescued.length) {
    fail(g, '融合后前 3 名里没有任何「仅单路命中」的文档 —— 融合看起来就像没起作用');
  }

  // ③ 必须存在至少一个预设查询，让两路结果明显不同，否则页面全是「两路一致」
  let divergent = 0;
  for (const p of corpusData.PRESET_QUERIES) {
    const a = bm25.searchBM25(index, p.query, 6).map((r) => r.id).join(',');
    const b = bm25.searchSemantic(index, p.query, corpusData.SYNONYMS, 6).map((r) => r.id).join(',');
    if (a !== b) divergent += 1;
  }
  if (divergent < 3) {
    fail(g, `只有 ${divergent} 个预设查询让两路召回产生差异，至少需要 3 个，否则演示单薄`);
  }

  // ④ 语料不能出现重复 id，否则 byId 映射会悄悄丢掉内容
  const ids = corpusData.CORPUS.map((c) => c.id);
  if (new Set(ids).size !== ids.length) {
    fail(g, `语料存在重复 id：${ids.filter((x, i) => ids.indexOf(x) !== i).join(', ')}`);
  }

  if (!problems.some((p) => p.group === g)) {
    ok(g, `两路召回分叉、融合拉上独家命中文档、${divergent}/${corpusData.PRESET_QUERIES.length} 个预设查询产生差异`);
  }
}

/* ============================================================
   8. 轨迹数据完整性
   ============================================================ */

{
  const g = '轨迹数据';
  const toolNames = new Set(tracesData.TOOLS.map((t) => t.name));

  if (!tracesData.TRACES.length) fail(g, '没有任何轨迹');

  for (const tr of tracesData.TRACES) {
    const w = `轨迹「${tr.title || tr.id}」`;
    if (!tr.id) fail(g, `${w} 缺少 id`);
    if (!tr.userMessage) fail(g, `${w} 缺少 userMessage`);
    if (!tr.systemPrompt) fail(g, `${w} 缺少 systemPrompt`);
    if (!tr.steps || !tr.steps.length) { fail(g, `${w} 没有任何步骤`); continue; }
    if (!Array.isArray(tr.takeaway) || tr.takeaway.length < 2) {
      warn(g, `${w} 的教学要点少于 2 条，这一页会显得单薄`);
    }

    // 最后一步必须是 final，否则步骤播放器永远走不到收尾
    const last = tr.steps[tr.steps.length - 1];
    if (last.kind !== 'final') fail(g, `${w} 的最后一步不是 final —— 看不到循环如何终止`);

    tr.steps.forEach((s, i) => {
      const sw = `${w} 第 ${i + 1} 步`;
      if (!s.modelOutput) fail(g, `${sw} 缺少 modelOutput`);
      if (s.kind === 'tool') {
        if (!s.action || !s.action.name) { fail(g, `${sw} 缺少 action.name`); return; }
        if (!toolNames.has(s.action.name)) {
          fail(g, `${sw} 调用了未定义的工具「${s.action.name}」`);
        }
        if (!s.observation) fail(g, `${sw} 是工具步骤但没有 observation —— 循环走不下去`);
        // 报错的 observation 必须带 error 字段，否则界面上的错误标签不会出现
        if (s.isError && !(s.observation && s.observation.error)) {
          fail(g, `${sw} 标了 isError 但 observation 里没有 error 字段`);
        }
      }
      if (s.kind === 'final' && !s.answer) fail(g, `${sw} 是 final 但没有 answer`);
    });

    // 参数必须满足工具 schema 里的 required，否则是「模型乱填参数」而非演示
    for (const s of tr.steps) {
      if (!s.action || !s.action.name) continue;
      const tool = tracesData.TOOLS.find((t) => t.name === s.action.name);
      if (!tool) continue;
      const req = (tool.parameters && tool.parameters.required) || [];
      const missing = req.filter((r) => !(r in (s.action.args || {})));
      if (missing.length) {
        fail(g, `${w} 调用 ${s.action.name} 时缺少必填参数：${missing.join(', ')}`);
      }
      // 枚举值必须落在 schema 允许的范围内（trace-retry 的错误步骤是故意违例的）
      for (const [key, spec] of Object.entries(tool.parameters.properties || {})) {
        if (!spec.enum || !(key in (s.action.args || {}))) continue;
        const val = s.action.args[key];
        if (!spec.enum.includes(val) && !s.isError) {
          fail(g, `${w} 调用 ${s.action.name} 时 ${key}="${val}" 不在枚举 ${JSON.stringify(spec.enum)} 内，且该步没有标记为错误`);
        }
      }
    }
  }

  if (!problems.some((p) => p.group === g)) {
    ok(g, `${tracesData.TRACES.length} 条轨迹：步骤完整、工具名与必填参数合法、均以 final 收尾`);
  }
}

/* ============================================================
   9. 预算数据
   ============================================================ */

{
  const g = '预算数据';
  const wins = budgetData.MODELS.map((m) => m.window);

  for (let i = 1; i < wins.length; i += 1) {
    if (!(wins[i] > wins[i - 1])) fail(g, `窗口档位没有递增：${wins.join(', ')}`);
  }
  if (budgetData.MODELS.some((m) => !Number.isInteger(m.window) || m.window <= 0)) {
    fail(g, '存在非法窗口值（必须是正整数）');
  }
  if (!budgetData.HISTORY_TURNS.length) fail(g, '对话历史样本为空，历史深度滑块会失去意义');
  if (!budgetData.CURRENT_TURN) fail(g, '缺少当前提问文本');
  if (!Number.isInteger(budgetData.DEFAULT_OUTPUT_RESERVE) || budgetData.DEFAULT_OUTPUT_RESERVE <= 0) {
    fail(g, '输出预留默认值非法');
  }
  // 预算实验室复用轨迹的工具集，两边必须是同一份
  if (budgetData.TOOLS !== tracesData.TOOLS) {
    fail(g, '预算实验室的工具集与轨迹不是同一份引用 —— 两个实验室会讲出不同的 Agent');
  }

  if (!problems.some((p) => p.group === g)) {
    ok(g, `${budgetData.MODELS.length} 个窗口档位递增合法，历史样本 ${budgetData.HISTORY_TURNS.length} 轮，工具集与轨迹一致`);
  }
}

/* ============================================================
   10. 样式类名
   ------------------------------------------------------------
   JS 里拼出来的类名如果 CSS 里没有，页面不会报错，只是默默没有
   样式 —— 这类问题很难靠肉眼发现。
   ============================================================ */

{
  const g = '样式类名';
  const css = read('assets/css/main.css') + read('assets/css/lab.css');

  // 从三个实验室模块里抽出关键类名
  const classNames = new Set();
  for (const rel of Object.values(LAB_MODULES)) {
    const src = read(rel);
    for (const m of src.matchAll(/class="([^"$]*?)"/g)) {
      for (const c of m[1].trim().split(/\s+/)) {
        if (c && /^[a-z][\w-]*$/.test(c)) classNames.add(c);
      }
    }
  }

  const missing = [...classNames].filter((c) => !css.includes(`.${c}`));
  if (missing.length) {
    warn(g, `以下类名在 CSS 里找不到定义，可能只是没有样式：${missing.join(', ')}`);
  }
  if (!missing.length && classNames.size) {
    ok(g, `实验室模块用到的 ${classNames.size} 个类名在 CSS 中都有定义`);
  }
}

/* ============================================================
   11. 输出报告
   ============================================================ */

const groups = [...new Set([
  ...passes.map((x) => x.group),
  ...warnings.map((x) => x.group),
  ...problems.map((x) => x.group)
])];

console.log('');
console.log(`  ${paint('Agent 机制可视化实验室 · 内容与结构校验', C.bold)}`);
console.log(`  ${paint('─'.repeat(66), C.dim)}`);

for (const gname of groups) {
  const p = passes.filter((x) => x.group === gname);
  const wn = warnings.filter((x) => x.group === gname);
  const er = problems.filter((x) => x.group === gname);
  const mark = er.length ? paint('✗', C.red) : (wn.length ? paint('!', C.yellow) : paint('✓', C.green));

  console.log(`  ${mark} ${gname}`);
  for (const x of p) console.log(`      ${paint('·', C.dim)} ${x.msg}`);
  for (const x of wn) console.log(`      ${paint('!', C.yellow)} ${x.msg}`);
  for (const x of er) console.log(`      ${paint('✗', C.red)} ${x.msg}`);
}

console.log(`  ${paint('─'.repeat(66), C.dim)}`);
console.log(`  通过 ${passes.length} 组 · 警告 ${warnings.length} 条 · 错误 ${problems.length} 条`);

if (problems.length) {
  console.log('');
  console.log(`  ${paint('✗ 校验未通过', C.red)}`);
  console.log('');
  process.exit(1);
}

console.log('');
console.log(`  ${paint('✓ 校验通过', C.green)}`);
console.log('');
