/* ============================================================
   检索：BM25 / 词袋余弦 / RRF 融合
   ------------------------------------------------------------
   【这三个都是真实实现，不是演示用的假数据】
     · BM25        —— k1=1.2、b=0.75、IDF 用 ln(1 + (N-df+0.5)/(df+0.5))
     · 词袋余弦     —— tf-idf 加权后的余弦相似度
     · RRF         —— score = Σ 1/(k + rank)，k 取业界常用的 60

   【唯一「替身」在哪，页面也会明说】
   真实检索系统里第二个召回通道是**向量检索**，靠 embedding 模型
   提供「语义泛化」：查「幻觉」也能召回只写了「编造事实」的片段。
   纯静态站点无法内嵌 embedding 模型，所以这里用**手工维护的同义词表**
   来提供同一类泛化能力 —— 算法仍是真实的 tf-idf 余弦，
   只是「语义知识」的来源从学习得到的向量空间换成了人工词表。
   要接真实向量库，只需替换 searchSemantic 这一个函数，
   融合层的数学完全不变。
   ============================================================ */

/* ---------------- 分词 ---------------- */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN = /[a-zA-Z0-9_]+/g;

/**
 * 停用词。
 *
 * 【为什么必须有】
 * 分词用的是 bigram，虚词会产生大量高频碎片。不剔除的话，
 * 查询「幻觉怎么缓解」里的「怎么」会实打实地把一篇讲会话压缩的
 * 文档拉进结果 —— 实测它一度排到第 2 名，纯粹是噪声。
 * 真实检索系统同样要过停用词表，这不是为了演示而加的补丁。
 * 中文停用词以双字虚词为主，正好对应 bigram 的粒度。
 */
const STOPWORDS = new Set((
  '怎么 什么 可以 这个 那个 就是 不是 因为 所以 但是 而且 如果 以及 一个 我们 他们 它们 '
  + '进行 需要 能够 应该 已经 还是 或者 并且 由于 通过 关于 对于 为了 这些 那些 这样 那样 '
  + '之后 之前 现在 时候 一些 一样 不会 没有 是否 的话 来说 而言 到底 如何 哪些 哪个 那么 '
  + '这么 怎样 多少 为什么 会不会 有没有 之类 等等 然后 于是 因此 然而 不过 只是 还要 还要 '
  + 'the a an of to in is are and or for on with how do does can i you it this that'
).split(/\s+/).filter(Boolean));

/**
 * 虚词字符。
 *
 * 【为什么还要这一层】
 * 停用词表按 bigram 粒度剔词，但 bigram 会跨越虚词边界产生碎片：
 * 「幻觉怎么缓解」除了「幻觉」「缓解」，还会切出「觉怎」「么缓」
 * 这种没有任何意义的组合。它们对打分基本无害（语料里几乎不出现），
 * 却会让检索面板显示出一堆垃圾词 —— 教学场景里这很致命。
 * 因此在切 bigram 时就跳过含虚词的组合。
 *
 * 刻意**不包含**「不」「没」等否定字：同义词表里的「不实」需要它，
 * 误伤内容词比留下几个碎片代价更大。这是一次有意识的取舍。
 */
const STOP_CHARS = new Set((
  '的了是在和与或也就都而及等着之呢吗吧啊我你他它们这那哪个些'
  + '以于从但并因所如则且更最还再又已将被把让很太只能要什么怎么'
).split(''));

