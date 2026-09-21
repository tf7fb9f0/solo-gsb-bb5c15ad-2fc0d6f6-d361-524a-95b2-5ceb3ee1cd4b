'use strict';

/* ================= 基础工具 ================= */

const STATUS_LABEL = { open: '待处理', resolved: '已解决', pending_review: '待复核' };
const TYPE_LABEL = { added: '新增', removed: '删除', changed: '修改' };
const DECISION_LABEL = { accepted: '接受变更', rejected: '拒绝变更', deferred: '暂缓' };
const SOURCE_LABEL = { unchanged: '未变更', new: '采用新版', old: '恢复旧版' };

const app = document.getElementById('app');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

let toastTimer = null;
function toast(msg, isErr = false) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = isErr ? 'toast err show' : 'toast show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

const lastAuthor = {
  get: () => localStorage.getItem('review-author') || '',
  set: (v) => localStorage.setItem('review-author', v),
};

const lastSealer = {
  get: () => localStorage.getItem('review-sealer') || '',
  set: (v) => localStorage.setItem('review-sealer', v),
};

/* ================= 视图：项目列表 ================= */

async function renderProjects() {
  const { projects } = await api('GET', '/api/projects');
  app.innerHTML = `
    <section class="panel">
      <div class="panel-head">
        <h2>审阅项目</h2>
        <button class="btn" data-action="load-demo">⚡ 载入示例数据</button>
      </div>
      <form id="create-project-form" class="inline-form">
        <input name="name" required maxlength="100" placeholder="新项目名称，如：《数据安全管理办法》">
        <button class="btn primary" type="submit">新建项目</button>
      </form>
      ${projects.length === 0
        ? '<p class="empty">还没有项目。新建一个项目，或点击「载入示例数据」快速体验完整流程。</p>'
        : `<div class="cards">${projects.map((p) => `
            <a class="card" href="#/projects/${p.id}">
              <div class="card-title">${esc(p.name)}</div>
              <div class="card-meta">${p.version_count} 个版本 · ${p.comparison_count} 轮比对</div>
              <div class="card-meta dim">创建于 ${esc(p.created_at)}</div>
            </a>`).join('')}</div>`}
    </section>`;
}

/* ================= 视图：项目详情 ================= */

async function renderProject(id) {
  const { project, versions, comparisons } = await api('GET', `/api/projects/${id}`);
  app.innerHTML = `
    <nav class="crumbs"><a href="#/">全部项目</a> / ${esc(project.name)}</nav>
    <section class="panel">
      <div class="panel-head">
        <h2>${esc(project.name)}</h2>
        <button class="btn danger" data-action="delete-project" data-id="${project.id}">删除项目</button>
      </div>

      <h3>导入新版本</h3>
      <form id="import-form" data-project="${project.id}" class="import-form">
        <input name="label" required maxlength="100" placeholder="版本标签，如：v2.0 送审稿">
        ${versions.length === 0 ? '' : `
        <label class="baseline-pick">比对基线
          <select name="baseline_version_id">
            ${[...versions]
              .sort((a, b) => b.seq - a.seq)
              .map((v, i) =>
                `<option value="${v.id}">${i === 0 ? '最新版本：' : ''}v${v.seq} ${esc(v.label)}</option>`)
              .join('')}
          </select>
        </label>`}
        <textarea name="content" required rows="9"
          placeholder="粘贴规范全文。段落之间用空行分隔；若无空行，则每行视为一条。"></textarea>
        <button class="btn primary" type="submit">导入并按所选基线比对</button>
        <p class="hint">首个版本仅存档；其后默认与<b>最新版本</b>比对，也可选择项目内任一更早的历史版本作为基线。批注只会从「以所选基线为新版」的最近一轮比对迁移。</p>
      </form>

      <h3>版本记录</h3>
      ${versions.length === 0 ? '<p class="empty">尚未导入任何版本。</p>' : `
        <ol class="version-list">
          ${versions.map((v) => `<li><span class="tag">v${v.seq}</span> ${esc(v.label)}
            <span class="dim">${esc(v.created_at)}</span>
            ${v.baseline_id == null
              ? '<span class="base-chip first">首版 · 仅存档</span>'
              : `<span class="base-chip" title="该版本导入时所选的比对基线">⟂ 基线：v${v.baseline_seq} ${esc(v.baseline_label)}</span>`}
            </li>`).join('')}
        </ol>`}

      <h3>比对记录</h3>
      ${comparisons.length === 0 ? '<p class="empty">导入两个以上版本后，这里会列出差异比对。</p>' : `
        <div class="cards">${comparisons.map((c) => `
          <a class="card${c.sealed_at ? ' sealed' : ''}" href="#/comparisons/${c.id}">
            <div class="card-title">
              ${c.sealed_at
                ? '<span class="seal-badge">🔒 已封存</span>'
                : '<span class="draft-badge">📝 草稿</span>'}
              <span class="seq-tag">v${c.old_seq}</span>
              ${esc(c.old_label)} → <span class="seq-tag">v${c.new_seq}</span> ${esc(c.new_label)}
            </div>
            ${c.new_seq !== c.old_seq + 1
              ? `<div class="base-rel">⟂ 跨版本基线：新版 v${c.new_seq} 以更早的 v${c.old_seq} 为基线（中间隔 ${c.new_seq - c.old_seq - 1} 个版本）</div>`
              : '<div class="base-rel adjacent">相邻版本比对</div>'}
            <div class="card-meta">${c.fragment_count} 处差异 · ${c.annotation_count} 条批注
              ${c.open_count > 0 ? ` · <b class="warn">${c.open_count} 条批注待办</b>` : ''}
              ${!c.sealed_at && c.undecided_count > 0 ? ` · <b class="warn">${c.undecided_count} 个片段未结论</b>` : ''}</div>
            <div class="card-meta dim">
              ${c.sealed_at ? `封存人 ${esc(c.sealed_by || '（未署名）')} · ${esc(c.sealed_at)}` : esc(c.created_at)}
            </div>
          </a>`).join('')}</div>`}
    </section>`;
}

