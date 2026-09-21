import type { DB } from './db';
import { similarity } from './diff';

/** 锚点相似度达到该阈值才允许自动迁移，否则标记为「待复核」 */
export const MIGRATION_THRESHOLD = 0.4;

/** 每条迁移批注最多保留的候选片段数（按相似度降序），供迁移复核与人工重挂选择 */
export const MAX_MIGRATION_CANDIDATES = 5;

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

/** 批注锚点在某个目标片段上的最佳匹配（一个片段的新 / 旧文本只保留较高者） */
export interface FragmentCandidate {
  fragmentId: number;
  side: 'old' | 'new';
  similarity: number;
}

/**
 * 计算锚点文本在全部目标片段上的候选列表：
 * 每个片段取新旧两侧文本中相似度较高的一侧，按相似度降序保留前 MAX_MIGRATION_CANDIDATES 条。
 */
export function rankCandidates(anchor: string, targets: TargetFragment[]): FragmentCandidate[] {
  const bestByFragment = new Map<number, FragmentCandidate>();
  for (const t of targets) {
    const sides: Array<['old' | 'new', string | null]> = [
      ['old', t.old_text],
      ['new', t.new_text],
    ];
    for (const [side, text] of sides) {
      if (!text) continue;
      const sim = similarity(anchor, text);
      const prev = bestByFragment.get(t.id);
      if (!prev || sim > prev.similarity) {
        bestByFragment.set(t.id, { fragmentId: t.id, side, similarity: sim });
      }
    }
  }
  return [...bestByFragment.values()]
    .filter((c) => c.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MAX_MIGRATION_CANDIDATES);
}

/**
 * 把上一轮比对中未解决（待处理 / 待复核）的批注迁移到新一轮比对：
 *  - 以批注保存的文本锚点，与新比对全部片段的新旧文本逐一计算相似度；
 *  - 相似度最高的片段若达到阈值，批注挂载到该片段（原状态为「待复核」的恢复为「待处理」）；
 *  - 否则批注不挂片段，状态置为「待复核」，等待人工处理；
 *  - 无论是否自动锚定，每条迁移批注的候选片段及相似度都写入 migration_candidates，
 *    供「迁移复核报告」查看与人工重新挂载时选择。
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
  const insertCandidate = db.prepare(
    `INSERT INTO migration_candidates
       (annotation_id, comparison_id, fragment_id, side, similarity, rank, auto_chosen)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  let migrated = 0;
  let pending = 0;

  for (const ann of unresolved) {
    const anchor = ann.anchor_text ?? ann.frag_new_text ?? ann.frag_old_text ?? '';
    const candidates = rankCandidates(anchor, targets);
    const best = candidates[0] ?? null;
    const anchored = best !== null && best.similarity >= MIGRATION_THRESHOLD;

    const status = anchored
      ? ann.status === 'pending_review'
        ? 'open'
        : ann.status
      : 'pending_review';
    const info = insert.run(
      toComparisonId,
      anchored ? best.fragmentId : null,
      ann.author,
      ann.content,
      status,
      anchor,
      best && best.similarity > 0 ? best.similarity : null,
      ann.id
    );
    const newAnnotationId = Number(info.lastInsertRowid);

    candidates.forEach((c, idx) => {
      insertCandidate.run(
        newAnnotationId,
        toComparisonId,
        c.fragmentId,
        c.side,
        c.similarity,
        idx + 1,
        anchored && idx === 0 ? 1 : 0
      );
    });

    if (anchored) migrated++;
    else pending++;
  }

  return { total: unresolved.length, migrated, pending };
}
