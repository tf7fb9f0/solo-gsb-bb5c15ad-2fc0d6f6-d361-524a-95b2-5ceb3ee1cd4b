import type { DB } from './db';
import { splitParagraphs, buildFragments } from './diff';
import { migrateAnnotations, type MigrationResult } from './migrate';

export function createProject(db: DB, name: string): number {
  const info = db.prepare('INSERT INTO projects (name) VALUES (?)').run(name);
  return Number(info.lastInsertRowid);
}

/**
 * 导入批注的来源信息：
 *  - migrated：找到「以所选基线为新版」的最近一轮比对，已按锚点迁移；
 *  - skipped：不存在这样的比对（如直接以首版为基线），明确不迁移，
 *    绝不回退到项目最新一轮比对，以免误带批注。
 */
export type ImportMigrationInfo =
  | (MigrationResult & { status: 'migrated'; source_comparison_id: number })
  | {
      status: 'skipped';
      reason: 'no_source_comparison';
      total: 0;
      migrated: 0;
      pending: 0;
      message: string;
    };

export interface ImportOk {
  status: 'ok';
  versionId: number;
  seq: number;
  comparisonId: number | null;
  fragmentCount: number;
  /** 本轮比对实际使用的基线版本（首版为 null） */
  baselineVersionId: number | null;
  migration: ImportMigrationInfo | null;
}

export type ImportVersionResult =
  | ImportOk
  | {
      status: 'error';
      reason: 'not_found' | 'baseline_not_in_project' | 'baseline_not_earlier';
    };

export type BaselineCheck =
  | { ok: true; baseline: { id: number; seq: number; content: string } }
  | { ok: false; reason: 'baseline_not_in_project' | 'baseline_not_earlier' };

/**
 * 纯函数校验：解析并校验显式指定的比对基线。
 *  - 基线必须存在且属于本项目；
 *  - 基线必须早于即将导入的新版本（newSeq 已按 MAX(seq)+1 确定）。
 *
 * 正常线性导入时后者必然成立；该校验是针对并发导入 / 脏数据的防御性不变量。
 */
export function resolveBaseline(
  row: { id: number; seq: number; content: string } | undefined,
  newSeq: number
): BaselineCheck {
  if (!row) return { ok: false, reason: 'baseline_not_in_project' };
  if (row.seq >= newSeq) return { ok: false, reason: 'baseline_not_earlier' };
  return { ok: true, baseline: row };
}

/**
 * 导入一个版本并在同一事务内完成：
 *  1. 确定比对基线：默认取项目最新版本，也可显式指定项目内任一历史版本；
 *  2. 校验基线归属本项目且早于本次导入的新版本；
 *  3. 按所选基线生成差异片段（比对）；
 *  4. 批注只允许从「以该基线为新版」的最近一轮比对迁移，找不到则明确不迁移。
 */
