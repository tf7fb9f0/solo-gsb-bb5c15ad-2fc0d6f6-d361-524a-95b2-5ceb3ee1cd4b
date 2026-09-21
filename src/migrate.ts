import type { DB } from './db';
import { similarity } from './diff';

/** 锚点相似度达到该阈值才允许自动迁移，否则标记为「待复核」 */
export const MIGRATION_THRESHOLD = 0.4;

export interface MigrationResult {
  /** 参与迁移的未解决批注总数 */
  total: number;
  /** 成功锚定到新片段的数量 */
  migrated: number;
  /** 无法匹配、被标记为「待复核」的数量 */
  pending: number;
}

interface SourceAnnotation {
  id: number;
  author: string;
  content: string;
  status: string;
  anchor_text: string | null;
  frag_new_text: string | null;
  frag_old_text: string | null;
}

interface TargetFragment {
  id: number;
  old_text: string | null;
  new_text: string | null;
}

/**
 * 把上一轮比对中未解决（待处理 / 待复核）的批注迁移到新一轮比对：
 *  - 以批注保存的文本锚点，与新比对全部片段的新旧文本逐一计算相似度；
 *  - 相似度最高的片段若达到阈值，批注挂载到该片段（原状态为「待复核」的恢复为「待处理」）；
 *  - 否则批注不挂片段，状态置为「待复核」，等待人工处理。
 * 原比对中的批注保留不动，迁移产生的是新比对中的副本（migrated_from 指向来源）。
 */
export function migrateAnnotations(
  db: DB,
  fromComparisonId: number,
  toComparisonId: number
): MigrationResult {
  const unresolved = db
    .prepare(
      `SELECT a.id, a.author, a.content, a.status, a.anchor_text,
              f.new_text AS frag_new_text, f.old_text AS frag_old_text
         FROM annotations a
         LEFT JOIN fragments f ON f.id = a.fragment_id
        WHERE a.comparison_id = ? AND a.status <> 'resolved'
        ORDER BY a.id`
    )
    .all(fromComparisonId) as SourceAnnotation[];

  const targets = db
    .prepare(`SELECT id, old_text, new_text FROM fragments WHERE comparison_id = ?`)
    .all(toComparisonId) as TargetFragment[];

  const insert = db.prepare(
    `INSERT INTO annotations
       (comparison_id, fragment_id, author, content, status, anchor_text, similarity, migrated_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let migrated = 0;
  let pending = 0;

  for (const ann of unresolved) {
    const anchor = ann.anchor_text ?? ann.frag_new_text ?? ann.frag_old_text ?? '';
    let bestId: number | null = null;
    let bestSim = 0;
    for (const t of targets) {
      for (const cand of [t.old_text, t.new_text]) {
        if (!cand) continue;
        const sim = similarity(anchor, cand);
        if (sim > bestSim) {
          bestSim = sim;
          bestId = t.id;
        }
      }
    }
    if (bestId !== null && bestSim >= MIGRATION_THRESHOLD) {
      const status = ann.status === 'pending_review' ? 'open' : ann.status;
      insert.run(toComparisonId, bestId, ann.author, ann.content, status, anchor, bestSim, ann.id);
      migrated++;
    } else {
      insert.run(
        toComparisonId,
        null,
        ann.author,
        ann.content,
        'pending_review',
        anchor,
        bestSim > 0 ? bestSim : null,
        ann.id
      );
      pending++;
    }
  }

  return { total: unresolved.length, migrated, pending };
}
