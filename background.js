/**
 * 译界 · background service worker
 * 职责：设置读写 / 翻译缓存 / 四套引擎适配 / 消息路由 / 右键菜单
 */

/* ------------------------------------------------------------------ */
/* 默认设置                                                            */
/* ------------------------------------------------------------------ */
const DEFAULTS = {
  engine: 'microsoft',
  targetLang: 'zh-CN',
  sourceLang: 'auto',
  bilingual: true,            // 双语对照插入；false = 文本节点替换
  autoTranslate: false,       // 打开页面自动翻译
  selectionMode: 'bubble',    // bubble = 选中即弹气泡；off = 只用快捷键/右键
  concurrency: 4,
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
  deepl: { apiKey: '' },
  glossary: '',               // 术语表：「原文=译文」每行一条，只对大模型引擎生效
  msToken: null,
};

/* ------------------------------------------------------------------ */
/* 语言                                                                */
/* ------------------------------------------------------------------ */
const LANGS = [
  ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'], ['ja', '日本語'],
  ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'],
  ['ru', 'Русский'], ['pt', 'Português'], ['it', 'Italiano'], ['ar', 'العربية'],
  ['th', 'ไทย'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'], ['tr', 'Türkçe'],
  ['nl', 'Nederlands'], ['pl', 'Polski'], ['hi', 'हिन्दी'], ['uk', 'Українська'],
];

const MS_LANG = {
  'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr',
  de: 'de', es: 'es', ru: 'ru', pt: 'pt', it: 'it', ar: 'ar', th: 'th', vi: 'vi',
  id: 'id', tr: 'tr', nl: 'nl', pl: 'pl', hi: 'hi', uk: 'uk',
};

const DEEPL_LANG = {
  'zh-CN': 'ZH', 'zh-TW': 'ZH', en: 'EN-US', ja: 'JA', ko: 'KO', fr: 'FR', de: 'DE',
  es: 'ES', ru: 'RU', pt: 'PT-BR', it: 'IT', ar: 'AR', nl: 'NL', pl: 'PL', tr: 'TR', uk: 'UK',
};

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let settingsCache = null;

async function getSettings() {
  if (settingsCache) return settingsCache;
  const got = await chrome.storage.local.get('settings');
  settingsCache = deepMerge(DEFAULTS, got.settings || {});
  return settingsCache;
}

async function setSettings(patch) {
  const cur = await getSettings();
  settingsCache = deepMerge(cur, patch);
  await chrome.storage.local.set({ settings: settingsCache });
  return settingsCache;
}

/* ------------------------------------------------------------------ */
/* 缓存：内存 + 落盘，LRU 上限 3000 条                                  */
/* ------------------------------------------------------------------ */
const MAX_CACHE = 3000;
let memCache = null;          // Map<hash, {t, ts}>
let cacheDirty = false;

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36) + '_' + str.length.toString(36);
}

async function loadCache() {
  if (memCache) return memCache;
  const got = await chrome.storage.local.get('cache.v1');
  memCache = new Map(Object.entries(got['cache.v1'] || {}));
  return memCache;
}

async function flushCache() {
  if (!memCache || !cacheDirty) return;
  const arr = [...memCache.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, MAX_CACHE);
  memCache = new Map(arr);
  await chrome.storage.local.set({ 'cache.v1': Object.fromEntries(memCache) });
  cacheDirty = false;
}

async function cacheGet(key) {
  const m = await loadCache();
  const hit = m.get(key);
  if (hit) { hit.ts = Date.now(); cacheDirty = true; return hit.t; }
  return null;
}

async function cachePut(key, val) {
  const m = await loadCache();
  m.set(key, { t: val, ts: Date.now() });
  cacheDirty = true;
  if (m.size > MAX_CACHE + 200) await flushCache();
}