export function importVersion(
  db: DB,
  projectId: number,
  label: string,
  content: string,
  baselineVersionId?: number
): ImportVersionResult {
  const tx = db.transaction((): ImportVersionResult => {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return { status: 'error', reason: 'not_found' };

    const latest = db
      .prepare('SELECT id, seq, content FROM versions WHERE project_id = ? ORDER BY seq DESC LIMIT 1')
      .get(projectId) as { id: number; seq: number; content: string } | undefined;

    const seq = latest ? latest.seq + 1 : 1;

    // 基线校验在写入新版本之前完成：非法基线直接返回错误，事务内不留下任何数据。
    let baseline: { id: number; seq: number; content: string };
    if (baselineVersionId != null) {
      const row = db
        .prepare('SELECT id, seq, content FROM versions WHERE id = ? AND project_id = ?')
        .get(baselineVersionId, projectId) as
        | { id: number; seq: number; content: string }
        | undefined;
      const check = resolveBaseline(row, seq);
      if (!check.ok) return { status: 'error', reason: check.reason };
      baseline = check.baseline;
    } else {
      // 首版之外默认仍取最新版本
      if (!latest) {
        const firstId = Number(
          db
            .prepare('INSERT INTO versions (project_id, label, content, seq) VALUES (?, ?, ?, ?)')
            .run(projectId, label, content, 1).lastInsertRowid
        );
        return {
          status: 'ok',
          versionId: firstId,
          seq: 1,
          comparisonId: null,
          fragmentCount: 0,
          baselineVersionId: null,
          migration: null,
        };
      }
      baseline = latest;
    }

    const versionId = Number(
      db
        .prepare('INSERT INTO versions (project_id, label, content, seq) VALUES (?, ?, ?, ?)')
        .run(projectId, label, content, seq).lastInsertRowid
    );

    const comparisonId = Number(
      db
        .prepare('INSERT INTO comparisons (project_id, old_version_id, new_version_id) VALUES (?, ?, ?)')
        .run(projectId, baseline.id, versionId).lastInsertRowid
    );

    const fragments = buildFragments(splitParagraphs(baseline.content), splitParagraphs(content));
    const insertFragment = db.prepare(
      `INSERT INTO fragments (comparison_id, ord, type, old_text, new_text, old_start, new_start, anchor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const f of fragments) {
      insertFragment.run(
        comparisonId,
        f.ord,
        f.type,
        f.oldText,
        f.newText,
        f.oldStart,
        f.newStart,
        f.newText ?? f.oldText ?? ''
      );
    }

    // 仅允许来自「以所选基线为新版」的最近一轮比对；禁止回退到项目最新比对误带批注。
    const sourceComparison = db
      .prepare(
        `SELECT id FROM comparisons
          WHERE project_id = ? AND new_version_id = ?
          ORDER BY id DESC LIMIT 1`
      )
      .get(projectId, baseline.id) as { id: number } | undefined;

    let migration: ImportMigrationInfo;
    if (sourceComparison) {
      migration = {
        status: 'migrated',
        ...migrateAnnotations(db, sourceComparison.id, comparisonId),
        source_comparison_id: sourceComparison.id,
      };
    } else {
      migration = {
        status: 'skipped',
        reason: 'no_source_comparison',
        total: 0,
        migrated: 0,
        pending: 0,
        message: '所选基线历史上未作为新版参与过比对，批注未迁移',
      };
    }

    return {
      status: 'ok',
      versionId,
      seq,
      comparisonId,
      fragmentCount: fragments.length,
      baselineVersionId: baseline.id,
      migration,
    };
  });
  return tx();
}

/** 在差异片段上创建批注，锚点取片段当前（新）文本。
 *  已封存的比对禁止新增批注（sealed）；片段不存在返回 null。 */
export function addAnnotation(
  db: DB,
  fragmentId: number,
  author: string,
  content: string
): { status: 'ok'; id: number } | { status: 'not_found' } | { status: 'sealed' } {
  const frag = db
    .prepare(
      `SELECT f.id, f.comparison_id, f.old_text, f.new_text, c.sealed_at
         FROM fragments f JOIN comparisons c ON c.id = f.comparison_id
        WHERE f.id = ?`
    )
    .get(fragmentId) as
    | { id: number; comparison_id: number; old_text: string | null; new_text: string | null; sealed_at: string | null }
    | undefined;
  if (!frag) return { status: 'not_found' };
  if (frag.sealed_at != null) return { status: 'sealed' };
  const anchor = frag.new_text ?? frag.old_text ?? '';
  const info = db
    .prepare(
      `INSERT INTO annotations (comparison_id, fragment_id, author, content, status, anchor_text)
       VALUES (?, ?, ?, ?, 'open', ?)`
    )
    .run(frag.comparison_id, fragmentId, author, content, anchor);
  return { status: 'ok', id: Number(info.lastInsertRowid) };
}

export type FragmentDecision = 'accepted' | 'rejected' | 'deferred';
export const FRAGMENT_DECISIONS: readonly FragmentDecision[] = ['accepted', 'rejected', 'deferred'];

export interface Blocker {
  kind: 'undecided_fragment' | 'open_annotation' | 'pending_review_annotation';
  message: string;
  fragment_ord?: number;
  annotation_id?: number;
}

export type SaveDecisionResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'sealed' }
  | { status: 'reason_required' };

/**
 * 保存片段审阅结论：接受变更 / 拒绝变更 / 暂缓。
 * 暂缓（deferred）必须填写理由。已封存的比对禁止修改结论。
 */
export function saveFragmentDecision(
  db: DB,
  fragmentId: number,
  decision: FragmentDecision,
  reason: string | null,
  decidedBy: string | null
): SaveDecisionResult {
  const frag = db
    .prepare(
      `SELECT f.id, c.sealed_at
         FROM fragments f JOIN comparisons c ON c.id = f.comparison_id
        WHERE f.id = ?`
    )
    .get(fragmentId) as { id: number; sealed_at: string | null } | undefined;
  if (!frag) return { status: 'not_found' };
  if (frag.sealed_at != null) return { status: 'sealed' };
  if (decision === 'deferred' && (reason == null || !reason.trim())) {
    return { status: 'reason_required' };
  }
  db.prepare(
    `UPDATE fragments
        SET decision = ?, decision_reason = ?, decided_by = ?,
            decided_at = datetime('now', 'localtime')
      WHERE id = ?`
  ).run(
    decision,
    decision === 'deferred' ? reason!.trim() : null,
    decidedBy,
    fragmentId
  );
  return { status: 'ok' };
}

/** 汇总封存前的全部阻塞项：未作结论的片段、未解决 / 待复核批注 */
export function getSealBlockers(db: DB, comparisonId: number): Blocker[] {
  const blockers: Blocker[] = [];
  const undecided = db
    .prepare(`SELECT ord FROM fragments WHERE comparison_id = ? AND decision IS NULL ORDER BY ord`)
    .all(comparisonId) as Array<{ ord: number }>;
  for (const f of undecided) {
    blockers.push({
      kind: 'undecided_fragment',
      fragment_ord: f.ord,
      message: `片段 #${f.ord} 尚未作出审阅结论`,
    });
  }
  const anns = db
    .prepare(
      `SELECT id, status, fragment_id
         FROM annotations
        WHERE comparison_id = ? AND status IN ('open', 'pending_review')
        ORDER BY id`
    )
    .all(comparisonId) as Array<{ id: number; status: string; fragment_id: number | null }>;
  for (const a of anns) {
    const suffix = a.fragment_id == null ? '（位于待复核区）' : '';
    blockers.push({
      kind: a.status === 'open' ? 'open_annotation' : 'pending_review_annotation',
      annotation_id: a.id,
      message:
        a.status === 'open'
          ? `存在未解决批注 #${a.id}${suffix}`
          : `存在待复核批注 #${a.id}${suffix}`,
    });
  }
  return blockers;
}

