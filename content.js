/**
 * 译界 · content script
 * 划词气泡（Shadow DOM 隔离）+ 整页双语对照 + 懒加载 + 还原
 */
(() => {
  'use strict';
  if (window.__TRG_LOADED__) return;
  window.__TRG_LOADED__ = true;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'TEXTAREA', 'INPUT',
    'SELECT', 'OPTION', 'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT',
    'EMBED', 'HEAD', 'TITLE', 'META', 'LINK', 'BR', 'HR', 'IMG', 'TEMPLATE',
  ]);

  const state = {
    settings: null,
    units: [],
    textNodes: [],
    bilingual: true,
    running: false,
    done: 0,
    total: 0,
    pageActive: false,
    observer: null,
  };

  const send = (msg) => new Promise((res, rej) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        const err = chrome.runtime.lastError;
        if (err) return rej(new Error(err.message));
        if (!r) return rej(new Error('后台无响应'));
        if (r.ok === false) return rej(new Error(r.error || '翻译失败'));
        res(r);
      });
    } catch (e) { rej(e); }
  });

  /* ---------------- 语言判断 ---------------- */
  function ratio(lang, text) {
    if (!text) return 0;
    if (lang.startsWith('zh')) {
      const cjk = (text.match(/[\u4E00-\u9FFF]/g) || []).length;
      return cjk / text.length;
    }
    return 0;
  }

  function pageAlreadyTarget(targetLang) {
    const sample = (document.body && document.body.innerText || '').slice(0, 1500);
    if (targetLang.startsWith('zh')) return ratio('zh', sample) > 0.25;
    const htmlLang = (document.documentElement.lang || '').toLowerCase();
    if (htmlLang && htmlLang.startsWith(targetLang.split('-')[0])) return true;
    return false;
  }

  /* ---------------- 单元收集（块级容器粒度） ---------------- */
  function isBlock(el) {
    const d = getComputedStyle(el).display;
    return d === 'block' || d === 'list-item' || d === 'table-cell' || d === 'table-caption'
      || d === 'flex' || d === 'grid' || d === 'flow-root' || d === 'table' || d === 'table-row'
      || d === 'table-header-group' || d === 'table-footer-group';
  }

  const LETTER_RE = /[A-Za-z\u00C0-\u024F\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u0600-\u06FF]/;

  function meaningful(text) {
    const t = text.trim();
    if (t.length < 2 || t.length > 4000) return false;
    if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return false;
    if (!LETTER_RE.test(t)) return false;
    if (/^[\d\s\p{P}\p{S}]+$/u.test(t)) return false;
    return true;
  }

  function collectBlocks(root) {
    const units = [];
    const walk = (el) => {
      if (!el || !el.childNodes) return;
      if (el.nodeType !== 1) return;
      if (SKIP_TAGS.has(el.tagName)) return;
      if (el.hasAttribute('data-tr-done') || el.classList.contains('trg-block')) return;
      if (el.isContentEditable) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;

      let inlineText = '';
      const blocks = [];
      for (const child of el.childNodes) {
        if (child.nodeType === 3) {
          inlineText += child.nodeValue;
        } else if (child.nodeType === 1) {
          if (SKIP_TAGS.has(child.tagName) || child.classList.contains('trg-block')) continue;
          if (child.hasAttribute('data-tr-done')) continue;
          if (isBlock(child)) blocks.push(child);
          else inlineText += ' ' + (child.innerText || '');
        }
      }
      const text = inlineText.replace(/\s+/g, ' ').trim();
      if (meaningful(text)) units.push({ el, text });
      for (const b of blocks) walk(b);
    };
    walk(root);
    return units;
  }

  function collectTextNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || SKIP_TAGS.has(p.tagName) || p.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (p.closest('[data-tr-skip],.trg-block')) return NodeFilter.FILTER_REJECT;
        const t = node.nodeValue;
        if (!t || !meaningful(t)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  /* ---------------- 插入译文 ---------------- */
  function insertBlock(unit) {
    const div = document.createElement('span');
    div.className = 'trg-block';
    div.setAttribute('data-tr-block', '1');
    div.setAttribute('dir', 'auto');
    unit.el.appendChild(div);
    unit.el.setAttribute('data-tr-done', '1');
    return div;
  }

  /* ---------------- 整页翻译 ---------------- */
  function pageCtx() {
    return { title: (document.title || '').slice(0, 200), url: location.href.slice(0, 300) };
  }

  function ensurePill() {
    let pill = document.getElementById('trg-pill');
    if (pill) return pill;
    pill = document.createElement('div');
    pill.id = 'trg-pill';
    pill.innerHTML = '<i></i><span class="trg-pill-text">准备中…</span><button class="trg-pill-close" title="还原">×</button>';
    pill.querySelector('.trg-pill-close').addEventListener('click', () => stopPage(true));
    document.documentElement.appendChild(pill);
    return pill;
  }

  function setPill(text, busy = true) {
    const pill = ensurePill();
    pill.classList.toggle('trg-busy', busy);
    pill.querySelector('.trg-pill-text').textContent = text;
  }

  function removePill() {
    const pill = document.getElementById('trg-pill');
    if (pill) pill.remove();
  }

  async function translateUnits(units) {
    if (!units.length) return;
    const CHUNK = 30;
    for (let i = 0; i < units.length; i += CHUNK) {
      const slice = units.slice(i, i + CHUNK);
      let res;
      try {
        const r = await send({ type: 'translate', texts: slice.map((u) => u.text), ctx: pageCtx() });
        res = r.results || [];
      } catch (e) {
        setPill('出错：' + e.message, false);
        throw e;
      }
      slice.forEach((u, k) => {
        const t = res[k];
        if (!t || !t.trim()) return;
        const holder = insertBlock(u);
        holder.textContent = t;
        try {
          const cs = getComputedStyle(u.el);
          holder.style.fontSize = cs.fontSize;
          holder.style.lineHeight = cs.lineHeight;
        } catch (_) {}
        state.done++;
      });
      setPill(`${state.done}/${state.total}`, true);
    }
  }

  async function startPage() {
    if (state.pageActive) return;
    state.pageActive = true;
    state.settings = state.settings || (await send({ type: 'settings:get' })).settings;
    state.bilingual = state.settings.bilingual !== false;

    if (!state.bilingual) return startPageReplace();

    const units = collectBlocks(document.body);
    // 过滤掉已经在视口外、且永远用不到的（先全部收集，交给 observer 决定）
    state.units = units;
    state.total = units.length;
    state.done = 0;
    ensurePill();
    setPill(`发现 ${units.length} 段`);

    if (!units.length) { setPill('没有可翻译的内容', false); return; }

    // 懒加载：进入视口附近才翻
    const pending = new Set();
    let flushing = false;
    const flush = async () => {
      if (flushing) return;
      flushing = true;
      const batch = [...pending];
      pending.clear();
      try { await translateUnits(batch); } catch (_) { flushing = false; return; }
      flushing = false;
      if (pending.size) flush();
      else if (state.done >= state.total) setPill(`完成 ${state.total} 段`, false);
    };

    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const u = en.target.__trgUnit;
        io.unobserve(en.target);
        if (!u || u.el.hasAttribute('data-tr-done')) continue;
        pending.add(u);
      }
      clearTimeout(flush._t);
      flush._t = setTimeout(flush, 120);
    }, { rootMargin: '400px 0px' });

    for (const u of units) {
      u.el.__trgUnit = u;
      io.observe(u.el);
    }
    state.observer = io;

    // 首屏立即翻
    const first = units.filter((u) => {
      const r = u.el.getBoundingClientRect();
      return r.top < innerHeight * 1.2 && r.bottom > -200;
    }).slice(0, 40);
    first.forEach((u) => pending.add(u));
    flush();
  }

  async function startPageReplace() {
    const nodes = collectTextNodes(document.body);
    state.textNodes = nodes.map((n) => ({ node: n, orig: n.nodeValue }));
    state.total = nodes.length;
    state.done = 0;
    setPill(`发现 ${nodes.length} 段`);
    const CHUNK = 30;
    for (let i = 0; i < nodes.length; i += CHUNK) {
      const slice = nodes.slice(i, i + CHUNK);
      let res;
      try {
        res = (await send({ type: 'translate', texts: slice.map((n) => n.nodeValue), ctx: pageCtx() })).results || [];
      } catch (e) { setPill('出错：' + e.message, false); throw e; }
      slice.forEach((n, k) => {
        if (res[k] && res[k].trim()) { n.nodeValue = res[k]; state.done++; }
      });
      setPill(`${state.done}/${state.total}`, true);
    }
    setPill(`完成 ${state.total} 段`, false);
  }

  function stopPage(restore) {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    document.querySelectorAll('[data-tr-block]').forEach((n) => n.remove());
    document.querySelectorAll('[data-tr-done]').forEach((n) => n.removeAttribute('data-tr-done'));
    for (const rec of state.textNodes) {
      try { if (rec.node && rec.node.isConnected) rec.node.nodeValue = rec.orig; } catch (_) {}
    }
    state.textNodes = [];
    state.units = [];
    state.pageActive = false;
    state.done = 0;
    state.total = 0;
    removePill();
    if (restore) toast('已还原原文');
  }

  async function togglePage() {
    if (state.pageActive) return stopPage(true);
    try {
      await startPage();
    } catch (e) {
      state.pageActive = false;
      setPill('翻译失败：' + e.message, false);
      setTimeout(removePill, 4000);
    }
  }

  /* ---------------- 轻提示 ---------------- */
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

  /* ---------------- 划词气泡（Shadow DOM 隔离，免受页面 CSS 污染） ---------------- */
  const BUBBLE_CSS = `
  :host { all: initial; }
  .card {
    width: min(92vw, 420px);
    max-height: min(62vh, 460px);
    display: flex; flex-direction: column;
    background: #ffffff; color: #1a1a1c;
    border-radius: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.08);
    border: 1px solid rgba(0,0,0,.07);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif;
    overflow: hidden;
  }
  @media (prefers-color-scheme: dark) {
    .card { background: #232327; color: #ececf0; border-color: rgba(255,255,255,.09);
            box-shadow: 0 12px 40px rgba(0,0,0,.5); }
    .src { color: #9d9da8; border-color: rgba(255,255,255,.08); }
    .foot { border-color: rgba(255,255,255,.08); background: rgba(255,255,255,.03); }
    .btn { color: #c9c9d4; }
    .btn:hover { background: rgba(255,255,255,.08); }
  }
  .head {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 12px 7px; font-size: 11px; letter-spacing: .02em;
    color: #8a8a95; text-transform: uppercase;
  }
  .tag { padding: 2px 7px; border-radius: 999px; background: #eef1ff; color: #4a5cff; font-weight: 600; }
  @media (prefers-color-scheme: dark) { .tag { background: rgba(96,116,255,.16); color: #9aa8ff; } }
  .spacer { flex: 1; }
  .x { cursor: pointer; border: 0; background: transparent; font-size: 16px; line-height: 1;
       color: #8a8a95; padding: 2px 4px; border-radius: 6px; }
  .x:hover { background: rgba(127,127,127,.15); }
  .body { padding: 0 12px 10px; overflow: auto; }
  .src { color: #6b6b75; font-size: 12.5px; padding-bottom: 8px; margin-bottom: 8px;
         border-bottom: 1px dashed rgba(0,0,0,.12); white-space: pre-wrap; word-break: break-word;
         max-height: 5.2em; overflow: auto; }
  .dst { white-space: pre-wrap; word-break: break-word; font-size: 15px; }
  .dst.loading { color: #8a8a95; }
  .err { color: #d14343; font-size: 13px; }
  .foot { display: flex; gap: 2px; padding: 5px 6px; border-top: 1px solid rgba(0,0,0,.07);
          background: rgba(0,0,0,.015); }
  .btn { flex: 1; border: 0; background: transparent; color: #4a4a55; font-size: 12.5px;
         padding: 8px 4px; border-radius: 8px; cursor: pointer; font-family: inherit; }
  .btn:hover { background: rgba(0,0,0,.05); }
  .btn:active { transform: scale(.97); }
  `;

  let bubbleEl = null, bubbleHost = null, bubbleData = null;

  function ensureBubble() {
    if (bubbleHost) return bubbleHost;
    bubbleHost = document.createElement('div');
    bubbleHost.id = 'trg-bubble-host';
    bubbleHost.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
    const sr = bubbleHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = BUBBLE_CSS;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="head">
        <span class="tag">译界</span>
        <span class="dir"></span>
        <span class="spacer"></span>
        <button class="x" title="关闭">✕</button>
      </div>
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
    bubbleEl = card;

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
      navigator.clipboard.writeText(result).then(() => toast('已复制译文')).catch(() => toast('复制失败'));
    } else if (act === 'speak') {
      speak(result || bubbleData.source);
    } else if (act === 'swap') {
      retranslate();
    } else if (act === 'page') {
      hideBubble();
      togglePage();
    }
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
    const host = ensureBubble();
    const card = bubbleEl;
    // 先显示出来才能量尺寸
    card.style.visibility = 'hidden';
    host.style.width = '0'; host.style.height = '0';
    const w = Math.min(420, innerWidth * 0.92);
    const h = card.offsetHeight || 160;
    const gap = 10;
    let left = Math.max(8, Math.min(innerWidth - w - 8, rect.left));
    let top = rect.bottom + gap;
    if (top + h > innerHeight - 8) top = Math.max(8, rect.top - h - gap);
    host.style.left = left + 'px';
    host.style.top = top + 'px';
    card.style.visibility = 'visible';
  }

  function showBubble({ source, result, error, engine, tl, rect }) {
    ensureBubble();
    bubbleData = { source, result, error };
    bubbleEl.querySelector('.src').textContent = source || '';
    const dst = bubbleEl.querySelector('.dst');
    const dir = bubbleEl.querySelector('.dir');
    const s = state.settings || {};
    dir.textContent = (engine ? engine : '') + (tl ? ' · ' + tl : '');
    if (error) {
      dst.className = 'dst err';
      dst.textContent = '⚠ ' + error;
    } else {
      dst.className = 'dst';
      dst.textContent = result || '';
    }
    bubbleHost.style.display = 'block';
    const r = rect || currentSelectionRect();
    positionBubble(r);
    requestAnimationFrame(() => positionBubble(r));
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

  async function retranslate() {
    if (!bubbleData) return;
    const dst = bubbleEl.querySelector('.dst');
    const old = bubbleData.result;
    dst.className = 'dst loading';
    dst.textContent = '换引擎重译…';
    try {
      const r = await send({ type: 'translate', texts: [bubbleData.source], engine: nextEngine() });
      bubbleData.result = r.results[0];
      dst.className = 'dst';
      dst.textContent = r.results[0];
    } catch (e) {
      dst.className = 'dst err';
      dst.textContent = '⚠ ' + e.message;
      bubbleData.result = old;
    }
  }

  const ENGINE_ORDER = ['microsoft', 'google', 'deepseek', 'openai', 'deepl'];
  function nextEngine() {
    const cur = (state.settings && state.settings.engine) || 'microsoft';
    const i = ENGINE_ORDER.indexOf(cur);
    return ENGINE_ORDER[(i + 1) % ENGINE_ORDER.length];
  }

  /* ---------------- 划词触发 ---------------- */
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
    selTimer = setTimeout(async () => {
      const s = state.settings;
      if (!s || s.selectionMode === 'off') return;
      const text = selectionText();
      if (!text) return;
      const rect = currentSelectionRect();
      const cache = { source: text, result: '', engine: '', tl: s.targetLang, rect };
      showBubble({ ...cache, result: '', error: '' });
      bubbleEl.querySelector('.dst').textContent = '翻译中…';
      try {
        const r = await send({ type: 'translate', texts: [text] });
        if (!bubbleData || bubbleData.source !== text) return;
        showBubble({ source: text, result: r.results[0], engine: engineLabel(s.engine), tl: s.targetLang, rect });
      } catch (e) {
        if (!bubbleData || bubbleData.source !== text) return;
        showBubble({ source: text, error: e.message, engine: engineLabel(s.engine), tl: s.targetLang, rect });
      }
    }, 220);
  }

  function engineLabel(id) {
    return ({ microsoft: '微软', google: 'Google', deepl: 'DeepL', openai: 'OpenAI', deepseek: 'DeepSeek' })[id] || id;
  }

  document.addEventListener('pointerup', (e) => {
    if (bubbleHost && bubbleHost.contains(e.target)) return;
    scheduleSelection();
  }, true);

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      scheduleSelection();
    }
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (bubbleHost && e.composedPath && e.composedPath().includes(bubbleHost)) return;
    if (bubbleData) hideBubble();
  }, true);

  /* ---------------- 消息 ---------------- */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'page:state') {
      sendResponse({ ok: true, active: state.pageActive, done: state.done, total: state.total });
      return;
    }
    if (msg.type === 'toggle-page') togglePage();
    else if (msg.type === 'translate-selection') {
      const text = selectionText();
      if (text) {
        const rect = currentSelectionRect();
        showBubble({ source: text, result: '翻译中…', engine: '', tl: '', rect });
        send({ type: 'translate', texts: [text] })
          .then((r) => showBubble({ source: text, result: r.results[0], engine: engineLabel((state.settings || {}).engine), tl: (state.settings || {}).targetLang, rect }))
          .catch((e) => showBubble({ source: text, error: e.message, rect }));
      } else {
        toast('先选中一段文字');
      }
    } else if (msg.type === 'show-bubble-loading') {
      showBubble({ source: msg.text, result: '', engine: '' });
      bubbleEl.querySelector('.dst').textContent = '翻译中…';
    } else if (msg.type === 'show-bubble') {
      showBubble({ source: msg.source, result: msg.result, error: msg.error, engine: msg.engine, tl: msg.tl });
    } else if (msg.type === 'speak') {
      speak(msg.text);
    }
  });

  /* ---------------- 启动 ---------------- */
  (async () => {
    try {
      const r = await send({ type: 'settings:get' });
      state.settings = r.settings;
    } catch (_) { return; }
    const s = state.settings;
    if (s.autoTranslate && !pageAlreadyTarget(s.targetLang)) {
      setTimeout(() => { togglePage().catch(() => {}); }, 700);
    }
  })();
})();