/* ================= 视图：比对详情 ================= */

const cmp = { id: null, data: null, status: 'all', author: 'all', onlyAnnotated: false, resolution: null };

async function renderComparison(id) {
  const data = await api('GET', `/api/comparisons/${id}`);
  if (cmp.id !== id) {
    cmp.status = 'all';
    cmp.author = 'all';
    cmp.onlyAnnotated = false;
  }
  cmp.id = id;
  cmp.data = data;
  cmp.resolution = null; // 结论可能已变化，决议稿需重新生成
  drawComparison();
}

function allAnnotations(data = cmp.data) {
  const anns = [];
  for (const f of data.fragments) anns.push(...f.annotations);
  anns.push(...data.unanchored);
  return anns;
}

function visibleAnnotations(anns) {
  return anns.filter(
    (a) =>
      (cmp.status === 'all' || a.status === cmp.status) &&
      (cmp.author === 'all' || a.author === cmp.author)
  );
}

function annHtml(a) {
  const sealed = !!cmp.data.comparison.sealed_at;
  const migrated = a.migrated_from != null
    ? `<span class="migrated" title="从上一轮比对自动迁移">⤳ 迁移${a.similarity != null ? ` · 相似度 ${(a.similarity * 100).toFixed(0)}%` : ''}</span>`
    : '';
  return `
    <div class="ann st-${a.status}">
      <div class="ann-head">
        <b>${esc(a.author)}</b>
        <span class="badge st-${a.status}">${STATUS_LABEL[a.status]}</span>
        ${migrated}
        <span class="dim">${esc(a.updated_at)}</span>
      </div>
      <div class="ann-body">${esc(a.content)}</div>
      ${sealed ? '' : `
      <div class="ann-actions">
        <select class="ann-status" data-id="${a.id}" title="更新状态">
          ${Object.entries(STATUS_LABEL).map(([v, l]) =>
            `<option value="${v}" ${v === a.status ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="btn small danger" data-action="delete-annotation" data-id="${a.id}">删除</button>
      </div>`}
    </div>`;
}

function decisionHtml(f) {
  const sealed = !!cmp.data.comparison.sealed_at;
  if (sealed) {
    if (!f.decision) return '<div class="decision-box dc-none">封存时该片段无结论记录</div>';
    const who = f.decided_by ? `（${esc(f.decided_by)}${f.decided_at ? ` · ${esc(f.decided_at)}` : ''}）` : '';
    return `
      <div class="decision-box dc-${f.decision}">
        <span class="badge dc-${f.decision}">${DECISION_LABEL[f.decision]}</span>
        ${f.decision === 'deferred' && f.decision_reason
          ? `<span class="decision-reason">暂缓理由：${esc(f.decision_reason)}</span>` : ''}
        <span class="dim">${who}</span>
      </div>`;
  }
  const options = [
    { v: 'accepted', l: '接受变更' },
    { v: 'rejected', l: '拒绝变更' },
    { v: 'deferred', l: '暂缓（需填理由）' },
  ];
  return `
    <div class="decision-box" data-fragment="${f.id}">
      <span class="decision-label">审阅结论：</span>
      <div class="decision-opts" role="radiogroup">
        ${options.map((o) => `
          <label class="decision-opt dc-${o.v}${f.decision === o.v ? ' picked' : ''}">
            <input type="radio" class="decision-radio" name="decision-${f.id}" value="${o.v}"
              ${f.decision === o.v ? 'checked' : ''}>
            ${o.l}
          </label>`).join('')}
      </div>
      <div class="decision-detail" ${f.decision === 'deferred' ? '' : 'hidden'}>
        <input class="decision-reason-input" maxlength="1000" placeholder="必须填写暂缓理由，保存后生效"
          value="${esc(f.decision_reason ?? '')}">
      </div>
      <div class="decision-actions">
        <button class="btn small primary" data-action="save-decision" data-id="${f.id}">保存结论</button>
        <span class="dim">切换选项后点击保存；暂缓需先填写理由</span>
      </div>
      ${f.decision && f.decided_by
        ? `<span class="dim">当前结论提出人：${esc(f.decided_by)}${f.decided_at ? ` · ${esc(f.decided_at)}` : ''}</span>`
        : ''}
    </div>`;
}

function fragHtml(f) {
  const sealed = !!cmp.data.comparison.sealed_at;
  const anns = visibleAnnotations(f.annotations);
  const pos = [
    f.old_start != null ? `旧¶${f.old_start}` : null,
    f.new_start != null ? `新¶${f.new_start}` : null,
  ].filter(Boolean).join(' → ');
  return `
    <div class="fragment ft-${f.type}">
      <div class="frag-head">
        <span class="badge ft-${f.type}">${TYPE_LABEL[f.type]}</span>
        <span class="dim">片段 #${f.ord}${pos ? ` · ${pos}` : ''} · ${f.annotations.length} 条批注</span>
        ${f.decision ? `<span class="badge dc-${f.decision}">${DECISION_LABEL[f.decision]}</span>` : '<span class="badge dc-none">未结论</span>'}
      </div>
      ${f.old_text != null ? `<pre class="frag-text old">${esc(f.old_text)}</pre>` : ''}
      ${f.new_text != null ? `<pre class="frag-text new">${esc(f.new_text)}</pre>` : ''}
      ${decisionHtml(f)}
      <div class="anns">${anns.map(annHtml).join('')}</div>
      ${sealed ? '' : `
      <form class="ann-form" data-fragment="${f.id}">
        <input name="author" required maxlength="50" placeholder="作者" value="${esc(lastAuthor.get())}">
        <input name="content" required maxlength="2000" placeholder="写下审阅意见…">
        <button class="btn small primary" type="submit">批注</button>
      </form>`}
    </div>`;
}

function sealBlockers(data) {
  const blockers = [];
  for (const f of data.fragments) {
    if (!f.decision) blockers.push({ kind: 'undecided_fragment', message: `片段 #${f.ord} 尚未作出审阅结论` });
  }
  for (const a of allAnnotations(data)) {
    if (a.status === 'open') {
      blockers.push({ kind: 'open_annotation', message: `存在未解决批注 #${a.id}${a.fragment_id == null ? '（位于待复核区）' : ''}` });
    } else if (a.status === 'pending_review') {
      blockers.push({ kind: 'pending_review_annotation', message: `存在待复核批注 #${a.id}${a.fragment_id == null ? '（位于待复核区）' : ''}` });
    }
  }
  return blockers;
}

