import express from 'express';
import path from 'node:path';
import { openDb } from './db';
import {
  createProject,
  importVersion,
  addAnnotation,
  getComparisonDetail,
  getProjectDetail,
  saveFragmentDecision,
  sealComparison,
  getSealBlockers,
  updateAnnotation,
  deleteAnnotation,
  FRAGMENT_DECISIONS,
  type FragmentDecision,
} from './service';
import { toCsv, toMarkdown } from './exporter';
import { buildResolution, resolutionToMarkdown } from './resolution';
import { seedDemo } from './demo';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'review.db');

const db = openDb(DB_PATH);
const app = express();

app.use(express.json({ limit: '20mb' }));

const VALID_STATUS = new Set(['open', 'resolved', 'pending_review']);

function badRequest(res: express.Response, message: string) {
  return res.status(400).json({ error: message });
}

function conflict(res: express.Response, message: string, extra?: Record<string, unknown>) {
  return res.status(409).json({ error: message, ...(extra ?? {}) });
}

function notFound(res: express.Response, message = '资源不存在') {
  return res.status(404).json({ error: message });
}

// ---------- 健康检查 ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------- 项目 ----------
app.get('/api/projects', (_req, res) => {
  const projects = db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id)    AS version_count,
              (SELECT COUNT(*) FROM comparisons c WHERE c.project_id = p.id) AS comparison_count
         FROM projects p
        ORDER BY p.id DESC`
    )
    .all();
  res.json({ projects });
});

app.post('/api/projects', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return badRequest(res, '项目名称必填');
  if (name.length > 100) return badRequest(res, '项目名称过长');
  const id = createProject(db, name);
  res.status(201).json({ id, name });
});

app.get('/api/projects/:id', (req, res) => {
  const detail = getProjectDetail(db, Number(req.params.id));
  if (!detail) return notFound(res, '项目不存在');
  res.json(detail);
});

app.delete('/api/projects/:id', (req, res) => {
  const info = db.prepare('DELETE FROM projects WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return notFound(res, '项目不存在');
  res.status(204).end();
});

// ---------- 版本导入（按所选基线比对 + 批注迁移） ----------
app.post('/api/projects/:id/versions', (req, res) => {
  const projectId = Number(req.params.id);

  const label = String(req.body?.label ?? '').trim();
  const content = String(req.body?.content ?? '');
  if (!label) return badRequest(res, '版本标签必填');
  if (!content.trim()) return badRequest(res, '版本内容必填');

  // 比对基线：省略时取项目最新版本；显式指定时必须为项目内早于新版本的历史版本
  let baselineVersionId: number | undefined;
  if (req.body?.baseline_version_id !== undefined && req.body?.baseline_version_id !== null) {
    baselineVersionId = Number(req.body.baseline_version_id);
    if (!Number.isInteger(baselineVersionId) || baselineVersionId <= 0) {
      return badRequest(res, '比对基线版本不合法');
    }
  }

  const result = importVersion(db, projectId, label, content, baselineVersionId);
  if (result.status === 'error') {
    if (result.reason === 'not_found') return notFound(res, '项目不存在');
    if (result.reason === 'baseline_not_in_project') {
      return badRequest(res, '比对基线必须为本项目的历史版本');
    }
    return badRequest(res, '比对基线必须早于本次导入的新版本');
  }
  res.status(201).json(result);
});

// ---------- 比对结果 ----------
app.get('/api/comparisons/:id', (req, res) => {
  const detail = getComparisonDetail(db, Number(req.params.id));
  if (!detail) return notFound(res, '比对不存在');
  res.json(detail);
});

/** 批注筛选：?status=open|resolved|pending_review & author=xxx */
app.get('/api/comparisons/:id/annotations', (req, res) => {
  const comparisonId = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM comparisons WHERE id = ?').get(comparisonId);
  if (!exists) return notFound(res, '比对不存在');

  const conds = ['a.comparison_id = ?'];
  const params: unknown[] = [comparisonId];
  const { status, author } = req.query;
  if (typeof status === 'string' && status) {
    if (!VALID_STATUS.has(status)) return badRequest(res, '非法的批注状态');
    conds.push('a.status = ?');
    params.push(status);
  }
  if (typeof author === 'string' && author) {
    conds.push('a.author = ?');
    params.push(author);
  }
  const annotations = db
    .prepare(
      `SELECT a.*, f.ord AS fragment_ord, f.type AS fragment_type
         FROM annotations a
         LEFT JOIN fragments f ON f.id = a.fragment_id
        WHERE ${conds.join(' AND ')}
        ORDER BY a.id`
    )
    .all(...params);
  res.json({ annotations });
});

// ---------- 批注 ----------
app.post('/api/fragments/:id/annotations', (req, res) => {
  const author = String(req.body?.author ?? '').trim();
  const content = String(req.body?.content ?? '').trim();
  if (!author) return badRequest(res, '作者必填');
  if (!content) return badRequest(res, '批注内容必填');
  if (author.length > 50) return badRequest(res, '作者姓名过长（最多 50 字）');
  const result = addAnnotation(db, Number(req.params.id), author, content);
  if (result.status === 'not_found') return notFound(res, '片段不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止新增批注');
  const annotation = db.prepare('SELECT * FROM annotations WHERE id = ?').get(result.id);
  res.status(201).json({ annotation });
});

// ---------- 片段审阅结论 ----------
app.patch('/api/fragments/:id/decision', (req, res) => {
  const fragmentId = Number(req.params.id);
  const rawDecision = String(req.body?.decision ?? '');
  if (!FRAGMENT_DECISIONS.includes(rawDecision as FragmentDecision)) {
    return badRequest(res, '结论必须为 accepted / rejected / deferred 之一');
  }
  const decision = rawDecision as FragmentDecision;
  let reason: string | null = null;
  if (req.body?.reason !== undefined && req.body?.reason !== null) {
    reason = String(req.body.reason).trim();
  }
  if (decision === 'deferred' && (reason == null || !reason)) {
    return badRequest(res, '暂缓时必须填写暂缓理由');
  }
  if (reason != null && reason.length > 1000) {
    return badRequest(res, '暂缓理由过长（最多 1000 字）');
  }
  let decidedBy: string | null = null;
  if (req.body?.decided_by !== undefined && req.body?.decided_by !== null) {
    decidedBy = String(req.body.decided_by).trim();
    if (decidedBy.length > 50) return badRequest(res, '结论提出人姓名过长（最多 50 字）');
  }

  const result = saveFragmentDecision(db, fragmentId, decision, reason, decidedBy);
  if (result.status === 'not_found') return notFound(res, '片段不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止修改片段结论');
  if (result.status === 'reason_required') return badRequest(res, '暂缓时必须填写暂缓理由');

  const fragment = db
    .prepare('SELECT id, decision, decision_reason, decided_by, decided_at FROM fragments WHERE id = ?')
    .get(fragmentId);
  res.json({ fragment });
});

// ---------- 审阅封存 ----------
app.get('/api/comparisons/:id/seal/blockers', (req, res) => {
  const comparisonId = Number(req.params.id);
  const cmpRow = db.prepare('SELECT sealed_at FROM comparisons WHERE id = ?').get(comparisonId) as
    | { sealed_at: string | null }
    | undefined;
  if (!cmpRow) return notFound(res, '比对不存在');
  res.json({
    sealed: cmpRow.sealed_at != null,
    blockers: cmpRow.sealed_at != null ? [] : getSealBlockers(db, comparisonId),
  });
});

app.post('/api/comparisons/:id/seal', (req, res) => {
  const comparisonId = Number(req.params.id);
  const sealedBy = String(req.body?.sealed_by ?? '').trim();
  if (!sealedBy) return badRequest(res, '封存人必填');
  if (sealedBy.length > 50) return badRequest(res, '封存人姓名过长（最多 50 字）');

  const result = sealComparison(db, comparisonId, sealedBy);
  if (result.status === 'not_found') return notFound(res, '比对不存在');
  if (result.status === 'already_sealed') {
    return conflict(res, '该比对已封存，无法重复封存', { sealed: result.sealed });
  }
  if (result.status === 'blocked') {
    return conflict(res, '仍存在未完成的审阅项，无法封存', { blockers: result.blockers });
  }
  res.status(201).json({ sealed: result.sealed });
});

app.patch('/api/annotations/:id', (req, res) => {
  const id = Number(req.params.id);
  const ann = db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as
    | { id: number; status: string; content: string }
    | undefined;
  if (!ann) return notFound(res, '批注不存在');

  const { status, content } = req.body ?? {};
  if (status === undefined && content === undefined) {
    return badRequest(res, '至少提供 status 或 content 之一');
  }
  if (status !== undefined && !VALID_STATUS.has(status)) {
    return badRequest(res, '非法的批注状态（open / resolved / pending_review）');
  }
  let trimmedContent: string | null = null;
  if (content !== undefined) {
    trimmedContent = String(content).trim();
    if (!trimmedContent) return badRequest(res, '批注内容不能为空');
  }
  const result = updateAnnotation(
    db,
    id,
    status !== undefined ? String(status) : null,
    trimmedContent
  );
  if (result.status === 'not_found') return notFound(res, '批注不存在');
  if (result.status === 'sealed') {
    return conflict(res, '该比对已封存，禁止编辑批注或变更批注状态');
  }
  res.json({ annotation: db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) });
});

app.delete('/api/annotations/:id', (req, res) => {
  const result = deleteAnnotation(db, Number(req.params.id));
  if (result.status === 'not_found') return notFound(res, '批注不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止删除批注');
  res.status(204).end();
});

// ---------- 导出 ----------
app.get('/api/comparisons/:id/export', (req, res) => {
  const detail = getComparisonDetail(db, Number(req.params.id));
  if (!detail) return notFound(res, '比对不存在');

  const format = String(req.query.format ?? 'json').toLowerCase();
  const { comparison } = detail;
  const filename = `审阅报告-${comparison.project_name}-${comparison.old_label}-vs-${comparison.new_label}`;
  const disposition = (ext: string) =>
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.${ext}`;

  if (format === 'json') {
    res.setHeader('Content-Disposition', disposition('json'));
    return res.json(detail);
  }
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', disposition('csv'));
    return res.send(toCsv(detail));
  }
  if (format === 'md' || format === 'markdown') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', disposition('md'));
    return res.send(toMarkdown(detail));
  }
  return badRequest(res, 'format 需为 json / csv / md');
});

