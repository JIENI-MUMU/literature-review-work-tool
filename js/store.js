/*
 * 数据存储与自动同步
 *
 * 数据结构（整个对象存为一个 JSON）：
 * {
 *   version: 1,
 *   updatedAt: ISO 时间,
 *   questions: [{ id, text }],                 // 我现在关心的问题
 *   questionHistory: [{ date, questions: [...] }],  // 每次修改前的快照
 *   papers: [{
 *     id, createdAt, updatedAt,
 *     doi, title, titleZh, authors, year, journal, crossrefType,
 *     sourceType,             // 'peer' | 'official' | 'grey' | 'media' | 'other' | ''
 *     questionIds: [],        // 问题 id，或 'unsure'
 *     fullRead: false,
 *     aQuestion,                                   // 研究问题
 *     mType, mSubjects, mSample, mSource, mWhenWhere, mMeasure, aMethod(其他补充),  // 研究方法
 *     rResults,                                    // 研究结果（旧字段 aFindings 自动迁移到这里）
 *     dInterpret, dConclusion, aAuthorLimits,      // 讨论与结论
 *     bEvidence, bEvidenceConfidence ('sure' | 'unsure' | ''),
 *     bApply, bCompare, bProves, bGap,
 *     quotes: [{ text, page }],
 *     summary
 *   }],
 *   reviews: [{ id, date, paperCount, consistent, conflict, missing }],
 *   lastReviewReadCount: 0     // 上次复盘时“全文已读”的篇数
 * }
 *
 * 本地：localStorage 'litreview.v1'
 * 同步：GitHub 私有仓库里的 data.json（Contents API）
 * 同步设置：localStorage 'litreview.sync'  { owner, repo, token, sha, lastSyncedAt }
 */
