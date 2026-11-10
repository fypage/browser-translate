/* 演示逻辑：模拟真实插件的行为，数据来自 demo-data.js（真实必应译文） */
(() => {
  const DATA = window.DEMO_DATA || [];
  const article = document.getElementById('article');
  const pill = document.getElementById('pill');
  const bubble = document.getElementById('bubble');
  const toggleBtn = document.getElementById('toggleBtn');
  const modeTag = document.getElementById('modeTag');
  const hint = document.getElementById('hint');

  let translated = false;
  let busy = false;

  /* 渲染正文段落（跳过 h2 与 meta） */
  function buildArticle() {
    DATA.slice(1).forEach((item, i) => {
      const p = document.createElement('p');
      p.dataset.idx = String(i + 1);
      p.textContent = item.en;
      article.appendChild(p);
    });
  }

  function setPill(text, done) {
    pill.classList.add('show');
    pill.classList.toggle('done', !!done);
    pill.querySelector('span').textContent = text;
  }

  function hidePill() { pill.classList.remove('show'); }

  /* 整页翻译：逐段插入，模拟真实请求节奏 */
  async function translatePage() {
    if (busy) return;
    busy = true;
    toggleBtn.textContent = '翻译中…';
    const nodes = [...article.querySelectorAll('p')];
    const total = nodes.length;
    let done = 0;
    setPill(`0/${total}`);
    for (const p of nodes) {
      await new Promise((r) => setTimeout(r, 180 + Math.random() * 220));
      const item = DATA[Number(p.dataset.idx)];
      if (item && !p.querySelector('.tr-block')) {
        const t = document.createElement('span');
        t.className = 'tr-block';
        t.textContent = item.zh;
        p.appendChild(t);
      }
      done++;
      setPill(`${done}/${total}`);
    }
    setPill(`完成 ${total} 段`, true);
    setTimeout(hidePill, 2400);
    translated = true;
    busy = false;
    toggleBtn.textContent = '还原原文';
    toggleBtn.classList.add('ghost');
    modeTag.textContent = '双语对照';
    modeTag.style.color = 'var(--ok)';
    hint.textContent = '译文以左侧竖线标出，原文完整保留。这就是整页翻译的效果。';
  }

  function restore() {
    article.querySelectorAll('.tr-block').forEach((n) => n.remove());
    translated = false;
    toggleBtn.textContent = '翻译此页';
    toggleBtn.classList.remove('ghost');
    modeTag.textContent = '未翻译';
    modeTag.style.color = '';
    hidePill();
    hint.textContent = '点「翻译此页」看整页双语对照；点任意英文句子，看划词气泡。';
  }

  toggleBtn.addEventListener('click', () => (translated ? restore() : translatePage()));

  /* 划词气泡：点段落即弹 */
  let cur = null;
  function showBubble(text, zh, rect) {
    const w = Math.min(400, innerWidth * 0.92);
    bubble.querySelector('.src').textContent = text;
    bubble.querySelector('.dst').textContent = zh;
    bubble.classList.add('show');
    const h = bubble.offsetHeight;
    let left = Math.max(10, Math.min(innerWidth - w - 10, rect.left));
    let top = rect.bottom + 10;
    if (top + h > innerHeight - 12) top = Math.max(12, rect.top - h - 10);
    bubble.style.left = left + 'px';
    bubble.style.top = top + 'px';
  }

  article.addEventListener('click', (e) => {
    const p = e.target.closest('p, h2');
    if (!p) return;
    const idx = p.dataset.idx !== undefined ? Number(p.dataset.idx) : 0;
    const item = DATA[idx] || DATA[0];
    if (!item) return;
    cur = item;
    showBubble(item.en, item.zh, p.getBoundingClientRect());
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('#bubble') || e.target.closest('p, h2')) return;
    bubble.classList.remove('show');
  });

  bubble.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !cur) return;
    const act = b.dataset.act;
    if (act === 'close') bubble.classList.remove('show');
    else if (act === 'copy') {
      try { await navigator.clipboard.writeText(cur.zh); b.textContent = '已复制'; setTimeout(() => (b.textContent = '复制'), 1200); }
      catch { b.textContent = '复制失败'; }
    } else if (act === 'speak') {
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(cur.zh);
        u.lang = 'zh-CN';
        speechSynthesis.speak(u);
      } catch { }
    } else if (act === 'swap') {
      const d = bubble.querySelector('.dst');
      d.textContent = '（真实插件里这里会换一个引擎重译，比如切到 GPT-4o-mini）';
      setTimeout(() => (d.textContent = cur.zh), 1600);
    }
  });

  buildArticle();
})();
