import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db';
import {
  createProject,
  importVersion,
  addAnnotation,
  getComparisonDetail,
  saveFragmentDecision,
  sealComparison,
  getSealBlockers,
  updateAnnotation,
  deleteAnnotation,
} from '../service';

const V1 = '第一条 甲。\n\n第二条 乙。\n\n第三条 丙。';
const V2 = '第一条 甲（修订）。\n\n第二条 乙。\n\n第三条 丙，新增内容。';

function setup() {
  const db = openDb(':memory:');
  const pid = createProject(db, '封存测试办法');
  importVersion(db, pid, 'v1', V1);
  const r2 = importVersion(db, pid, 'v2', V2);
  if (r2.status !== 'ok' || r2.comparisonId == null) throw new Error('夹具异常：v2 比对未生成');
  return { db, pid, comparisonId: r2.comparisonId };
}

/** 将全部片段置为「接受变更」，得到可封存状态 */
function acceptAll(db: ReturnType<typeof openDb>, comparisonId: number) {
  const frags = db
    .prepare('SELECT id FROM fragments WHERE comparison_id = ?')
    .all(comparisonId) as Array<{ id: number }>;
  for (const f of frags) {
    const r = saveFragmentDecision(db, f.id, 'accepted', null, '审阅人甲');
    assert.equal(r.status, 'ok');
  }
}

test('暂缓结论必须填写理由', () => {
  const { db, comparisonId } = setup();
  const frag = db
    .prepare('SELECT id FROM fragments WHERE comparison_id = ? ORDER BY ord LIMIT 1')
    .get(comparisonId) as { id: number };

  assert.deepEqual(
    saveFragmentDecision(db, frag.id, 'deferred', '', '甲'),
    { status: 'reason_required' }
  );
  assert.deepEqual(
    saveFragmentDecision(db, frag.id, 'deferred', '  ', '甲'),
    { status: 'reason_required' }
  );
  assert.equal(
    saveFragmentDecision(db, frag.id, 'deferred', '等待上位法更新', '甲').status,
    'ok'
  );

  const row = db.prepare('SELECT decision, decision_reason FROM fragments WHERE id = ?').get(frag.id);
  assert.deepEqual(row, { decision: 'deferred', decision_reason: '等待上位法更新' });
});

test('未全部结论 / 有未解决或待复核批注时，封存被阻塞并返回具体阻塞项', () => {
  const { db, comparisonId } = setup();
  let detail = getComparisonDetail(db, comparisonId)!;
  assert.equal(detail.stats.decisions.undecided, detail.fragments.length);

  // 一个片段未结论
  const frags = db
    .prepare('SELECT id FROM fragments WHERE comparison_id = ? ORDER BY ord')
    .all(comparisonId) as Array<{ id: number }>;
  saveFragmentDecision(db, frags[0].id, 'accepted', null, '甲');

  // 一个 open 批注 + 一个待复核批注（未挂片段）
  const addR = addAnnotation(db, frags[1].id, '乙', '待处理意见');
  assert.equal(addR.status, 'ok');
  const annOpenId = addR.status === 'ok' ? addR.id : -1;
  db.prepare(
    `INSERT INTO annotations (comparison_id, fragment_id, author, content, status, anchor_text)
     VALUES (?, NULL, '丙', '迁移失败的批注', 'pending_review', '锚点')`
  ).run(comparisonId);

  const blockers = getSealBlockers(db, comparisonId);
  const kinds = blockers.map((b) => b.kind);
  assert.ok(kinds.includes('undecided_fragment'));
  assert.ok(kinds.includes('open_annotation'));
  assert.ok(kinds.includes('pending_review_annotation'));
  // 阻塞项包含片段序号与批注 id，便于前端定位
  assert.ok(blockers.some((b) => b.fragment_ord === 2));
  assert.ok(blockers.some((b) => b.annotation_id === annOpenId));

  const r = sealComparison(db, comparisonId, '封存人');
  assert.equal(r.status, 'blocked');
  // 封存失败不得写入封存标记
  const cmpRow = db.prepare('SELECT sealed_at FROM comparisons WHERE id = ?').get(comparisonId);
  assert.equal((cmpRow as { sealed_at: string | null }).sealed_at, null);
});

test('全部片段有结论且批注均解决后可封存，封存返回封存人和封存时间', () => {
  const { db, comparisonId } = setup();
  const frags = db
    .prepare('SELECT id FROM fragments WHERE comparison_id = ?')
    .all(comparisonId) as Array<{ id: number }>;
  const addR = addAnnotation(db, frags[0].id, '乙', '意见');
  assert.equal(addR.status, 'ok');

  acceptAll(db, comparisonId);

  // open 批注仍阻塞
  assert.equal(sealComparison(db, comparisonId, '封存人').status, 'blocked');
  const annId = db.prepare('SELECT id FROM annotations WHERE comparison_id = ?').get(comparisonId) as {
    id: number;
  };
  assert.equal(updateAnnotation(db, annId.id, 'resolved', null).status, 'ok');

  const r = sealComparison(db, comparisonId, '王审阅');
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(r.sealed.sealed_by, '王审阅');
  assert.ok(r.sealed.sealed_at);

  // 重复封存返回 already_sealed
  const again = sealComparison(db, comparisonId, '其他人');
  assert.equal(again.status, 'already_sealed');
});

test('封存后：片段结论不可改、批注不可新增/编辑/改状态/删除', () => {
  const { db, comparisonId } = setup();
  const frags = db
    .prepare('SELECT id, ord FROM fragments WHERE comparison_id = ? ORDER BY ord')
    .all(comparisonId) as Array<{ id: number; ord: number }>;
  acceptAll(db, comparisonId);
  assert.equal(sealComparison(db, comparisonId, '王审阅').status, 'ok');

  const f0 = frags[0];
  assert.equal(saveFragmentDecision(db, f0.id, 'rejected', null, '甲').status, 'sealed');
  // 暂缓理由也不能在封存后补写
  assert.equal(
    saveFragmentDecision(db, f0.id, 'deferred', '理由', '甲').status,
    'sealed'
  );

  assert.equal(addAnnotation(db, f0.id, '丁', '封存后批注').status, 'sealed');

  // 模拟封存前遗留的批注（直接写库），接口层仍应拒绝编辑 / 改状态 / 删除
  db.prepare(
    `INSERT INTO annotations (comparison_id, fragment_id, author, content, status)
     VALUES (?, ?, '历史', '封存前遗留的已解决批注', 'resolved')`
  ).run(comparisonId, f0.id);
  const ann = db
    .prepare('SELECT id FROM annotations WHERE comparison_id = ? ORDER BY id DESC LIMIT 1')
    .get(comparisonId) as { id: number };
  assert.equal(updateAnnotation(db, ann.id, 'open', null).status, 'sealed');
  assert.equal(updateAnnotation(db, ann.id, null, '改内容').status, 'sealed');
  assert.equal(deleteAnnotation(db, ann.id).status, 'sealed');

  // 封存后比对详情带封存信息
  const detail = getComparisonDetail(db, comparisonId)!;
  assert.equal(detail.comparison.sealed_by, '王审阅');
  assert.ok(detail.comparison.sealed_at);
  assert.ok(detail.fragments.every((f) => f.decision === 'accepted'));
});

test('封存一个不存在的比对返回 not_found', () => {
  const db = openDb(':memory:');
  assert.equal(sealComparison(db, 99999, '甲').status, 'not_found');
});
