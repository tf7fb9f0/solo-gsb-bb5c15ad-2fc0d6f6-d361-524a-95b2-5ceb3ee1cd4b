import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { openDb, migrateSchema } from '../db';
import { rankCandidates } from '../migrate';
import {
  createProject,
  importVersion,
  addAnnotation,
  getComparisonDetail,
  saveFragmentDecision,
  sealComparison,
  updateAnnotation,
  getMigrationReport,
  getAnnotationCandidates,
  remountAnnotation,
} from '../service';

const V1 = '第一条 总则。\n\n第二条 应当在四十八小时内报告。\n\n第三条 罚则内容甲。';
const V2 = '第一条 总则。\n\n第二条 应当在二十四小时内报告。\n\n第三条 罚则内容甲，并处一万元罚款。';
// v3：第二条再次改写（批注应迁移）；第三条未变化（无对应片段，批注应转待复核）
const V3 = '第一条 总则。\n\n第二条 应当立即处置，并在二十四小时内报告。\n\n第三条 罚则内容甲，并处一万元罚款。';

function setup() {
  const db = openDb(':memory:');
  const pid = createProject(db, '迁移复核测试办法');
  importVersion(db, pid, 'v1', V1);
  const r2 = importVersion(db, pid, 'v2', V2);
  if (r2.status !== 'ok' || r2.comparisonId == null) throw new Error('夹具异常：v2 比对未生成');

  const frags = db
    .prepare('SELECT id, new_text FROM fragments WHERE comparison_id = ?')
    .all(r2.comparisonId) as Array<{ id: number; new_text: string }>;
  const frag2 = frags.find((f) => f.new_text.includes('二十四小时'))!;
  const frag3 = frags.find((f) => f.new_text.includes('一万元'))!;

  const note = (fragId: number, author: string, content: string): number => {
    const r = addAnnotation(db, fragId, author, content);
    if (r.status !== 'ok') throw new Error('夹具异常：批注创建失败');
    return r.id;
  };
  note(frag2.id, '甲', '时限压缩需确认'); // v3 中第二条仍相近 → 自动迁移
  note(frag3.id, '乙', '罚款额度待确认'); // v3 中第三条无变化 → 待复核

  const r3 = importVersion(db, pid, 'v3', V3);
  if (r3.status !== 'ok' || r3.comparisonId == null) throw new Error('夹具异常：v3 比对未生成');
  return { db, pid, r2, r3 };
}

/** 取出 v3 比对中迁移产生的两条批注（按 id 排序，前者自动锚定、后者待复核） */
function migratedAnnotations(db: ReturnType<typeof openDb>, comparisonId: number) {
  return db
    .prepare(
      `SELECT * FROM annotations WHERE comparison_id = ? AND migrated_from IS NOT NULL ORDER BY id`
    )
    .all(comparisonId) as Array<{
    id: number;
    fragment_id: number | null;
    status: string;
    author: string;
  }>;
}

test('迁移时保存每条批注的候选片段及相似度，自动选中的片段有标记', () => {
  const { db, r3 } = setup();
  const anns = migratedAnnotations(db, r3.comparisonId!);
  assert.equal(anns.length, 2);

  const rows = db
    .prepare(
      `SELECT mc.*, f.ord AS fragment_ord
         FROM migration_candidates mc JOIN fragments f ON f.id = mc.fragment_id
        WHERE mc.comparison_id = ? ORDER BY mc.annotation_id, mc.rank`
    )
    .all(r3.comparisonId!) as Array<{
    annotation_id: number;
    fragment_id: number;
    side: string;
    similarity: number;
    rank: number;
    auto_chosen: number;
  }>;

  // 两条迁移批注都应有候选记录（v3 比对只有一个差异片段，各保留一条候选）
  const byAnn = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byAnn.get(r.annotation_id) ?? [];
    list.push(r);
    byAnn.set(r.annotation_id, list);
  }
  assert.equal(byAnn.size, 2);

  const anchored = anns.find((a) => a.fragment_id != null)!;
  const pending = anns.find((a) => a.fragment_id == null)!;

  // 自动锚定的批注：rank 1 候选即挂载片段，且带 auto_chosen 标记
  const anchoredCands = byAnn.get(anchored.id)!;
  assert.ok(anchoredCands.length >= 1);
  assert.equal(anchoredCands[0].rank, 1);
  assert.equal(anchoredCands[0].fragment_id, anchored.fragment_id);
  assert.equal(anchoredCands[0].auto_chosen, 1);
  assert.ok(anchoredCands[0].similarity >= 0.4);
  assert.ok(anchoredCands.every((c) => c.similarity > 0 && c.similarity <= 1));

  // 待复核批注：候选同样落库（供人工重挂选择），但无 auto_chosen
  const pendingCands = byAnn.get(pending.id)!;
  assert.ok(pendingCands.length >= 1);
  assert.ok(pendingCands.every((c) => c.auto_chosen === 0));
  // rank 从 1 开始连续编号
  assert.deepEqual(pendingCands.map((c) => c.rank), pendingCands.map((_, i) => i + 1));
});