export interface SealedComparison {
  sealed_by: string;
  sealed_at: string;
}

export type SealResult =
  | { status: 'ok'; sealed: SealedComparison }
  | { status: 'not_found' }
  | { status: 'already_sealed'; sealed: SealedComparison }
  | { status: 'blocked'; blockers: Blocker[] };

/**
 * 封存比对：服务端在单个事务内再次校验
 *（全部片段已有结论、不存在未解决 / 待复核批注），
 * 任何阻塞项都会回滚并返回明细。
 */
export function sealComparison(
  db: DB,
  comparisonId: number,
  sealedBy: string
): SealResult {
  const tx = db.transaction((): SealResult => {
    const cmpRow = db
      .prepare('SELECT sealed_by, sealed_at FROM comparisons WHERE id = ?')
      .get(comparisonId) as { sealed_by: string | null; sealed_at: string | null } | undefined;
    if (!cmpRow) return { status: 'not_found' };
    if (cmpRow.sealed_at != null) {
      return {
        status: 'already_sealed',
        sealed: { sealed_by: cmpRow.sealed_by ?? '', sealed_at: cmpRow.sealed_at },
      };
    }

    const blockers = getSealBlockers(db, comparisonId);
    if (blockers.length > 0) return { status: 'blocked', blockers };

    db.prepare(
      `UPDATE comparisons
          SET sealed_by = ?, sealed_at = datetime('now', 'localtime')
        WHERE id = ? AND sealed_at IS NULL`
    ).run(sealedBy, comparisonId);

    const row = db
      .prepare('SELECT sealed_by, sealed_at FROM comparisons WHERE id = ?')
      .get(comparisonId) as { sealed_by: string; sealed_at: string };
    return { status: 'ok', sealed: { sealed_by: row.sealed_by, sealed_at: row.sealed_at } };
  });
  return tx();
}