/* ------------------------------------------------------------------ */
/* 并发池                                                              */
/* ------------------------------------------------------------------ */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function needKey(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* 引擎 1：必应翻译（cn.bing.com 网页接口）                             */
/* 说明：原来的 edge.microsoft.com/translate/auth 已返回 404，改用国内   */
/* 直连的 bing 翻译后端。返回里带 usedLLM 标记——微软这条链路本身就是   */
/* 大模型在翻，不是传统 SMT。                                           */
/* ------------------------------------------------------------------ */
let bingSess = null;
let bingSessJob = null;   // 会话获取互斥：并发抓取会互相踢掉，必须共享同一个 Promise

async function bingSession(force) {
  const now = Date.now();
  if (!force && bingSess && bingSess.exp > now) return bingSess;
  if (bingSessJob && !force) return bingSessJob;
  bingSessJob = (async () => {
    const r = await fetch('https://cn.bing.com/translator', {
      headers: { 'accept-language': 'zh-CN,zh;q=0.9' },
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!r.ok) throw new Error('必应会话获取失败 HTTP ' + r.status);
    const html = await r.text();
    const ig = (html.match(/IG:"([0-9A-Fa-f]+)"/) || [])[1];
    const iid = (html.match(/data-iid="([^"]+)"/) || [])[1];
    const abuse = (html.match(/params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/) || [])[1];
    if (!abuse) throw new Error('必应 token 解析失败（页面结构可能变了）');
    const [key, tok] = abuse.split(',');
    bingSess = {
      ig: ig || '',
      iid: iid || 'translator.5023',
      key: key.trim(),
      token: tok.trim().replace(/^"|"$/g, ''),
      exp: Date.now() + 25 * 60_000,
    };
    return bingSess;
  })().finally(() => { bingSessJob = null; });
  return bingSessJob;
}

async function bingOne(text, to, retry = true) {
  const s = await bingSession(false);
  const url = `https://cn.bing.com/ttranslatev3?isVertical=1&IG=${s.ig}&IID=${encodeURIComponent(s.iid)}`;
  const body = new URLSearchParams({
    fromLang: 'auto-detect',
    to,
    text,
    key: s.key,
    token: s.token,
  });
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://cn.bing.com/translator',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
    body,
    credentials: 'omit',
  });
  const raw = await r.text();
  const expired = !r.ok || !/^\s*\[/.test(raw);
  if (expired) {
    if (retry) { bingSess = null; return bingOne(text, to, false); }
    throw new Error('必应返回异常 HTTP ' + r.status + ' ' + raw.slice(0, 80));
  }
  let j;
  try { j = JSON.parse(raw); } catch (_) { throw new Error('必应返回非 JSON'); }
  if (!Array.isArray(j) || !j[0] || !j[0].translations || !j[0].translations[0]) {
    if (retry) { bingSess = null; return bingOne(text, to, false); }
    throw new Error('必应返回结构异常');
  }
  return j[0].translations[0].text;
}

async function trMicrosoft(texts, opts) {
  const to = MS_LANG[opts.tl] || opts.tl;
  const s = await getSettings();
  const limit = Math.max(1, Math.min(5, s.concurrency || 3));
  return pool(texts, limit, (t) => bingOne(t, to));
}

/* ------------------------------------------------------------------ */
/* 引擎 2：Google 免费 gtx 接口（无批量，走并发池）                      */
/* ------------------------------------------------------------------ */
async function googleOne(text, sl, tl) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
    + `&sl=${encodeURIComponent(sl || 'auto')}&tl=${encodeURIComponent(tl)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'q=' + encodeURIComponent(text),
  });
  if (!r.ok) throw new Error('Google HTTP ' + r.status);
  const data = await r.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Google 返回结构异常');
  return data[0].map((seg) => (seg && seg[0]) || '').join('');
}

async function trGoogle(texts, opts) {
  const s = await getSettings();
  const limit = Math.max(1, Math.min(8, s.concurrency || 4));
  return pool(texts, limit, (t) => googleOne(t, opts.sl, opts.tl));
}

/* ------------------------------------------------------------------ */
/* 引擎 3：DeepL                                                        */
/* ------------------------------------------------------------------ */
async function trDeepl(texts, { sl, tl }) {
  const s = await getSettings();
  needKey(s.deepl.apiKey, '未填写 DeepL API Key（设置页可填）');
  const key = s.deepl.apiKey.trim();
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const target = DEEPL_LANG[tl] || String(tl).toUpperCase();
  const src = sl && sl !== 'auto' ? (DEEPL_LANG[sl] || String(sl).toUpperCase()).split('-')[0] : undefined;
  const out = [];
  for (let i = 0; i < texts.length; i += 40) {
    const slice = texts.slice(i, i + 40);
    const r = await fetch(host + '/v2/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'DeepL-Auth-Key ' + key },
      body: JSON.stringify({ text: slice, target_lang: target, ...(src ? { source_lang: src } : {}) }),
    });
    if (!r.ok) throw new Error('DeepL HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
    const data = await r.json();
    if (!data.translations || data.translations.length !== slice.length) throw new Error('DeepL 返回条数不符');
    for (const t of data.translations) out.push(t.text);
  }
  return out;
}

/* 引擎 4：OpenAI 兼容 / 大模型（按批提交，要求回 JSON 数组）             */
/* 这条链路是「质量上限」路线：支持上下文注入 + 术语表，翻译腔明显更轻。 */
/* ------------------------------------------------------------------ */
function buildSystemPrompt(opts, glossary) {
  const parts = [
    '你是专业翻译引擎，把用户给的 JSON 字符串数组逐条翻译成目标语言。',
    `目标语言：${opts.tl}。`,
    '',
    '硬性要求：',
    '1. 只输出 {"t":["译文1","译文2",...]} 这一个 JSON 对象，条数与输入完全一致；不要解释、不要 Markdown 代码块。',
    '2. 原样保留：{name} %s ${var} 这类占位符、HTML/XML 标签、Markdown 标记、URL、代码片段、数字与单位。',
    '3. 产品名、公司名、人名优先保留原文；行业标准译名用通用译法。',
    '4. 译文要像母语者写的，不要逐字硬译；同一批内术语必须一致。',
    '5. 输入若已经是目标语言，原样返回，不要改写。',
    '6. 不要添加原文没有的信息，不要合并或拆分条目。',
  ];
  if (glossary && glossary.trim()) {
    parts.push('', '术语表（必须严格采用，格式 原文=译文）：', glossary.trim());
  }
  if (opts.ctx && opts.ctx.title) {
    parts.push('', `页面上下文（仅用于判断领域与语气，不要翻译）：标题「${opts.ctx.title}」${opts.ctx.url ? '，地址 ' + opts.ctx.url : ''}`);
  }
  return parts.join('\n');
}

async function llmBatch(texts, opts, conf) {
  const s = await getSettings();
  const system = buildSystemPrompt(opts, s.glossary);
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
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) {
      const t = await r.text();
      const e = new Error('大模型接口 HTTP ' + r.status + ' ' + t.slice(0, 160));
      e.status = r.status;
      throw e;
    }
    return r.json();
  };

  let data;
  try {
    data = await call(true);
  } catch (e) {
    // 部分兼容接口 / Ollama 不认 response_format，去掉参数重试一次
    if (e.status === 400 || e.status === 422 || e.status === 404) data = await call(false);
    else throw e;
  }
  const txt = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!txt) throw new Error('大模型返回为空');
  let parsed;
  try {
    const m = txt.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : txt);
  } catch (_) {
    throw new Error('大模型返回不是合法 JSON');
  }
  const arr = parsed.t || parsed.translations || parsed.result || [];
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('大模型返回条数不符');
  return arr.map((x) => String(x == null ? '' : x));
}

async function trLLM(texts, opts) {
  const s = await getSettings();
  const conf = opts.engine === 'deepseek' ? s.deepseek : s.openai;
  needKey(conf.apiKey, '未填写 API Key（设置页可填）');
  needKey(conf.baseUrl, '未填写接口地址');
  const size = 10;
  const out = [];
  for (let i = 0; i < texts.length; i += size) {
    const slice = texts.slice(i, i + size);
    let got;
    try {
      got = await llmBatch(slice, opts, conf);
    } catch (e) {
      if (slice.length === 1) throw e;
      // 整批失败（多半是模型没按格式回）→ 拆小重试，单条再失败就抛原文
      const half = Math.ceil(slice.length / 2);
      if (slice.length > 2) {
        const a = await pool([slice.slice(0, half), slice.slice(half)], 2, (part) => llmBatch(part, opts, conf));
        got = [...a[0], ...a[1]];
      } else {
        got = await pool(slice, 2, (t) => llmBatch([t], opts, conf).then((x) => x[0]));
      }
    }
    out.push(...got);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 引擎注册表                                                          */
/* ------------------------------------------------------------------ */
const ENGINES = {
  microsoft: { label: '微软 Edge', free: true, fn: trMicrosoft },
  google: { label: 'Google', free: true, fn: trGoogle },
  deepl: { label: 'DeepL', free: false, fn: trDeepl },
  openai: { label: 'OpenAI 兼容', free: false, fn: trLLM },
  deepseek: { label: 'DeepSeek', free: false, fn: trLLM },
};

/* ------------------------------------------------------------------ */
/* 翻译主入口：去重 → 查缓存 → 引擎（分批 + 失败降级）→ 回填            */
/* ------------------------------------------------------------------ */
const BATCH_CHARS = 3000;   // 单批字符上限
const BATCH_ITEMS = 60;     // 单批条数上限

function splitBatches(texts) {
  const batches = [];
  let cur = [], chars = 0;
  texts.forEach((t, i) => {
    if (cur.length && (cur.length >= BATCH_ITEMS || chars + t.length > BATCH_CHARS)) {
      batches.push(cur); cur = []; chars = 0;
    }
    cur.push(i); chars += t.length;
  });
  if (cur.length) batches.push(cur);
  return batches;
}

async function runEngine(texts, opts) {
  const name = opts.engine;
  const eng = ENGINES[name];
  if (!eng) throw new Error('未知引擎：' + name);
  try {
    return await eng.fn(texts, opts);
  } catch (e) {
    // 免费引擎互相兜底：微软挂了退 Google，反之亦然
    const err = e;
    if (opts.engine === 'microsoft') {
      try { return await ENGINES.google.fn(texts, opts); } catch (_) {}
    } else if (opts.engine === 'google') {
      try { return await ENGINES.microsoft.fn(texts, opts); } catch (_) {}
    }
    throw err;
  }
}

async function translate(texts, overrides) {
  const s = await getSettings();
  const opts = {
    engine: overrides.engine || s.engine,
    sl: overrides.sl || s.sourceLang || 'auto',
    tl: overrides.tl || s.targetLang || 'zh-CN',
    ctx: overrides.ctx || null,
  };
  if (!Array.isArray(texts) || !texts.length) return [];

  const results = new Array(texts.length).fill(null);
  const pending = [];       // {i, text, key}
  const seen = new Map();   // key -> [i...] 同一页重复文本只请求一次

  for (let i = 0; i < texts.length; i++) {
    const raw = String(texts[i] == null ? '' : texts[i]);
    const text = raw.trim() ? raw : '';
    if (!text.trim()) { results[i] = raw; continue; }
    const key = hash(`${opts.engine}|${opts.sl}|${opts.tl}|${text}`);
    const cached = await cacheGet(key);
    if (cached != null) { results[i] = cached; continue; }
    if (seen.has(key)) { seen.get(key).push(i); continue; }
    seen.set(key, [i]);
    pending.push({ i, text, key });
  }

  if (!pending.length) return results;

  for (const idxs of splitBatches(pending.map((p) => p.text))) {
    const slice = idxs.map((n) => pending[n]);
    let out;
    try {
      out = await runEngine(slice.map((p) => p.text), opts);
    } catch (e) {
      // 整批失败 → 逐条重试，单条失败留空而不炸掉整页
      out = await pool(slice, 3, async (p) => {
        try { const a = await runEngine([p.text], opts); return a[0]; }
        catch (_) { return null; }
      });
      if (out.every((x) => x == null)) throw e;
    }
    for (let k = 0; k < slice.length; k++) {
      const p = slice[k];
      const val = out[k];
      if (val == null) { results[p.i] = null; continue; }
      results[p.i] = val;
      await cachePut(p.key, val);
      for (const dup of seen.get(p.key) || []) if (dup !== p.i) results[dup] = val;
    }
  }
  flushCache().catch(() => {});
  return results;
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */
async function handle(msg, sender) {
  switch (msg.type) {
    case 'translate': {
      const results = await translate(msg.texts || [], msg);
      return { ok: true, results };
    }
    case 'settings:get':
      return { ok: true, settings: await getSettings(), langs: LANGS, engines: Object.keys(ENGINES).map((k) => ({ id: k, label: ENGINES[k].label, free: ENGINES[k].free })) };
    case 'settings:set':
      return { ok: true, settings: await setSettings(msg.patch || {}) };
    case 'cache:clear': {
      memCache = new Map();
      await chrome.storage.local.remove('cache.v1');
      return { ok: true };
    }
    case 'cache:stats': {
      const m = await loadCache();
      return { ok: true, count: m.size };
    }
    case 'bg:selection-result': {
      if (sender.tab && sender.tab.id != null) {
        chrome.tabs.sendMessage(sender.tab.id, { type: 'show-bubble', ...msg.payload }).catch(() => {});
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: 'unknown message: ' + msg.type };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

/* ------------------------------------------------------------------ */
/* 右键菜单                                                            */
/* ------------------------------------------------------------------ */
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'tr-selection', title: '翻译“%s”', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'tr-page', title: '整页翻译 / 还原', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'tr-read', title: '朗读选中文本', contexts: ['selection'] });
  });
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === 'tr-page') {
    chrome.tabs.sendMessage(tab.id, { type: 'toggle-page' }).catch(() => {});
    return;
  }
  if (!info.selectionText) return;
  if (info.menuItemId === 'tr-read') {
    chrome.tabs.sendMessage(tab.id, { type: 'speak', text: info.selectionText }).catch(() => {});
    return;
  }
  const s = await getSettings();
  chrome.tabs.sendMessage(tab.id, { type: 'show-bubble-loading', text: info.selectionText }).catch(() => {});
  try {
    const [out] = await translate([info.selectionText], {});
    chrome.tabs.sendMessage(tab.id, {
      type: 'show-bubble',
      source: info.selectionText,
      result: out,
      engine: ENGINES[s.engine] && ENGINES[s.engine].label,
      tl: s.targetLang,
    }).catch(() => {});
  } catch (e) {
    chrome.tabs.sendMessage(tab.id, { type: 'show-bubble', source: info.selectionText, error: String(e.message || e) }).catch(() => {});
  }
});

/* ------------------------------------------------------------------ */
/* 快捷键                                                              */
/* ------------------------------------------------------------------ */
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd === 'toggle-page-translate' && tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'toggle-page' }).catch(() => {});
  } else if (cmd === 'translate-selection' && tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'translate-selection' }).catch(() => {});
  }
});