test('rankCandidates：每片段取新旧两侧较高者，按相似度降序并截断，零相似度剔除', () => {
  const targets = [
    { id: 1, old_text: '平台应当每年开展数据安全评估', new_text: '平台应当每年开展数据安全评估并报送' },
    { id: 2, old_text: '完全无关的内容甲乙丙丁', new_text: '也是毫不相干的文字戊己庚辛' },
    { id: 3, old_text: null, new_text: '数据安全评估报告应当报送主管部门' },
  ];
  const cands = rankCandidates('平台应当每年开展数据安全评估', targets);
  assert.ok(cands.length >= 1);
  assert.equal(cands[0].fragmentId, 1);
  // 零相似度片段被剔除
  assert.ok(cands.every((c) => c.similarity > 0));
  assert.ok(cands.every((c) => c.fragmentId !== 2));
  // 降序排列
  for (let i = 1; i < cands.length; i++) {
    assert.ok(cands[i - 1].similarity >= cands[i].similarity);
  }
});

test('迁移复核报告：按比对汇总迁移批注、候选片段与统计', () => {
  const { db, r3 } = setup();
  const report = getMigrationReport(db, r3.comparisonId!)!;
  assert.equal(report.comparison_id, r3.comparisonId);
  assert.equal(report.sealed, false);
  assert.deepEqual(report.summary, {
    total: 2,
    auto_migrated: 1,
    pending_review: 1,
    remounted: 0,
  });

  const anchoredItem = report.items.find((it) => it.fragment_id != null)!;
  assert.equal(anchoredItem.author, '甲');
  assert.ok(anchoredItem.fragment_ord != null);
  assert.ok(anchoredItem.candidates.some((c) => c.auto_chosen));
  assert.equal(anchoredItem.remounts.length, 0);

  const pendingItem = report.items.find((it) => it.fragment_id == null)!;
  assert.equal(pendingItem.author, '乙');
  assert.equal(pendingItem.status, 'pending_review');
  assert.ok(pendingItem.candidates.length >= 1);
  assert.ok(pendingItem.candidates[0].fragment_ord != null);
  assert.ok(pendingItem.candidates[0].old_text !== undefined);

  // 不存在的比对返回 null
  assert.equal(getMigrationReport(db, 99999), null);
});

test('待复核批注重新挂载：事务内改挂、恢复待处理并记录操作者与时间', () => {
  const { db, r3 } = setup();
  const pending = migratedAnnotations(db, r3.comparisonId!).find((a) => a.fragment_id == null)!;

  const candView = getAnnotationCandidates(db, pending.id)!;
  assert.equal(candView.sealed, false);
  assert.equal(candView.annotation.status, 'pending_review');
  assert.ok(candView.candidates.length >= 1);
  const target = candView.candidates[0];

  const r = remountAnnotation(db, pending.id, target.fragment_id, '复核人赵');
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(r.annotation.fragment_id, target.fragment_id);
  assert.equal(r.annotation.status, 'open');
  assert.equal(r.annotation.remounted_by, '复核人赵');
  assert.ok(r.annotation.remounted_at);

  // 审计日志同事务写入：操作者、来源（未挂载）与目标片段
  const logs = db
    .prepare('SELECT * FROM remount_logs WHERE annotation_id = ?')
    .all(pending.id) as Array<{
    from_fragment_id: number | null;
    to_fragment_id: number;
    operator: string;
    created_at: string;
  }>;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].from_fragment_id, null);
  assert.equal(logs[0].to_fragment_id, target.fragment_id);
  assert.equal(logs[0].operator, '复核人赵');
  assert.ok(logs[0].created_at);

  // 详情中该批注离开待复核区，挂到目标片段
  const detail = getComparisonDetail(db, r3.comparisonId!)!;
  assert.equal(detail.unanchored.length, 0);
  const frag = detail.fragments.find((f) => f.id === target.fragment_id)!;
  assert.ok(frag.annotations.some((a) => a.id === pending.id && a.remounted_by === '复核人赵'));

  // 报告同步反映重挂结果
  const report = getMigrationReport(db, r3.comparisonId!)!;
  assert.equal(report.summary.pending_review, 0);
  assert.equal(report.summary.remounted, 1);
  const item = report.items.find((it) => it.annotation_id === pending.id)!;
  assert.equal(item.remounted_by, '复核人赵');
  assert.equal(item.remounts.length, 1);
  assert.equal(item.remounts[0].to_fragment_id, target.fragment_id);
});

