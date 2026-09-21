import test from 'node:test';
import assert from 'node:assert/strict';
import { splitParagraphs, similarity, buildFragments } from '../diff';

test('splitParagraphs：按空行分段', () => {
  const paras = splitParagraphs('第一条 A。\n\n第二条 B。\n\n第三条 C。');
  assert.deepEqual(paras, ['第一条 A。', '第二条 B。', '第三条 C。']);
});

test('splitParagraphs：无空行时按行分段', () => {
  const paras = splitParagraphs('第一条 A。\n第二条 B。\n第三条 C。');
  assert.deepEqual(paras, ['第一条 A。', '第二条 B。', '第三条 C。']);
});

test('splitParagraphs：块内多行合并为一个段落', () => {
  const paras = splitParagraphs('第一条\n多款内容合并。\n\n第二条 B。');
  assert.deepEqual(paras, ['第一条\n多款内容合并。', '第二条 B。']);
});

test('similarity：相同文本为 1，相近文本得分高，无关文本得分低', () => {
  assert.equal(similarity('数据安全管理办法', '数据安全管理办法'), 1);
  assert.ok(similarity('应当在二十四小时内报告', '应当在四十八小时内报告') > 0.5);
  assert.ok(similarity('数据安全管理办法', '个人所得税法实施条例') < 0.4);
  assert.equal(similarity('', '任意文本'), 0);
});

test('buildFragments：识别修改 / 删除 / 新增', () => {
  const oldP = ['第一条 总则。', '第六条 应当在四十八小时内报告。', '第七条 罚则内容甲。'];
  const newP = ['第一条 总则。', '第六条 应当在二十四小时内报告。', '第八条 全新增加的评估条款。'];
  const frags = buildFragments(oldP, newP);
  assert.deepEqual(
    frags.map((f) => f.type),
    ['changed', 'removed', 'added']
  );
  assert.equal(frags[0].oldText, '第六条 应当在四十八小时内报告。');
  assert.equal(frags[0].newText, '第六条 应当在二十四小时内报告。');
  assert.equal(frags[1].oldText, '第七条 罚则内容甲。');
  assert.equal(frags[2].newText, '第八条 全新增加的评估条款。');
});

test('buildFragments：完全相同的文本没有片段', () => {
  const paras = ['第一条 A。', '第二条 B。'];
  assert.deepEqual(buildFragments(paras, [...paras]), []);
});

test('buildFragments：段落整体后移时不产生差异', () => {
  const oldP = ['第一条 A。', '第二条 B。'];
  const newP = ['引言 新增说明。', '第一条 A。', '第二条 B。'];
  const frags = buildFragments(oldP, newP);
  assert.equal(frags.length, 1);
  assert.equal(frags[0].type, 'added');
  assert.equal(frags[0].newText, '引言 新增说明。');
});
