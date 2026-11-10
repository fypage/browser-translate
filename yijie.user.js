// ==UserScript==
// @name         译界 · 划词与整页翻译
// @namespace    https://github.com/fypage/browser-translate
// @version      1.0.0
// @description  整页双语对照 + 划词即译。必应免费引擎国内直连，也支持 DeepSeek / OpenAI 兼容 / DeepL 自填 Key。
// @author       fypage
// @match        *://*/*
// @exclude      *://*.bing.com/*
// @exclude      *://*.google.com/search*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      cn.bing.com
// @connect      translate.googleapis.com
// @connect      api.deepseek.com
// @connect      api.openai.com
// @connect      api-free.deepl.com
// @connect      api.deepl.com
// @connect      *
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

/* eslint-disable no-multi-spaces */
(function () {
  'use strict';

  /* ================================================================
   * 0. 存储
   * ================================================================ */
  const KEY = 'yijie.settings.v1';
  const CACHE_KEY = 'yijie.cache.v1';
  const MAX_CACHE = 2000;

  const DEFAULTS = {
    engine: 'bing',
    targetLang: 'zh-CN',
    sourceLang: 'auto',
    bilingual: true,
    selectionMode: 'bubble',
    autoTranslate: false,
    concurrency: 3,
    glossary: '',
    button: true,
    deepl: { apiKey: '' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' },
  };

  function merge(base, patch) {
    const out = Object.assign({}, base);
    for (const k of Object.keys(patch || {})) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
        out[k] = merge(base[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  let CFG = null;
  function cfg() {
    if (CFG) return CFG;
    let saved = {};
    try { saved = JSON.parse(GM_getValue(KEY, '{}')) || {}; } catch (_) {}
    CFG = merge(DEFAULTS, saved);
    return CFG;
  }
  function saveCfg(patch) {
    CFG = merge(cfg(), patch);
    GM_setValue(KEY, JSON.stringify(CFG));
  }

  /* 缓存：内存 + GM 持久化 */
  let memCache = null;
  function cacheLoad() {
    if (memCache) return memCache;
    try { memCache = new Map(Object.entries(JSON.parse(GM_getValue(CACHE_KEY, '{}')) || {})); }
    catch (_) { memCache = new Map(); }
    return memCache;
  }
  function cacheGet(k) {
    const m = cacheLoad();
    const hit = m.get(k);
    if (hit) { hit.ts = Date.now(); return hit.t; }
    return null;
  }
  function cachePut(k, v) {
    const m = cacheLoad();
    m.set(k, { t: v, ts: Date.now() });
    if (m.size > MAX_CACHE) {
      const arr = [...m.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, MAX_CACHE);
      memCache = new Map(arr);
    }
  }
  let cacheTimer = null;
  function cacheFlush() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      try { GM_setValue(CACHE_KEY, JSON.stringify(Object.fromEntries(cacheLoad()))); } catch (_) {}
    }, 1500);
  }
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36) + '_' + s.length.toString(36);
  }

  /* ================================================================
   * 1. 网络：GM_xmlhttpRequest 包一层，绕开页面 CORS
   * ================================================================ */
  function request(url, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      const req = {
        method: opts.method || 'GET',
        url: url,
        headers: opts.headers || {},
        timeout: opts.timeout || 25000,
        onload(res) {
          const ok = res.status >= 200 && res.status < 300;
          resolve({
            ok,
            status: res.status,
            text: res.responseText || '',
            json() { try { return JSON.parse(res.responseText); } catch (e) { throw new Error('返回不是合法 JSON'); } },
            headers: res.responseHeaders || '',
          });
        },
        onerror() { reject(new Error('网络请求失败（检查 @connect 权限或网络）')); },
        ontimeout() { reject(new Error('请求超时')); },
      };
      if (opts.body != null) req.data = opts.body;
      if (opts.anonymous) req.anonymous = true;
      try { GM_xmlhttpRequest(req); } catch (e) { reject(e); }
    });
  }

  async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const n = Math.min(limit, items.length) || 1;
    await Promise.all(Array.from({ length: n }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
  }

  const MS_LANG = {
    'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr',
    de: 'de', es: 'es', ru: 'ru', pt: 'pt', it: 'it', ar: 'ar', th: 'th', vi: 'vi',
    id: 'id', tr: 'tr', nl: 'nl', pl: 'pl', hi: 'hi', uk: 'uk',
  };
  const DEEPL_LANG = {
    'zh-CN': 'ZH', 'zh-TW': 'ZH', en: 'EN-US', ja: 'JA', ko: 'KO', fr: 'FR', de: 'DE',
    es: 'ES', ru: 'RU', pt: 'PT-BR', it: 'IT', ar: 'AR', nl: 'NL', pl: 'PL', tr: 'TR', uk: 'UK',
  };

  /* ================================================================
   * 2. 引擎
   * ================================================================ */

  /* ---- 2.1 必应（免费，国内直连，底层已是 LLM） ---- */
  let bingSess = null;
  let bingJob = null;

  async function bingSession(force) {
    if (!force && bingSess && bingSess.exp > Date.now()) return bingSess;
    if (bingJob && !force) return bingJob;          // 并发抓会话会互相踢掉，必须共享
    bingJob = (async () => {
      const r = await request('https://cn.bing.com/translator', {
        headers: { 'accept-language': 'zh-CN,zh;q=0.9' },
        anonymous: true,
      });
      if (!r.ok) throw new Error('必应会话获取失败 HTTP ' + r.status);
      const html = r.text;
      const ig = (html.match(/IG:"([0-9A-Fa-f]+)"/) || [])[1];
      const iid = (html.match(/data-iid="([^"]+)"/) || [])[1];
      const abuse = (html.match(/params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/) || [])[1];
      if (!abuse) throw new Error('必应 token 解析失败（页面结构可能变了）');
      const parts = abuse.split(',');
      bingSess = {
        ig: ig || '',
        iid: iid || 'translator.5023',
        key: parts[0].trim(),
        token: parts[1].trim().replace(/^"|"$/g, ''),
        exp: Date.now() + 25 * 60 * 1000,
      };
      return bingSess;
    })().finally(() => { bingJob = null; });
    return bingJob;
  }

  async function bingOne(text, to, retry) {
    if (retry === undefined) retry = true;
    const s = await bingSession(false);
    const body = 'fromLang=auto-detect&to=' + encodeURIComponent(to)
      + '&text=' + encodeURIComponent(text)
      + '&key=' + encodeURIComponent(s.key)
      + '&token=' + encodeURIComponent(s.token);
    const url = 'https://cn.bing.com/ttranslatev3?isVertical=1&IG=' + encodeURIComponent(s.ig)
      + '&IID=' + encodeURIComponent(s.iid);
    const r = await request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: 'https://cn.bing.com/translator',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      body,
      anonymous: true,
    });
    if (!r.ok || r.text.trim()[0] !== '[') {
      if (retry) { bingSess = null; return bingOne(text, to, false); }
      throw new Error('必应返回异常 HTTP ' + r.status);
    }
    const j = r.json();
    if (!Array.isArray(j) || !j[0] || !j[0].translations) {
      if (retry) { bingSess = null; return bingOne(text, to, false); }
      throw new Error('必应返回结构异常');
    }
    return j[0].translations[0].text;
  }

  async function trBing(texts, opts) {
    const to = MS_LANG[opts.tl] || opts.tl;
    return pool(texts, Math.max(1, Math.min(5, cfg().concurrency || 3)), (t) => bingOne(t, to));
  }

  /* ---- 2.2 Google（需能访问 googleapis） ---- */
  async function googleOne(text, sl, tl) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
      + '&sl=' + encodeURIComponent(sl || 'auto') + '&tl=' + encodeURIComponent(tl);
    const r = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'q=' + encodeURIComponent(text),
    });
    if (!r.ok) throw new Error('Google HTTP ' + r.status);
    const d = r.json();
    if (!Array.isArray(d) || !Array.isArray(d[0])) throw new Error('Google 返回结构异常');
    return d[0].map((s) => (s && s[0]) || '').join('');
  }

  async function trGoogle(texts, opts) {
    return pool(texts, Math.max(1, Math.min(8, cfg().concurrency || 4)), (t) => googleOne(t, opts.sl, opts.tl));
  }

  /* ---- 2.3 DeepL ---- */
  async function trDeepl(texts, opts) {
    const conf = cfg().deepl || {};
    if (!conf.apiKey) throw new Error('未填写 DeepL API Key');
    const key = conf.apiKey.trim();
    const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const target = DEEPL_LANG[opts.tl] || String(opts.tl).toUpperCase();
    const src = opts.sl && opts.sl !== 'auto' ? (DEEPL_LANG[opts.sl] || String(opts.sl).toUpperCase()).split('-')[0] : null;
    const out = [];
    for (let i = 0; i < texts.length; i += 40) {
      const slice = texts.slice(i, i + 40);
      const payload = { text: slice, target_lang: target };
      if (src) payload.source_lang = src;
      const r = await request(host + '/v2/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'DeepL-Auth-Key ' + key },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error('DeepL HTTP ' + r.status + ' ' + r.text.slice(0, 120));
      const d = r.json();
      if (!d.translations || d.translations.length !== slice.length) throw new Error('DeepL 返回条数不符');
      d.translations.forEach((t) => out.push(t.text));
    }
    return out;
  }

  /* ---- 2.4 大模型（OpenAI 兼容 / DeepSeek） ---- */
  function buildSystemPrompt(opts) {
    const g = (cfg().glossary || '').trim();
    const p = [
      '你是专业翻译引擎，把用户给的 JSON 字符串数组逐条翻译成目标语言。',
      '目标语言：' + opts.tl + '。',
      '',
      '硬性要求：',
      '1. 只输出 {"t":["译文1","译文2",...]} 这一个 JSON 对象，条数与输入完全一致；不要解释、不要 Markdown 代码块。',
      '2. 原样保留：{name} %s ${var} 这类占位符、HTML/XML 标签、Markdown 标记、URL、代码片段、数字与单位。',
      '3. 产品名、公司名、人名优先保留原文；行业标准译名用通用译法。',
      '4. 译文要像母语者写的，不要逐字硬译；同一批内术语必须一致。',
      '5. 输入若已经是目标语言，原样返回，不要改写。',
      '6. 不要添加原文没有的信息，不要合并或拆分条目。',
    ];
    if (g) p.push('', '术语表（必须严格采用，格式 原文=译文）：', g);
    if (opts.ctx && opts.ctx.title) {
      p.push('', '页面上下文（仅用于判断领域与语气，不要翻译）：标题「' + opts.ctx.title + '」');
    }
    return p.join('\n');
  }

  async function llmBatch(texts, opts, conf) {
    const system = buildSystemPrompt(opts);
    const url = conf.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + conf.apiKey.trim() };

    const call = async (withFormat) => {
      const body = {
        model: conf.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(texts) },
        ],
      };
      if (withFormat) body.response_format = { type: 'json_object' };
      const r = await request(url, { method: 'POST', headers, body: JSON.stringify(body), timeout: 60000 });
      if (!r.ok) {
        const err = new Error('大模型接口 HTTP ' + r.status + ' ' + r.text.slice(0, 140));
        err.status = r.status;
        throw err;
      }
      return r.json();
    };

    let data;
    try { data = await call(true); }
    catch (e) {
      if (e.status === 400 || e.status === 422 || e.status === 404) data = await call(false);
      else throw e;
    }
    const txt = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!txt) throw new Error('大模型返回为空');
    let parsed;
    try {
      const m = txt.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : txt);
    } catch (_) { throw new Error('大模型返回不是合法 JSON'); }
    const arr = parsed.t || parsed.translations || parsed.result || [];
    if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('大模型返回条数不符');
    return arr.map((x) => String(x == null ? '' : x));
  }

  async function trLLM(texts, opts) {
    const id = opts.engine;
    const conf = id === 'deepseek' ? cfg().deepseek : cfg().openai;
    if (!conf.apiKey) throw new Error('未填写 API Key（菜单 → 设置）');
    const size = 10;
    const out = [];
    for (let i = 0; i < texts.length; i += size) {
      const slice = texts.slice(i, i + size);
      let got;
      try {
        got = await llmBatch(slice, opts, conf);
      } catch (e) {
        if (slice.length === 1) throw e;
        const half = Math.ceil(slice.length / 2);
        if (slice.length > 2) {
          const a = await pool([slice.slice(0, half), slice.slice(half)], 2, (p) => llmBatch(p, opts, conf));
          got = [...a[0], ...a[1]];
        } else {
          got = await pool(slice, 2, (t) => llmBatch([t], opts, conf).then((x) => x[0]));
        }
      }
      out.push(...got);
    }
    return out;
  }

  const ENGINES = {
    bing: { label: '必应', fn: trBing },
    google: { label: 'Google', fn: trGoogle },
    deepseek: { label: 'DeepSeek', fn: trLLM },
    openai: { label: 'OpenAI 兼容', fn: trLLM },
    deepl: { label: 'DeepL', fn: trDeepl },
  };

  /* ================================================================
   * 3. 翻译调度（去重 + 缓存 + 分批 + 失败降级）
   * ================================================================ */
  async function runEngine(texts, opts) {
    const eng = ENGINES[opts.engine];
    if (!eng) throw new Error('未知引擎：' + opts.engine);
    try {
      return await eng.fn(texts, opts);
    } catch (e) {
      if (opts.engine === 'bing') {
        try { return await ENGINES.google.fn(texts, opts); } catch (_) {}
      } else if (opts.engine === 'google') {
        try { return await ENGINES.bing.fn(texts, opts); } catch (_) {}
      }
      throw e;
    }
  }

  function splitBatches(texts) {
    const batches = [];
    let cur = [], chars = 0;
    texts.forEach((t, i) => {
      if (cur.length && (cur.length >= 60 || chars + t.length > 3000)) { batches.push(cur); cur = []; chars = 0; }
      cur.push(i); chars += t.length;
    });
    if (cur.length) batches.push(cur);
    return batches;
  }

  async function translate(texts, overrides) {
    const c = cfg();
    const o = overrides || {};
    const opts = {
      engine: o.engine || c.engine,
      sl: o.sl || c.sourceLang || 'auto',
      tl: o.tl || c.targetLang || 'zh-CN',
      ctx: o.ctx || null,
    };
    if (!Array.isArray(texts) || !texts.length) return [];

    const results = new Array(texts.length).fill(null);
    const pending = [];
    const seen = new Map();

    for (let i = 0; i < texts.length; i++) {
      const raw = texts[i] == null ? '' : String(texts[i]);
      if (!raw.trim()) { results[i] = raw; continue; }
      const k = hash(opts.engine + '|' + opts.sl + '|' + opts.tl + '|' + raw);
      const hit = cacheGet(k);
      if (hit != null) { results[i] = hit; continue; }
      if (seen.has(k)) { seen.get(k).push(i); continue; }
      seen.set(k, [i]);
      pending.push({ i, text: raw, key: k });
    }
    if (!pending.length) return results;

    for (const idxs of splitBatches(pending.map((p) => p.text))) {
      const slice = idxs.map((n) => pending[n]);
      let out;
      try {
        out = await runEngine(slice.map((p) => p.text), opts);
      } catch (e) {
        out = await pool(slice, 3, async (p) => {
          try { const a = await runEngine([p.text], opts); return a[0]; }
          catch (_) { return null; }
        });
        if (out.every((x) => x == null)) throw e;
      }
      slice.forEach((p, k) => {
        const val = out[k];
        if (val == null) return;
        results[p.i] = val;
        cachePut(p.key, val);
        (seen.get(p.key) || []).forEach((dup) => { if (dup !== p.i) results[dup] = val; });
      });
    }
    cacheFlush();
    return results;
  }

  /* ================================================================
   * 4. 整页双语对照
   * ================================================================ */
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO',
    'IFRAME', 'OBJECT', 'EMBED', 'HEAD', 'TITLE', 'META', 'LINK', 'BR', 'HR', 'IMG', 'TEMPLATE']);

  const LETTER_RE = /[A-Za-z\u00C0-\u024F\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u0600-\u06FF]/;

  function isBlock(el) {
    const d = getComputedStyle(el).display;
    return d === 'block' || d === 'list-item' || d === 'table-cell' || d === 'table-caption'
      || d === 'flex' || d === 'grid' || d === 'flow-root' || d === 'table' || d === 'table-row'
      || d === 'table-header-group' || d === 'table-footer-group';
  }

  function meaningful(t) {
    const s = t.trim();
    if (s.length < 2 || s.length > 4000) return false;
    if (/^(https?:\/\/|www\.)\S+$/i.test(s)) return false;
    if (!LETTER_RE.test(s)) return false;
    if (/^[\d\s\p{P}\p{S}]+$/u.test(s)) return false;
    return true;
  }

  function collectBlocks(root) {
    const units = [];
    (function walk(el) {
      if (!el || el.nodeType !== 1) return;
      if (SKIP_TAGS.has(el.tagName)) return;
      if (el.hasAttribute('data-tr-done') || el.classList.contains('trg-block')) return;
      if (el.isContentEditable) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;

      let inlineText = '';
      const blocks = [];
      for (const child of el.childNodes) {
        if (child.nodeType === 3) inlineText += child.nodeValue;
        else if (child.nodeType === 1) {
          if (SKIP_TAGS.has(child.tagName) || child.classList.contains('trg-block')) continue;
          if (child.hasAttribute('data-tr-done')) continue;
          if (isBlock(child)) blocks.push(child);
          else inlineText += ' ' + (child.innerText || '');
        }
      }
      const text = inlineText.replace(/\s+/g, ' ').trim();
      if (meaningful(text)) units.push({ el, text });
      for (const b of blocks) walk(b);
    })(root);
    return units;
  }

  function collectTextNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || SKIP_TAGS.has(p.tagName) || p.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (p.closest('[data-tr-skip],.trg-block')) return NodeFilter.FILTER_REJECT;
        if (!meaningful(node.nodeValue || '')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  const page = {
    active: false, done: 0, total: 0, observer: null, textNodes: [],
  };

  function pageCtx() { return { title: (document.title || '').slice(0, 200) }; }

  function ensurePill() {
    let pill = document.getElementById('trg-pill');
    if (pill) return pill;
    pill = document.createElement('div');
    pill.id = 'trg-pill';
    pill.innerHTML = '<i></i><span class="trg-pill-text">准备中…</span>'
      + '<button class="trg-pill-close" title="还原">×</button>';
    pill.querySelector('.trg-pill-close').addEventListener('click', () => stopPage(true));
    document.documentElement.appendChild(pill);
    return pill;
  }

  function setPill(text, busy) {
    const pill = ensurePill();
    pill.classList.toggle('trg-busy', busy !== false);
    pill.querySelector('.trg-pill-text').textContent = text;
  }

  function removePill() {
    const p = document.getElementById('trg-pill');
    if (p) p.remove();
  }

  async function translateUnits(units) {
    const CHUNK = 30;
    for (let i = 0; i < units.length; i += CHUNK) {
      const slice = units.slice(i, i + CHUNK);
      let res;
      try {
        res = (await translate(slice.map((u) => u.text), { ctx: pageCtx() })) || [];
      } catch (e) {
        setPill('出错：' + e.message, false);
        throw e;
      }
      slice.forEach((u, k) => {
        const t = res[k];
        if (!t || !String(t).trim()) return;
        const holder = document.createElement('span');
        holder.className = 'trg-block';
        holder.setAttribute('data-tr-block', '1');
        holder.setAttribute('dir', 'auto');
        holder.textContent = t;
        try {
          const cs = getComputedStyle(u.el);
          holder.style.fontSize = cs.fontSize;
          holder.style.lineHeight = cs.lineHeight;
        } catch (_) {}
        u.el.appendChild(holder);
        u.el.setAttribute('data-tr-done', '1');
        page.done++;
      });
      setPill(page.done + '/' + page.total);
    }
  }

  async function startPage() {
    if (page.active) return;
    page.active = true;

    if (cfg().bilingual === false) return startReplace();

    const units = collectBlocks(document.body);
    page.total = units.length;
    page.done = 0;
    ensurePill();
    setPill('发现 ' + units.length + ' 段');
    if (!units.length) { setPill('没有可翻译的内容', false); return; }

    const pending = new Set();
    let flushing = false;
    const flush = async () => {
      if (flushing) return;
      flushing = true;
      const batch = [...pending];
      pending.clear();
      try { await translateUnits(batch); }
      catch (_) { flushing = false; return; }
      flushing = false;
      if (pending.size) flush();
      else if (page.done >= page.total) setPill('完成 ' + page.total + ' 段', false);
    };

    const io = new IntersectionObserver((entries) => {
      let hit = false;
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const u = en.target.__yijieUnit;
        io.unobserve(en.target);
        if (!u || u.el.hasAttribute('data-tr-done')) continue;
        pending.add(u);
        hit = true;
      }
      if (hit) { clearTimeout(flush._t); flush._t = setTimeout(flush, 120); }
    }, { rootMargin: '400px 0px' });

    for (const u of units) { u.el.__yijieUnit = u; io.observe(u.el); }
    page.observer = io;

    const first = units.filter((u) => {
      const r = u.el.getBoundingClientRect();
      return r.top < innerHeight * 1.2 && r.bottom > -200;
    }).slice(0, 40);
    first.forEach((u) => pending.add(u));
    flush();
  }

  async function startReplace() {
    const nodes = collectTextNodes(document.body);
    page.textNodes = nodes.map((n) => ({ node: n, orig: n.nodeValue }));
    page.total = nodes.length;
    page.done = 0;
    setPill('发现 ' + nodes.length + ' 段');
    const CHUNK = 30;
    for (let i = 0; i < nodes.length; i += CHUNK) {
      const slice = nodes.slice(i, i + CHUNK);
      let res;
      try { res = (await translate(slice.map((n) => n.nodeValue), { ctx: pageCtx() })) || []; }
      catch (e) { setPill('出错：' + e.message, false); throw e; }
      slice.forEach((n, k) => {
        if (res[k] && String(res[k]).trim()) { n.nodeValue = res[k]; page.done++; }
      });
      setPill(page.done + '/' + page.total);
    }
    setPill('完成 ' + page.total + ' 段', false);
  }

  function stopPage(notify) {
    if (page.observer) { page.observer.disconnect(); page.observer = null; }
    document.querySelectorAll('[data-tr-block]').forEach((n) => n.remove());
    document.querySelectorAll('[data-tr-done]').forEach((n) => n.removeAttribute('data-tr-done'));
    for (const rec of page.textNodes) {
      try { if (rec.node && rec.node.isConnected) rec.node.nodeValue = rec.orig; } catch (_) {}
    }
    page.textNodes = [];
    page.active = false;
    page.done = 0;
    page.total = 0;
    removePill();
    if (notify) toast('已还原原文');
  }

  async function togglePage() {
    if (page.active) return stopPage(true);
    try { await startPage(); }
    catch (e) {
      page.active = false;
      setPill('翻译失败：' + e.message, false);
      setTimeout(removePill, 4000);
    }
  }

  /* ================================================================
   * 5. 页面内样式
   * ================================================================ */
  const PAGE_CSS = `
.trg-block{display:block!important;margin:.28em 0 .1em!important;padding:0 0 0 .6em!important;
  border-left:2px solid rgba(88,116,255,.42)!important;color:inherit;opacity:.93;
  font-family:inherit!important;font-style:normal!important;text-align:left!important;
  text-indent:0!important;letter-spacing:normal!important;white-space:pre-wrap;word-break:break-word;
  background:none!important;box-shadow:none!important;max-width:100%!important;position:static!important;
  float:none!important;transform:none!important;animation:trg-fade .22s ease-out}
@keyframes trg-fade{from{opacity:0;transform:translateY(-2px)}to{opacity:.93;transform:none}}
#trg-pill{position:fixed!important;right:16px!important;bottom:76px!important;z-index:2147483646!important;
  display:flex!important;align-items:center!important;gap:7px!important;padding:8px 10px!important;
  border-radius:999px!important;background:rgba(28,28,32,.93)!important;color:#f2f2f5!important;
  font:12px/1.2 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif!important;
  box-shadow:0 6px 22px rgba(0,0,0,.28)!important;user-select:none}
#trg-pill i{width:8px;height:8px;border-radius:50%;background:#6f7dff;flex:0 0 auto}
#trg-pill.trg-busy i{animation:trg-pulse 1s ease-in-out infinite}
@keyframes trg-pulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.15)}}
#trg-pill .trg-pill-close{border:0!important;background:rgba(255,255,255,.12)!important;color:#fff!important;
  width:18px;height:18px;border-radius:50%!important;line-height:1!important;font-size:13px!important;
  padding:0!important;margin:0!important;cursor:pointer;display:flex;align-items:center;justify-content:center}
#trg-toast{position:fixed!important;left:50%!important;bottom:90px!important;
  transform:translate(-50%,12px)!important;z-index:2147483647!important;padding:9px 16px!important;
  border-radius:10px!important;background:rgba(28,28,32,.94)!important;color:#fff!important;
  font:13px/1.3 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif!important;
  opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease}
#trg-toast.trg-show{opacity:1;transform:translate(-50%,0)!important}
`;

  /* 气泡 + 面板共用的设计语言 */
  const SHARED_CSS = `
:host{all:initial}
.card{background:#fff;color:#1a1a1c;border-radius:14px;overflow:hidden;
  box-shadow:0 14px 44px rgba(0,0,0,.24),0 2px 8px rgba(0,0,0,.1);border:1px solid rgba(0,0,0,.07);
  font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif}
@media(prefers-color-scheme:dark){
  .card{background:#232327;color:#ececf0;border-color:rgba(255,255,255,.1);box-shadow:0 14px 44px rgba(0,0,0,.55)}
  .src{color:#9d9da8;border-color:rgba(255,255,255,.1)!important}
  .foot{border-color:rgba(255,255,255,.08)!important;background:rgba(255,255,255,.03)!important}
  .btn{color:#c9c9d4!important}
  .head{color:#9d9da8!important}
  input,select,textarea{background:#1b1b1f!important;color:#ececf0!important;border-color:rgba(255,255,255,.12)!important}
}
.head{display:flex;align-items:center;gap:8px;padding:9px 12px 7px;font-size:11px;color:#8a8a95}
.tag{padding:2px 7px;border-radius:99px;background:#eef1ff;color:#4a5cff;font-weight:650}
@media(prefers-color-scheme:dark){.tag{background:rgba(96,116,255,.16);color:#9aa8ff}}
.spacer{flex:1}
.x{cursor:pointer;border:0;background:transparent;font-size:16px;line-height:1;color:#8a8a95;
  padding:2px 4px;border-radius:6px;font-family:inherit}
.body{padding:0 12px 10px;overflow:auto}
.src{color:#6b6b75;font-size:12.5px;padding-bottom:8px;margin-bottom:8px;
  border-bottom:1px dashed rgba(0,0,0,.12);white-space:pre-wrap;word-break:break-word;max-height:5.2em;overflow:auto}
.dst{white-space:pre-wrap;word-break:break-word;font-size:15px}
.dst.loading{color:#8a8a95}
.err{color:#d14343;font-size:13px}
.foot{display:flex;gap:2px;padding:5px 6px;border-top:1px solid rgba(0,0,0,.07);background:rgba(0,0,0,.015)}
.btn{flex:1;border:0;background:transparent;color:#4a4a55;font-size:12.5px;padding:8px 4px;
  border-radius:8px;cursor:pointer;font-family:inherit}
.btn:hover{background:rgba(127,127,127,.12)}
.btn:active{transform:scale(.97)}
.btn.on{color:#4a5cff;font-weight:650}
input,select,textarea{font-family:inherit;font-size:12.5px;background:#fff;color:#1a1a1c;
  border:1px solid rgba(0,0,0,.14);border-radius:8px;padding:7px 9px;outline:none;width:100%}
input:focus,select:focus,textarea:focus{border-color:#5b6cff}
.row{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.row label{flex:0 0 66px;font-size:12px;color:#8a8a95}
.row.wide{flex-direction:column;align-items:stretch;gap:5px}
.row.wide label{flex:none}
.primary{width:100%;border:0;border-radius:10px;cursor:pointer;color:#fff;font-size:13.5px;font-weight:600;
  font-family:inherit;padding:10px;background:linear-gradient(135deg,#5b6cff,#7b62ff)}
.primary:active{transform:scale(.99)}
.hint{font-size:11px;color:#8a8a95;line-height:1.4;margin:-3px 0 9px}
`;

  if (typeof GM_addStyle === 'function') GM_addStyle(PAGE_CSS);
  else {
    const st = document.createElement('style');
    st.textContent = PAGE_CSS;
    document.documentElement.appendChild(st);
  }

  let toastTimer = null;
  function toast(text) {
    let t = document.getElementById('trg-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'trg-toast';
      document.documentElement.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('trg-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('trg-show'), 1800);
  }

  /* ================================================================
   * 6. 划词气泡
   * ================================================================ */
  let bubbleHost = null, bubbleCard = null, bubbleData = null;

  function ensureBubble() {
    if (bubbleHost) return bubbleHost;
    bubbleHost = document.createElement('div');
    bubbleHost.id = 'yijie-bubble-host';
    bubbleHost.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;display:none';
    const sr = bubbleHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SHARED_CSS + `
.card{width:min(92vw,420px);max-height:min(62vh,460px);display:flex;flex-direction:column}
`;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="head"><span class="tag">译界</span><span class="dir"></span>
        <span class="spacer"></span><button class="x" title="关闭">✕</button></div>
      <div class="body">
        <div class="src"></div>
        <div class="dst loading">翻译中…</div>
      </div>
      <div class="foot">
        <button class="btn" data-act="copy">复制</button>
        <button class="btn" data-act="speak">朗读</button>
        <button class="btn" data-act="swap">换引擎</button>
        <button class="btn" data-act="page">整页</button>
      </div>`;
    sr.append(style, card);
    document.documentElement.appendChild(bubbleHost);
    bubbleCard = card;
    card.querySelector('.x').addEventListener('click', hideBubble);
    card.addEventListener('click', onBubbleAction);
    return bubbleHost;
  }

  function onBubbleAction(ev) {
    const btn = ev.target.closest('.btn');
    if (!btn || !bubbleData) return;
    const act = btn.dataset.act;
    const result = bubbleData.result || '';
    if (act === 'copy') {
      const done = () => toast('已复制译文');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(result).then(done).catch(() => fallbackCopy(result, done));
      } else fallbackCopy(result, done);
    } else if (act === 'speak') speak(result || bubbleData.source);
    else if (act === 'swap') retranslate();
    else if (act === 'page') { hideBubble(); togglePage(); }
  }

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    } catch (_) { toast('复制失败'); }
  }

  function speak(text) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = /[\u4E00-\u9FFF]/.test(text) ? 'zh-CN' : 'en-US';
      speechSynthesis.speak(u);
    } catch (_) { toast('当前浏览器不支持朗读'); }
  }

  function positionBubble(rect) {
    ensureBubble();
    const w = Math.min(420, innerWidth * 0.92);
    bubbleCard.style.visibility = 'hidden';
    const h = bubbleCard.offsetHeight || 160;
    const gap = 10;
    const left = Math.max(8, Math.min(innerWidth - w - 8, rect.left));
    let top = rect.bottom + gap;
    if (top + h > innerHeight - 8) top = Math.max(8, rect.top - h - gap);
    bubbleHost.style.left = left + 'px';
    bubbleHost.style.top = top + 'px';
    bubbleCard.style.visibility = 'visible';
  }

  function showBubble(data) {
    ensureBubble();
    bubbleData = data;
    bubbleHost.style.display = 'block';
    bubbleCard.querySelector('.dir').textContent = data.engineLabel || '';
    bubbleCard.querySelector('.src').textContent = data.source || '';
    const dst = bubbleCard.querySelector('.dst');
    if (data.error) { dst.className = 'dst err'; dst.textContent = '⚠ ' + data.error; }
    else if (data.loading) { dst.className = 'dst loading'; dst.textContent = '翻译中…'; }
    else { dst.className = 'dst'; dst.textContent = data.result || ''; }
    const rect = data.rect || currentSelectionRect();
    positionBubble(rect);
    requestAnimationFrame(() => positionBubble(rect));
  }

  function hideBubble() {
    if (bubbleHost) bubbleHost.style.display = 'none';
    bubbleData = null;
  }

  function currentSelectionRect() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return { left: 20, top: 20, bottom: 20 };
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      const rects = sel.getRangeAt(0).getClientRects();
      if (rects.length) return rects[rects.length - 1];
    }
    return r;
  }

  const ENGINE_ORDER = ['bing', 'google', 'deepseek', 'openai', 'deepl'];
  function engineLabel(id) { return (ENGINES[id] && ENGINES[id].label) || id; }

  async function retranslate() {
    if (!bubbleData) return;
    const cur = cfg().engine;
    const idx = ENGINE_ORDER.indexOf(cur);
    const next = ENGINE_ORDER[(idx + 1) % ENGINE_ORDER.length];
    const dst = bubbleCard.querySelector('.dst');
    dst.className = 'dst loading';
    dst.textContent = '换到 ' + engineLabel(next) + ' 重译…';
    try {
      const r = await translate([bubbleData.source], { engine: next });
      bubbleData.result = r[0];
      bubbleData.engineLabel = engineLabel(next) + ' · ' + cfg().targetLang;
      dst.className = 'dst';
      dst.textContent = r[0];
      bubbleCard.querySelector('.dir').textContent = bubbleData.engineLabel;
    } catch (e) {
      dst.className = 'dst err';
      dst.textContent = '⚠ ' + e.message;
    }
  }

  async function translateSelection(text, rect) {
    const c = cfg();
    showBubble({ source: text, loading: true, engineLabel: engineLabel(c.engine) + ' · ' + c.targetLang, rect });
    try {
      const r = await translate([text]);
      if (!bubbleData || bubbleData.source !== text) return;
      showBubble({ source: text, result: r[0], engineLabel: engineLabel(c.engine) + ' · ' + c.targetLang, rect });
    } catch (e) {
      if (!bubbleData || bubbleData.source !== text) return;
      showBubble({ source: text, error: e.message, engineLabel: engineLabel(c.engine), rect });
    }
  }

  function selectionText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    const t = sel.toString().trim();
    if (t.length < 1 || t.length > 5000) return '';
    return t;
  }

  let selTimer = null;
  function scheduleSelection() {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      if (cfg().selectionMode === 'off') return;
      const text = selectionText();
      if (!text) return;
      translateSelection(text, currentSelectionRect());
    }, 220);
  }

  /* ================================================================
   * 7. 悬浮按钮 + 菜单
   * ================================================================ */
  let fabHost = null;

  function ensureFab() {
    if (fabHost) return fabHost;
    fabHost = document.createElement('div');
    fabHost.id = 'yijie-fab-host';
    fabHost.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483645';
    const sr = fabHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SHARED_CSS + `
.wrap{position:relative}
.fab{width:38px;height:38px;border-radius:50%;border:0;cursor:pointer;
  background:linear-gradient(135deg,#5b6cff,#8f5bff);color:#fff;font-size:15px;font-weight:700;
  display:flex;align-items:center;justify-content:center;font-family:inherit;
  box-shadow:0 4px 16px rgba(90,108,255,.42);opacity:.92;transition:transform .15s,opacity .15s}
.fab:hover{opacity:1;transform:scale(1.06)}
.fab:active{transform:scale(.95)}
.menu{position:absolute;right:0;bottom:48px;min-width:150px;padding:5px;
  display:none;flex-direction:column;gap:1px}
.menu.show{display:flex}
.menu button{border:0;background:transparent;text-align:left;padding:9px 11px;border-radius:8px;
  font:13px/1.3 inherit;font-family:inherit;color:inherit;cursor:pointer;white-space:nowrap}
.menu button:hover{background:rgba(127,127,127,.14)}
.menu .sep{height:1px;background:rgba(127,127,127,.18);margin:3px 6px}
`;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <div class="card menu" id="menu">
        <button data-act="page">翻译此页 / 还原</button>
        <button data-act="setting">设置…</button>
        <div class="sep"></div>
        <button data-act="hide">隐藏悬浮球</button>
      </div>
      <button class="fab" id="fab" title="译界">译</button>`;
    sr.append(style, wrap);
    document.documentElement.appendChild(fabHost);

    const menu = wrap.querySelector('#menu');
    wrap.querySelector('#fab').addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('show');
    });
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      menu.classList.remove('show');
      const act = b.dataset.act;
      if (act === 'page') togglePage();
      else if (act === 'setting') openPanel();
      else if (act === 'hide') { saveCfg({ button: false }); fabHost.style.display = 'none'; toast('已隐藏，可在脚本菜单里重新打开'); }
    });
    document.addEventListener('click', () => menu.classList.remove('show'), true);
    return fabHost;
  }

  /* ================================================================
   * 8. 设置面板
   * ================================================================ */
  const LANGS = [
    ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'], ['ja', '日本語'],
    ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'],
    ['ru', 'Русский'], ['pt', 'Português'], ['it', 'Italiano'], ['ar', 'العربية'],
    ['th', 'ไทย'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'], ['tr', 'Türkçe'],
    ['nl', 'Nederlands'], ['pl', 'Polski'], ['hi', 'हिन्दी'], ['uk', 'Українська'],
  ];

  let panelHost = null;

  function openPanel() {
    if (panelHost) { panelHost.style.display = 'flex'; return; }
    const c = cfg();
    panelHost = document.createElement('div');
    panelHost.id = 'yijie-panel-host';
    panelHost.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;'
      + 'align-items:center;justify-content:center;background:rgba(0,0,0,.42)';
    const sr = panelHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SHARED_CSS + `
.card{width:min(94vw,400px);max-height:88vh;display:flex;flex-direction:column}
.body{padding:4px 14px 12px}
.title{font-size:15px;font-weight:650;padding:14px 14px 10px;display:flex;align-items:center;gap:8px}
.foot{padding:10px 14px;gap:8px}
`;
    const card = document.createElement('div');
    card.className = 'card';
    const langOpts = LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
    const engOpts = ENGINE_ORDER.map((k) => `<option value="${k}">${engineLabel(k)}</option>`).join('');
    card.innerHTML = `
      <div class="title"><span class="tag">译界</span>设置<span class="spacer"></span>
        <button class="x" id="close">✕</button></div>
      <div class="body">
        <div class="row"><label>引擎</label><select id="engine">${engOpts}</select></div>
        <div class="row"><label>目标语言</label><select id="tl">${langOpts}</select></div>
        <div class="row"><label>双语对照</label><input type="checkbox" id="bilingual" style="width:auto;flex:0 0 auto"></div>
        <div class="row"><label>划词即译</label><input type="checkbox" id="selmode" style="width:auto;flex:0 0 auto"></div>
        <div class="row"><label>自动翻译</label><input type="checkbox" id="auto" style="width:auto;flex:0 0 auto"></div>

        <div id="cfgBox" style="display:none">
          <div class="row"><label>API Key</label><input id="apiKey" type="password" autocomplete="off" placeholder="sk-…"></div>
          <div class="row" id="baseRow"><label>接口地址</label><input id="baseUrl" type="text" placeholder="https://api.example.com/v1"></div>
          <div class="row" id="modelRow"><label>模型</label><input id="model" type="text" placeholder="gpt-4o-mini"></div>
        </div>

        <div class="row wide"><label>术语表（每行 原文=译文，仅大模型生效）</label>
          <textarea id="glossary" rows="2" placeholder="token=令牌&#10;workspace=工作台"></textarea></div>
        <p class="hint" id="hint"></p>
      </div>
      <div class="foot" style="display:flex">
        <button class="btn" id="clear">清除缓存</button>
        <button class="btn" id="cancel">取消</button>
        <button class="btn on" id="save">保存</button>
      </div>`;
    sr.append(style, card);
    document.documentElement.appendChild(panelHost);

    const $ = (id) => card.querySelector('#' + id);
    $('#engine').value = c.engine;
    $('#tl').value = c.targetLang;
    $('#bilingual').checked = c.bilingual !== false;
    $('#selmode').checked = c.selectionMode !== 'off';
    $('#auto').checked = !!c.autoTranslate;
    $('#glossary').value = c.glossary || '';

    const syncCfgBox = () => {
      const id = $('#engine').value;
      const needs = id === 'deepseek' || id === 'openai' || id === 'deepl';
      $('#cfgBox').style.display = needs ? 'block' : 'none';
      if (!needs) { $('#hint').textContent = ''; return; }
      const conf = id === 'deepl' ? c.deepl : id === 'deepseek' ? c.deepseek : c.openai;
      $('#apiKey').value = conf.apiKey || '';
      $('#baseUrl').value = conf.baseUrl || '';
      $('#model').value = conf.model || '';
      $('#baseRow').style.display = id === 'deepl' ? 'none' : 'flex';
      $('#modelRow').style.display = id === 'deepl' ? 'none' : 'flex';
      $('#hint').textContent = conf.apiKey ? '' : (id === 'deepl' ? '免费 Key 以 :fx 结尾' : '未填 Key 时该引擎不可用');
    };
    syncCfgBox();
    $('#engine').addEventListener('change', syncCfgBox);

    $('#close').addEventListener('click', () => { panelHost.style.display = 'none'; });
    $('#cancel').addEventListener('click', () => { panelHost.style.display = 'none'; });
    panelHost.addEventListener('click', (e) => { if (e.target === panelHost) panelHost.style.display = 'none'; });

    $('#clear').addEventListener('click', () => {
      memCache = new Map();
      GM_setValue(CACHE_KEY, '{}');
      toast('缓存已清除');
    });

    $('#save').addEventListener('click', () => {
      const id = $('#engine').value;
      const patch = {
        engine: id,
        targetLang: $('#tl').value,
        bilingual: $('#bilingual').checked,
        selectionMode: $('#selmode').checked ? 'bubble' : 'off',
        autoTranslate: $('#auto').checked,
        glossary: $('#glossary').value,
      };
      if (id === 'deepl') {
        patch.deepl = { apiKey: $('#apiKey').value.trim() };
      } else if (id === 'openai' || id === 'deepseek') {
        patch[id] = {
          apiKey: $('#apiKey').value.trim(),
          baseUrl: $('#baseUrl').value.trim() || (id === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1'),
          model: $('#model').value.trim() || (id === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini'),
        };
      }
      saveCfg(patch);
      panelHost.style.display = 'none';
      toast('已保存');
    });
  }

  /* ================================================================
   * 9. 事件 + 启动
   * ================================================================ */
  function isTyping(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  document.addEventListener('pointerup', (e) => {
    const path = e.composedPath ? e.composedPath() : [];
    if (bubbleHost && path.includes(bubbleHost)) return;
    if (fabHost && path.includes(fabHost)) return;
    if (panelHost && path.includes(panelHost)) return;
    scheduleSelection();
  }, true);

  document.addEventListener('keyup', (e) => {
    if (['Shift', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) scheduleSelection();
  }, true);

  document.addEventListener('mousedown', (e) => {
    const path = e.composedPath ? e.composedPath() : [];
    if (bubbleHost && path.includes(bubbleHost)) return;
    if (bubbleData) hideBubble();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (isTyping(e.target)) return;
    const k = (e.key || '').toLowerCase();
    if (k === 't') { e.preventDefault(); togglePage(); }
    else if (k === 's') {
      e.preventDefault();
      const t = selectionText();
      if (t) translateSelection(t, currentSelectionRect());
      else toast('先选中一段文字');
    }
  }, true);

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('翻译整页 / 还原', () => togglePage());
    GM_registerMenuCommand('设置…', () => openPanel());
    GM_registerMenuCommand('显示悬浮球', () => { saveCfg({ button: true }); ensureFab().style.display = 'block'; });
    GM_registerMenuCommand('清除翻译缓存', () => { memCache = new Map(); GM_setValue(CACHE_KEY, '{}'); toast('缓存已清除'); });
  }

  function boot() {
    if (cfg().button !== false) ensureFab();
    if (cfg().autoTranslate) {
      const sample = (document.body && document.body.innerText || '').slice(0, 1200);
      const cjk = (sample.match(/[\u4E00-\u9FFF]/g) || []).length;
      const isZh = cjk / (sample.length || 1) > 0.25;
      const wantZh = String(cfg().targetLang).startsWith('zh');
      if (!(isZh && wantZh)) setTimeout(() => { togglePage().catch(() => {}); }, 700);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