function sealPanelHtml(data) {
  const blockers = sealBlockers(data);
  const undecided = data.stats.decisions.undecided;
  const openAnn = data.stats.annotations.open;
  const pendingAnn = data.stats.annotations.pending_review;
  const canSeal = blockers.length === 0;
  const preview = blockers.slice(0, 8).map((b) => `<li>${esc(b.message)}</li>`).join('');
  const more = blockers.length > 8 ? `<li class="dim">…另有 ${blockers.length - 8} 项</li>` : '';
  return `
    <div class="seal-panel${canSeal ? ' ready' : ''}">
      <div class="seal-summary">
        <h3>🔖 审阅封存</h3>
        <div class="seal-counts">
          <span class="${undecided > 0 ? 'warn' : 'ok'}">未作结论片段：${undecided}</span>
          <span class="${openAnn > 0 ? 'warn' : 'ok'}">未解决批注：${openAnn}</span>
          <span class="${pendingAnn > 0 ? 'warn' : 'ok'}">待复核批注：${pendingAnn}</span>
        </div>
      </div>
      ${blockers.length > 0 ? `
        <ul class="blocker-list">${preview}${more}</ul>
        <p class="hint">所有片段均已有结论，且不存在未解决或待复核批注时，方可封存。</p>` : ''}
      <div class="seal-form-row">
        <input id="seal-by" maxlength="50" placeholder="封存人姓名" value="${esc(lastSealer.get())}">
        <button class="btn primary" data-action="seal" data-id="${data.comparison.id}" ${canSeal ? '' : 'disabled'}>
          ${canSeal ? '确认封存' : '尚有阻塞项，无法封存'}
        </button>
      </div>
    </div>`;
}

