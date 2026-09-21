import type { DB } from './db';
import { splitParagraphs, diffSequences } from './diff';
import { typeLabel, decisionLabel } from './exporter';
import type { FragmentRow, FragmentDecision, ComparisonDetail } from './service';

/**
 * 决议稿生成：
 * 仅当比对中的全部差异片段都已有结论（接受 / 拒绝 / 暂缓）时才能生成。
 * 重建正文时重新计算新旧版本的段落序列对齐（与导入时同一套 LCS 引擎，
 * 版本内容不可变，结果确定），再按片段记录的旧 / 新段落序号把结论逐一
 * 落到对齐操作上 —— 全程基于段落位置，不做任何全局字符串替换，
 * 因此相邻的新增 / 删除 / 修改以及重复段落都能被正确处理。
 *
 * 结论落地规则：
 *  - 接受（accepted）：采用新版内容（新增保留、删除不恢复、修改用新文）；
 *  - 拒绝（rejected）：恢复旧版内容（新增剔除、删除在原位置恢复、修改回旧文）；
 *  - 暂缓（deferred）：正文暂保留新版状态，同时把片段与理由列入独立待办清单。
 */

/** 决议稿段落来源 */
export type ParagraphSource =
  | 'unchanged' // 未变更段落（新旧一致）
  | 'new'       // 采用新版内容（接受 / 暂缓的新增与修改）
  | 'old';      // 恢复旧版内容（被拒绝的修改 / 删除）

export const SOURCE_LABEL: Record<ParagraphSource, string> = {
  unchanged: '未变更',
  new: '采用新版',
  old: '恢复旧版',
};

export interface ResolutionParagraph {
  /** 决议稿中的段落序号（1 起） */
  ord: number;
  text: string;
  source: ParagraphSource;
  /** 对应的差异片段序号；未变更段落为 null */
  fragment_ord: number | null;
  fragment_type: FragmentRow['type'] | null;
  decision: FragmentDecision | null;
}

export interface ResolutionTodo {
  fragment_ord: number;
  fragment_type: FragmentRow['type'];
  reason: string;
  decided_by: string | null;
  decided_at: string | null;
  old_text: string | null;
  new_text: string | null;
  /** 暂缓期间决议稿的处理方式：new = 暂保留新版内容；absent = 暂维持删除（新版不含该段） */
  kept: 'new' | 'absent';
}

export interface Resolution {
  comparison: ComparisonDetail['comparison'];
  generated_at: string;
  paragraphs: ResolutionParagraph[];
  /** 暂缓待办清单（按片段序号排序） */
  todos: ResolutionTodo[];
  stats: {
    total: number;
    unchanged: number;
    from_new: number;
    from_old: number;
    deferred: number;
  };
}

export type ResolutionResult =
  | { status: 'ok'; resolution: Resolution }
  | { status: 'not_found' }
  | { status: 'undecided'; ords: number[] };

type ComparisonInfo = ComparisonDetail['comparison'];

type ComparisonRow = ComparisonInfo & {
  old_content: string;
  new_content: string;
};

