/**
 * 段落级差异引擎：
 *  - splitParagraphs：把粘贴的规范全文切分为段落
 *  - similarity：基于字符二元组（bigram）的 Dice 相似度，对中文等无空格语言友好
 *  - diffSequences：基于 LCS 的段落序列比对
 *  - buildFragments：把比对结果整理为「新增 / 删除 / 修改」差异片段
 */

/** 压缩空白，便于相似度比较 */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Dice 相似度（字符 bigram），返回值 ∈ [0, 1] */
export function similarity(a: string, b: string): number {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x.length || !y.length) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;

  const counts = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const c = counts.get(g);
    if (c && c > 0) {
      intersection++;
      counts.set(g, c - 1);
    }
  }
  return (2 * intersection) / (x.length - 1 + (y.length - 1));
}

/**
 * 切分段落：
 *  - 优先按空行分块（块内多行合并为一个段落）；
 *  - 若全文没有空行，则退化为每行一个段落（每行一条条文的情形）。
 */
export function splitParagraphs(content: string): string[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      blocks.push(buf.join('\n').trim());
      buf = [];
    }
  };
  for (const line of lines) {
    if (line.trim() === '') flush();
    else buf.push(line);
  }
  flush();
  const nonEmptyLines = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (blocks.length <= 1 && nonEmptyLines.length > 1) return nonEmptyLines;
  return blocks.filter((b) => b.length > 0);
}

export type DiffOp =
  | { type: 'equal'; oldIndex: number; newIndex: number }
  | { type: 'del'; oldIndex: number }
  | { type: 'ins'; newIndex: number };

/** LCS 矩阵的最大规模，超过则退化为整体替换，防止超长文档撑爆内存 */
const MAX_LCS_CELLS = 40_000_000;

/** 基于 LCS 的序列比对（先剥离公共前后缀，再对中间差异段求最长公共子序列） */
export function diffSequences(a: string[], b: string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }

  for (let k = 0; k < start; k++) ops.push({ type: 'equal', oldIndex: k, newIndex: k });

  const n = aEnd - start;
  const m = bEnd - start;

  if (n > 0 || m > 0) {
    if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_LCS_CELLS) {
      for (let i = 0; i < n; i++) ops.push({ type: 'del', oldIndex: start + i });
      for (let j = 0; j < m; j++) ops.push({ type: 'ins', newIndex: start + j });
    } else {
      const width = m + 1;
      const dp = new Uint32Array((n + 1) * width);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i * width + j] =
            a[start + i] === b[start + j]
              ? dp[(i + 1) * width + j + 1] + 1
              : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a[start + i] === b[start + j]) {
          ops.push({ type: 'equal', oldIndex: start + i, newIndex: start + j });
          i++;
          j++;
        } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
          ops.push({ type: 'del', oldIndex: start + i });
          i++;
        } else {
          ops.push({ type: 'ins', newIndex: start + j });
          j++;
        }
      }
      while (i < n) ops.push({ type: 'del', oldIndex: start + i++ });
      while (j < m) ops.push({ type: 'ins', newIndex: start + j++ });
    }
  }

  for (let k = 0; k < a.length - aEnd; k++) {
    ops.push({ type: 'equal', oldIndex: aEnd + k, newIndex: bEnd + k });
  }
  return ops;
}

export type FragmentType = 'added' | 'removed' | 'changed';

export interface FragmentData {
  ord: number;
  type: FragmentType;
  oldText: string | null;
  newText: string | null;
  /** 1 起始的段落序号，用于界面展示 */
  oldStart: number | null;
  newStart: number | null;
}

/** 同一变更块内，删除段与新增段相似度超过该阈值即配对为「修改」 */
export const PAIR_THRESHOLD = 0.3;

/** 把段落比对结果整理为差异片段列表 */
export function buildFragments(oldParas: string[], newParas: string[]): FragmentData[] {
  const ops = diffSequences(oldParas, newParas);
  const fragments: FragmentData[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      i++;
      continue;
    }
    // 收集一个连续的变更块
    const dels: number[] = [];
    const inss: number[] = [];
    while (i < ops.length && ops[i].type !== 'equal') {
      const op = ops[i];
      if (op.type === 'del') dels.push(op.oldIndex);
      else inss.push(op.newIndex);
      i++;
    }
    // 块内按相似度贪心配对：配对的视为「修改」，落单的为「删除 / 新增」
    const usedIns = new Set<number>();
    const pairs: Array<{ d?: number; n?: number }> = [];
    for (const d of dels) {
      let best = -1;
      let bestSim = PAIR_THRESHOLD;
      for (const nIdx of inss) {
        if (usedIns.has(nIdx)) continue;
        const sim = similarity(oldParas[d], newParas[nIdx]);
        if (sim > bestSim) {
          bestSim = sim;
          best = nIdx;
        }
      }
      if (best >= 0) {
        usedIns.add(best);
        pairs.push({ d, n: best });
      } else {
        pairs.push({ d });
      }
    }
    for (const nIdx of inss) {
      if (!usedIns.has(nIdx)) pairs.push({ n: nIdx });
    }
    pairs.sort((p, q) => {
      const pk = (p.d ?? p.n!) - (q.d ?? q.n!);
      return pk !== 0 ? pk : (p.n ?? p.d!) - (q.n ?? q.d!);
    });
    for (const p of pairs) {
      const type: FragmentType =
        p.d !== undefined && p.n !== undefined ? 'changed' : p.d !== undefined ? 'removed' : 'added';
      fragments.push({
        ord: fragments.length + 1,
        type,
        oldText: p.d !== undefined ? oldParas[p.d] : null,
        newText: p.n !== undefined ? newParas[p.n] : null,
        oldStart: p.d !== undefined ? p.d + 1 : null,
        newStart: p.n !== undefined ? p.n + 1 : null,
      });
    }
  }
  return fragments;
}