/**
 * 中文分词：字符二元组（bigram）。
 *
 * 【为什么用 bigram 而不是单字】
 * 单字召回会把「工会」「会计」这类同字不同义的词混在一起，
 * 而且词序信息全丢。bigram 在无词典分词里是很稳的折中方案：
 * 不需要分词词典，又能保留大部分相邻搭配信息。
 * 代价是召回粒度偏细、索引略大 —— 对本实验室的语料规模完全可接受。
 *
 * 英文与数字按单词小写化后整体保留。
 * 两套 token 放在同一个空间里，所以中英混合查询可以直接比。
 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const tokens = [];

  // 英文 / 数字
  for (const m of s.matchAll(LATIN)) tokens.push(m[0]);

  // CJK 连续段 → bigram（单字段落保留单字，否则会丢字）
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (!CJK.test(s[i])) { i += 1; continue; }
    let j = i;
    while (j < n && CJK.test(s[j])) j += 1;
    const run = s.slice(i, j);
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let k = 0; k + 2 <= run.length; k += 1) {
        const pair = run.slice(k, k + 2);
        if (STOP_CHARS.has(pair[0]) || STOP_CHARS.has(pair[1])) continue;
        tokens.push(pair);
      }
    }
    i = j;
  }

  // 文档与查询走同一套停用词，保证两侧的词空间一致
  return tokens.filter((t) => !STOPWORDS.has(t));
}

/* ---------------- 索引 ---------------- */

/**
 * 建立倒排统计量。
 * @param {{id:string,title:string,text:string}[]} chunks
 */
export function createIndex(chunks) {
  const docs = chunks.map((c) => {
    const body = `${c.title} ${c.text}`;
    const tokens = tokenize(body);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { id: c.id, title: c.title, text: c.text, tokens, tf, len: tokens.length };
  });

  const df = new Map();
  for (const d of docs) {
    for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1);
  }

  const avgdl = docs.length ? docs.reduce((a, d) => a + d.len, 0) / docs.length : 0;
  return { docs, df, avgdl, N: docs.length };
}

/** BM25 的 IDF。用 +1 的变体，避免高频词出现负 IDF */
function idf(df, N, term) {
  const d = df.get(term) || 0;
  return Math.log(1 + (N - d + 0.5) / (d + 0.5));
}

/* ---------------- 长尾截断 ---------------- */

/**
 * 相对阈值截断。
 * 低于最高分一定比例的命中，多数只是偶然共现的词碎片（语料里恰好
 * 也出现了同一个 bigram），把它们留在列表里会让两路召回的差异被
 * 噪声淹没。真实检索系统同样要在这一步做截断或重排。
 */
export const REL_CUTOFF = 0.12;

function cutLongTail(scored, topK, rel = REL_CUTOFF) {
  const hits = scored.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
  if (!hits.length) return [];
  const floor = hits[0].score * rel;
  return hits.filter((r) => r.score >= floor).slice(0, topK);
}

/* ---------------- BM25 ---------------- */

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/**
 * BM25 检索：字面精确匹配通道。
 * @returns {{id:string,score:number,matched:string[]}[]} 按分数降序
 */
export function searchBM25(index, queryText, topK = 6) {
  const qTokens = [...new Set(tokenize(queryText))];
  if (!qTokens.length) return [];

  const { docs, df, avgdl, N } = index;
  const scored = docs.map((d) => {
    let score = 0;
    const matched = [];
    for (const t of qTokens) {
      const f = d.tf.get(t) || 0;
      if (!f) continue;
      const denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * d.len) / (avgdl || 1));
      score += idf(df, N, t) * ((f * (BM25_K1 + 1)) / denom);
      matched.push(t);
    }
    // 命中词全在标题里时给一点加权：标题通常是片段主旨
    const inTitle = qTokens.filter((t) => tokenize(d.title).includes(t)).length;
    if (inTitle) score *= 1 + 0.12 * inTitle;
    return { id: d.id, score, matched };
  });

  return cutLongTail(scored, topK);
}

/* ---------------- 同义词扩展（模拟语义泛化） ---------------- */

/**
 * 把查询里的词按同义词表展开，返回「token → 权重」。
 * 原始词权重 1，扩展词权重稍低（0.7）—— 扩展是补充，不应压过原词。
 */
export function expandQuery(queryText, synonyms, expandWeight = 0.7) {
  const weights = new Map();
  const add = (tok, w) => {
    if (!tok) return;
    weights.set(tok, Math.max(weights.get(tok) || 0, w));
  };

  for (const t of tokenize(queryText)) add(t, 1);

  const q = String(queryText ?? '').toLowerCase();

  for (const [key, values] of Object.entries(synonyms || {})) {
    const members = [key, ...values];
    // 双向匹配：查询里出现词条本身、或出现它的任一同义词，都把整组加进来。
    // 只认词条（单向）是不够的 —— 用户说「怎么降费用」时用的是同义词那一侧。
    const hit = members.some((m) => q.includes(String(m).toLowerCase()));
    if (!hit) continue;
    for (const m of members) for (const t of tokenize(m)) add(t, expandWeight);
  }

  return weights;
}