(function () {
  const KEY = 'litreview.v1';
  const SYNC_KEY = 'litreview.sync';
  const FILE = 'data.json';

  function emptyData() {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      questions: [],
      questionHistory: [],
      papers: [],
      reviews: [],
      lastReviewReadCount: 0,
    };
  }

  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function safeDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function loadLocal() {
    const raw = safeGet(KEY);
    if (!raw) return emptyData();
    try { return normalize(JSON.parse(raw)); } catch (e) { return emptyData(); }
  }

  function normalize(d) {
    const base = emptyData();
    const out = Object.assign(base, d || {});
    out.papers = (out.papers || []).map((p) => {
      p = Object.assign({ quotes: [], questionIds: [] }, p);
      // 旧版“它查到了什么”迁移到“研究结果”
      if (p.aFindings && !p.rResults) { p.rResults = p.aFindings; p.aFindings = ''; }
      return p;
    });
    return out;
  }

  // ---------- 编码（中文安全的 base64） ----------
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(b64.replace(/\n/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ---------- 同步设置 ----------
  function getSync() {
    try { return JSON.parse(safeGet(SYNC_KEY) || 'null'); } catch (e) { return null; }
  }
  function setSync(s) { if (s) safeSet(SYNC_KEY, JSON.stringify(s)); else safeDel(SYNC_KEY); }

  async function gh(path, opts = {}) {
    const s = getSync();
    const headers = Object.assign({
      Authorization: `Bearer ${s.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }, opts.headers || {});
    const url = `https://api.github.com/repos/${s.owner}/${s.repo}/contents/${path}`;
    return fetch(url, Object.assign({ cache: 'no-store' }, opts, { headers }));
  }

  async function fetchRemote() {
    const res = await gh(FILE);
    if (res.status === 404) return { exists: false };
    if (res.status === 401 || res.status === 403) throw new Error('令牌无效或没有权限，请到“设置”检查令牌');
    if (!res.ok) throw new Error('读取远端失败：HTTP ' + res.status);
    const j = await res.json();
    return { exists: true, sha: j.sha, data: normalize(JSON.parse(b64decode(j.content))) };
  }

  async function pushRemote(data, sha) {
    const body = {
      message: '更新文献笔记 ' + new Date().toISOString(),
      content: b64encode(JSON.stringify(data, null, 2)),
    };
    if (sha) body.sha = sha;
    const res = await gh(FILE, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    if (res.status === 409 || res.status === 422) return { conflict: true };
    if (res.status === 401 || res.status === 403) throw new Error('令牌无效或没有权限，请到“设置”检查令牌');
    if (!res.ok) throw new Error('上传失败：HTTP ' + res.status);
    const j = await res.json();
    return { sha: j.content.sha };
  }

  // ---------- Store ----------
  const listeners = [];
  const store = {
    data: loadLocal(),
    syncStatus: 'off', // off | idle | syncing | error | conflict
    syncMessage: '',
    dirty: false,
    _timer: null,

    onChange(fn) { listeners.push(fn); },
    emit() { listeners.forEach((fn) => fn()); },

    save() {
      this.data.updatedAt = new Date().toISOString();
      safeSet(KEY, JSON.stringify(this.data));
      this.dirty = true;
      this.schedulePush();
    },

    replaceAll(data) {
      this.data = normalize(data);
      safeSet(KEY, JSON.stringify(this.data));
      this.replaced = true; // 通知界面整页重画
      this.emit();
    },

    getSync, setSync,

    setStatus(st, msg) { this.syncStatus = st; this.syncMessage = msg || ''; this.emit(); },

    schedulePush() {
      if (!getSync()) return;
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.push(), 2500);
    },

    async push() {
      const s = getSync();
      if (!s) return;
      this.setStatus('syncing', '正在上传…');
      try {
        const r = await pushRemote(this.data, s.sha);
        if (r.conflict) {
          // 远端被别的设备改过：拉下来比较
          const remote = await fetchRemote();
          this.pendingRemote = remote;
          this.setStatus('conflict', '另一台设备也修改过数据');
          return;
        }
        s.sha = r.sha; s.lastSyncedAt = new Date().toISOString(); setSync(s);
        this.dirty = false;
        this.setStatus('idle', '已同步 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
      } catch (e) {
        this.setStatus('error', e.message);
      }
    },

    async pull() {
      const s = getSync();
      if (!s) { this.setStatus('off'); return; }
      if (this.syncStatus === 'syncing') return;
      this.setStatus('syncing', '正在检查更新…');
      try {
        const remote = await fetchRemote();
        if (!remote.exists) {
          // 远端还没有数据：把本地上传上去
          s.sha = null; setSync(s);
          await this.push();
          return;
        }
        if (remote.sha === s.sha) {
          if (this.dirty) await this.push(); else this.setStatus('idle', '已同步 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
          return;
        }
        // 远端有新版本
        if (!this.dirty) {
          s.sha = remote.sha; s.lastSyncedAt = new Date().toISOString(); setSync(s);
          this.replaceAll(remote.data);
          this.setStatus('idle', '已拉取最新数据 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
        } else {
          this.pendingRemote = remote;
          this.setStatus('conflict', '另一台设备也修改过数据');
        }
      } catch (e) {
        this.setStatus('error', e.message);
      }
    },

    // 冲突时：choice = 'remote' 用远端覆盖本地；'local' 用本地覆盖远端
    async resolveConflict(choice) {
      const s = getSync();
      const remote = this.pendingRemote;
      if (!remote) return;
      if (choice === 'remote') {
        s.sha = remote.sha; setSync(s);
        this.dirty = false;
        this.replaceAll(remote.data);
        this.setStatus('idle', '已使用另一台设备的数据');
      } else {
        s.sha = remote.exists ? remote.sha : null; setSync(s);
        this.pendingRemote = null;
        await this.push();
      }
      this.pendingRemote = null;
    },

    async testSync(owner, repo, token) {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      });
      if (res.status === 404) throw new Error('找不到仓库，或令牌没有授权这个仓库');
      if (res.status === 401) throw new Error('令牌无效');
      if (!res.ok) throw new Error('连接失败：HTTP ' + res.status);
      const j = await res.json();
      if (!j.private) throw new Error('这个仓库是公开的！笔记不能放在公开仓库，请换成私有仓库');
      return true;
    },
  };

  window.Store = store;
})();
