#!/usr/bin/env python3
"""由 popup.html 生成可在普通网页里打开的预览版（注入 chrome API mock）"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
MOCK = """<script>
/* 预览用 mock：把真实 popup 界面在普通网页里跑起来，不进扩展包 */
const SETTINGS = {
  engine: 'microsoft', targetLang: 'zh-CN', sourceLang: 'auto',
  bilingual: true, autoTranslate: false, selectionMode: 'bubble',
  glossary: 'token=令牌\\nworkspace=工作台',
  deepl: { apiKey: '' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-demo-xxxxxxxxxxxx' },
};
const LANGS = [['zh-CN','简体中文'],['zh-TW','繁體中文'],['en','English'],['ja','日本語'],['ko','한국어'],['fr','Français'],['de','Deutsch'],['es','Español'],['ru','Русский'],['pt','Português']];
const ENGINES = [
  {id:'microsoft',label:'微软 Edge',free:true},
  {id:'google',label:'Google',free:true},
  {id:'deepseek',label:'DeepSeek',free:false},
  {id:'openai',label:'OpenAI 兼容',free:false},
  {id:'deepl',label:'DeepL',free:false},
];
window.chrome = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      let r = { ok: true };
      if (msg.type === 'settings:get') r = { ok: true, settings: SETTINGS, langs: LANGS, engines: ENGINES };
      else if (msg.type === 'cache:stats') r = { ok: true, count: 1284 };
      else if (msg.type === 'settings:set') { Object.assign(SETTINGS, msg.patch || {}); r = { ok: true, settings: SETTINGS }; }
      setTimeout(() => cb(r), 8);
    },
  },
  tabs: {
    async query() { return [{ id: 1, url: 'https://example.com/article' }]; },
    sendMessage(id, msg, cb) { if (cb) cb({ ok: true, active: false }); },
    create() {},
  },
  permissions: { async contains() { return true; }, async request() { return true; } },
  scripting: {},
};
</script>
<script src="../popup.js"></script>"""

EXTRA_CSS = """<style>
body { margin: 24px auto; background: #e9e9ee; }
@media (prefers-color-scheme: dark) { body { background: #0e0e10; } }
</style>"""

html = (ROOT / "popup.html").read_text(encoding="utf-8")
html = html.replace('<script src="popup.js"></script>', MOCK)
html = html.replace('<link rel="stylesheet" href="popup.css">',
                    '<link rel="stylesheet" href="../popup.css">\n' + EXTRA_CSS)
(ROOT / "preview" / "popup-demo.html").write_text(html, encoding="utf-8")
print("built preview/popup-demo.html")
