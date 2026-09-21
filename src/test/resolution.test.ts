import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DB } from '../db';
import { createProject, importVersion, saveFragmentDecision, type FragmentDecision } from '../service';
import { buildResolution, resolutionToMarkdown, type Resolution } from '../resolution';

/**
 * 固定夹具：同时覆盖相邻的删除 + 修改、重复段落与末尾新增。
 * 片段（ord）：
 *   #1 removed  第二条（旧¶2）
 *   #2 changed  第三条 48 小时 → 24 小时（旧¶3 → 新¶2）
 *   #3 added    第六条（新¶6）
 */
const V1 = `第一条 总则内容保持不变。

第二条 本条款将在新版中被整体删除。

第三条 平台发生数据安全事件，应当在四十八小时内向主管部门报告。

第四条 重复条款内容，两处完全相同。

第四条 重复条款内容，两处完全相同。

第五条 末尾条款保持不变。`;

const V2 = `第一条 总则内容保持不变。

第三条 平台发生数据安全事件，应当在二十四小时内向主管部门报告。

第四条 重复条款内容，两处完全相同。

第四条 重复条款内容，两处完全相同。

第五条 末尾条款保持不变。

第六条 全新增加的条款内容。`;

const OLD_PARAS = [
  '第一条 总则内容保持不变。',
  '第二条 本条款将在新版中被整体删除。',
  '第三条 平台发生数据安全事件，应当在四十八小时内向主管部门报告。',
  '第四条 重复条款内容，两处完全相同。',
  '第四条 重复条款内容，两处完全相同。',
  '第五条 末尾条款保持不变。',
];
const NEW_PARAS = [
  '第一条 总则内容保持不变。',
  '第三条 平台发生数据安全事件，应当在二十四小时内向主管部门报告。',
  '第四条 重复条款内容，两处完全相同。',
  '第四条 重复条款内容，两处完全相同。',
  '第五条 末尾条款保持不变。',
  '第六条 全新增加的条款内容。',
];

function setup() {
  const db = openDb(':memory:');
  const pid = createProject(db, '决议稿测试办法');
  importVersion(db, pid, 'v1', V1);
  const r2 = importVersion(db, pid, 'v2', V2);
  if (r2.status !== 'ok' || r2.comparisonId == null) throw new Error('夹具异常：v2 比对未生成');
  return { db, comparisonId: r2.comparisonId };
}

interface FragInfo {
  id: number;
  ord: number;
  type: 'added' | 'removed' | 'changed';
}

function fragmentsOf(db: DB, comparisonId: number): FragInfo[] {
  return db
    .prepare('SELECT id, ord, type FROM fragments WHERE comparison_id = ? ORDER BY ord')
    .all(comparisonId) as FragInfo[];
}

/** 按片段类型分别给出结论并保存 */
function decideAll(
  db: DB,
  comparisonId: number,
  pick: (f: FragInfo) => { decision: FragmentDecision; reason?: string }
) {
  for (const f of fragmentsOf(db, comparisonId)) {
    const { decision, reason } = pick(f);
    const r = saveFragmentDecision(db, f.id, decision, reason ?? null, '测试员');
    assert.equal(r.status, 'ok');
  }
}

function okResolution(db: DB, comparisonId: number): Resolution {
  const r = buildResolution(db, comparisonId);
  assert.equal(r.status, 'ok');
  return (r as { status: 'ok'; resolution: Resolution }).resolution;
}

test('夹具自检：片段类型与数量符合预期', () => {
  const { db, comparisonId } = setup();
  assert.deepEqual(
    fragmentsOf(db, comparisonId).map((f) => f.type),
    ['removed', 'changed', 'added']
  );
});

test('存在未结论片段时不可生成，返回未结论片段序号', () => {
  const { db, comparisonId } = setup();
  const frags = fragmentsOf(db, comparisonId);
  // 只给第一个片段下结论
  assert.equal(saveFragmentDecision(db, frags[0].id, 'accepted', null, '甲').status, 'ok');

  const r = buildResolution(db, comparisonId);
  assert.equal(r.status, 'undecided');
  assert.deepEqual((r as { status: 'undecided'; ords: number[] }).ords, [2, 3]);
});

test('全部接受：决议稿与新版完全一致', () => {
  const { db, comparisonId } = setup();
  decideAll(db, comparisonId, () => ({ decision: 'accepted' }));

  const res = okResolution(db, comparisonId);
  assert.deepEqual(res.paragraphs.map((p) => p.text), NEW_PARAS);
  assert.deepEqual(
    res.paragraphs.map((p) => p.source),
    ['unchanged', 'new', 'unchanged', 'unchanged', 'unchanged', 'new']
  );
  assert.equal(res.todos.length, 0);
  assert.equal(res.stats.total, NEW_PARAS.length);
  assert.equal(res.stats.deferred, 0);
});

