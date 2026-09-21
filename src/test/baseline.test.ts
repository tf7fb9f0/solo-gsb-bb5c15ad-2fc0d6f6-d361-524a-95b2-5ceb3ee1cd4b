import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db';
import {
  createProject,
  importVersion,
  addAnnotation,
  getComparisonDetail,
  getProjectDetail,
  resolveBaseline,
} from '../service';

/**
 * 「比对基线」选择相关测试：
 *  - 默认基线 = 项目最新版本；
 *  - 可显式选择任一历史版本作为基线；
 *  - 后端校验基线归属本项目且早于新版本，失败时不写入任何数据；
 *  - 批注只允许来自「以该基线为新版」的最近一轮比对；
 *    不存在这样的比对时明确不迁移，禁止从项目最新比对误带批注。
 */

const V1 = '第一条 甲条款原始内容。\n\n第二条 乙条款原始内容。';
const V2 = '第一条 甲条款原始内容。\n\n第二条 乙条款修订为二〇二六版。';
// v3：第一条新增内容；第二条保持 v2 文本（与 v1 仍不同）
const V3 = '第一条 甲条款原始内容，并新增合规要求。\n\n第二条 乙条款修订为二〇二六版。';

function setupVersions() {
  const db = openDb(':memory:');
  const pid = createProject(db, '基线测试办法');
  const r1 = importVersion(db, pid, 'v1', V1);
  const r2 = importVersion(db, pid, 'v2', V2);
  const r3 = importVersion(db, pid, 'v3', V3);
  for (const r of [r1, r2, r3]) {
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') throw new Error('夹具异常：版本导入失败');
  }
  if (r1.status !== 'ok' || r2.status !== 'ok' || r3.status !== 'ok') {
    throw new Error('不可达');
  }
  assert.equal(r1.comparisonId, null);
  assert.ok(r2.comparisonId != null);
  assert.ok(r3.comparisonId != null);
  return {
    db,
    pid,
    v1: r1.versionId,
    v2: r2.versionId,
    v3: r3.versionId,
    cmpV2: r2.comparisonId!,
    cmpV3: r3.comparisonId!,
  };
}

test('默认基线为最新版本：返回中带 baselineVersionId，比对取相邻版本', () => {
  const { db, pid, v2, v3, cmpV3 } = setupVersions();
  const cmp = db
    .prepare('SELECT old_version_id, new_version_id FROM comparisons WHERE id = ?')
    .get(cmpV3) as { old_version_id: number; new_version_id: number };
  assert.equal(cmp.old_version_id, v2);
  assert.equal(cmp.new_version_id, v3);

  // 继续默认导入 v4：基线 = 最新版本 v3，迁移来源为上一轮 v2→v3 比对
  const r4 = importVersion(db, pid, 'v4', V3);
  if (r4.status !== 'ok') throw new Error('v4 导入失败');
  assert.equal(r4.baselineVersionId, v3);
  assert.equal(r4.migration?.status, 'migrated');
  if (r4.migration?.status === 'migrated') {
    assert.equal(r4.migration.source_comparison_id, cmpV3);
  }
});
test('首版导入：无基线、无比对、无迁移', () => {
  const db = openDb(':memory:');
  const pid = createProject(db, '首版测试');
  const r = importVersion(db, pid, 'v1', V1);
  if (r.status !== 'ok') throw new Error('首版导入失败');
  assert.equal(r.comparisonId, null);
  assert.equal(r.fragmentCount, 0);
  assert.equal(r.baselineVersionId, null);
  assert.equal(r.migration, null);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM versions').get() as { n: number }).n,
    1
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM comparisons').get() as { n: number }).n,
    0
  );
});

test('显式以更早历史版本为基线：差异按所选基线生成（而非最新版本）', () => {
  const { db, pid, v1 } = setupVersions();
  // v4 直接以 v1 为基线：相对 v1 同时包含「第一条新增」「第二条修改」两个片段
  const r4 = importVersion(db, pid, 'v4', V3, v1);
  if (r4.status !== 'ok') throw new Error('v4 导入失败');
  assert.equal(r4.baselineVersionId, v1);
  assert.ok(r4.comparisonId != null);

  const cmp = db
    .prepare('SELECT old_version_id, new_version_id FROM comparisons WHERE id = ?')
    .get(r4.comparisonId) as { old_version_id: number; new_version_id: number };
  assert.equal(cmp.old_version_id, v1);

  const frags = db
    .prepare('SELECT type, new_text FROM fragments WHERE comparison_id = ? ORDER BY ord')
    .all(r4.comparisonId) as Array<{ type: string; new_text: string | null }>;
  assert.equal(frags.length, 2);
  assert.ok(frags.some((f) => f.new_text?.includes('合规要求')));
  assert.ok(frags.some((f) => f.new_text?.includes('二〇二六')));
});