// ---------- 决议稿 ----------
app.get('/api/comparisons/:id/resolution', (req, res) => {
  const result = buildResolution(db, Number(req.params.id));
  if (result.status === 'not_found') return notFound(res, '比对不存在');
  if (result.status === 'undecided') {
    return conflict(res, '尚有未作结论的差异片段，无法生成决议稿', { undecided: result.ords });
  }
  const { resolution } = result;
  const format = String(req.query.format ?? 'json').toLowerCase();
  if (format === 'md' || format === 'markdown') {
    const { comparison } = resolution;
    const filename = `决议稿-${comparison.project_name}-${comparison.old_label}-vs-${comparison.new_label}`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.md`
    );
    return res.send(resolutionToMarkdown(resolution));
  }
  if (format !== 'json') return badRequest(res, 'format 需为 json / md');
  res.json(resolution);
});

// ---------- 示例数据 ----------
app.post('/api/demo', (_req, res) => {
  const result = seedDemo(db);
  res.status(201).json(result);
});

// ---------- 前端静态资源 ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

// API 404 与统一错误处理
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: '服务器内部错误' });
  }
);

app.listen(PORT, () => {
  console.log(`条文变更审阅台已启动：http://localhost:${PORT}`);
  console.log(`数据库文件：${DB_PATH}`);
});
