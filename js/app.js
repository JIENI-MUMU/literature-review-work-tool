/* 文献综述笔记 · 主程序（页面渲染与交互） */
(function () {
  const S = window.Store;
  const H = window.HINTS;
  const app = document.getElementById('app');
  const D = () => S.data;

  // ---------- 小工具 ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const today = () => new Date().toISOString().slice(0, 10);
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '');

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  const modal = document.getElementById('modal');
  function openModal(html) { modal.querySelector('.modal-body').innerHTML = html; modal.classList.remove('hidden'); }
  function closeModal() { modal.classList.add('hidden'); if (typeof pickResolve === 'function') { const r = pickResolve; pickResolve = null; r(null); } }
  modal.addEventListener('click', (e) => { if (e.target === modal || e.target.classList.contains('modal-close')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  function showHelp(key) {
    const h = H[key]; if (!h) return;
    let html = `<h3>${esc(h.label)}</h3><div class="help-text">${esc(h.help || '')}</div>`;
    if (h.example) html += `<div class="example"><b>例子</b>${esc(h.example)}<span class="caveat">例子根据 RP 中对文献的描述写成，未核对原文，只示范写法。</span></div>`;
    openModal(html);
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-help]');
    if (b) { e.preventDefault(); showHelp(b.dataset.help); }
  });

  const helpBtn = (key) => `<button type="button" class="help-btn" data-help="${key}" title="这个格子怎么填">?</button>`;
  const label = (key) => `<div class="field-label">${esc(H[key].label)} ${helpBtn(key)}</div>`;

  // ---------- 问题标签 ----------
  function qLabel(id) {
    if (id === 'unsure') return '暂不确定';
    const q = D().questions.find((x) => x.id === id);
    return q ? q.code : '';
  }
  function qTags(p) {
    const ids = p.questionIds || [];
    if (!ids.length) return '<span class="tag unsure">未归类</span>';
    return ids.map((id) => `<span class="tag ${id === 'unsure' ? 'unsure' : ''}" title="${esc(id === 'unsure' ? '' : (D().questions.find((q) => q.id === id) || {}).text)}">${esc(qLabel(id))}</span>`).join('');
  }

  const readCount = () => D().papers.filter((p) => p.fullRead).length;

  // ---------- 顶部状态 ----------
  function updateBadge() {
    const b = document.getElementById('syncBadge');
    const st = S.syncStatus;
    b.className = 'sync-badge ' + st;
    if (!S.getSync()) { b.textContent = '○ 未开启同步'; return; }
    b.textContent = { idle: '● ', syncing: '◌ ', error: '⚠ ', conflict: '⚠ ', off: '○ ' }[st] + (S.syncMessage || '同步已开启');
  }
  document.getElementById('syncBadge').addEventListener('click', () => { location.hash = '#/settings'; });

  function updateBanner() {
    const el = document.getElementById('banner');
    let html = '';
    if (S.syncStatus === 'conflict') {
      html = `<div class="banner red"><span>另一台设备也修改过数据，两份不一样。用哪一份？（另一份会被覆盖）</span>
        <span><button class="small" data-act="use-remote">用另一台设备的</button> <button class="small" data-act="use-local">用这台设备的</button></span></div>`;
    } else {
      const n = readCount() - (D().lastReviewReadCount || 0);
      if (n >= 5 && !location.hash.startsWith('#/review')) {
        html = `<div class="banner"><span>你又读完了 ${n} 篇。该做一次横向复盘了：哪些一致、哪些矛盾、什么没人研究。</span><a class="btn small" href="#/review">去复盘</a></div>`;
      } else if (!S.getSync() && D().papers.length > 0) {
        let last = null; try { last = localStorage.getItem('litreview.lastBackup'); } catch (e) {}
        const old = !last || (Date.now() - new Date(last).getTime()) > 7 * 864e5;
        if (old) html = `<div class="banner"><span>数据只存在这台设备的浏览器里，清缓存会丢失。建议开启同步，或导出备份。</span><a class="btn small" href="#/settings">去设置</a></div>`;
      }
    }
    el.innerHTML = html;
  }
  document.getElementById('banner').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'use-remote') await S.resolveConflict('remote');
    if (a.dataset.act === 'use-local') await S.resolveConflict('local');
  });

  S.onChange(() => {
    updateBadge(); updateBanner();
    if (S.replaced) { S.replaced = false; route(); }
  });

  // ---------- 路由 ----------
  const listState = { q: '', filter: 'all', unread: false, unsure: false, sort: 'updated' };

  function route() {
    const h = location.hash || '#/list';
    const [, page, id] = h.split('/');
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === (page === 'paper' ? 'list' : page)));
    if (page === 'paper' && id) renderCard(id);
    else if (page === 'questions') renderQuestions();
    else if (page === 'review') renderReview();
    else if (page === 'guide') renderGuide();
    else if (page === 'settings') renderSettings();
    else renderList();
    updateBanner();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  // =====================================================
  // 文献列表
  // =====================================================
  function filteredPapers() {
    const st = listState;
    let ps = D().papers.slice();
    if (st.q) {
      const q = st.q.toLowerCase();
      ps = ps.filter((p) => [p.title, p.titleZh, p.authors, p.journal, p.summary, p.year].join(' ').toLowerCase().includes(q));
    }
    if (st.filter === 'none') ps = ps.filter((p) => !(p.questionIds || []).length);
    else if (st.filter !== 'all') ps = ps.filter((p) => (p.questionIds || []).includes(st.filter));
    if (st.unread) ps = ps.filter((p) => !p.fullRead);
    if (st.unsure) ps = ps.filter((p) => p.bEvidenceConfidence === 'unsure');
    if (st.sort === 'year') ps.sort((a, b) => String(b.year || '').localeCompare(String(a.year || '')));
    else if (st.sort === 'title') ps.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    else ps.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return ps;
  }

  function renderList() {
    const st = listState;
    const qs = D().questions;
    const opts = [['all', '全部问题']].concat(qs.map((q) => [q.id, q.code + '：' + q.text.slice(0, 24)]), [['unsure', '暂不确定'], ['none', '未归类']]);
    const total = D().papers.length;
    app.innerHTML = `
      <h1>文献列表</h1>
      <p class="sub">共 ${total} 篇，全文已读 ${readCount()} 篇。点一行打开笔记卡。<b style="color:var(--red)">左边有红线的行</b>=还没读完全文，不能引用。</p>
      <div class="toolbar">
        <label class="btn primary-label" style="margin:0">＋ 从 PDF 新增<input type="file" id="pdfFiles" accept=".pdf,application/pdf" multiple hidden></label>
        <button id="btnNew">＋ 手动新增</button>
        <label class="btn" style="margin:0">导入 Zotero CSV<input type="file" id="zoteroFile" accept=".csv,text/csv" hidden></label>
        <span class="spacer"></span>
        <input type="search" id="q" placeholder="搜索标题、作者、总结…" value="${esc(st.q)}">
        <select id="filter">${opts.map(([v, t]) => `<option value="${esc(v)}" ${st.filter === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <select id="sort">
          <option value="updated" ${st.sort === 'updated' ? 'selected' : ''}>最近修改</option>
          <option value="year" ${st.sort === 'year' ? 'selected' : ''}>年份</option>
          <option value="title" ${st.sort === 'title' ? 'selected' : ''}>标题</option>
        </select>
      </div>
      <div class="toolbar">
        <label class="chk"><input type="checkbox" id="fUnread" ${st.unread ? 'checked' : ''}> 只看未读全文</label>
        <label class="chk"><input type="checkbox" id="fUnsure" ${st.unsure ? 'checked' : ''}> 只看“局限不确定”的（待批改）</label>
      </div>
      <div class="dropzone" id="dropZone">把 PDF 拖到这里（可以一次拖多篇），自动找 DOI、填好标题作者年份期刊。<br><span class="meta-line">PDF 只在你电脑上读取，不会上传，也不会保存。</span></div>
      <div class="list" id="listBox"></div>`;
    drawRows();
    app.querySelector('#pdfFiles').onchange = (e) => { addFromPdfs(e.target.files); e.target.value = ''; };
    const dz = app.querySelector('#dropZone');
    dz.onclick = () => app.querySelector('#pdfFiles').click();

    app.querySelector('#btnNew').onclick = newPaper;
    app.querySelector('#zoteroFile').onchange = (e) => importZotero(e.target.files[0]);
    app.querySelector('#q').oninput = (e) => { st.q = e.target.value; drawRows(); };
    app.querySelector('#filter').onchange = (e) => { st.filter = e.target.value; drawRows(); };
    app.querySelector('#sort').onchange = (e) => { st.sort = e.target.value; drawRows(); };
    app.querySelector('#fUnread').onchange = (e) => { st.unread = e.target.checked; drawRows(); };
    app.querySelector('#fUnsure').onchange = (e) => { st.unsure = e.target.checked; drawRows(); };
  }

  function drawRows() {
    const box = document.getElementById('listBox'); if (!box) return;
    const ps = filteredPapers();
    if (!D().papers.length) {
      box.innerHTML = `<div class="empty">还没有文献。<br>先去“我关心的问题”写下几个工作问题，再把 PDF 拖进上面的虚线框。</div>`;
      return;
    }
    if (!ps.length) { box.innerHTML = '<div class="empty">没有符合筛选条件的文献。</div>'; return; }
    box.innerHTML = `<table>
      <thead><tr><th>标题</th><th class="col-year">年份</th><th>一句话总结</th><th class="col-q">对应问题</th><th class="col-read">全文已读</th></tr></thead>
      <tbody>${ps.map((p) => `
        <tr class="${p.fullRead ? '' : 'unread'}" data-id="${p.id}">
          <td><div class="t-title">${esc(p.title || '（未填标题）')}</div>${p.titleZh ? `<div class="t-zh">${esc(p.titleZh)}</div>` : ''}</td>
          <td class="td-year">${esc(p.year)}</td>
          <td class="t-sum">${p.summary ? esc(p.summary) : '<span class="empty-sum">还没写</span>'}${p.bEvidenceConfidence === 'unsure' ? ' <span class="tag unsure">局限待批改</span>' : ''}</td>
          <td class="col-q">${qTags(p)}</td>
          <td class="td-read">${p.fullRead ? '✓<span class="m-only"> 已读</span>' : '<span class="tag red">未读</span>'}</td>
        </tr>`).join('')}</tbody></table>`;
    box.querySelectorAll('tbody tr').forEach((tr) => { tr.onclick = () => { location.hash = '#/paper/' + tr.dataset.id; }; });
  }

  function blankPaper() {
    const now = new Date().toISOString();
    return {
      id: uid(), createdAt: now, updatedAt: now,
      doi: '', title: '', titleZh: '', authors: '', year: '', journal: '', crossrefType: '',
      sourceType: '', questionIds: [], fullRead: false,
      aQuestion: '', mType: '', mSubjects: '', mSample: '', mSource: '', mWhenWhere: '', mMeasure: '', aMethod: '',
      rResults: '', dInterpret: '', dConclusion: '', aAuthorLimits: '',
      bEvidence: '', bEvidenceConfidence: '', bApply: '', bCompare: '', bProves: '', bGap: '',
      quotes: [], summary: '', pdfName: '',
    };
  }

  function newPaper() {
    const p = blankPaper();
    D().papers.push(p); S.save();
    renderCard.lastSec = 'basic';
    location.hash = '#/paper/' + p.id;
  }

  // =====================================================
  // 笔记卡
  // =====================================================
  const SOURCE_TYPES = [['', '— 请选择 —'], ['peer', '同行评审论文'], ['official', '官方文件'], ['grey', '灰色文献'], ['media', '行业媒体'], ['other', '其他']];

  function ta(p, key, rows) {
    return `<div class="field">${label(key)}<textarea data-f="${key}" rows="${rows || 3}" placeholder="${esc(H[key].placeholder || '')}">${esc(p[key])}</textarea></div>`;
  }
  function inp(p, key) {
    return `<div class="field">${label(key)}<input type="text" data-f="${key}" placeholder="${esc(H[key].placeholder || '')}" value="${esc(p[key])}"></div>`;
  }

  function renderCard(id) {
    const p = D().papers.find((x) => x.id === id);
    if (!p) { app.innerHTML = '<div class="empty">找不到这篇文献。<a href="#/list">回到列表</a></div>'; return; }
    const qs = D().questions;

    app.innerHTML = `
      <div class="card-head">
        <a href="#/list">← 回到列表</a>
        <span class="meta-line">最后修改：${esc(fmtDate(p.updatedAt))}</span>
        <span><button class="small" id="btnAI" title="找不到某格的内容时，生成一段提示词，拿去问 Claude">让 AI 指路</button>
        <button class="danger small" id="btnDel">删除这篇</button></span>
      </div>
      <div id="readWarn"></div>
      <div class="card-layout">
        <nav class="sec-nav" id="secNav"></nav>
        <div class="sec-body">

      <section class="panel sec" data-sec="basic">
        <h2 class="sec-head">基本信息</h2>
        <div class="field">${label('doi')}
          <div class="inline"><input type="text" data-f="doi" placeholder="${esc(H.doi.placeholder)}" value="${esc(p.doi)}"><button id="btnDoi">拉取</button><label class="btn" style="margin:0;white-space:nowrap">从 PDF 识别<input type="file" id="pdfOne" accept=".pdf,application/pdf" hidden></label></div>
          ${p.pdfName ? `<div class="meta-line">对应的 PDF 文件：${esc(p.pdfName)}</div>` : ''}
          ${p.crossrefType ? `<div class="meta-line">${p.crossrefType.startsWith('Zotero：') ? 'Zotero 记录的类型：' + esc(p.crossrefType.slice(7)) : 'Crossref 记录的类型：' + esc(p.crossrefType)}（只供参考，来源类型要你自己判断）</div>` : ''}
        </div>
        ${inp(p, 'title')}
        ${inp(p, 'titleZh')}
        <div class="row3">${inp(p, 'authors')}${inp(p, 'year')}${inp(p, 'journal')}</div>
        <div class="row2">
          <div class="field">${label('sourceType')}
            <select data-f="sourceType">${SOURCE_TYPES.map(([v, t]) => `<option value="${v}" ${p.sourceType === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
          </div>
          <div class="field">${label('fullRead')}
            <label class="chk" style="color:var(--ink)"><input type="checkbox" id="fullRead" ${p.fullRead ? 'checked' : ''}> 我已经读完全文</label>
          </div>
        </div>
        <div class="field">${label('questions')}
          <div class="checks">
            ${qs.map((q) => `<label title="${esc(q.text)}"><input type="checkbox" data-q="${q.id}" ${(p.questionIds || []).includes(q.id) ? 'checked' : ''}> ${esc(q.code)}：${esc(q.text.length > 30 ? q.text.slice(0, 30) + '…' : q.text)}</label>`).join('')}
            <label><input type="checkbox" data-q="unsure" ${(p.questionIds || []).includes('unsure') ? 'checked' : ''}> 暂不确定</label>
          </div>
          ${qs.length ? '' : '<div class="meta-line">还没有问题。先去 <a href="#/questions">我关心的问题</a> 写几条。</div>'}
        </div>
      </section>

      <section class="panel sec" data-sec="question">
        <h2 class="sec-head">研究问题</h2>
        <p class="part-note">在引言最后一段或摘要里找。照原文写，不加评价。</p>
        ${ta(p, 'aQuestion', 1)}
      </section>

      <section class="panel sec" data-sec="method">
        <h2 class="sec-head">研究方法</h2>
        <p class="part-note">在方法（Methods）部分找。每格几个字就够；找不到就空着，作者没写清楚本身就是局限。</p>
        <div class="field">${label('mType')}
          <select data-f="mType">${(window.M_TYPES || []).map((t) => `<option value="${esc(t)}" ${p.mType === t ? 'selected' : ''}>${t || '— 请选择 —'}</option>`).join('')}</select>
        </div>
        ${inp(p, 'mSubjects')}
        ${inp(p, 'mSample')}
        ${inp(p, 'mSource')}
        ${inp(p, 'mWhenWhere')}
        ${inp(p, 'mMeasure')}
        ${ta(p, 'aMethod', 1)}
      </section>

      <section class="panel sec" data-sec="results">
        <h2 class="sec-head">研究结果</h2>
        <p class="part-note">在结果（Results）部分找。只写数据显示了什么，作者的解释放到下一项。</p>
        ${ta(p, 'rResults', 2)}
      </section>

      <section class="panel sec" data-sec="discussion">
        <h2 class="sec-head">讨论与结论</h2>
        <p class="part-note">在讨论（Discussion）和结论（Conclusion）部分找。写完和“研究结果”对比：作者有没有说过头？</p>
        ${ta(p, 'dInterpret', 1)}
        ${ta(p, 'dConclusion', 1)}
        ${ta(p, 'aAuthorLimits', 1)}
      </section>

      <section class="panel sec" data-sec="eval">
        <h2 class="sec-head">我的评价</h2>
        <p class="part-note">前面记的都是别人说了什么，这里轮到你。用大白话写，不必每格都填，能写出一两格就够。拿不准的标“不确定”。</p>
        <div class="field">${label('bEvidence')}
          <div>
          <textarea data-f="bEvidence" rows="1" placeholder="${esc(H.bEvidence.placeholder)}">${esc(p.bEvidence)}</textarea>
          <div style="margin-top:8px;display:flex;gap:10px;align-items:center">
            <span class="meta-line">把握程度</span>
            <span class="seg" id="conf">
              <button type="button" data-v="sure" class="${p.bEvidenceConfidence === 'sure' ? 'on' : ''}">有把握</button>
              <button type="button" data-v="unsure" class="${p.bEvidenceConfidence === 'unsure' ? 'on unsure' : ''}">不确定</button>
            </span>
            ${helpBtn('bEvidenceConfidence')}
          </div>
          </div>
        </div>
        ${ta(p, 'bApply', 1)}
        ${ta(p, 'bCompare', 1)}
        ${ta(p, 'bProves', 1)}
        ${ta(p, 'bGap', 1)}
      </section>

      <section class="panel sec" data-sec="cite">
        <h2 class="sec-head">引用与总结</h2>
        <div class="field">${label('quotes')}
          <div><div id="quotes"></div>
          <button type="button" class="small add-btn" id="addQuote" title="再加一条原话">＋</button></div>
        </div>
        ${ta(p, 'summary', 1)}
      </section>
        </div>
      </div>`;

    // 自动保存
    let saveT;
    const touch = () => { p.updatedAt = new Date().toISOString(); clearTimeout(saveT); saveT = setTimeout(() => S.save(), 400); };

    app.querySelectorAll('[data-f]').forEach((el) => {
      const ev = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, () => { p[el.dataset.f] = el.value; touch(); });
    });
    app.querySelectorAll('[data-q]').forEach((el) => {
      el.addEventListener('change', () => {
        const set = new Set(p.questionIds || []);
        if (el.checked) set.add(el.dataset.q); else set.delete(el.dataset.q);
        p.questionIds = [...set]; touch();
      });
    });
    const fr = app.querySelector('#fullRead');
    const drawWarn = () => {
      app.querySelector('#readWarn').innerHTML = p.fullRead ? '' :
        '<div class="warn-box">还没有读完全文。这篇在勾选“全文已读”之前，<b>不能在论文里引用</b>。</div>';
    };
    drawWarn();
    fr.onchange = () => { p.fullRead = fr.checked; drawWarn(); touch(); updateBanner(); };

    const autosize = (el) => { if (!el.offsetParent) return; el.style.height = 'auto'; el.style.height = (el.scrollHeight + 2) + 'px'; };
    // 左栏目录：点哪一项，右边只显示那一项
    const SECS = [
      ['basic', '基本信息', () => [p.title, p.authors, p.year, p.journal, p.sourceType, (p.questionIds || []).length ? 1 : ''], 6],
      ['question', '研究问题', () => [p.aQuestion], 1],
      ['method', '研究方法', () => [p.mType, p.mSubjects, p.mSample, p.mSource, p.mWhenWhere, p.mMeasure], 6],
      ['results', '研究结果', () => [p.rResults], 1],
      ['discussion', '讨论与结论', () => [p.dInterpret, p.dConclusion, p.aAuthorLimits], 3],
      ['eval', '我的评价', () => [p.bEvidence, p.bApply, p.bCompare, p.bProves, p.bGap], 5],
      ['cite', '引用与总结', () => [(p.quotes || []).some((q) => (q.text || '').trim()) ? 1 : '', p.summary], 2],
    ];
    const nav = app.querySelector('#secNav');
    let active = renderCard.lastSec || 'basic';
    if (!['basic', 'question', 'method', 'results', 'discussion', 'eval', 'cite'].includes(active)) active = 'basic';
    // 目录只建一次，之后只更新计数和高亮（重建会吞掉点击）
    nav.innerHTML = SECS.map(([k, name]) => `<button type="button" data-go="${k}"><span>${name}</span><span class="cnt"></span></button>`).join('');
    nav.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => show(b.dataset.go); });
    const drawNav = () => {
      SECS.forEach(([k, , vals, n]) => {
        const b = nav.querySelector(`[data-go="${k}"]`);
        const done = vals().filter((v) => String(v || '').trim()).length;
        b.classList.toggle('on', k === active);
        const c = b.querySelector('.cnt');
        c.textContent = `${done}/${n}`;
        c.classList.toggle('full', done === n);
      });
    };
    const show = (k) => {
      active = k; renderCard.lastSec = k;
      app.querySelectorAll('.sec').forEach((sec) => { sec.hidden = sec.dataset.sec !== k; });
      drawNav();
      app.querySelectorAll('.sec:not([hidden]) textarea').forEach((el) => autosize(el));
      const top = app.querySelector('.card-layout'); if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView();
    };
    SECS.forEach(([k], i) => {
      const sec = app.querySelector(`.sec[data-sec="${k}"]`);
      const nxt = SECS[i + 1];
      const bar = document.createElement('div'); bar.className = 'sec-next';
      bar.innerHTML = (i > 0 ? `<button type="button" data-step="${SECS[i - 1][0]}">← ${SECS[i - 1][1]}</button>` : '<span></span>') +
        (nxt ? `<button type="button" data-step="${nxt[0]}">下一步：${nxt[1]} →</button>` : '<a class="btn" href="#/list">完成，回到列表</a>');
      sec.appendChild(bar);
    });
    app.querySelectorAll('[data-step]').forEach((b) => { b.onclick = () => show(b.dataset.step); });
    const layout = app.querySelector('.card-layout');
    layout.addEventListener('input', () => drawNav());
    layout.addEventListener('change', () => drawNav());
    // 文本框随内容自动变高
    app.querySelectorAll('textarea').forEach((el) => { el.addEventListener('input', () => autosize(el)); });
    show(active);

    app.querySelectorAll('#conf button').forEach((b) => {
      b.onclick = () => {
        p.bEvidenceConfidence = p.bEvidenceConfidence === b.dataset.v ? '' : b.dataset.v;
        app.querySelectorAll('#conf button').forEach((x) => {
          x.className = p.bEvidenceConfidence === x.dataset.v ? ('on' + (x.dataset.v === 'unsure' ? ' unsure' : '')) : '';
        });
        touch();
      };
    });

    // 原话
    const drawQuotes = () => {
      const box = app.querySelector('#quotes');
      while (p.quotes.length < 3) p.quotes.push({ text: '', page: '' }); // 默认三个空格子
      box.innerHTML = p.quotes.map((q, i) => `
        <div class="quote-row">
          <input type="text" data-qi="${i}" data-k="text" placeholder="原话" value="${esc(q.text)}">
          <input type="text" data-qi="${i}" data-k="page" placeholder="页码（必填）" value="${esc(q.page)}">
          <button type="button" class="small x-btn" data-qdel="${i}" title="删掉这一条">×</button>
        </div>`).join('');
      box.querySelectorAll('[data-qi]').forEach((el) => {
        el.oninput = () => { p.quotes[+el.dataset.qi][el.dataset.k] = el.value; touch(); drawNav(); };
      });
      box.querySelectorAll('[data-qdel]').forEach((b) => {
        b.onclick = () => { p.quotes.splice(+b.dataset.qdel, 1); drawQuotes(); touch(); drawNav(); };
      });
    };
    drawQuotes();
    app.querySelector('#addQuote').onclick = () => {
      p.quotes.push({ text: '', page: '' }); drawQuotes(); touch();
      const ins = app.querySelectorAll('#quotes [data-k="text"]'); ins[ins.length - 1].focus();
    };

    app.querySelector('#btnDoi').onclick = () => fetchDoi(p);
    app.querySelector('#pdfOne').onchange = (e) => { fillFromPdf(p, e.target.files[0]); e.target.value = ''; };
    app.querySelector('#btnDel').onclick = () => {
      if (!confirm('确定删除这篇文献和它的全部笔记？删除后不能恢复。')) return;
      D().papers = D().papers.filter((x) => x.id !== p.id); S.save();
      location.hash = '#/list';
    };

    app.querySelector('#btnAI').onclick = () => openAiGuide(p);

    // AI_EXTRACT_HOOK：现在的“让 AI 指路”只生成提示词，由用户拿去 Claude 对话里问（做法一）。
    // 以后若改成网页里直接调用 AI（做法二），在 openAiGuide 里接 API；
    // 规则不变：只用于 AI_FIELDS 里的“记录原文”格子，必须带原文原句和页码，“我的评价”永远不碰。
  }

  // =====================================================
  // 让 AI 指路：生成提示词，用户拿去 Claude 对话里问
  // AI 只告诉你“在哪一页、原文怎么说”，你自己去原文核对，再用自己的话填。
  // “我的评价”不在这里，永远不让 AI 写。
  // =====================================================
  const AI_FIELDS = [
    ['aQuestion', '研究问题', '这篇文章想回答的研究问题或研究目的'],
    ['mType', '研究方法', '用的是哪种研究方法（访谈、问卷、案例研究、实验、二手数据分析、综述等）'],
    ['mSubjects', '研究方法', '研究对象是谁、是什么'],
    ['mSample', '研究方法', '样本量：多少人、多少机构、多少个案例或多少条数据'],
    ['mSource', '研究方法', '数据从哪里来；是研究对象自己报告的，还是客观记录的'],
    ['mWhenWhere', '研究方法', '研究在哪个国家或地区做的，数据是哪段时间的'],
    ['mMeasure', '研究方法', '文章的核心概念具体用什么指标或标准来衡量'],
    ['rResults', '研究结果', '结果部分报告的主要数据（只要数据本身，不要作者的解释）'],
    ['dInterpret', '讨论与结论', '讨论部分作者怎么解释结果'],
    ['dConclusion', '讨论与结论', '结论部分作者的结论和建议'],
    ['aAuthorLimits', '讨论与结论', '作者自己承认的研究局限'],
  ];

  function buildAiPrompt(p, keys) {
    const items = AI_FIELDS.filter(([k]) => keys.includes(k));
    const head = [p.title && `标题：${p.title}`, p.authors && `作者：${p.authors}`, p.year && `年份：${p.year}`, p.doi && `DOI：${p.doi}`].filter(Boolean).join('\n');
    return `请帮我在这篇论文里找到下面 ${items.length} 项内容的出处：
${items.map(([k, sec, desc], i) => `${i + 1}. 【${sec}｜${H[k].label}】${desc}`).join('\n')}

论文（PDF 已上传）：
${head || '（见附件）'}

我在练习自己读文献、写笔记。请你只帮我“指路”，不要替我写笔记。每一项按这个格式回答：
- 出处：在哪一部分（章节名）、第几页
- 原文：把原文里最关键的那一句照抄下来（保留英文原文，不要改写，不要翻译）
- 提示：用一句中文告诉我这一项该注意什么，不超过 20 个字

规则：
1. 原文里没有写到的，直接回答“原文没有写”，不要猜，不要用常识补。没写清楚本身就是重要信息。
2. 不要评价这篇文章的好坏，不要告诉我它有什么局限（作者自己承认的局限除外），不要给我写“我的看法”。
3. 数字必须是原文里的数字，标明页码。`;
  }

  function openAiGuide(p) {
    const empty = AI_FIELDS.filter(([k]) => !String(p[k] || '').trim()).map(([k]) => k);
    openModal(`<h3>让 AI 指路</h3>
      <p class="meta-line">找不到某一格的内容时用。网页会生成一段提示词，你把 PDF 和提示词一起发给 Claude，它会告诉你每一项<b>在第几页、原文怎么说</b>。你翻到那一页核对，再用自己的话填。<br><b>“我的评价”不在这里，那部分要你自己写。</b></p>
      <div class="field-label" style="margin-top:12px">要问哪几格？（默认勾选还空着的）</div>
      <div class="ai-checks">${AI_FIELDS.map(([k, sec]) => `<label><input type="checkbox" data-ai="${k}" ${empty.includes(k) ? 'checked' : ''}> <span class="meta-line">${sec}｜</span>${esc(H[k].label)}</label>`).join('')}</div>
      <textarea id="aiPrompt" readonly rows="8" style="margin-top:12px;font-size:12px"></textarea>
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">
        <button class="primary" id="aiCopy">复制提示词</button>
        <a class="btn" href="https://claude.ai/new" target="_blank" rel="noopener">打开 Claude</a>
        <span class="meta-line" id="aiMsg"></span>
      </div>
      <ol class="steps meta-line" style="margin-top:12px;padding-left:18px">
        <li>点“复制提示词”</li><li>打开 Claude，上传这篇论文的 PDF，粘贴提示词，发送</li>
        <li>按 Claude 给的页码去原文核对，<b>用自己的话</b>填进格子</li>
      </ol>`);
    const ta = modal.querySelector('#aiPrompt');
    const draw = () => {
      const keys = [...modal.querySelectorAll('[data-ai]:checked')].map((c) => c.dataset.ai);
      ta.value = keys.length ? buildAiPrompt(p, keys) : '至少勾选一项。';
      ta.scrollTop = 0;
      const msg = modal.querySelector('#aiMsg');
      if (msg) msg.textContent = keys.length ? `提示词已更新：现在问 ${keys.length} 项` : '';
    };
    modal.querySelectorAll('[data-ai]').forEach((c) => { c.onchange = draw; });
    draw();
    modal.querySelector('#aiCopy').onclick = async () => {
      const msg = modal.querySelector('#aiMsg');
      try { await navigator.clipboard.writeText(ta.value); msg.textContent = '已复制，去 Claude 粘贴'; }
      catch (e) { ta.removeAttribute('readonly'); ta.focus(); ta.select(); msg.textContent = '自动复制失败，已全选，请按 Cmd+C 复制'; }
    };
  }

  function normDoi(s) {
    return String(s || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  }

  function applyMeta(p, m) {
    p.doi = m.doi || p.doi;
    p.title = m.title || p.title;
    p.authors = m.authors || p.authors;
    p.year = m.year || p.year;
    p.journal = m.journal || p.journal;
    p.crossrefType = m.crossrefType || '';
    p.updatedAt = new Date().toISOString();
  }

  async function fetchDoi(p) {
    const doi = normDoi(p.doi);
    if (!doi) { toast('先填 DOI'); return; }
    const filled = ['title', 'authors', 'year', 'journal'].filter((k) => p[k]);
    if (filled.length && !confirm('标题/作者/年份/期刊已经有内容，用拉取到的信息覆盖吗？')) return;
    toast('正在拉取…');
    try {
      const m = await Crossref.lookup(doi);
      if (!m) { toast('找不到这个 DOI，检查一下有没有抄错'); return; }
      applyMeta(p, m);
      p.doi = normDoi(m.doi || doi);
      S.save();
      renderCard(p.id);
      toast('已拉取。来源类型请你自己判断。');
    } catch (e) {
      toast('拉取失败（' + e.message + '），请检查网络，或手动填写');
    }
  }

  // =====================================================
  // 从 PDF 识别（PDF 只在本机读取，不上传、不保存）
  // =====================================================
  let pickResolve = null;
  function pickCandidate(fileName, guess, cands) {
    return new Promise((resolve) => {
      pickResolve = resolve;
      openModal(`<h3>没在 PDF 里找到 DOI</h3>
        <p class="meta-line">文件：${esc(fileName)}<br>用标题“${esc(guess || '（没认出标题）')}”在 Crossref 搜到下面这些。是哪一篇？</p>
        ${cands.length ? cands.map((c, i) => `<div class="cand">
            <div><b>${esc(c.title)}</b></div>
            <div class="meta-line">${esc(c.authors.split(';').slice(0, 3).join(';'))}${c.authors.split(';').length > 3 ? ' 等' : ''} · ${esc(c.year)} · ${esc(c.journal)}</div>
            <button class="small" data-pick="${i}">就是这篇</button></div>`).join('') : '<p>没有搜到。</p>'}
        <p style="margin-top:16px"><button data-pick="manual">都不对，我自己手填</button>
        ${cands.length ? '' : ''}</p>`);
      modal.querySelectorAll('[data-pick]').forEach((b) => {
        b.onclick = () => { const r = pickResolve; pickResolve = null; closeModal(); r(b.dataset.pick === 'manual' ? null : cands[+b.dataset.pick]); };
      });
    });
  }

  async function addFromPdfs(files) {
    files = [...files].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) { toast('请选择 PDF 文件'); return; }
    let added = 0, dup = 0, manual = 0, lastId = null;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      toast(`正在识别 ${i + 1}/${files.length}：${f.name}`);
      let info;
      try { info = await PdfMeta.extract(f); } catch (e) { toast(`读不了 ${f.name}：${e.message}`); continue; }
      let meta = null;
      try {
        if (info.doi) meta = await Crossref.lookup(info.doi);
        if (!meta) {
          const cands = info.titleGuess ? await Crossref.search(info.titleGuess) : [];
          meta = await pickCandidate(f.name, info.titleGuess, cands);
        }
      } catch (e) {
        toast('联网查询失败（' + e.message + '），先用 PDF 里认出的信息');
      }
      const key = normDoi(meta && meta.doi).toLowerCase();
      if (key && D().papers.some((p) => normDoi(p.doi).toLowerCase() === key)) { dup++; continue; }
      const p = blankPaper();
      p.pdfName = info.pdfName;
      if (meta) applyMeta(p, meta);
      else { p.doi = info.doi; p.title = info.titleGuess; manual++; }
      D().papers.push(p); added++; lastId = p.id;
    }
    S.save();
    const msg = `新增 ${added} 篇` + (dup ? `，${dup} 篇已存在被跳过` : '') + (manual ? `，${manual} 篇需要你手动补全信息` : '');
    if (added === 1 && files.length === 1) { renderCard.lastSec = 'basic'; location.hash = '#/paper/' + lastId; }
    else renderList();
    setTimeout(() => toast(msg), 50);
  }

  async function fillFromPdf(p, file) {
    if (!file) return;
    toast('正在识别…');
    try {
      const info = await PdfMeta.extract(file);
      let meta = info.doi ? await Crossref.lookup(info.doi) : null;
      if (!meta) {
        const cands = info.titleGuess ? await Crossref.search(info.titleGuess) : [];
        meta = await pickCandidate(file.name, info.titleGuess, cands);
      }
      const filled = ['title', 'authors', 'year', 'journal'].filter((k) => p[k]);
      if (filled.length && !confirm('标题/作者/年份/期刊已经有内容，用识别到的信息覆盖吗？')) return;
      p.pdfName = file.name;
      if (meta) applyMeta(p, meta); else { if (info.doi) p.doi = info.doi; if (info.titleGuess) p.title = info.titleGuess; }
      S.save(); renderCard(p.id);
      toast(meta ? '已识别。来源类型请你自己判断。' : '没找到匹配，请手动补全');
    } catch (e) { toast('识别失败：' + e.message); }
  }

  // =====================================================
  // Zotero CSV 导入
  // =====================================================
  function parseCSV(text) {
    const rows = []; let row = []; let f = ''; let q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); rows.push(row); row = []; f = '';
      } else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim() !== ''));
  }

  function zoteroAuthors(s) {
    return String(s || '').split(';').map((a) => {
      const [last, first] = a.split(',').map((x) => (x || '').trim());
      if (!first) return last;
      return last + ' ' + first.split(/[\s.-]+/).filter(Boolean).map((x) => x[0]).join('');
    }).filter(Boolean).join('; ');
  }

  function importZotero(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const rows = parseCSV(reader.result);
      if (rows.length < 2) { toast('文件里没有数据'); return; }
      const head = rows[0].map((h) => h.trim());
      const col = (name) => head.indexOf(name);
      const iT = col('Title'), iA = col('Author'), iY = col('Publication Year'), iJ = col('Publication Title'), iD = col('DOI'), iType = col('Item Type'), iPub = col('Publisher');
      if (iT < 0) { toast('不像是 Zotero 导出的 CSV（找不到 Title 列）'); return; }
      const seen = new Set(D().papers.map((p) => (normDoi(p.doi) || p.title).toLowerCase()));
      let added = 0, skipped = 0;
      rows.slice(1).forEach((r) => {
        const p = blankPaper();
        p.title = (r[iT] || '').trim();
        p.authors = iA >= 0 ? zoteroAuthors(r[iA]) : '';
        p.year = iY >= 0 ? (r[iY] || '').trim() : '';
        p.journal = (iJ >= 0 && r[iJ]) ? r[iJ].trim() : (iPub >= 0 ? (r[iPub] || '').trim() : '');
        p.doi = iD >= 0 ? normDoi(r[iD]) : '';
        p.crossrefType = iType >= 0 ? 'Zotero：' + (r[iType] || '') : '';
        const key = (p.doi || p.title).toLowerCase();
        if (!p.title || seen.has(key)) { skipped++; return; }
        seen.add(key); D().papers.push(p); added++;
      });
      S.save(); renderList();
      toast(`导入 ${added} 篇${skipped ? `，跳过 ${skipped} 篇（重复或没有标题）` : ''}`);
    };
    reader.readAsText(file, 'utf-8');
  }

  // =====================================================
  // 我关心的问题
  // =====================================================
  function renderQuestions() {
    const d = D();
    let draft = d.questions.map((q) => Object.assign({}, q));
    app.innerHTML = `
      <h1>我关心的问题</h1>
      <p class="sub">这是“工作问题”，用来帮你筛选读什么，不是最终的研究问题。读着读着一定会改，改了说明你读进去了。每次保存，旧版本自动存进下面的历史。 ${helpBtn('question')}</p>
      <section class="panel">
        <div id="qList"></div>
        <button type="button" class="small" id="addQ">＋ 加一个问题</button>
        <div style="margin-top:16px;display:flex;gap:10px;align-items:center">
          <button class="primary" id="saveQ">保存修改</button>
          <span class="meta-line" id="qMsg"></span>
        </div>
      </section>
      <h2>修改历史</h2>
      <section class="panel hist" id="hist"></section>`;

    const nextCode = () => {
      const nums = d.questions.concat(draft).map((q) => +(String(q.code || '').replace(/\D/g, '')) || 0)
        .concat((d.questionHistory || []).flatMap((h) => h.questions.map((q) => +(String(q.code || '').replace(/\D/g, '')) || 0)));
      return '问题' + (Math.max(0, ...nums) + 1);
    };
    const draw = () => {
      const box = app.querySelector('#qList');
      box.innerHTML = draft.length ? draft.map((q, i) => `
        <div class="q-item">
          <span class="q-no">${esc(q.code)}</span>
          <input type="text" data-i="${i}" value="${esc(q.text)}" placeholder="${esc(H.question.placeholder)}">
          <button type="button" class="small danger" data-del="${i}">删除</button>
        </div>`).join('') : '<div class="meta-line" style="margin-bottom:10px">还没有问题。从你的 RP 里挑两三个，用大白话写下来。</div>';
      box.querySelectorAll('input').forEach((el) => { el.oninput = () => { draft[+el.dataset.i].text = el.value; msg('有未保存的修改'); }; });
      box.querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = () => {
          const q = draft[+b.dataset.del];
          const n = d.papers.filter((p) => (p.questionIds || []).includes(q.id)).length;
          if (n && !confirm(`有 ${n} 篇文献标了“${q.code}”。删除后这些文献会去掉这个标签。确定删除？`)) return;
          draft.splice(+b.dataset.del, 1); draw(); msg('有未保存的修改');
        };
      });
    };
    const msg = (t) => { app.querySelector('#qMsg').textContent = t; };
    draw();
    app.querySelector('#addQ').onclick = () => { draft.push({ id: uid(), code: nextCode(), text: '' }); draw(); const ins = app.querySelectorAll('#qList input'); if (ins.length) ins[ins.length - 1].focus(); };
    app.querySelector('#saveQ').onclick = () => {
      draft = draft.filter((q) => q.text.trim());
      const same = JSON.stringify(draft.map((q) => [q.id, q.text])) === JSON.stringify(d.questions.map((q) => [q.id, q.text]));
      if (same) { msg('没有改动'); draw(); return; }
      if (d.questions.length) d.questionHistory.unshift({ date: new Date().toISOString(), questions: d.questions });
      const keep = new Set(draft.map((q) => q.id));
      d.papers.forEach((p) => { p.questionIds = (p.questionIds || []).filter((id) => id === 'unsure' || keep.has(id)); });
      d.questions = draft.map((q) => ({ id: q.id, code: q.code, text: q.text.trim() }));
      S.save(); toast('已保存，旧版本已存进历史'); renderQuestions();
    };

    const hist = app.querySelector('#hist');
    const hs = d.questionHistory || [];
    hist.innerHTML = hs.length ? hs.map((h) => `
      <details><summary>${esc(fmtDate(h.date))} 之前的版本</summary>
        <ul>${h.questions.map((q) => `<li><b>${esc(q.code)}</b>：${esc(q.text)}</li>`).join('')}</ul>
      </details>`).join('') : '<div class="meta-line">还没有修改过。以后每次修改，旧版本都会出现在这里。几个月后回头看，你能看到自己的问题是怎么一步步变清楚的。</div>';
  }

  // =====================================================
  // 横向复盘
  // =====================================================
  function renderReview() {
    const d = D();
    const rc = readCount();
    const since = rc - (d.lastReviewReadCount || 0);
    const readPapers = d.papers.filter((p) => p.fullRead).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    app.innerHTML = `
      <h1>横向复盘</h1>
      <p class="sub">每读完 5 篇做一次。把下面几篇的笔记横着看，写三句话。几轮下来，“没人研究过”那一栏会长成你综述的论断。</p>
      <p>目前全文已读 <b>${rc}</b> 篇，上次复盘后新读了 <b>${since}</b> 篇。</p>

      <section class="panel">
        <h2>横着看：已读文献的关键格子</h2>
        ${readPapers.length ? `<div class="list" style="border:none"><table>
          <thead><tr><th style="width:28%">文献</th><th>和其他文献比</th><th>留下的空白</th></tr></thead>
          <tbody>${readPapers.map((p) => `<tr data-id="${p.id}"><td><div class="t-title">${esc(p.authors.split(';')[0] || '')} ${esc(p.year)}</div><div class="t-zh">${esc(p.titleZh || p.title)}</div></td>
            <td class="t-sum">${esc(p.bCompare) || '<span class="empty-sum">没写</span>'}</td>
            <td class="t-sum">${esc(p.bGap) || '<span class="empty-sum">没写</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="meta-line">还没有读完全文的文献。</div>'}
      </section>

      <section class="panel">
        <h2>写这一轮的复盘</h2>
        <div class="field">${label('reviewConsistent')}<textarea id="rv1" rows="3" placeholder="${esc(H.reviewConsistent.placeholder)}"></textarea></div>
        <div class="field">${label('reviewConflict')}<textarea id="rv2" rows="3" placeholder="${esc(H.reviewConflict.placeholder)}"></textarea></div>
        <div class="field">${label('reviewMissing')}<textarea id="rv3" rows="3" placeholder="${esc(H.reviewMissing.placeholder)}"></textarea></div>
        <button class="primary" id="saveRv">保存这次复盘</button>
      </section>

      <h2>历次复盘</h2>
      <section class="panel" id="rvList"></section>`;

    app.querySelectorAll('tbody tr[data-id]').forEach((tr) => { tr.onclick = () => { location.hash = '#/paper/' + tr.dataset.id; }; });

    app.querySelector('#saveRv').onclick = () => {
      const v = ['#rv1', '#rv2', '#rv3'].map((s) => app.querySelector(s).value.trim());
      if (!v.some(Boolean)) { toast('三栏都是空的'); return; }
      d.reviews.unshift({ id: uid(), date: new Date().toISOString(), paperCount: rc, consistent: v[0], conflict: v[1], missing: v[2] });
      d.lastReviewReadCount = rc;
      S.save(); toast('已保存'); renderReview(); updateBanner();
    };

    const box = app.querySelector('#rvList');
    box.innerHTML = d.reviews.length ? d.reviews.map((r) => `
      <dl class="review-item">
        <div><b>${esc(fmtDate(r.date))}</b> <span class="meta-line">（当时已读 ${r.paperCount} 篇）</span>
          <button class="small danger" data-rdel="${r.id}" style="float:right">删除</button></div>
        <dt>一致的</dt><dd>${esc(r.consistent) || '—'}</dd>
        <dt>矛盾的</dt><dd>${esc(r.conflict) || '—'}</dd>
        <dt>没人研究的</dt><dd>${esc(r.missing) || '—'}</dd>
      </dl>`).join('') : '<div class="meta-line">还没有复盘记录。</div>';
    box.querySelectorAll('[data-rdel]').forEach((b) => {
      b.onclick = () => {
        if (!confirm('删除这次复盘记录？')) return;
        d.reviews = d.reviews.filter((r) => r.id !== b.dataset.rdel); S.save(); renderReview();
      };
    });
  }

  // =====================================================
  // 使用说明
  // =====================================================
  function renderGuide() {
    app.innerHTML = `<div class="guide">${window.GUIDE_HTML}</div>`;
    app.querySelectorAll('.toc a').forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); const t = app.querySelector(a.getAttribute('href')); if (t) t.scrollIntoView({ behavior: 'smooth' }); };
    });
  }

  // =====================================================
  // 设置：同步、导出、导入
  // =====================================================
  function renderSettings() {
    const s = S.getSync();
    app.innerHTML = `
      <h1>设置</h1>
      <p class="sub">同步、备份、导出。</p>

      <section class="panel">
        <h2>自动同步</h2>
        ${s ? `
          <p>已开启。数据存放在 <b>${esc(s.owner)}/${esc(s.repo)}</b> 的 <code>data.json</code>。</p>
          <p class="meta-line">状态：${esc(S.syncMessage || S.syncStatus)}${s.lastSyncedAt ? '；上次同步：' + esc(fmtDate(s.lastSyncedAt)) : ''}</p>
          <button id="syncNow">立即同步</button>
          <button class="danger" id="syncOff">断开同步（在公用电脑上用完记得点）</button>`
        : `
          <p>开启后，打开软件自动拉取最新数据，修改后几秒内自动上传。第一次要填一个 GitHub 令牌，<a href="#/guide" id="toSyncGuide">怎么生成令牌？</a></p>
          <div class="row2">
            <div class="field"><div class="field-label">GitHub 用户名</div><input type="text" id="sOwner" value="JIENI-MUMU"></div>
            <div class="field"><div class="field-label">私有仓库名</div><input type="text" id="sRepo" value="literature-review-work-data"></div>
          </div>
          <div class="field"><div class="field-label">令牌（github_pat_ 开头）</div><input type="password" id="sToken" autocomplete="off" placeholder="粘贴令牌"></div>
          <button class="primary" id="syncOn">连接并开启同步</button>
          <span class="meta-line" id="syncMsg"></span>`}
      </section>

      <section class="panel">
        <h2>导出</h2>
        <p class="meta-line">导出的 Excel / CSV 方便在别处查看；完整备份（JSON）可以导回本软件。</p>
        <button id="expXlsx">导出 Excel</button>
        <button id="expCsv">导出 CSV</button>
        <button id="expJson">下载完整备份（JSON）</button>
      </section>

      <section class="panel">
        <h2>导入</h2>
        <p><label class="btn" style="margin:0">导入 Zotero CSV（追加文献）<input type="file" id="impZotero" accept=".csv" hidden></label></p>
        <p class="meta-line">Zotero 里选中文献 → 右键 → Export Items… → 格式选 CSV。</p>
        <p><label class="btn" style="margin:0">从完整备份恢复（会替换现有全部数据）<input type="file" id="impJson" accept=".json,application/json" hidden></label></p>
      </section>`;

    if (s) {
      app.querySelector('#syncNow').onclick = async () => { await S.pull(); renderSettings(); };
      app.querySelector('#syncOff').onclick = () => {
        if (!confirm('断开后，这台设备不再同步，令牌会从这台设备删除。数据仍保留在本机和 GitHub 上。确定？')) return;
        S.setSync(null); S.setStatus('off'); renderSettings();
      };
    } else {
      app.querySelector('#toSyncGuide').onclick = (e) => { e.preventDefault(); location.hash = '#/guide'; setTimeout(() => { const t = document.getElementById('g-sync'); if (t) t.scrollIntoView(); }, 50); };
      app.querySelector('#syncOn').onclick = async () => {
        const owner = app.querySelector('#sOwner').value.trim();
        const repo = app.querySelector('#sRepo').value.trim();
        const token = app.querySelector('#sToken').value.trim();
        const m = app.querySelector('#syncMsg');
        if (!owner || !repo || !token) { m.textContent = '三项都要填'; return; }
        m.textContent = '正在连接…';
        try {
          await S.testSync(owner, repo, token);
          S.setSync({ owner, repo, token, sha: null, lastSyncedAt: null });
          await firstSync();
          renderSettings();
          toast('同步已开启');
        } catch (e) { m.textContent = '连接失败：' + e.message; }
      };
    }

    app.querySelector('#expXlsx').onclick = exportXlsx;
    app.querySelector('#expCsv').onclick = exportCsv;
    app.querySelector('#expJson').onclick = exportJson;
    app.querySelector('#impZotero').onchange = (e) => { importZotero(e.target.files[0]); location.hash = '#/list'; };
    app.querySelector('#impJson').onchange = (e) => importJson(e.target.files[0]);
  }

  // 第一次开启同步：远端有数据而本地也有数据时，让用户选
  async function firstSync() {
    const s = S.getSync();
    const res = await fetch(`https://api.github.com/repos/${s.owner}/${s.repo}/contents/data.json`, {
      headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' }, cache: 'no-store',
    });
    const localHas = D().papers.length || D().questions.length;
    if (res.status === 404) { await S.push(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!localHas) { s.sha = null; S.setSync(s); S.dirty = false; await S.pull(); return; }
    // 两边都有：交给冲突处理
    S.dirty = true; s.sha = j.sha + '-local'; S.setSync(s); // 故意让 sha 不一致，触发选择
    await S.pull();
  }

  function rowsForExport() {
    const st = Object.fromEntries(SOURCE_TYPES);
    return D().papers.map((p) => ({
      '英文标题': p.title, '中文标题': p.titleZh, '作者': p.authors, '年份': p.year, '期刊/来源': p.journal, 'DOI': p.doi,
      '来源类型': st[p.sourceType] || '', '对应问题': (p.questionIds || []).map(qLabel).join('、'), '全文已读': p.fullRead ? '是' : '否',
      '研究问题': p.aQuestion,
      '研究类型': p.mType, '研究对象': p.mSubjects, '样本量': p.mSample, '数据来源': p.mSource, '时间和地点': p.mWhenWhere, '关键的东西怎么测的': p.mMeasure, '方法其他补充': p.aMethod,
      '研究结果': p.rResults, '作者怎么解释': p.dInterpret, '作者的结论和建议': p.dConclusion, '作者自认局限': p.aAuthorLimits,
      '证据够不够（我看到的局限）': p.bEvidence, '把握程度': { sure: '有把握', unsure: '不确定' }[p.bEvidenceConfidence] || '',
      '能不能搬过来': p.bApply, '和其他文献比': p.bCompare, '帮我证明了什么': p.bProves, '留下的空白': p.bGap,
      '原话': (p.quotes || []).filter((q) => (q.text || '').trim()).map((q) => `"${q.text}"（第${q.page || '?'}页）`).join('\n'), '一句话总结': p.summary,
    }));
  }
  function download(name, blob) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function markBackup() { try { localStorage.setItem('litreview.lastBackup', new Date().toISOString()); } catch (e) {} updateBanner(); }

  function exportXlsx() {
    if (!window.XLSX) { toast('Excel 组件没有加载成功'); return; }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsForExport()), '文献笔记');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(D().questions.map((q) => ({ '编号': q.code, '问题': q.text }))), '我关心的问题');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(D().reviews.map((r) => ({ '日期': fmtDate(r.date), '当时已读': r.paperCount, '一致的': r.consistent, '矛盾的': r.conflict, '没人研究的': r.missing }))), '横向复盘');
    XLSX.writeFile(wb, `文献笔记_${today()}.xlsx`);
    markBackup();
  }
  function exportCsv() {
    const rows = rowsForExport();
    if (!rows.length) { toast('还没有文献'); return; }
    const head = Object.keys(rows[0]);
    const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = '﻿' + [head.map(cell).join(',')].concat(rows.map((r) => head.map((h) => cell(r[h])).join(','))).join('\r\n');
    download(`文献笔记_${today()}.csv`, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    markBackup();
  }
  function exportJson() {
    download(`文献笔记备份_${today()}.json`, new Blob([JSON.stringify(D(), null, 2)], { type: 'application/json' }));
    markBackup();
  }
  function importJson(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!data || !Array.isArray(data.papers)) throw new Error('格式不对');
        if (!confirm(`备份里有 ${data.papers.length} 篇文献。恢复会替换现在的全部数据（现在有 ${D().papers.length} 篇）。确定？`)) return;
        S.replaceAll(data); S.save(); toast('已恢复');
        location.hash = '#/list';
      } catch (e) { toast('无法读取这个备份：' + e.message); }
    };
    r.readAsText(file, 'utf-8');
  }

  // ---------- 自动同步 ----------
  function startSync() {
    if (S.getSync()) S.pull();
    document.addEventListener('visibilitychange', () => {
      if (!S.getSync()) return;
      if (document.visibilityState === 'visible') S.pull();
      else if (S.dirty) { clearTimeout(S._timer); S.push(); } // 离开页面前尽快上传
    });
    setInterval(() => { if (S.getSync() && document.visibilityState === 'visible' && !S.dirty) S.pull(); }, 120000);
  }
  window.addEventListener('beforeunload', (e) => {
    if (S.getSync() && S.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- 拖放 PDF ----------
  document.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer.types || [])].includes('Files')) return;
    e.preventDefault();
    const dz = document.getElementById('dropZone'); if (dz) dz.classList.add('over');
  });
  document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) { const dz = document.getElementById('dropZone'); if (dz) dz.classList.remove('over'); } });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const dz = document.getElementById('dropZone'); if (dz) dz.classList.remove('over');
    const m = (location.hash || '').match(/^#\/paper\/(.+)$/);
    if (m) { const p = D().papers.find((x) => x.id === m[1]); if (p) { fillFromPdf(p, e.dataTransfer.files[0]); return; } }
    addFromPdfs(e.dataTransfer.files);
  });

  // ---------- 启动 ----------
  if (!location.hash) location.hash = D().questions.length ? '#/list' : '#/questions';
  route();
  updateBadge();
  startSync();
})();