test('全部拒绝：决议稿与旧版完全一致（新增剔除、删除恢复、修改回旧文）', () => {
  const { db, comparisonId } = setup();
  decideAll(db, comparisonId, () => ({ decision: 'rejected' }));

  const res = okResolution(db, comparisonId);
  assert.deepEqual(res.paragraphs.map((p) => p.text), OLD_PARAS);
  // 被恢复的删除段与回退的修改段标记为「恢复旧版」，并携带片段编号
  const restored = res.paragraphs.filter((p) => p.source === 'old');
  assert.equal(restored.length, 2);
  assert.equal(restored[0].fragment_ord, 1);
  assert.equal(restored[1].fragment_ord, 2);
  assert.equal(res.todos.length, 0);
});

test('混合结论：相邻删除 / 修改 / 新增与重复段落均按位置正确重建', () => {
  const { db, comparisonId } = setup();
  decideAll(db, comparisonId, (f) =>
    f.type === 'added' ? { decision: 'accepted' } : { decision: 'rejected' }
  );

  const res = okResolution(db, comparisonId);
  // 删除恢复在原位置、修改回旧文、新增保留、重复段落原样保留
  assert.deepEqual(res.paragraphs.map((p) => p.text), [...OLD_PARAS, NEW_PARAS[5]]);
  // 每段的来源与对应片段编号
  const marks = res.paragraphs.map((p) => [p.source, p.fragment_ord]);
  assert.deepEqual(marks, [
    ['unchanged', null],
    ['old', 1],
    ['old', 2],
    ['unchanged', null],
    ['unchanged', null],
    ['unchanged', null],
    ['new', 3],
  ]);
  // 段落序号连续
  assert.deepEqual(res.paragraphs.map((p) => p.ord), [1, 2, 3, 4, 5, 6, 7]);
});

test('暂缓：正文暂保留新版状态，并生成带理由的独立待办清单', () => {
  const { db, comparisonId } = setup();
  decideAll(db, comparisonId, (f) => ({
    decision: 'deferred',
    reason: `暂缓理由-${f.type}`,
  }));

  const res = okResolution(db, comparisonId);
  // 暂缓的新增 / 修改保留新版内容；暂缓的删除维持删除（新版不含该段）
  assert.deepEqual(res.paragraphs.map((p) => p.text), NEW_PARAS);
  assert.equal(res.todos.length, 3);
  assert.deepEqual(
    res.todos.map((t) => [t.fragment_ord, t.fragment_type, t.kept, t.reason]),
    [
      [1, 'removed', 'absent', '暂缓理由-removed'],
      [2, 'changed', 'new', '暂缓理由-changed'],
      [3, 'added', 'new', '暂缓理由-added'],
    ]
  );
  // 暂缓段落仍带片段编号与结论标记
  const deferredPara = res.paragraphs.find((p) => p.fragment_ord === 2)!;
  assert.equal(deferredPara.decision, 'deferred');
  assert.equal(deferredPara.source, 'new');
  assert.equal(res.stats.deferred, 3);
});

test('部分暂缓 + 部分拒绝：删除暂缓不产出段落，修改拒绝恢复旧文', () => {
  const { db, comparisonId } = setup();
  decideAll(db, comparisonId, (f) => {
    if (f.type === 'removed') return { decision: 'deferred', reason: '待主管部门口径明确后再定' };
    if (f.type === 'changed') return { decision: 'rejected' };
    return { decision: 'accepted' };
  });

  const res = okResolution(db, comparisonId);
  assert.deepEqual(res.paragraphs.map((p) => p.text), [
    OLD_PARAS[0],
    OLD_PARAS[2], // 修改被拒绝 → 旧文
    OLD_PARAS[3],
    OLD_PARAS[4],
    OLD_PARAS[5],
    NEW_PARAS[5], // 新增被接受
  ]);
  assert.equal(res.todos.length, 1);
  assert.equal(res.todos[0].fragment_ord, 1);
  assert.equal(res.todos[0].kept, 'absent');
  assert.equal(res.todos[0].reason, '待主管部门口径明确后再定');
});

test('决议稿 Markdown：包含正文、来源标记与暂缓待办清单', () => {
  const { db, comparisonId } = setup();
  decideAll(db, comparisonId, (f) =>
    f.type === 'changed'
      ? { decision: 'deferred', reason: '报告时限需再评估' }
      : { decision: 'accepted' }
  );

  const res = okResolution(db, comparisonId);
  const md = resolutionToMarkdown(res);
  assert.match(md, /^# 决议稿：决议稿测试办法/m);
  assert.match(md, /## 正文/);
  assert.match(md, /## 来源标记/);
  assert.match(md, /## 暂缓待办清单/);
  assert.ok(md.includes(NEW_PARAS[1]));
  assert.ok(md.includes('暂缓理由') && md.includes('报告时限需再评估'));
  // 来源标记表逐段列出片段编号
  assert.ok(md.includes('| ¶2 | 采用新版 | #2（修改） | 暂缓 |'));
});

test('比对不存在时返回 not_found', () => {
  const db = openDb(':memory:');
  assert.equal(buildResolution(db, 99999).status, 'not_found');
});