/* ================= 决议稿 ================= */

function resolutionHtml(r) {
  const paras = r.paragraphs.map((p) => {
    const fragTag = p.fragment_ord != null
      ? `片段 #${p.fragment_ord}（${TYPE_LABEL[p.fragment_type]} · ${DECISION_LABEL[p.decision]}）`
      : '无对应差异片段';
    return `
      <div class="res-para src-${p.source}${p.decision === 'deferred' ? ' is-deferred' : ''}">
        <div class="res-meta">
          <span class="res-ord">¶${p.ord}</span>
          <span class="badge src-${p.source}">${SOURCE_LABEL[p.source]}</span>
          ${p.decision === 'deferred' ? '<span class="badge dc-deferred">暂缓</span>' : ''}
          <span class="dim">${fragTag}</span>
        </div>
        <pre class="res-text">${esc(p.text)}</pre>
      </div>`;
  }).join('');

  const todos = r.todos.map((t) => `
    <li class="todo-item">
      <div>
        <b>片段 #${t.fragment_ord}（${TYPE_LABEL[t.fragment_type]}）</b>
        <span class="dim">${t.kept === 'absent' ? '决议稿暂维持删除（新版不含该段）' : '决议稿暂保留新版内容'}</span>
      </div>
      <div class="todo-reason">暂缓理由：${esc(t.reason)}</div>
      <div class="dim">提出人：${esc(t.decided_by || '（未署名）')}${t.decided_at ? ` · ${esc(t.decided_at)}` : ''}</div>
    </li>`).join('');

  return `
    <div class="resolution-panel">
      <div class="res-head">
        <h3>📄 决议稿 <span class="dim">生成于 ${esc(r.generated_at)} · 共 ${r.stats.total} 段</span></h3>
        <div class="res-actions">
          <a class="btn small" href="/api/comparisons/${cmp.id}/resolution?format=md">⬇ 下载 Markdown（UTF-8）</a>
          <button class="btn small" data-action="close-resolution">收起</button>
        </div>
      </div>
      <div class="stats">
        <span class="chip src-unchanged">未变更 ${r.stats.unchanged}</span>
        <span class="chip src-new">采用新版 ${r.stats.from_new}</span>
        <span class="chip src-old">恢复旧版 ${r.stats.from_old}</span>
        <span class="chip dc-deferred${r.stats.deferred > 0 ? ' hot' : ''}">暂缓待办 ${r.stats.deferred}</span>
      </div>
      ${r.todos.length > 0 ? `
        <div class="todo-box">
          <h4>⏸ 暂缓待办清单（${r.todos.length} 项）</h4>
          <ol>${todos}</ol>
        </div>` : ''}
      <div class="res-body">${paras}</div>
    </div>`;
}

