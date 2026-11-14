/*
 * 从 PDF 里找 DOI，再去 Crossref 拉取元数据。
 * PDF 只在浏览器里读取，不会上传到任何地方，也不会保存。
 * 不使用 AI：DOI 靠正则表达式找，找不到就用标题去 Crossref 搜候选。
 */
(function () {
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = document.querySelector('script[src*="pdf.min.js"]').src.replace('pdf.min.js', 'pdf.worker.min.js');
  }

  // DOI 格式：10.xxxx/后缀
  const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)/i;

  function cleanDoi(d) {
    d = String(d || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
    // 去掉粘在末尾的标点
    d = d.replace(/[.,;:\]}>'"]+$/, '');
    // 末尾不成对的右括号去掉
    while (d.endsWith(')') && (d.match(/\(/g) || []).length < (d.match(/\)/g) || []).length) d = d.slice(0, -1);
    return d;
  }

  function findDoi(text) {
    // 处理 “DOI: 10.” “doi.org/10.” 以及被换行拆开的情况
    const t = text.replace(/­/g, '').replace(/doi\s*:\s*/gi, 'doi:').replace(/(10\.\d{4,9})\s*\/\s*/g, '$1/');
    const m = t.match(DOI_RE);
    return m ? cleanDoi(m[1]) : '';
  }

  // 第一页里字号最大的那几行，通常是标题
  function biggestText(items) {
    const sized = items.filter((it) => it.str && it.str.trim()).map((it) => ({ s: it.str, h: Math.round(Math.abs(it.transform[3]) || it.height || 0) }));
    if (!sized.length) return '';
    const max = Math.max(...sized.map((x) => x.h));
    const title = sized.filter((x) => x.h >= max - 1).map((x) => x.s).join(' ').replace(/\s+/g, ' ').trim();
    return title.length >= 10 && title.length <= 300 ? title : '';
  }

  async function extract(file) {
    if (!window.pdfjsLib) throw new Error('PDF 组件没有加载成功');
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let doi = '';
    let titleGuess = '';
    let metaTitle = '';
    try {
      const meta = await pdf.getMetadata();
      const info = (meta && meta.info) || {};
      metaTitle = (info.Title || '').trim();
      const mdDoi = findDoi([info.Subject, info.Keywords, info['doi'], meta.metadata && meta.metadata.get && meta.metadata.get('dc:identifier')].filter(Boolean).join(' '));
      if (mdDoi) doi = mdDoi;
    } catch (e) {}
    const pages = Math.min(pdf.numPages, 2);
    for (let i = 1; i <= pages && !doi; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      if (i === 1) titleGuess = biggestText(tc.items);
      doi = findDoi(tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join(''));
    }
    if (!titleGuess) {
      const page = await pdf.getPage(1);
      titleGuess = biggestText((await page.getTextContent()).items);
    }
    // PDF 内部记录的标题经常是垃圾（文件名、about:blank、PII 编号），所以优先用第一页字号最大的文字
    const badMeta = !metaTitle || metaTitle.length < 10 || /^(microsoft word|untitled|document|about:|https?:|pii|doi|\d+)/i.test(metaTitle) || /\.(docx?|pdf|tex)$/i.test(metaTitle);
    const guess = titleGuess || (!badMeta ? metaTitle : '');
    try { pdf.destroy(); } catch (e) {}
    return { doi, titleGuess: guess, pdfName: file.name };
  }

  // ---------- Crossref ----------
  function toMeta(m) {
    const dp = (m.issued || m['published-print'] || m['published-online'] || {})['date-parts'];
    return {
      doi: m.DOI || '',
      title: (m.title || [])[0] || '',
      authors: (m.author || []).map((a) => [a.family, a.given ? a.given.split(/[\s.-]+/).filter(Boolean).map((x) => x[0]).join('') : ''].filter(Boolean).join(' ') || a.name).join('; '),
      year: dp && dp[0] && dp[0][0] ? String(dp[0][0]) : '',
      journal: (m['container-title'] || [])[0] || m.publisher || '',
      crossrefType: m.type || '',
    };
  }

  async function lookup(doi) {
    const res = await fetch('https://api.crossref.org/works/' + encodeURIComponent(cleanDoi(doi)));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Crossref HTTP ' + res.status);
    return toMeta((await res.json()).message);
  }

  async function search(title) {
    const url = 'https://api.crossref.org/works?rows=5&query.bibliographic=' + encodeURIComponent(title);
    const res = await fetch(url);
    if (!res.ok) throw new Error('Crossref HTTP ' + res.status);
    return ((await res.json()).message.items || []).map(toMeta);
  }

  window.PdfMeta = { extract, findDoi, cleanDoi };
  window.Crossref = { lookup, search };
})();
