/* ============================================================
   token 估算
   ------------------------------------------------------------
   【为什么是「估算」而不是精确计数】
   精确计数必须依赖具体模型的分词器（BPE / SentencePiece 等），
   那是一份几百 KB 到几 MB 的词表，而且每个模型家族都不同。
   本项目坚持零依赖、纯静态，不可能把词表塞进来 —— 也没有必要：
   这几个实验室要传达的是**量级与相对开销**，不是账单金额。

   【估算方法（页面上也向读者明示）】
   按字符类别分段累加：
     · CJK / 全角字符        约 1 token / 字
     · ASCII 字母数字串       约 1 token / 4 字符
     · 空白与标点             约 1 token / 3 字符
   这是对主流 BPE 分词器行为的粗略拟合。中文 ≈ 1 字 1 token、
   英文 ≈ 4 字符 1 token 是流传最广的两条经验值。

   【误差】
   真实值随分词器、文本领域、是否含大量标识符而波动，实测偏差
   常在 ±20% 以内。所以界面上所有 token 数字都带「估算」标注，
   并且**只用于比较不同构成的相对开销**（例如「工具定义占了多大
   比例」），不用于对外报数。
   ============================================================ */

/** CJK 汉字、日文假名、韩文、全角标点与符号 */
const CJK = /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const ALNUM = /[A-Za-z0-9_]/;

export const ESTIMATOR_NOTE =
  '估算方法：CJK/全角 ≈ 1 字 1 token，英文数字 ≈ 4 字符 1 token，标点空白 ≈ 3 字符 1 token。'
  + '真实值取决于具体分词器，偏差常在 ±20% 以内。';

/**
 * 估算一段文本的 token 数。
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;

  let tokens = 0;
  let i = 0;
  const n = s.length;

  while (i < n) {
    const ch = s[i];

    if (CJK.test(ch)) {
      // CJK 段：逐字计 1
      while (i < n && CJK.test(s[i])) { tokens += 1; i += 1; }
      continue;
    }

    if (ALNUM.test(ch)) {
      // 英文 / 数字 / 下划线串：整体按 4 字符 1 token
      let j = i;
      while (j < n && ALNUM.test(s[j])) j += 1;
      tokens += Math.ceil((j - i) / 4);
      i = j;
      continue;
    }

    // 空白、标点、其他符号：按 3 字符 1 token
    let j = i;
    while (j < n && !CJK.test(s[j]) && !ALNUM.test(s[j])) j += 1;
    tokens += Math.ceil((j - i) / 3);
    i = j;
  }

  return tokens;
}

/** 估算任意值的 token 数：非字符串先序列化，与真实「塞进 prompt」的方式一致 */
export function estimateValueTokens(value) {
  if (typeof value === 'string') return estimateTokens(value);
  if (value === null || value === undefined) return 0;
  try {
    return estimateTokens(JSON.stringify(value));
  } catch (_) {
    return estimateTokens(String(value));
  }
}

/**
 * 估算一段对话消息数组的开销。
 * 真实 API 每条消息还有固定封装开销（role 标记等），这里显式加上，
 * 否则会系统性低估 —— 这正是很多人算不准上下文的原因之一。
 */
export const MESSAGE_OVERHEAD = 4;

export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages || []) {
    total += MESSAGE_OVERHEAD;
    total += estimateTokens(m.role || '');
    total += estimateValueTokens(m.content);
    if (m.tool_calls) total += estimateValueTokens(m.tool_calls);
  }
  return total;
}

/**
 * 估算一份工具定义的固定开销。
 * 这是很多人的盲区：工具 schema 每一轮都会随请求重新发送，
 * 轮数越多，这份固定成本被乘的次数越多。
 */
export function estimateToolTokens(tool) {
  return estimateValueTokens({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  });
}