/** 批注是否处于已封存比对（用于编辑 / 改状态 / 删除前的写保护） */
export function isAnnotationSealed(db: DB, annotationId: number): boolean | null {
  const row = db
    .prepare('SELECT c.sealed_at FROM annotations a JOIN comparisons c ON c.id = a.comparison_id WHERE a.id = ?')
    .get(annotationId) as { sealed_at: string | null } | undefined;
  if (!row) return null;
  return row.sealed_at != null;
}

export type UpdateAnnotationResult = { status: 'ok' } | { status: 'not_found' } | { status: 'sealed' };

/** 更新批注状态 / 内容，已封存的比对一律拒绝 */
export function updateAnnotation(
  db: DB,
  annotationId: number,
  status: string | null,
  content: string | null
): UpdateAnnotationResult {
  const ann = db
    .prepare(
      `SELECT a.status, a.content, c.sealed_at
         FROM annotations a JOIN comparisons c ON c.id = a.comparison_id
        WHERE a.id = ?`
    )
    .get(annotationId) as
    | { status: string; content: string; sealed_at: string | null }
    | undefined;
  if (!ann) return { status: 'not_found' };
  if (ann.sealed_at != null) return { status: 'sealed' };
  db.prepare(
    `UPDATE annotations
        SET status = ?, content = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?`
  ).run(status ?? ann.status, content ?? ann.content, annotationId);
  return { status: 'ok' };
}

/** 删除批注，已封存的比对一律拒绝 */
export function deleteAnnotation(
  db: DB,
  annotationId: number
): { status: 'ok' } | { status: 'not_found' } | { status: 'sealed' } {
  const sealed = isAnnotationSealed(db, annotationId);
  if (sealed == null) return { status: 'not_found' };
  if (sealed) return { status: 'sealed' };
  db.prepare('DELETE FROM annotations WHERE id = ?').run(annotationId);
  return { status: 'ok' };
}

export interface AnnotationRow {
  id: number;
  comparison_id: number;
  fragment_id: number | null;
  author: string;
  content: string;
  status: 'open' | 'resolved' | 'pending_review';
  anchor_text: string | null;
  similarity: number | null;
  migrated_from: number | null;
  created_at: string;
  updated_at: string;
}

