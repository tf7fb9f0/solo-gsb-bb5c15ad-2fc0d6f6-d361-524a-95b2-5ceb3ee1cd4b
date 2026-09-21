import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db';
import {
  createProject,
  importVersion,
  addAnnotation,
  getComparisonDetail,
  getMigrationReport,
  remountAnnotation,
  saveFragmentDecision,
  sealComparison,
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

  const note = (fragId: number, author: string, content: string) => {
    const r = addAnnotation(db, fragId, author, content);
    assert.equal(r.status, 'ok');
  };
  note(frag2.id, '甲', '时限压缩需确认'); // v3 中应自动迁移
  note(frag3.id, '乙', '罚款额度待确认'); // v3 中无对应片段 → 待复核

  const r3 = importVersion(db, pid, 'v3', V3);
  if (r3.status !== 'ok' || r3.comparisonId == null) throw new Error('夹具异常：v3 比对未生成');
  return { db, pid, c2: r2.comparisonId, c3: r3.comparisonId };
}

test('迁移时保存每条批注的候选片段及相似度，自动挂载的候选标记为 chosen', () => {
  const { db, c3 } = setup();
  const rows = db
    .prepare(
      `SELECT mc.*, a.author
         FROM migration_candidates mc JOIN annotations a ON a.id = mc.annotation_id
        WHERE mc.comparison_id = ?
        ORDER BY a.id, mc.rank`
    )
    .all(c3) as Array<{
    author: string;
    fragment_id: number;
    fragment_ord: number;
    side: string;
    similarity: number;
    rank: number;
    chosen: number;
  }>;

  // 两条迁移批注都应有候选记录
  const byAuthor = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byAuthor.get(r.author) ?? [];
    list.push(r);
    byAuthor.set(r.author, list);
  }
  assert.ok(byAuthor.has('甲') && byAuthor.has('乙'));

  for (const list of byAuthor.values()) {
    // rank 从 1 开始连续编号，相似度降序
    list.forEach((r, i) => {
      assert.equal(r.rank, i + 1);
      assert.ok(r.similarity > 0);
      if (i > 0) assert.ok(list[i - 1].similarity >= r.similarity);
    });
  }

  // 甲自动迁移成功：rank=1 的候选被标记 chosen，且就是当前挂载片段
  const jia = byAuthor.get('jia') ?? byAuthor.get('甲')!;
  assert.equal(jia[0].chosen, 1);
  const annJia = db
    .prepare(`SELECT fragment_id, similarity FROM annotations WHERE comparison_id = ? AND author = '甲'`)
    .get(c3) as { fragment_id: number; similarity: number };
  assert.equal(annJia.fragment_id, jia[0].fragment_id);
  assert.ok(Math.abs(annJia.similarity - jia[0].similarity) < 1e-9);

  // 乙转待复核：所有候选均未 chosen
  assert.ok(byAuthor.get('乙')!.every((r) => r.chosen === 0));
});

test('迁移报告按比对返回每条迁移批注的候选片段、相似度与统计', () => {
  const { db, c3 } = setup();
  const report = getMigrationReport(db, c3)!;
  assert.equal(report.comparison_id, c3);
  assert.equal(report.sealed, false);
  assert.deepEqual(report.stats, { total: 2, mounted: 1, pending_review: 1, remounted: 0 });

  const pendingItem = report.items.find((it) => it.annotation.author === '乙')!;
  assert.equal(pendingItem.annotation.status, 'pending_review');
  assert.equal(pendingItem.current_fragment, null);
  assert.ok(pendingItem.candidates.length > 0);
  // 候选按 rank 升序返回，附文本预览
  assert.equal(pendingItem.candidates[0].rank, 1);
  assert.ok(pendingItem.candidates[0].text_preview.length > 0);
  assert.ok(pendingItem.candidates.every((c) => !c.chosen));

  const mountedItem = report.items.find((it) => it.annotation.author === '甲')!;
  assert.ok(mountedItem.current_fragment != null);
  assert.ok(mountedItem.candidates.some((c) => c.chosen));

  // 不存在的比对返回 null
  assert.equal(getMigrationReport(db, 99999), null);
});