export function buildResolution(db: DB, comparisonId: number): ResolutionResult {
  const comparison = db
    .prepare(
      `SELECT c.id, c.project_id, c.created_at, c.sealed_by, c.sealed_at,
              p.name AS project_name,
              ov.label AS old_label, nv.label AS new_label,
              ov.seq AS old_seq, nv.seq AS new_seq,
              ov.content AS old_content, nv.content AS new_content
         FROM comparisons c
         JOIN projects p ON p.id = c.project_id
         JOIN versions ov ON ov.id = c.old_version_id
         JOIN versions nv ON nv.id = c.new_version_id
        WHERE c.id = ?`
    )
    .get(comparisonId) as ComparisonRow | undefined;
  if (!comparison) return { status: 'not_found' };

  const fragments = db
    .prepare('SELECT * FROM fragments WHERE comparison_id = ? ORDER BY ord')
    .all(comparisonId) as FragmentRow[];

  const undecided = fragments.filter((f) => f.decision == null).map((f) => f.ord);
  if (undecided.length > 0) return { status: 'undecided', ords: undecided };

  const oldParas = splitParagraphs(comparison.old_content);
  const newParas = splitParagraphs(comparison.new_content);
  const ops = diffSequences(oldParas, newParas);

  // 片段按段落序号（1 起）索引到对齐操作使用的 0 起下标
  const removedByOld = new Map<number, FragmentRow>();
  const changedByOld = new Map<number, FragmentRow>();
  const addedByNew = new Map<number, FragmentRow>();
  const changedByNew = new Map<number, FragmentRow>();
  for (const f of fragments) {
    if (f.type === 'removed') removedByOld.set(f.old_start! - 1, f);
    else if (f.type === 'added') addedByNew.set(f.new_start! - 1, f);
    else {
      changedByOld.set(f.old_start! - 1, f);
      changedByNew.set(f.new_start! - 1, f);
    }
  }

  const paragraphs: ResolutionParagraph[] = [];
  const consumed = new Set<number>();
  const push = (text: string, source: ParagraphSource, f: FragmentRow | null) => {
    if (f) consumed.add(f.id);
    paragraphs.push({
      ord: paragraphs.length + 1,
      text,
      source,
      fragment_ord: f?.ord ?? null,
      fragment_type: f?.type ?? null,
      decision: f?.decision ?? null,
    });
  };

  for (const op of ops) {
    if (op.type === 'equal') {
      push(newParas[op.newIndex], 'unchanged', null);
      continue;
    }
    if (op.type === 'del') {
      // 「修改」片段的删除半边：统一在对应的新增半边处落地，这里跳过
      if (changedByOld.has(op.oldIndex)) continue;
      const f = removedByOld.get(op.oldIndex);
      if (!f) {
        throw new Error(`差异片段与版本内容不一致：旧段落 ${op.oldIndex + 1} 缺少对应片段`);
      }
      consumed.add(f.id);
      // 拒绝删除 → 在原位置恢复旧段落；接受 / 暂缓 → 维持删除，不产出段落
      if (f.decision === 'rejected') push(oldParas[op.oldIndex], 'old', f);
      continue;
    }
    // ins
    const changed = changedByNew.get(op.newIndex);
    if (changed) {
      const rejected = changed.decision === 'rejected';
      push(rejected ? changed.old_text! : changed.new_text!, rejected ? 'old' : 'new', changed);
      continue;
    }
    const added = addedByNew.get(op.newIndex);
    if (!added) {
      throw new Error(`差异片段与版本内容不一致：新段落 ${op.newIndex + 1} 缺少对应片段`);
    }
    consumed.add(added.id);
    // 拒绝新增 → 剔除该段；接受 / 暂缓 → 保留新版内容
    if (added.decision === 'rejected') continue;
    push(newParas[op.newIndex], 'new', added);
  }

  if (consumed.size !== fragments.length) {
    throw new Error('差异片段与版本内容不一致：存在无法对应到段落序列的片段');
  }

  const todos: ResolutionTodo[] = fragments
    .filter((f) => f.decision === 'deferred')
    .map((f) => ({
      fragment_ord: f.ord,
      fragment_type: f.type,
      reason: f.decision_reason ?? '',
      decided_by: f.decided_by,
      decided_at: f.decided_at,
      old_text: f.old_text,
      new_text: f.new_text,
      kept: f.type === 'removed' ? 'absent' : 'new',
    }));

  const stats = { total: paragraphs.length, unchanged: 0, from_new: 0, from_old: 0, deferred: todos.length };
  for (const p of paragraphs) {
    if (p.source === 'unchanged') stats.unchanged++;
    else if (p.source === 'new') stats.from_new++;
    else stats.from_old++;
  }

  const generatedAt = db.prepare("SELECT datetime('now', 'localtime') AS t").get() as { t: string };

  const comparisonInfo: ComparisonInfo = {
    id: comparison.id,
    project_id: comparison.project_id,
    project_name: comparison.project_name,
    old_label: comparison.old_label,
    new_label: comparison.new_label,
    old_seq: comparison.old_seq,
    new_seq: comparison.new_seq,
    sealed_by: comparison.sealed_by,
    sealed_at: comparison.sealed_at,
    created_at: comparison.created_at,
  };
  return {
    status: 'ok',
    resolution: {
      comparison: comparisonInfo,
      generated_at: generatedAt.t,
      paragraphs,
      todos,
      stats,
    },
  };
}

/** 把决议稿渲染为 UTF-8 Markdown（正文 + 来源标记 + 暂缓待办清单） */
export function resolutionToMarkdown(resolution: Resolution): string {
  const { comparison, paragraphs, todos, stats } = resolution;
  const lines: string[] = [];
  lines.push(`# 决议稿：${comparison.project_name}`);
  lines.push('');
  lines.push(`- 版本对比：\`${comparison.old_label}\` → \`${comparison.new_label}\``);
  lines.push(`- 生成时间：${resolution.generated_at}`);
  lines.push(
    `- 比对状态：${
      comparison.sealed_at != null
        ? `已封存（封存人：${comparison.sealed_by || '（未署名）'} · ${comparison.sealed_at}）`
        : '草稿（未封存）'
    }`
  );
  lines.push(
    `- 段落统计：共 ${stats.total} 段（未变更 ${stats.unchanged} · 采用新版 ${stats.from_new} · 恢复旧版 ${stats.from_old}）`
  );
  lines.push(`- 暂缓事项：${stats.deferred} 项（结论落地规则：接受 → 采用新版，拒绝 → 恢复旧版，暂缓 → 暂保留新版状态并列入待办）`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 正文');
  lines.push('');
  for (const p of paragraphs) {
    lines.push(p.text);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 来源标记');
  lines.push('');
  lines.push('| 段落 | 来源 | 对应片段 | 片段结论 |');
  lines.push('| ---- | ---- | -------- | -------- |');
  for (const p of paragraphs) {
    const frag =
      p.fragment_ord != null ? `#${p.fragment_ord}（${typeLabel(p.fragment_type!)}）` : '—';
    const decision = p.decision != null ? decisionLabel(p.decision) : '—';
    lines.push(`| ¶${p.ord} | ${SOURCE_LABEL[p.source]} | ${frag} | ${decision} |`);
  }

  lines.push('');
  lines.push('## 暂缓待办清单');
  lines.push('');
  if (todos.length === 0) {
    lines.push('无暂缓事项。');
  } else {
    todos.forEach((t, i) => {
      const kept = t.kept === 'absent' ? '决议稿暂维持删除（新版不含该段）' : '决议稿暂保留新版内容';
      lines.push(`${i + 1}. **片段 #${t.fragment_ord}（${typeLabel(t.fragment_type)}）** — ${kept}`);
      lines.push(`   - 暂缓理由：${t.reason}`);
      const who = t.decided_by ? `${t.decided_by}${t.decided_at ? ` · ${t.decided_at}` : ''}` : '（未署名）';
      lines.push(`   - 提出人：${who}`);
      if (t.old_text != null) lines.push(`   - 旧文本：${t.old_text}`);
      if (t.new_text != null) lines.push(`   - 新文本：${t.new_text}`);
    });
  }
  lines.push('');
  return lines.join('\n');
}
