import type { ComparisonDetail } from './service';

const TYPE_LABEL: Record<string, string> = { added: '新增', removed: '删除', changed: '修改' };
const STATUS_LABEL: Record<string, string> = {
  open: '待处理',
  resolved: '已解决',
  pending_review: '待复核',
};
const DECISION_LABEL: Record<string, string> = {
  accepted: '接受变更',
  rejected: '拒绝变更',
  deferred: '暂缓',
};

export function typeLabel(t: string): string {
  return TYPE_LABEL[t] ?? t;
}

export function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

export function decisionLabel(d: string | null | undefined): string {
  return d == null ? '' : DECISION_LABEL[d] ?? d;
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/** 导出 CSV（带 BOM，方便 Excel 直接打开中文） */
export function toCsv(detail: ComparisonDetail): string {
  const { comparison } = detail;
  const header = [
    '片段序号',
    '片段类型',
    '旧文本',
    '新文本',
    '批注作者',
    '批注内容',
    '批注状态',
    '迁移相似度',
    '批注更新时间',
    '片段结论',
    '暂缓理由',
    '结论提出人',
    '结论时间',
  ];
  const rows: string[] = [header.map(csvCell).join(',')];

  const pushRow = (
    ord: number | string,
    type: string,
    oldText: string | null,
    newText: string | null,
    f?: {
      decision: string | null;
      decision_reason: string | null;
      decided_by: string | null;
      decided_at: string | null;
    },
    a?: { author: string; content: string; status: string; similarity: number | null; updated_at: string }
  ) => {
    rows.push(
      [
        ord,
        type,
        oldText ?? '',
        newText ?? '',
        a?.author ?? '',
        a?.content ?? '',
        a ? statusLabel(a.status) : '',
        a?.similarity != null ? a.similarity.toFixed(3) : '',
        a?.updated_at ?? '',
        f ? decisionLabel(f.decision) : '',
        f?.decision_reason ?? '',
        f?.decided_by ?? '',
        f?.decided_at ?? '',
      ]
        .map(csvCell)
        .join(',')
    );
  };

  for (const f of detail.fragments) {
    if (f.annotations.length === 0) {
      pushRow(f.ord, typeLabel(f.type), f.old_text, f.new_text, f);
    } else {
      for (const a of f.annotations) {
        pushRow(f.ord, typeLabel(f.type), f.old_text, f.new_text, f, a);
      }
    }
  }
  for (const a of detail.unanchored) {
    pushRow('-', '待复核（未匹配片段）', a.anchor_text, '', undefined, a);
  }

  // 封存信息以汇总行附在末尾，避免在每个片段行上冗余
  rows.push('');
  rows.push(
    [
      comparison.sealed_at != null ? '已封存' : '草稿（未封存）',
      `封存人：${comparison.sealed_by ?? ''}`,
      `封存时间：${comparison.sealed_at ?? ''}`,
    ]
      .map(csvCell)
      .join(',')
  );

  return '﻿' + rows.join('\r\n');
}

/** 导出 Markdown 审阅报告 */
export function toMarkdown(detail: ComparisonDetail): string {
  const { comparison, fragments, unanchored, stats } = detail;
  const lines: string[] = [];
  lines.push(`# 审阅报告：${comparison.project_name}`);
  lines.push('');
  lines.push(`- 版本对比：\`${comparison.old_label}\` → \`${comparison.new_label}\``);
  lines.push(`- 比对时间：${comparison.created_at}`);
  lines.push(
    `- 封存状态：${
      comparison.sealed_at != null
        ? `**已封存**（封存人：${comparison.sealed_by || '（未署名）'} · 封存时间：${comparison.sealed_at}）`
        : '草稿（未封存）'
    }`
  );
  lines.push(
    `- 差异统计：新增 ${stats.added} · 删除 ${stats.removed} · 修改 ${stats.changed}`
  );
  lines.push(
    `- 片段结论：接受 ${stats.decisions.accepted} · 拒绝 ${stats.decisions.rejected} · 暂缓 ${stats.decisions.deferred} · 未作结论 ${stats.decisions.undecided}（共 ${stats.decisions.total} 个片段）`
  );
  lines.push(
    `- 批注统计：待处理 ${stats.annotations.open} · 已解决 ${stats.annotations.resolved} · 待复核 ${stats.annotations.pending_review}（共 ${stats.annotations.total} 条）`
  );
  lines.push('');
  lines.push('---');

  const renderAnnotation = (a: {
    author: string;
    content: string;
    status: string;
    similarity: number | null;
    migrated_from: number | null;
  }) => {
    const mig =
      a.migrated_from != null
        ? `（迁移自上一轮${a.similarity != null ? `，相似度 ${(a.similarity * 100).toFixed(0)}%` : ''}）`
        : '';
    lines.push(`> 【${statusLabel(a.status)}】**${a.author}**${mig}：${a.content}`);
  };

  const renderDecision = (f: {
    decision: string | null;
    decision_reason: string | null;
    decided_by: string | null;
    decided_at: string | null;
  }) => {
    if (f.decision == null) {
      lines.push('**审阅结论：** ⚠ 尚未作出结论');
      lines.push('');
      return;
    }
    const who = f.decided_by ? `（提出人：${f.decided_by}${f.decided_at ? ` · ${f.decided_at}` : ''}）` : '';
    lines.push(`**审阅结论：** ${decisionLabel(f.decision)}${who}`);
    if (f.decision === 'deferred' && f.decision_reason) {
      lines.push('');
      lines.push(`> 暂缓理由：${f.decision_reason}`);
    }
    lines.push('');
  };

  for (const f of fragments) {
    lines.push('');
    lines.push(`## 片段 #${f.ord}（${typeLabel(f.type)}）`);
    lines.push('');
    if (f.old_text != null) {
      lines.push('**旧文本**');
      lines.push('');
      lines.push('```');
      lines.push(f.old_text);
      lines.push('```');
    }
    if (f.new_text != null) {
      lines.push('**新文本**');
      lines.push('');
      lines.push('```');
      lines.push(f.new_text);
      lines.push('```');
    }
    lines.push('');
    renderDecision(f);
    if (f.annotations.length > 0) {
      lines.push('**批注**');
      lines.push('');
      for (const a of f.annotations) renderAnnotation(a);
    }
  }

  if (unanchored.length > 0) {
    lines.push('');
    lines.push('## 待复核（未匹配到新片段的批注）');
    lines.push('');
    for (const a of unanchored) {
      lines.push(`- 锚点文本：${a.anchor_text ?? '(空)'}`);
      lines.push(`  - 【${statusLabel(a.status)}】**${a.author}**：${a.content}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  if (comparison.sealed_at != null) {
    lines.push(
      `✅ **本比对已于 ${comparison.sealed_at} 由 ${
        comparison.sealed_by || '（未署名）'
      } 封存**，封存后片段结论与批注均不可修改。`
    );
  } else {
    lines.push('📝 本比对当前为**草稿**状态，尚未封存。');
  }

  return lines.join('\n');
}