export interface FragmentRow {
  id: number;
  comparison_id: number;
  ord: number;
  type: 'added' | 'removed' | 'changed';
  old_text: string | null;
  new_text: string | null;
  old_start: number | null;
  new_start: number | null;
  anchor: string | null;
  decision: FragmentDecision | null;
  decision_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

export interface ComparisonDetail {
  comparison: {
    id: number;
    project_id: number;
    project_name: string;
    old_label: string;
    new_label: string;
    /** 基线（旧版）版本序号 */
    old_seq: number;
    /** 新版版本序号；old_seq + 1 !== new_seq 表示跨版本选基线 */
    new_seq: number;
    sealed_by: string | null;
    sealed_at: string | null;
    created_at: string;
  };
  fragments: Array<FragmentRow & { annotations: AnnotationRow[] }>;
  /** 无法锚定到任何片段的批注（待复核） */
  unanchored: AnnotationRow[];
  stats: {
    added: number;
    removed: number;
    changed: number;
    annotations: { open: number; resolved: number; pending_review: number; total: number };
    decisions: {
      accepted: number;
      rejected: number;
      deferred: number;
      undecided: number;
      total: number;
    };
  };
}

export function getComparisonDetail(db: DB, comparisonId: number): ComparisonDetail | null {
  const comparison = db
    .prepare(
      `SELECT c.id, c.project_id, c.created_at, c.sealed_by, c.sealed_at,
              p.name AS project_name,
              ov.label AS old_label,
              nv.label AS new_label,
              ov.seq AS old_seq,
              nv.seq AS new_seq
         FROM comparisons c
         JOIN projects p ON p.id = c.project_id
         JOIN versions ov ON ov.id = c.old_version_id
         JOIN versions nv ON nv.id = c.new_version_id
        WHERE c.id = ?`
    )
    .get(comparisonId) as ComparisonDetail['comparison'] | undefined;
  if (!comparison) return null;

  const fragments = db
    .prepare('SELECT * FROM fragments WHERE comparison_id = ? ORDER BY ord')
    .all(comparisonId) as FragmentRow[];
  const annotations = db
    .prepare('SELECT * FROM annotations WHERE comparison_id = ? ORDER BY id')
    .all(comparisonId) as AnnotationRow[];

  const byFragment = new Map<number, AnnotationRow[]>();
  const unanchored: AnnotationRow[] = [];
  for (const a of annotations) {
    if (a.fragment_id == null) {
      unanchored.push(a);
    } else {
      const list = byFragment.get(a.fragment_id) ?? [];
      list.push(a);
      byFragment.set(a.fragment_id, list);
    }
  }

  const stats: ComparisonDetail['stats'] = {
    added: 0,
    removed: 0,
    changed: 0,
    annotations: { open: 0, resolved: 0, pending_review: 0, total: annotations.length },
    decisions: { accepted: 0, rejected: 0, deferred: 0, undecided: 0, total: fragments.length },
  };
  for (const f of fragments) {
    stats[f.type]++;
    if (f.decision == null) stats.decisions.undecided++;
    else stats.decisions[f.decision]++;
  }
  for (const a of annotations) stats.annotations[a.status]++;

  return {
    comparison,
    fragments: fragments.map((f) => ({ ...f, annotations: byFragment.get(f.id) ?? [] })),
    unanchored,
    stats,
  };
}

export interface ProjectVersionRow {
  id: number;
  label: string;
  seq: number;
  created_at: string;
  /** 该版本作为新版导入时使用的基线版本（首版为 null） */
  baseline_id: number | null;
  baseline_seq: number | null;
  baseline_label: string | null;
}

export interface ProjectComparisonRow {
  id: number;
  created_at: string;
  sealed_by: string | null;
  sealed_at: string | null;
  old_version_id: number;
  new_version_id: number;
  old_seq: number;
  new_seq: number;
  old_label: string;
  new_label: string;
  fragment_count: number;
  undecided_count: number;
  annotation_count: number;
  open_count: number;
}

/** 组装项目详情：版本（含其导入时所选基线）与比对（含基线关系） */
export function getProjectDetail(
  db: DB,
  projectId: number
): {
  project: { id: number; name: string; created_at: string };
  versions: ProjectVersionRow[];
  comparisons: ProjectComparisonRow[];
} | null {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | { id: number; name: string; created_at: string }
    | undefined;
  if (!project) return null;

  const versions = db
    .prepare(
      `SELECT v.id, v.label, v.seq, v.created_at,
              c.old_version_id AS baseline_id,
              bv.seq AS baseline_seq,
              bv.label AS baseline_label
         FROM versions v
         LEFT JOIN comparisons c ON c.new_version_id = v.id
         LEFT JOIN versions bv ON bv.id = c.old_version_id
        WHERE v.project_id = ?
        ORDER BY v.seq`
    )
    .all(projectId) as ProjectVersionRow[];

  const comparisons = db
    .prepare(
      `SELECT c.id, c.created_at, c.sealed_by, c.sealed_at,
              c.old_version_id, c.new_version_id,
              ov.seq AS old_seq, nv.seq AS new_seq,
              ov.label AS old_label, nv.label AS new_label,
              (SELECT COUNT(*) FROM fragments f WHERE f.comparison_id = c.id)  AS fragment_count,
              (SELECT COUNT(*) FROM fragments f WHERE f.comparison_id = c.id AND f.decision IS NULL) AS undecided_count,
              (SELECT COUNT(*) FROM annotations a WHERE a.comparison_id = c.id) AS annotation_count,
              (SELECT COUNT(*) FROM annotations a WHERE a.comparison_id = c.id AND a.status <> 'resolved') AS open_count
         FROM comparisons c
         JOIN versions ov ON ov.id = c.old_version_id
         JOIN versions nv ON nv.id = c.new_version_id
        WHERE c.project_id = ?
        ORDER BY c.id`
    )
    .all(projectId) as ProjectComparisonRow[];

  return { project, versions, comparisons };
}