test('待复核批注可重新挂载到候选片段：事务内更新挂载点并记录操作者与时间', () => {
  const { db, c3 } = setup();
  const report = getMigrationReport(db, c3)!;
  const pending = report.items.find((it) => it.annotation.author === '乙')!;
  const target = pending.candidates[0];

  const r = remountAnnotation(db, pending.annotation.id, target.fragment_id!, '复核员赵');
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;

  assert.equal(r.annotation.fragment_id, target.fragment_id);
  assert.equal(r.annotation.status, 'open'); // 重挂后恢复为待处理
  assert.equal(r.annotation.remounted_by, '复核员赵');
  assert.ok(r.annotation.remounted_at);
  assert.ok(r.annotation.similarity! > 0);

  // 候选 chosen 标记同步到人工选中的片段
  const chosen = db
    .prepare('SELECT fragment_id FROM migration_candidates WHERE annotation_id = ? AND chosen = 1')
    .all(pending.annotation.id) as Array<{ fragment_id: number }>;
  assert.deepEqual(chosen, [{ fragment_id: target.fragment_id }]);

  // 报告与比对详情同步反映
  const after = getMigrationReport(db, c3)!;
  assert.equal(after.stats.pending_review, 0);
  assert.equal(after.stats.remounted, 1);
  const detail = getComparisonDetail(db, c3)!;
  assert.equal(detail.unanchored.length, 0);
  assert.equal(detail.stats.annotations.open, 2);
});

test('重挂校验：非待复核 / 跨比对片段 / 不存在的批注', () => {
  const { db, c2, c3 } = setup();
  const report = getMigrationReport(db, c3)!;
  const pending = report.items.find((it) => it.annotation.author === '乙')!;
  const mounted = report.items.find((it) => it.annotation.author === '甲')!;

  // 非待复核批注不可重挂
  assert.equal(
    remountAnnotation(db, mounted.annotation.id, mounted.candidates[0].fragment_id!, '赵').status,
    'not_pending'
  );

  // 目标片段必须属于同一比对（c2 的片段不能挂到 c3 的批注上）
  const oldFrag = db
    .prepare('SELECT id FROM fragments WHERE comparison_id = ? LIMIT 1')
    .get(c2) as { id: number };
  const before = db
    .prepare('SELECT fragment_id, status, remounted_by FROM annotations WHERE id = ?')
    .get(pending.annotation.id) as { fragment_id: number | null; status: string; remounted_by: string | null };
  assert.equal(
    remountAnnotation(db, pending.annotation.id, oldFrag.id, '赵').status,
    'fragment_not_found'
  );
  // 校验失败不产生任何写入
  assert.deepEqual(
    db
      .prepare('SELECT fragment_id, status, remounted_by FROM annotations WHERE id = ?')
      .get(pending.annotation.id),
    before
  );

  assert.equal(remountAnnotation(db, 99999, oldFrag.id, '赵').status, 'not_found');
});

test('已封存比对禁止重新挂载', () => {
  const { db, c3 } = setup();
  const report = getMigrationReport(db, c3)!;
  const pending = report.items.find((it) => it.annotation.author === '乙')!;

  // 满足封存条件：全部片段给结论，批注全部关闭
  const frags = db
    .prepare('SELECT id FROM fragments WHERE comparison_id = ?')
    .all(c3) as Array<{ id: number }>;
  for (const f of frags) {
    assert.equal(saveFragmentDecision(db, f.id, 'accepted', null, '甲').status, 'ok');
  }
  db.prepare(`UPDATE annotations SET status = 'resolved' WHERE comparison_id = ?`).run(c3);
  assert.equal(sealComparison(db, c3, '封存人').status, 'ok');

  // 模拟封存前遗留的待复核批注（直接写库），接口层仍应拒绝重挂
  db.prepare(`UPDATE annotations SET status = 'pending_review', fragment_id = NULL WHERE id = ?`).run(
    pending.annotation.id
  );
  assert.equal(
    remountAnnotation(db, pending.annotation.id, pending.candidates[0].fragment_id!, '赵').status,
    'sealed'
  );

  // 报告仍可读，且标记为已封存
  const sealedReport = getMigrationReport(db, c3)!;
  assert.equal(sealedReport.sealed, true);
});
