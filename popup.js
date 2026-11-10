/* 译界 · popup */

const $ = (id) => document.getElementById(id);

const ENGINE_LABELS = {
  microsoft: '微软',
  google: 'Google',
  deepl: 'DeepL',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
};

const ENGINE_HINT = {
  microsoft: '免费，无需 Key，支持批量，速度最快。',
  google: '免费，无需 Key，逐段并发请求，长页面略慢。',
  deepl: '质量高，需自备 DeepL API Key（免费版也行）。',
  openai: '任意 OpenAI 兼容接口：官方 / 中转 / 本地 Ollama 均可。',
  deepseek: '大模型翻译，性价比高，需 API Key。',
};

let settings = null;

function send(msg) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage(msg, (r) => {
      const err = chrome.runtime.lastError;
      if (err) return rej(new Error(err.message));
      if (!r) return rej(new Error('无响应'));
      if (r.ok === false) return rej(new Error(r.error));
      res(r);
    });
  });
}

/* ---------- 渲染 ---------- */
function renderEngines(engines) {
  const seg = $('engineSeg');
  seg.innerHTML = '';
  engines.forEach((e) => {
    const b = document.createElement('button');
    b.textContent = ENGINE_LABELS[e.id] || e.label;
    b.dataset.id = e.id;
    b.className = settings.engine === e.id ? 'on' : '';
    b.addEventListener('click', () => {
      settings.engine = e.id;
      save({ engine: e.id });
      [...seg.children].forEach((c) => c.classList.toggle('on', c.dataset.id === e.id));
      renderCfg();
    });
    seg.appendChild(b);
  });
}

function renderLangs(langs) {
  const t = $('targetLang');
  const s = $('sourceLang');
  t.innerHTML = '';
  s.innerHTML = '<option value="auto">自动检测</option>';
  langs.forEach(([code, name]) => {
    t.insertAdjacentHTML('beforeend', `<option value="${code}">${name}</option>`);
    s.insertAdjacentHTML('beforeend', `<option value="${code}">${name}</option>`);
  });
  t.value = settings.targetLang;
  s.value = settings.sourceLang;
}

function renderCfg() {
  const id = settings.engine;
  const box = $('cfgBox');
  const needKey = id === 'deepl' || id === 'openai' || id === 'deepseek';
  box.classList.toggle('hidden', !needKey);
  $('engineHint').textContent = ENGINE_HINT[id] || '';
  if (!needKey) return;

  const conf = id === 'deepl' ? settings.deepl : id === 'deepseek' ? settings.deepseek : settings.openai;
  $('apiKey').value = conf.apiKey || '';
  $('baseUrlField').style.display = id === 'deepl' ? 'none' : 'flex';
  $('modelField').style.display = id === 'deepl' ? 'none' : 'flex';
  $('baseUrl').value = conf.baseUrl || '';
  $('glossary').value = settings.glossary || '';
  $('model').value = conf.model || '';
  $('keyHint').textContent = conf.apiKey ? '' : (id === 'deepl' ? '免费 Key 以 :fx 结尾' : '未填 Key 时该引擎不可用');
}

function renderSwitches() {
  $('bilingual').checked = settings.bilingual !== false;
  $('selectionMode').checked = settings.selectionMode !== 'off';
  $('autoTranslate').checked = !!settings.autoTranslate;
}

/* ---------- 保存 ---------- */
let saveTimer = null;
function save(patch) {
  settings = { ...settings, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { send({ type: 'settings:set', patch }).catch(() => {}); }, 120);
}

function saveConf() {
  const id = settings.engine;
  if (id === 'deepl') {
    save({ deepl: { ...settings.deepl, apiKey: $('apiKey').value.trim() } });
  } else if (id === 'openai' || id === 'deepseek') {
    const conf = {
      apiKey: $('apiKey').value.trim(),
      baseUrl: $('baseUrl').value.trim() || (id === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1'),
      model: $('model').value.trim() || (id === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini'),
    };
    save({ [id]: conf });
    ensureHostPermission(conf.baseUrl);
  }
}

async function ensureHostPermission(baseUrl) {
  try {
    const origin = new URL(baseUrl).origin + '/*';
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      const ok = await chrome.permissions.request({ origins: [origin] });
      $('keyHint').textContent = ok ? '' : '未授权该接口域名，翻译会被浏览器拦截';
    } else {
      $('keyHint').textContent = '';
    }
  } catch (_) {}
}

/* ---------- 页面按钮 ---------- */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshPageBtn() {
  const tab = await activeTab();
  if (!tab || !tab.id) return;
  try {
    const st = await new Promise((res, rej) => {
      chrome.tabs.sendMessage(tab.id, { type: 'page:state' }, (r) => {
        if (chrome.runtime.lastError) return rej(chrome.runtime.lastError);
        res(r);
      });
    });
    if (st && st.active) {
      $('pageBtnText').textContent = st.total ? `还原原文（${st.done}/${st.total}）` : '还原原文';
    } else {
      $('pageBtnText').textContent = '翻译当前页面';
    }
  } catch (_) {
    $('pageBtnText').textContent = '翻译当前页面';
    $('pageBtn').disabled = false;
  }
}

async function togglePage() {
  const tab = await activeTab();
  if (!tab || !tab.id) return;
  // 不支持的页面（chrome:// 等）直接退出
  if (/^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url || '')) {
    $('sub').textContent = '此页面不允许注入脚本';
    return;
  }
  try {
    await new Promise((res, rej) => {
      chrome.tabs.sendMessage(tab.id, { type: 'toggle-page' }, () => {
        if (chrome.runtime.lastError) return rej(chrome.runtime.lastError);
        res();
      });
    });
    window.close();
  } catch (e) {
    // content script 没注入（装完插件前的旧标签页）→ 手动注入再试
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      chrome.tabs.sendMessage(tab.id, { type: 'toggle-page' });
      window.close();
    } catch (e2) {
      $('sub').textContent = '注入失败，请刷新页面后重试';
    }
  }
}

/* ---------- 初始化 ---------- */
(async function init() {
  const r = await send({ type: 'settings:get' });
  settings = r.settings;
  renderEngines(r.engines);
  renderLangs(r.langs);
  renderSwitches();
  renderCfg();
  refreshPageBtn();

  const stats = await send({ type: 'cache:stats' }).catch(() => ({ count: 0 }));
  $('cacheInfo').textContent = `缓存 ${stats.count} 条`;

  $('pageBtn').addEventListener('click', togglePage);

  $('targetLang').addEventListener('change', (e) => save({ targetLang: e.target.value }));
  $('sourceLang').addEventListener('change', (e) => save({ sourceLang: e.target.value }));

  $('bilingual').addEventListener('change', (e) => save({ bilingual: e.target.checked }));
  $('selectionMode').addEventListener('change', (e) => save({ selectionMode: e.target.checked ? 'bubble' : 'off' }));
  $('autoTranslate').addEventListener('change', (e) => save({ autoTranslate: e.target.checked }));

  $('glossary').addEventListener('change', (e) => save({ glossary: e.target.value }));

  ['apiKey', 'baseUrl', 'model'].forEach((id) => {
    $(id).addEventListener('change', saveConf);
    $(id).addEventListener('blur', saveConf);
  });

  $('clearCache').addEventListener('click', async () => {
    await send({ type: 'cache:clear' });
    $('cacheInfo').textContent = '缓存 0 条';
  });

  $('openShortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
})();
