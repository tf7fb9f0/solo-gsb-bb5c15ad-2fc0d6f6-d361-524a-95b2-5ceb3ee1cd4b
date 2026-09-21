import type { DB } from './db';
import { similarity } from './diff';

/** 锚点相似度达到该阈值才允许自动迁移，否则标记为「待复核」 */
export const MIGRATION_THRESHOLD = 0.4;

/** 每条迁移批注最多保存的候选片段数（供迁移复核报告与人工重挂选择） */
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
  ord: number;
  type: string;
  old_text: string | null;
  new_text: string | null;
}

/** 一个候选片段：取该片段新 / 旧两侧文本中与锚点最相似的一侧 */
interface ScoredCandidate {
  fragmentId: number;
  fragmentOrd: number;
  fragmentType: string;
  side: 'old' | 'new';
  text: string;
  similarity: number;
}

/**
 * 把上一轮比对中未解决（待处理 / 待复核）的批注迁移到新一轮比对：
 *  - 以批注保存的文本锚点，与新比对全部片段的新旧文本逐一计算相似度；
 *  - 相似度最高的片段若达到阈值，批注挂载到该片段（原状态为「待复核」的恢复为「待处理」）；
 *  - 否则批注不挂片段，状态置为「待复核」，等待人工处理。
 * 每条迁移批注的候选片段（按相似度排序的 Top-N）连同相似度一并写入
 * migration_candidates，供「迁移复核」报告查看与人工重新挂载时选择。
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
    .prepare(`SELECT id, ord, type, old_text, new_text FROM fragments WHERE comparison_id = ?`)
    .all(toComparisonId) as TargetFragment[];

  const insert = db.prepare(
    `INSERT INTO annotations
       (comparison_id, fragment_id, author, content, status, anchor_text, similarity, migrated_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertCandidate = db.prepare(
    `INSERT INTO migration_candidates
       (annotation_id, comparison_id, fragment_id, fragment_ord, fragment_type,
        side, candidate_text, similarity, rank, chosen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let migrated = 0;
  let pending = 0;

  for (const ann of unresolved) {
    const anchor = ann.anchor_text ?? ann.frag_new_text ?? ann.frag_old_text ?? '';

    // 每个片段取新 / 旧两侧中相似度更高的一侧作为该片段的候选，再按相似度排序取 Top-N
    const scored: ScoredCandidate[] = [];
    for (const t of targets) {
      let best: ScoredCandidate | null = null;
      for (const [side, text] of [
        ['old', t.old_text],
        ['new', t.new_text],
      ] as Array<['old' | 'new', string | null]>) {
        if (!text) continue;
        const sim = similarity(anchor, text);
        if (!best || sim > best.similarity) {
          best = {
            fragmentId: t.id,
            fragmentOrd: t.ord,
            fragmentType: t.type,
            side,
            text,
            similarity: sim,
          };
        }
      }
      if (best && best.similarity > 0) scored.push(best);
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    const top = scored.slice(0, MAX_MIGRATION_CANDIDATES);

    const best = top[0] ?? null;
    const mounted = best !== null && best.similarity >= MIGRATION_THRESHOLD;
    const status = mounted ? (ann.status === 'pending_review' ? 'open' : ann.status) : 'pending_review';
    const newAnnotationId = Number(
      insert.run(
        toComparisonId,
        mounted ? best!.fragmentId : null,
        ann.author,
        ann.content,
        status,
        anchor,
        best && best.similarity > 0 ? best.similarity : null,
        ann.id
      ).lastInsertRowid
    );

    top.forEach((cand, idx) => {
      insertCandidate.run(
        newAnnotationId,
        toComparisonId,
        cand.fragmentId,
        cand.fragmentOrd,
        cand.fragmentType,
        cand.side,
        cand.text,
        cand.similarity,
        idx + 1,
        mounted && idx === 0 ? 1 : 0
      );
    });

    if (mounted) migrated++;
    else pending++;
  }

  return { total: unresolved.length, migrated, pending };
}