/* ---------------- 词袋余弦（模拟向量检索） ---------------- */

/**
 * 用 tf-idf 加权的词袋余弦做第二路召回。
 * 语义泛化来自 expandQuery 的同义词表（见文件头说明）。
 * @returns {{id:string,score:number,matched:string[]}[]}
 */
export function searchSemantic(index, queryText, synonyms, topK = 6) {
  const qWeights = expandQuery(queryText, synonyms);
  if (!qWeights.size) return [];

  const { docs, df, N } = index;

  // 查询向量
  const qVec = new Map();
  let qNorm = 0;
  for (const [t, w] of qWeights) {
    const v = w * idf(df, N, t);
    if (!v) continue;
    qVec.set(t, v);
    qNorm += v * v;
  }
  qNorm = Math.sqrt(qNorm);
  if (!qNorm) return [];

  const scored = docs.map((d) => {
    let dot = 0;
    let dNorm = 0;
    const matched = [];
    for (const [t, f] of d.tf) {
      const w = (1 + Math.log(f)) * idf(df, N, t);
      dNorm += w * w;
      const qv = qVec.get(t);
      if (qv) { dot += qv * w; matched.push(t); }
    }
    const score = dNorm ? dot / (qNorm * Math.sqrt(dNorm)) : 0;
    return { id: d.id, score, matched };
  });

  return cutLongTail(scored, topK);
}

/* ---------------- 融合 ---------------- */

/** RRF 的平滑常数。60 出自原论文，作用是压低头部名次的权重差距 */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion。
 *
 * 【为什么用名次而不是分数】
 * 不同召回通道的分数不可比：BM25 是无界实数，余弦是 0~1，
 * 向量库返回的可能是内积或距离。想按分数融合就得先归一化，
 * 而归一化本身很不稳 —— 分数分布随查询变化，同一个文档在不同
 * 查询下可能被归一化到完全不同的位置。
 * 名次则天然可比：两边都只有「第 1、第 2、……」，无需校准。
 * 公式里的 1/(k+rank) 让第 1 名和第 2 名的差距不至于过分悬殊。
 *
 * @param {{name:string,items:{id:string}[]}[]} lists 各通道的排名列表
 * @returns {{id:string,score:number,contributions:{list:string,rank:number,term:number}[]}[]}
 */
export function reciprocalRankFusion(lists, k = RRF_K) {
  const acc = new Map();

  for (const list of lists) {
    (list.items || []).forEach((item, idx) => {
      const rank = idx + 1;
      const term = 1 / (k + rank);
      if (!acc.has(item.id)) acc.set(item.id, { id: item.id, score: 0, contributions: [] });
      const entry = acc.get(item.id);
      entry.score += term;
      entry.contributions.push({ list: list.name, rank, term });
    });
  }

  return [...acc.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** 最小-最大归一化到 0~1。分数全等时退化为 0，避免除零 */
export function minMaxNormalize(items) {
  if (!items.length) return [];
  const vals = items.map((i) => i.score);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const span = max - min;
  return items.map((i) => ({ ...i, score: span ? (i.score - min) / span : 0 }));
}

/**
 * 「朴素融合」：归一化后按分数相加。
 * 专供对照 —— 它看起来更「充分利用了分数信息」，但实测很容易
 * 被某一个通道的高分主导。界面上把它和 RRF 并排给人看。
 */
export function scoreFusion(lists) {
  const acc = new Map();
  for (const list of lists) {
    for (const item of minMaxNormalize(list.items || [])) {
      if (!acc.has(item.id)) acc.set(item.id, { id: item.id, score: 0, contributions: [] });
      const entry = acc.get(item.id);
      entry.score += item.score;
      entry.contributions.push({ list: list.name, term: item.score });
    }
  }
  return [...acc.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
