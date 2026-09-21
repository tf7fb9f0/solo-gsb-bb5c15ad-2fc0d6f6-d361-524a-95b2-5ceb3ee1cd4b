import type { DB } from './db';
import { createProject, importVersion, addAnnotation } from './service';

const V1 = `第一条 为规范平台数据处理活动，保障数据安全，根据《中华人民共和国数据安全法》等法律法规，制定本办法。

第二条 本办法适用于在境内开展的平台数据收集、存储、使用、加工、传输、提供、公开等活动。

第三条 平台运营者应当建立数据安全管理制度，明确数据安全负责人，落实数据安全保护责任。

第四条 平台收集个人信息，应当遵循合法、正当、必要的原则，公开收集规则，明示收集目的、方式和范围。

第五条 平台应当对用户数据实行分类分级管理，采取相应的技术保护措施，防止数据泄露、篡改、丢失。

第六条 平台发生数据安全事件，应当在四十八小时内向主管部门报告。

第七条 违反本办法规定的，由主管部门责令改正，给予警告。`;

const V2 = `第一条 为规范平台数据处理活动，保障数据安全，根据《中华人民共和国数据安全法》等法律法规，制定本办法。

第二条 本办法适用于在境内开展的平台数据收集、存储、使用、加工、传输、提供、公开等活动。

第三条 平台运营者应当建立数据安全管理制度，明确数据安全负责人，落实数据安全保护责任。

第四条 平台收集个人信息，应当遵循合法、正当、必要的原则，公开收集规则，明示收集目的、方式和范围，不得过度收集与提供服务无关的个人信息。

第五条 平台应当对用户数据实行分类分级管理，采取相应的技术保护措施和访问控制策略，防止数据泄露、篡改、丢失。

第六条 平台发生数据安全事件，应当在二十四小时内向主管部门报告，并同步采取补救措施。

第七条 违反本办法规定的，由主管部门责令改正，给予警告，并处一万元以上十万元以下罚款。

第八条 平台应当每年开展数据安全评估，并将评估结果报送主管部门。`;

const V3 = `第一条 为规范平台数据处理活动，保障数据安全，根据《中华人民共和国数据安全法》等法律法规，制定本办法。

第二条 本办法适用于在境内开展的平台数据收集、存储、使用、加工、传输、提供、公开等活动。

第三条 平台运营者应当建立数据安全管理制度，明确数据安全负责人，落实数据安全保护责任，定期组织数据安全培训。

第四条 平台收集个人信息，应当遵循合法、正当、必要的原则，公开收集规则，明示收集的目的、方式和范围，不得过度收集与提供服务无关的个人信息。

第五条 平台应当对用户数据实行分类分级管理，采取相应的技术保护措施和访问控制策略，防止数据泄露、篡改、丢失。

第六条 平台发生数据安全事件，应当立即采取补救措施，并在二十四小时内向主管部门报告。

第八条 平台应当每年开展数据安全评估，并将评估结果报送主管部门。`;

export interface DemoResult {
  projectId: number;
  projectName: string;
  comparisons: number[];
  migration: unknown;
}

/**
 * 载入示例：导入三个版本，并在第一轮比对上预置若干批注，
 * 使第二轮比对可以直接演示批注迁移（成功迁移 / 条款被删除 / 待复核）。
 */
export function seedDemo(db: DB): DemoResult {
  const projectName = '示例：平台数据安全管理办法';
  const projectId = createProject(db, projectName);

  importVersion(db, projectId, 'v1.0 征求意见稿', V1);
  const r2 = importVersion(db, projectId, 'v2.0 送审稿', V2);
  if (r2.status !== 'ok' || r2.comparisonId == null) {
    throw new Error('示例数据异常：v2 比对未生成');
  }

  const fragments = db
    .prepare('SELECT id, new_text FROM fragments WHERE comparison_id = ?')
    .all(r2.comparisonId) as Array<{ id: number; new_text: string | null }>;
  const find = (kw: string): number => {
    const f = fragments.find((fr) => (fr.new_text ?? '').includes(kw));
    if (!f) throw new Error(`示例数据异常：找不到包含「${kw}」的片段`);
    return f.id;
  };

  const note = (fragId: number, author: string, content: string): number => {
    const r = addAnnotation(db, fragId, author, content);
    if (r.status !== 'ok') throw new Error(`示例数据异常：批注创建失败（${r.status}）`);
    return r.id;
  };

  note(find('不得过度收集'), '王法务', '「不得过度收集」的判定标准需要明确，建议补充实施细则或指引。');
  note(find('访问控制策略'), '李合规', '访问控制策略的基线需要安全团队给出，落地周期约两个月。');
  note(find('二十四小时'), '李合规', '报告时限从 48 小时压缩到 24 小时，应急预案和值班流程需要同步修订。');
  note(find('一万元以上十万元以下'), '张审计', '罚款额度是否与上位法冲突？需要法务出具意见。');
  const resolvedId = note(find('每年开展数据安全评估'), '王法务', '年度评估要求已与团队确认，无异议。');
  db.prepare(`UPDATE annotations SET status = 'resolved' WHERE id = ?`).run(resolvedId);

  const r3 = importVersion(db, projectId, 'v3.0 正式发布稿', V3);
  if (r3.status !== 'ok' || r3.comparisonId == null) {
    throw new Error('示例数据异常：v3 比对未生成');
  }

  return {
    projectId,
    projectName,
    comparisons: [r2.comparisonId, r3.comparisonId],
    migration: r3.migration,
  };
}
