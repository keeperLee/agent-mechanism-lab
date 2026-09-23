/* ============================================================
   通用工具
   ============================================================ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 转义后再插入 DOM。全站拼接 HTML 的地方都必须经过它 */
export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 千分位。token 数字动辄几万，不分隔很难读 */
export function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/** 百分比，保留一位小数 */
export function pct(part, total) {
  if (!total) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** 紧凑建 DOM，自动把 textContent 当文本处理（不解析 HTML） */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** 深拷贝纯数据（数据模块里的预设对象要被反复重置） */
export function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** 数字列求和 */
export const sum = (arr) => arr.reduce((a, b) => a + b, 0);
