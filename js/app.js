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
  function closeModal() { modal.classList.add('hidden'); }
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
        <button class="primary" id="btnNew">＋ 新增文献</button>
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
      <div class="list" id="listBox"></div>`;
    drawRows();

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
      box.innerHTML = `<div class="empty">还没有文献。<br>先去“我关心的问题”写下几个工作问题，再点“新增文献”。</div>`;
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
      aQuestion: '', aMethod: '', aFindings: '', aAuthorLimits: '',
      bEvidence: '', bEvidenceConfidence: '', bApply: '', bCompare: '', bProves: '', bGap: '',
      quotes: [], summary: '',
    };
  }

  function newPaper() {
    const p = blankPaper();
    D().papers.push(p); S.save();
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
        <button class="danger small" id="btnDel">删除这篇</button>
      </div>
      <div id="readWarn"></div>

      <section class="panel">
        <h2>基本信息</h2>
        <div class="field">${label('doi')}
          <div class="inline"><input type="text" data-f="doi" placeholder="${esc(H.doi.placeholder)}" value="${esc(p.doi)}"><button id="btnDoi">拉取</button></div>
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

      <section class="panel">
        <h2>A. 它说了什么</h2>
        <p class="part-note">照着原文写，不加评价。</p>
        ${ta(p, 'aQuestion', 2)}
        ${ta(p, 'aMethod', 4)}
        ${ta(p, 'aFindings', 4)}
        ${ta(p, 'aAuthorLimits', 3)}
      </section>

      <section class="panel">
        <h2>B. 我的看法</h2>
        <p class="part-note">用大白话写你的判断。四类不必每篇都写全，能写出一两类就够。拿不准的标“不确定”。</p>
        <div class="field">${label('bEvidence')}
          <textarea data-f="bEvidence" rows="4" placeholder="${esc(H.bEvidence.placeholder)}">${esc(p.bEvidence)}</textarea>
          <div style="margin-top:8px;display:flex;gap:10px;align-items:center">
            <span class="meta-line">把握程度</span>
            <span class="seg" id="conf">
              <button type="button" data-v="sure" class="${p.bEvidenceConfidence === 'sure' ? 'on' : ''}">有把握</button>
              <button type="button" data-v="unsure" class="${p.bEvidenceConfidence === 'unsure' ? 'on unsure' : ''}">不确定</button>
            </span>
            ${helpBtn('bEvidenceConfidence')}
          </div>
        </div>
        ${ta(p, 'bApply', 3)}
        ${ta(p, 'bCompare', 3)}
        ${ta(p, 'bProves', 3)}
        ${ta(p, 'bGap', 3)}
      </section>

      <section class="panel">
        <h2>C. 收尾</h2>
        <div class="field">${label('quotes')}
          <div id="quotes"></div>
          <button type="button" class="small" id="addQuote">＋ 加一条原话</button>
        </div>
        ${ta(p, 'summary', 2)}
      </section>
      <p style="text-align:center"><a href="#/list">← 回到列表</a></p>`;

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
      if (!p.quotes.length) { box.innerHTML = '<div class="meta-line" style="margin-bottom:8px">还没有。大多数时候应该转述，不是直接引用。</div>'; return; }
      box.innerHTML = p.quotes.map((q, i) => `
        <div class="quote-row">
          <input type="text" data-qi="${i}" data-k="text" placeholder="原话" value="${esc(q.text)}">
          <input type="text" data-qi="${i}" data-k="page" placeholder="页码（必填）" value="${esc(q.page)}">
          <button type="button" class="small danger" data-qdel="${i}">删除</button>
        </div>`).join('');
      box.querySelectorAll('[data-qi]').forEach((el) => {
        el.oninput = () => { p.quotes[+el.dataset.qi][el.dataset.k] = el.value; touch(); };
      });
      box.querySelectorAll('[data-qdel]').forEach((b) => {
        b.onclick = () => { p.quotes.splice(+b.dataset.qdel, 1); drawQuotes(); touch(); };
      });
    };
    drawQuotes();
    app.querySelector('#addQuote').onclick = () => { p.quotes.push({ text: '', page: '' }); drawQuotes(); touch(); };

    app.querySelector('#btnDoi').onclick = () => fetchDoi(p);
    app.querySelector('#btnDel').onclick = () => {
      if (!confirm('确定删除这篇文献和它的全部笔记？删除后不能恢复。')) return;
      D().papers = D().papers.filter((x) => x.id !== p.id); S.save();
      location.hash = '#/list';
    };

    // AI_EXTRACT_HOOK：以后如果要加“AI 抽取研究问题/方法作为初稿”，在这里加按钮。
    // 规则：只能填 A 部分，必须标“未核实”；B 部分（我的看法）永远不自动填。
  }

  function normDoi(s) {
    return String(s || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  }

  async function fetchDoi(p) {
    const doi = normDoi(p.doi);
    if (!doi) { toast('先填 DOI'); return; }
    const filled = ['title', 'authors', 'year', 'journal'].filter((k) => p[k]);
    if (filled.length && !confirm('标题/作者/年份/期刊已经有内容，用拉取到的信息覆盖吗？')) return;
    toast('正在拉取…');
    try {
      const res = await fetch('https://api.crossref.org/works/' + encodeURIComponent(doi));
      if (res.status === 404) { toast('找不到这个 DOI，检查一下有没有抄错'); return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const m = (await res.json()).message;
      p.doi = doi;
      p.title = (m.title || [])[0] || p.title;
      p.authors = (m.author || []).map((a) => [a.family, a.given ? a.given.split(/[\s.-]+/).filter(Boolean).map((x) => x[0]).join('') : ''].filter(Boolean).join(' ') || a.name).join('; ') || p.authors;
      const dp = (m.issued || m['published-print'] || m['published-online'] || {})['date-parts'];
      p.year = dp && dp[0] && dp[0][0] ? String(dp[0][0]) : p.year;
      p.journal = (m['container-title'] || [])[0] || m.publisher || p.journal;
      p.crossrefType = m.type || '';
      p.updatedAt = new Date().toISOString();
      S.save();
      renderCard(p.id);
      toast('已拉取。来源类型请你自己判断。');
    } catch (e) {
      toast('拉取失败（' + e.message + '），请检查网络，或手动填写');
    }
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
          <thead><tr><th style="width:28%">文献</th><th>7. 和其他文献比</th><th>9. 留下的空白</th></tr></thead>
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
      '1 它想搞清楚什么': p.aQuestion, '2 它怎么查的': p.aMethod, '3 它查到了什么': p.aFindings, '4 作者自认局限': p.aAuthorLimits,
      '5 我看到的局限': p.bEvidence, '把握程度': { sure: '有把握', unsure: '不确定' }[p.bEvidenceConfidence] || '',
      '6 能不能搬过来': p.bApply, '7 和其他文献比': p.bCompare, '8 帮我证明了什么': p.bProves, '9 留下的空白': p.bGap,
      '10 原话': (p.quotes || []).map((q) => `"${q.text}"（第${q.page || '?'}页）`).join('\n'), '11 一句话总结': p.summary,
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

  // ---------- 启动 ----------
  if (!location.hash) location.hash = D().questions.length ? '#/list' : '#/questions';
  route();
  updateBadge();
  startSync();
})();