function resolutionBarHtml(data) {
  const undecided = data.stats.decisions.undecided;
  const ready = undecided === 0;
  return `
    <div class="resolution-bar">
      <button class="btn" data-action="gen-resolution" ${ready ? '' : 'disabled'}
        title="${ready ? '依据全部片段结论重建正文' : '尚有片段未作结论'}">📄 生成决议稿</button>
      <span class="dim">${ready
        ? '全部片段已有结论：接受 → 采用新版，拒绝 → 恢复旧版，暂缓 → 暂保留新版并列入待办清单'
        : `尚有 ${undecided} 个片段未作结论，全部有结论后才能生成决议稿`}</span>
    </div>
    ${cmp.resolution ? resolutionHtml(cmp.resolution) : ''}`;
}

function drawComparison() {
  const { comparison, fragments, unanchored, stats } = cmp.data;
  const authors = [...new Set(allAnnotations().map((a) => a.author))].sort();
  const filtering = cmp.status !== 'all' || cmp.author !== 'all';

  const shownFragments = fragments.filter((f) => {
    if (filtering) return visibleAnnotations(f.annotations).length > 0;
    if (cmp.onlyAnnotated) return f.annotations.length > 0;
    return true;
  });
  const shownUnanchored = visibleAnnotations(unanchored);

  app.innerHTML = `
    <nav class="crumbs">
      <a href="#/">全部项目</a> / <a href="#/projects/${comparison.project_id}">${esc(comparison.project_name)}</a>
      / <span class="seq-tag">v${comparison.old_seq}</span> ${esc(comparison.old_label)} → <span class="seq-tag">v${comparison.new_seq}</span> ${esc(comparison.new_label)}
    </nav>
    <section class="panel">
      <div class="panel-head wrap">
        <h2><span class="seq-tag">v${comparison.old_seq}</span> ${esc(comparison.old_label)} → <span class="seq-tag">v${comparison.new_seq}</span> ${esc(comparison.new_label)}</h2>
        <div class="head-side">
          ${comparison.sealed_at
            ? '<span class="seal-badge big">🔒 已封存</span>'
            : '<span class="draft-badge big">📝 草稿</span>'}
          <div class="export-bar">
            导出：
            <a class="btn small" href="/api/comparisons/${cmp.id}/export?format=json">JSON</a>
            <a class="btn small" href="/api/comparisons/${cmp.id}/export?format=csv">CSV</a>
            <a class="btn small" href="/api/comparisons/${cmp.id}/export?format=md">Markdown</a>
          </div>
        </div>
      </div>

      ${comparison.new_seq !== comparison.old_seq + 1 ? `
        <div class="baseline-banner">
          ⟂ 本轮为<b>跨版本基线</b>比对：以历史版本 <b>v${comparison.old_seq} ${esc(comparison.old_label)}</b>
          为基线，与新版 <b>v${comparison.new_seq} ${esc(comparison.new_label)}</b> 计算差异
          （中间跳过 ${comparison.new_seq - comparison.old_seq - 1} 个版本）。
          批注仅来自以该基线为新版的最近一轮比对。
        </div>` : `
        <div class="baseline-banner adjacent">
          ⟂ 比对基线：上一版本 <b>v${comparison.old_seq} ${esc(comparison.old_label)}</b> → 新版 <b>v${comparison.new_seq} ${esc(comparison.new_label)}</b>
        </div>`}

      ${comparison.sealed_at ? `
        <div class="sealed-banner">
          🔒 本比对已于 <b>${esc(comparison.sealed_at)}</b> 由 <b>${esc(comparison.sealed_by || '（未署名）')}</b> 封存。
          封存后禁止修改片段结论，禁止新增、编辑、改状态或删除批注。
        </div>` : sealPanelHtml(cmp.data)}

      <div class="stats">
        <span class="chip ft-added">新增 ${stats.added}</span>
        <span class="chip ft-removed">删除 ${stats.removed}</span>
        <span class="chip ft-changed">修改 ${stats.changed}</span>
        <span class="chip dc-accepted">接受 ${stats.decisions.accepted}</span>
        <span class="chip dc-rejected">拒绝 ${stats.decisions.rejected}</span>
        <span class="chip dc-deferred">暂缓 ${stats.decisions.deferred}</span>
        <span class="chip dc-none${stats.decisions.undecided > 0 ? ' hot' : ''}">未作结论 ${stats.decisions.undecided}</span>
        <span class="chip st-open${stats.annotations.open > 0 ? ' hot' : ''}">未解决批注 ${stats.annotations.open}</span>
        <span class="chip st-pending_review${stats.annotations.pending_review > 0 ? ' hot' : ''}">待复核批注 ${stats.annotations.pending_review}</span>
        <span class="chip st-resolved">已解决 ${stats.annotations.resolved}</span>
      </div>

      ${resolutionBarHtml(cmp.data)}

      <div class="filter-bar">
        <label>状态
          <select id="filter-status">
            <option value="all">全部</option>
            ${Object.entries(STATUS_LABEL).map(([v, l]) =>
              `<option value="${v}" ${cmp.status === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>作者
          <select id="filter-author">
            <option value="all">全部</option>
            ${authors.map((a) =>
              `<option value="${esc(a)}" ${cmp.author === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
          </select>
        </label>
        <label class="check">
          <input type="checkbox" id="filter-annotated" ${cmp.onlyAnnotated ? 'checked' : ''}>
          只显示含批注的片段
        </label>
        <span class="dim">显示 ${shownFragments.length} / ${fragments.length} 个片段</span>
      </div>

      ${shownUnanchored.length > 0 ? `
        <div class="pending-box">
          <h3>⚠ 待复核：以下批注未能锚定到新片段（${shownUnanchored.length}）</h3>
          ${shownUnanchored.map((a) => `
            <div class="pending-item">
              <div class="anchor-text">锚点文本：${esc(a.anchor_text ?? '（空）')}</div>
              ${annHtml(a)}
            </div>`).join('')}
        </div>` : ''}

      ${shownFragments.length === 0
        ? '<p class="empty">没有符合筛选条件的差异片段。</p>'
        : shownFragments.map(fragHtml).join('')}
    </section>`;
}

/* ================= 事件处理 ================= */

document.addEventListener('submit', async (e) => {
  const form = e.target;
  try {
    if (form.id === 'create-project-form') {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      const { id } = await api('POST', '/api/projects', { name });
      location.hash = `#/projects/${id}`;
    } else if (form.id === 'import-form') {
      e.preventDefault();
      const projectId = form.dataset.project;
      const label = form.elements.label.value.trim();
      const content = form.elements.content.value;
      const baselineSel = form.elements.baseline_version_id;
      const body = { label, content };
      if (baselineSel && baselineSel.value) body.baseline_version_id = Number(baselineSel.value);
      const r = await api('POST', `/api/projects/${projectId}/versions`, body);
      if (r.comparisonId) {
        const mig = r.migration;
        let migText = '';
        if (mig) {
          if (mig.status === 'migrated') {
            migText = `；批注迁移 ${mig.migrated} 条、待复核 ${mig.pending} 条`;
          } else {
            migText = `；批注未迁移（${mig.message || '没有以所选基线为新版的历史比对'}）`;
          }
        }
        const base = r.baselineVersionId == null ? '' : '（按所选基线）';
        toast(`比对完成${base}：${r.fragmentCount} 处差异${migText}`);
        location.hash = `#/comparisons/${r.comparisonId}`;
      } else {
        toast('首个版本已存档，再导入一个版本即可比对');
        await renderProject(projectId);
      }
    } else if (form.classList.contains('ann-form')) {
      e.preventDefault();
      const author = form.elements.author.value.trim();
      const content = form.elements.content.value.trim();
      lastAuthor.set(author);
      await api('POST', `/api/fragments/${form.dataset.fragment}/annotations`, { author, content });
      await renderComparison(cmp.id);
      toast('批注已添加');
    }
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  try {
    if (action === 'load-demo') {
      btn.disabled = true;
      const r = await api('POST', '/api/demo');
      const mig = r.migration;
      let migText = '';
      if (mig) {
        migText =
          mig.status === 'migrated'
            ? `：批注迁移 ${mig.migrated} 条、待复核 ${mig.pending} 条`
            : '：批注未迁移';
      }
      toast('示例数据已载入' + migText);
      location.hash = `#/comparisons/${r.comparisons[r.comparisons.length - 1]}`;
    } else if (action === 'delete-project') {
      if (!confirm('确定删除该项目及其全部版本、比对与批注？')) return;
      await api('DELETE', `/api/projects/${btn.dataset.id}`);
      location.hash = '#/';
    } else if (action === 'delete-annotation') {
      if (!confirm('确定删除这条批注？')) return;
      await api('DELETE', `/api/annotations/${btn.dataset.id}`);
      await renderComparison(cmp.id);
      toast('批注已删除');
    } else if (action === 'save-decision') {
      const box = btn.closest('.decision-box');
      const checked = box.querySelector('input[type=radio]:checked');
      const fragmentId = box.dataset.fragment;
      if (!checked) {
        toast('请先选择「接受变更 / 拒绝变更 / 暂缓」', true);
        return;
      }
      const decision = checked.value;
      const reasonInput = box.querySelector('.decision-reason-input');
      const reason = reasonInput ? reasonInput.value.trim() : '';
      if (decision === 'deferred' && !reason) {
        toast('暂缓必须填写理由', true);
        reasonInput?.focus();
        return;
      }
      btn.disabled = true;
      try {
        await api('PATCH', `/api/fragments/${fragmentId}/decision`, {
          decision,
          reason: decision === 'deferred' ? reason : null,
          decided_by: lastAuthor.get() || null,
        });
        toast('片段结论已保存');
        await renderComparison(cmp.id);
      } finally {
        btn.disabled = false;
      }
    } else if (action === 'gen-resolution') {
      btn.disabled = true;
      try {
        cmp.resolution = await api('GET', `/api/comparisons/${cmp.id}/resolution`);
        drawComparison();
        toast('决议稿已生成');
      } catch (err) {
        await renderComparison(cmp.id);
        throw err;
      }
    } else if (action === 'close-resolution') {
      cmp.resolution = null;
      drawComparison();
    } else if (action === 'seal') {
      const input = document.getElementById('seal-by');
      const sealedBy = input.value.trim();
      if (!sealedBy) {
        toast('请填写封存人姓名', true);
        input.focus();
        return;
      }
      btn.disabled = true;
      try {
        const res = await fetch(`/api/comparisons/${btn.dataset.id}/seal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sealed_by: sealedBy }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok) {
          if (j?.blockers?.length) {
            toast(`封存被阻塞：${j.blockers[0].message} 等 ${j.blockers.length} 项`, true);
          } else {
            toast(j?.error || `封存失败（${res.status}）`, true);
          }
          await renderComparison(cmp.id);
          return;
        }
        lastSealer.set(sealedBy);
        toast('已封存：片段结论与批注均已锁定');
        await renderComparison(cmp.id);
      } finally {
        btn.disabled = false;
      }
    }
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  try {
    if (t.classList.contains('decision-radio')) {
      const box = t.closest('.decision-box');
      const detail = box.querySelector('.decision-detail');
      detail.hidden = t.value !== 'deferred';
      box.querySelectorAll('.decision-opt').forEach((el) => {
        el.classList.toggle('picked', el.querySelector('input').checked);
      });
    } else if (t.classList.contains('ann-status')) {
      await api('PATCH', `/api/annotations/${t.dataset.id}`, { status: t.value });
      await renderComparison(cmp.id);
      toast('状态已更新');
    } else if (t.id === 'filter-status') {
      cmp.status = t.value;
      drawComparison();
    } else if (t.id === 'filter-author') {
      cmp.author = t.value;
      drawComparison();
    } else if (t.id === 'filter-annotated') {
      cmp.onlyAnnotated = t.checked;
      drawComparison();
    }
  } catch (err) {
    toast(err.message, true);
  }
});

/* ================= 路由 ================= */

async function route() {
  const hash = location.hash || '#/';
  const mProject = hash.match(/^#\/projects\/(\d+)$/);
  const mCompare = hash.match(/^#\/comparisons\/(\d+)$/);
  try {
    if (mCompare) await renderComparison(Number(mCompare[1]));
    else if (mProject) await renderProject(Number(mProject[1]));
    else await renderProjects();
  } catch (err) {
    app.innerHTML = `<section class="panel"><p class="error">${esc(err.message)}</p>
      <p><a href="#/">返回首页</a></p></section>`;
  }
}

window.addEventListener('hashchange', route);
route();