test('基线找不到「以它为新版」的最近一轮比对时明确不迁移，绝不取项目最新比对', () => {
  const { db, pid, cmpV3, v1 } = setupVersions();

  // 在项目最新一轮（v2→v3）上放一条未解决批注；该批注绝不能被带入以 v1 为基线的新比对
  const fragsV3 = db
    .prepare('SELECT id, new_text FROM fragments WHERE comparison_id = ?')
    .all(cmpV3) as Array<{ id: number; new_text: string | null }>;
  const frag = fragsV3.find((f) => f.new_text?.includes('合规要求'))!;
  const addR = addAnnotation(db, frag.id, '甲', '最新一轮上的意见，不应被误带');
  assert.equal(addR.status, 'ok');

  const r4 = importVersion(db, pid, 'v4', V3, v1);
  if (r4.status !== 'ok') throw new Error('v4 导入失败');
  // v1 从未作为过新版（首版），没有以 v1 为新版的比对 → 明确未迁移
  assert.equal(r4.migration?.status, 'skipped');
  if (r4.migration?.status === 'skipped') {
    assert.equal(r4.migration.reason, 'no_source_comparison');
    assert.equal(r4.migration.total, 0);
    assert.equal(r4.migration.migrated, 0);
    assert.equal(r4.migration.pending, 0);
    assert.ok(r4.migration.message.length > 0);
  }

  const detail = getComparisonDetail(db, r4.comparisonId!)!;
  assert.equal(detail.stats.annotations.total, 0);
  assert.equal(detail.fragments.flatMap((f) => f.annotations).length, 0);
  assert.equal(detail.unanchored.length, 0);
});

test('批注迁移只来自以所选基线为新版的最近一轮比对（非线性分支）', () => {
  const { db, pid, cmpV2, cmpV3, v2, v3 } = setupVersions();

  // 分别在 v1→v2 与 v2→v3 两轮上各放一条可识别批注
  const fragsV2 = db
    .prepare('SELECT id, new_text FROM fragments WHERE comparison_id = ?')
    .all(cmpV2) as Array<{ id: number; new_text: string | null }>;
  const fV2 = fragsV2.find((f) => f.new_text?.includes('二〇二六'))!;
  const addA = addAnnotation(db, fV2.id, '甲', '来自 v1→v2 轮次的批注');
  assert.equal(addA.status, 'ok');

  const fragsV3 = db
    .prepare('SELECT id, new_text FROM fragments WHERE comparison_id = ?')
    .all(cmpV3) as Array<{ id: number; new_text: string | null }>;
  const fV3 = fragsV3.find((f) => f.new_text?.includes('合规要求'))!;
  const addB = addAnnotation(db, fV3.id, '乙', '来自 v2→v3 轮次的批注');
  assert.equal(addB.status, 'ok');

  // v4 以 v2 为基线：迁移来源必须是 v1→v2（以 v2 为新版的唯一比对），
  // 而非项目最新一轮 v2→v3。
  const r4 = importVersion(db, pid, 'v4-基于v2', V3, v2);
  if (r4.status !== 'ok') throw new Error('v4 导入失败');
  assert.equal(r4.baselineVersionId, v2);
  assert.equal(r4.migration?.status, 'migrated');
  if (r4.migration?.status !== 'migrated') throw new Error('应发生迁移');
  assert.equal(r4.migration.source_comparison_id, cmpV2);
  assert.notEqual(r4.migration.source_comparison_id, cmpV3);

  const detail = getComparisonDetail(db, r4.comparisonId!)!;
  const anns = detail.fragments.flatMap((f) => f.annotations);
  assert.equal(anns.length + detail.unanchored.length, 1);
  const theOnly = anns[0] ?? detail.unanchored[0];
  assert.equal(theOnly.author, '甲');
  assert.ok(theOnly.content.includes('v1→v2'));
  // 乙的批注属于最新一轮 v2→v3，不得出现在本轮
  const allContents = [...anns, ...detail.unanchored].map((a) => a.content).join('\n');
  assert.ok(!allContents.includes('v2→v3'));
  // v3 不是本结果的基线
  assert.notEqual(r4.baselineVersionId, v3);
});