test('重挂校验：非待复核 / 不存在 / 跨比对片段均拒绝，且不留下任何写入', () => {
  const { db, r2, r3 } = setup();
  const anns = migratedAnnotations(db, r3.comparisonId!);
  const anchored = anns.find((a) => a.fragment_id != null)!;
  const pending = anns.find((a) => a.fragment_id == null)!;

  // 非待复核状态
  assert.equal(remountAnnotation(db, anchored.id, anchored.fragment_id!, '丙').status, 'not_pending');
  // 批注不存在
  assert.equal(remountAnnotation(db, 99999, anchored.fragment_id!, '丙').status, 'not_found');

  // 目标片段属于另一轮比对（v1→v2 的片段不能挂到 v2→v3 的批注上）
  const otherFrag = db
    .prepare('SELECT id FROM fragments WHERE comparison_id = ? LIMIT 1')
    .get(r2.comparisonId!) as { id: number };
  assert.equal(remountAnnotation(db, pending.id, otherFrag.id, '丙').status, 'fragment_mismatch');

  // 失败的重挂不产生任何写入：批注保持待复核、无审计日志
  const row = db.prepare('SELECT status, fragment_id, remounted_by FROM annotations WHERE id = ?').get(pending.id) as {
    status: string;
    fragment_id: number | null;
    remounted_by: string | null;
  };
  assert.equal(row.status, 'pending_review');
  assert.equal(row.fragment_id, null);
  assert.equal(row.remounted_by, null);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM remount_logs').get() as { n: number }).n,
    0
  );
});

test('已封存比对禁止重新挂载（409 语义）', () => {
  const { db, r3 } = setup();
  const comparisonId = r3.comparisonId!;
  const anns = migratedAnnotations(db, comparisonId);
  const pending = anns.find((a) => a.fragment_id == null)!;
  const targetFrag = (
    db.prepare('SELECT id FROM fragments WHERE comparison_id = ? LIMIT 1').get(comparisonId) as {
      id: number;
    }
  ).id;

  // 满足封存条件：全部片段接受 + 迁移来的 open 批注解决 + 待复核批注解决
  const frags = db
    .prepare('SELECT id FROM fragments WHERE comparison_id = ?')
    .all(comparisonId) as Array<{ id: number }>;
  for (const f of frags) {
    assert.equal(saveFragmentDecision(db, f.id, 'accepted', null, '审阅人').status, 'ok');
  }
  for (const a of anns) {
    assert.equal(updateAnnotation(db, a.id, 'resolved', null).status, 'ok');
  }
  assert.equal(sealComparison(db, comparisonId, '王审阅').status, 'ok');

  // 封存后注入一条待复核批注（模拟历史遗留），重挂仍被拒绝
  db.prepare(
    `INSERT INTO annotations (comparison_id, fragment_id, author, content, status, anchor_text)
     VALUES (?, NULL, '历史', '封存前遗留的待复核批注', 'pending_review', '锚点')`
  ).run(comparisonId);
  const legacy = db
    .prepare('SELECT id FROM annotations WHERE comparison_id = ? ORDER BY id DESC LIMIT 1')
    .get(comparisonId) as { id: number };
  assert.equal(remountAnnotation(db, legacy.id, targetFrag, '复核人').status, 'sealed');

  // 已解决批注（原待复核）在封存后同样不可重挂
  assert.equal(remountAnnotation(db, pending.id, targetFrag, '复核人').status, 'sealed');

  // 候选查询仍可用（只读），但标记为已封存
  assert.equal(getAnnotationCandidates(db, legacy.id)!.sealed, true);
  assert.equal(getMigrationReport(db, comparisonId)!.sealed, true);
});

test('旧库升级：annotations 表自动补齐 remounted_by / remounted_at 列', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY);
    CREATE TABLE comparisons (id INTEGER PRIMARY KEY);
    CREATE TABLE fragments (id INTEGER PRIMARY KEY);
    CREATE TABLE annotations (id INTEGER PRIMARY KEY, content TEXT);
  `);
  migrateSchema(db);
  const cols = (db.prepare(`PRAGMA table_info(annotations)`).all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  assert.ok(cols.includes('remounted_by'));
  assert.ok(cols.includes('remounted_at'));
  // 幂等：重复执行不报错
  migrateSchema(db);
  db.close();
});

test('新建库自动包含迁移复核相关表', () => {
  const db = openDb(':memory:');
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
  ).map((t) => t.name);
  assert.ok(tables.includes('migration_candidates'));
  assert.ok(tables.includes('remount_logs'));
});
