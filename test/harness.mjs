/**
 * 无浏览器环境下的端到端测试：mock chrome API 后直接跑 background.js
 * 用法：node --dns-result-order=ipv4first test/harness.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function mockChrome() {
  const store = {};
  return {
    __store: store,
    storage: {
      local: {
        async get(k) {
          if (typeof k === 'string') return { [k]: store[k] };
          return { ...store };
        },
        async set(obj) { Object.assign(store, obj); },
        async remove(k) { delete store[k]; },
      },
    },
    runtime: {
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      lastError: null,
    },
    contextMenus: { removeAll(cb) { cb && cb(); }, create() {}, onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    tabs: { sendMessage: async () => {}, query: async () => [] },
  };
}

export function loadBackground(overrides = {}) {
  const chrome = mockChrome();
  Object.assign(chrome, overrides);
  // 浏览器里 fetch 自动带 UA，Node 里默认是 "node"，必应会 401 —— 测试时补上
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const fetchUA = (url, init = {}) => {
    const headers = { ...(init.headers || {}), 'user-agent': UA };
    return fetch(url, { ...init, headers });
  };
  const sandbox = {
    chrome,
    fetch: fetchUA,
    console,
    URLSearchParams,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Error,
    Promise,
    atob,
    btoa,
    Intl,
  };
  vm.createContext(sandbox);
  sandbox.globalThis = sandbox;
  const code = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  vm.runInContext(code + '\n;globalThis.__api = { translate, getSettings, setSettings, ENGINES, bingOne, bingSession };', sandbox);
  return { api: sandbox.__api, chrome, sandbox };
}

const { api } = loadBackground();

const CASES = [
  ['微软默认', [
    'Artificial intelligence has fundamentally changed how we build software.',
    'Click the button below to continue.',
    'The meeting has been moved to Thursday at 3 PM.',
  ]],
  ['长段 + 术语', [
    'We use Kubernetes to orchestrate containers across multiple availability zones, which improves fault tolerance and reduces downtime.',
  ]],
  ['含格式占位符', [
    'Hello {name}, your order %s has shipped. Visit <b>this link</b> for details.',
  ]],
  ['已经是中文', ['这是一段本来就中文的内容。']],
];

for (const [name, texts] of CASES) {
  const t0 = Date.now();
  try {
    const out = await api.translate(texts, { engine: 'microsoft' });
    console.log(`\n[${name}] ${Date.now() - t0}ms`);
    texts.forEach((s, i) => console.log('  EN:', s.slice(0, 60), '\n  ZH:', out[i]));
  } catch (e) {
    console.log(`\n[${name}] FAILED:`, e.message);
  }
}

// 缓存是否生效：第二次应几乎立即返回
const warm = ['Artificial intelligence has fundamentally changed how we build software.'];
const t1 = Date.now();
await api.translate(warm, { engine: 'microsoft' });
console.log('\n[缓存命中] ' + (Date.now() - t1) + 'ms');