test('基线不属于本项目 → 报错且事务回滚，不产生版本与比对', () => {
  const { db, pid } = setupVersions();
  const other = createProject(db, '别的项目');
  const ro = importVersion(db, other, 'other-v1', V1);
  if (ro.status !== 'ok') throw new Error('夹具异常：他项目首版导入失败');
  const otherVersionId = ro.versionId;

  const beforeVersions = (
    db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ?').get(pid) as { n: number }
  ).n;
  const beforeComparisons = (
    db.prepare('SELECT COUNT(*) AS n FROM comparisons WHERE project_id = ?').get(pid) as {
      n: number;
    }
  ).n;

  const r = importVersion(db, pid, 'v4-非法基线', V3, otherVersionId);
  assert.deepEqual(r, { status: 'error', reason: 'baseline_not_in_project' });

  const afterVersions = (
    db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ?').get(pid) as { n: number }
  ).n;
  const afterComparisons = (
    db.prepare('SELECT COUNT(*) AS n FROM comparisons WHERE project_id = ?').get(pid) as {
      n: number;
    }
  ).n;
  assert.equal(afterVersions, beforeVersions);
  assert.equal(afterComparisons, beforeComparisons);
});

test('基线不存在 → not_found 之外的非法基线错误；项目不存在返回 not_found', () => {
  const { db, pid } = setupVersions();
  const r = importVersion(db, pid, 'v4-幽灵基线', V3, 999999);
  assert.deepEqual(r, { status: 'error', reason: 'baseline_not_in_project' });

  const r2 = importVersion(db, 999999, 'x', V1);
  assert.deepEqual(r2, { status: 'error', reason: 'not_found' });
});

test('resolveBaseline：归属与「早于新版本」校验', () => {
  assert.deepEqual(resolveBaseline(undefined, 4), {
    ok: false,
    reason: 'baseline_not_in_project',
  });
  assert.deepEqual(resolveBaseline({ id: 1, seq: 4, content: 'x' }, 4), {
    ok: false,
    reason: 'baseline_not_earlier',
  });
  assert.deepEqual(resolveBaseline({ id: 1, seq: 9, content: 'x' }, 4), {
    ok: false,
    reason: 'baseline_not_earlier',
  });
  const ok = resolveBaseline({ id: 7, seq: 3, content: '基线正文' }, 4);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.baseline, { id: 7, seq: 3, content: '基线正文' });
  }
});

test('以最新版本为基线（显式）与默认行为一致：迁移来自项目最新一轮', () => {
  const { db, pid, cmpV3, v3 } = setupVersions();
  const fragsV3 = db
    .prepare('SELECT id FROM fragments WHERE comparison_id = ?')
    .all(cmpV3) as Array<{ id: number }>;
  const addR = addAnnotation(db, fragsV3[0].id, '丙', '最新轮批注');
  assert.equal(addR.status, 'ok');

  const r4 = importVersion(db, pid, 'v4', V3, v3);
  if (r4.status !== 'ok') throw new Error('v4 导入失败');
  assert.equal(r4.migration?.status, 'migrated');
  if (r4.migration?.status !== 'migrated') throw new Error('应发生迁移');
  assert.equal(r4.migration.source_comparison_id, cmpV3);
  assert.equal(r4.migration.total, 1);
});

/** 项目详情：版本记录带基线关系、比对卡片带 old/new 序号 */
test('getProjectDetail：版本与比对均带基线关系字段', () => {
  const { db, pid, v1, v2, cmpV2 } = setupVersions();
  const detail = getProjectDetail(db, pid)!;
  assert.equal(detail.versions.length, 3);
  assert.equal(detail.versions[0].baseline_id, null); // 首版
  assert.equal(detail.versions[1].baseline_id, v1);
  assert.equal(detail.versions[1].baseline_seq, 1);

  assert.equal(detail.comparisons[0].old_version_id, v1);
  assert.equal(detail.comparisons[0].new_version_id, v2);
  assert.equal(detail.comparisons[0].old_seq, 1);
  assert.equal(detail.comparisons[0].new_seq, 2);
  assert.equal(detail.comparisons[0].id, cmpV2);

  // 再以 v1 为基线导入 v4，该比对呈现跨版本关系 old_seq=1, new_seq=4
  const r4 = importVersion(db, pid, 'v4', V3, v1);
  if (r4.status !== 'ok') throw new Error('v4 导入失败');
  const detail2 = getProjectDetail(db, pid)!;
  const cmp4 = detail2.comparisons.find((c) => c.id === r4.comparisonId)!;
  assert.equal(cmp4.old_seq, 1);
  assert.equal(cmp4.new_seq, 4);
  // v4 版本记录上的基线指向 v1
  const ver4 = detail2.versions.find((v) => v.id === r4.versionId)!;
  assert.equal(ver4.baseline_id, v1);
  assert.equal(ver4.baseline_seq, 1);
});

test('基线 id 为 0 时按不存在的版本处理（路由层会在入参校验阶段拦截）', () => {
  const { db, pid } = setupVersions();
  assert.deepEqual(importVersion(db, pid, 'v', V3, 0), {
    status: 'error',
    reason: 'baseline_not_in_project',
  });
});
