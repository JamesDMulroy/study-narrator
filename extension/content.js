// Study Narrator content script: on-page widget, narration (browser TTS), voice questions, memory saves.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__studyNarratorVersion === VERSION) return;           // same build already here
  // an older build is on this page (tab predates an extension update): remove its widget and take over
  document.querySelectorAll('#study-narrator-host').forEach(e => e.remove());
  if (window.__studyNarrator) { try { speechSynthesis.cancel(); } catch (_) { /* ignore */ } }
  window.__studyNarrator = true; window.__studyNarratorVersion = VERSION;

  const S = {
    settings: Object.assign({}, SN.DEFAULTS),
    voice: null, voices: [],
    sentences: [], idx: 0, playing: false, prepared: false, preparing: false, waiting: false,
    rawText: '', title: document.title, url: location.href,
    terms: [], savedTerms: new Set(),
    history: [], listening: false, thinking: false, speakingAnswer: false, resumeAfter: false,
    gen: 0, utter: null, port: null, rec: null, lastSelection: '',
  };

  // ---------- UI ----------
  const host = document.createElement('div');
  host.id = 'study-narrator-host';
  host.setAttribute('data-sn', '1');
  // Closed: the page's own scripts cannot reach the widget's controls or read its answers. Every handler that
  // acts also requires a trusted (real user) event, so script-made clicks and keys do nothing.
  const root = host.attachShadow({ mode: 'closed' });
  const trusted = (fn) => (e) => { if (e && e.isTrusted) return fn(e); };
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .wrap { position: fixed; left: 0; top: 0; z-index: 2147483646; display: block; touch-action: none; }
    .wrap.dragging { opacity: .85; }
    .bubble { position: absolute; right: 0; bottom: calc(100% + 8px); width: min(420px, calc(100vw - 32px)); background: #fff; color: #111; border: 1px solid #ddd; border-radius: 14px; box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 10px 12px; max-height: 42vh; overflow: auto; font-size: 14px; line-height: 1.45; display: none; }
    .wrap.q-top .bubble { bottom: auto; top: calc(100% + 8px); }
    .wrap.q-left .bubble { right: auto; left: 0; }
    .status .handle { cursor: grab; flex: 1; }
    .bubble.show { display: block; }
    .status { font-size: 12px; color: #666; margin-bottom: 4px; display: flex; justify-content: space-between; gap: 8px; }
    .status b { color: #4f46e5; font-weight: 600; }
    .text { white-space: pre-wrap; }
    .text.answer { background: #eef2ff; border-radius: 10px; padding: 8px 10px; }
    .text.interim { color: #555; font-style: italic; }
    .err { color: #b91c1c; font-size: 12px; margin-top: 4px; }
    .row { display: flex; gap: 6px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
    input.q { flex: 1; min-width: 120px; padding: 7px 10px; border: 1px solid #ccc; border-radius: 8px; font-size: 14px; }
    .link { background: none; border: none; color: #4f46e5; cursor: pointer; font-size: 12px; padding: 2px 4px; text-decoration: underline; }
    .terms { margin-top: 8px; border-top: 1px solid #eee; padding-top: 6px; }
    .term { display: flex; gap: 8px; align-items: flex-start; padding: 4px 0; font-size: 13px; }
    .term b { flex: 0 0 auto; }
    .term span { flex: 1; color: #444; }
    .term button { flex: 0 0 auto; }
    .pill { display: flex; gap: 4px; align-items: center; background: #1f2937; color: #fff; border-radius: 999px; padding: 6px 8px; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
    .pill button { background: transparent; color: #fff; border: none; border-radius: 999px; padding: 6px 9px; font-size: 14px; cursor: pointer; line-height: 1; white-space: nowrap; }
    .pill button:hover { background: rgba(255,255,255,.14); }
    .pill button.primary { background: #4f46e5; font-weight: 600; }
    .pill button.primary:hover { background: #4338ca; }
    .pill button.live { background: #dc2626; animation: pulse 1.2s infinite; }
    .pill button:disabled { opacity: .45; cursor: default; }
    .pill select { background: #374151; color: #fff; border: none; border-radius: 8px; padding: 4px 6px; font-size: 12px; }
    .pill.collapsed { padding: 4px; }
    .pill.collapsed button:not(.toggle), .pill.collapsed select { display: none; }
    .pill button.grip { cursor: grab; padding: 6px 4px; opacity: .75; font-size: 15px; }
    .pill button.grip:active, .wrap.dragging .pill button.grip { cursor: grabbing; }
    .pill button.toggle { cursor: grab; }
    .pill button.close { opacity: .7; font-size: 13px; padding: 6px 8px; }
    .pill { max-width: calc(100vw - 8px); }
    .pill button.more { display: none; }
    .wrap.narrow .pill .secondary { display: none; }
    .wrap.narrow .pill button.more { display: inline-block; }
    .small { background: #4f46e5; color: #fff; border: none; border-radius: 8px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
    .small.ghost { background: #e5e7eb; color: #111; }
    .toast { position: absolute; right: 0; bottom: calc(100% + 8px); white-space: nowrap; background: #111; color: #fff; padding: 8px 12px; border-radius: 10px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 2147483647; }
    .wrap.q-top .toast { bottom: auto; top: calc(100% + 8px); }
    .wrap.q-left .toast { right: auto; left: 0; }
    .toast.show { opacity: 1; }
    @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(220,38,38,.6)} 100%{box-shadow:0 0 0 10px rgba(220,38,38,0)} }
  </style>
  <div class="wrap">
    <div class="bubble">
      <div class="status"><span class="st handle" title="Drag to move">Ready</span><span><button class="link" data-act="panel">Notes</button><button class="link" data-act="hide">Hide</button></span></div>
      <div class="text"></div>
      <div class="err"></div>
      <div class="row actions"></div>
      <div class="row qrow" style="display:none"><input class="q" placeholder="Type a question or a term to save…"><button class="small" data-act="send">Ask</button><button class="small ghost" data-act="saveTyped">Save</button></div>
      <div class="terms" style="display:none"></div>
    </div>
    <div class="pill">
      <button class="grip" data-act="drag" title="Drag to move">⠿</button>
      <button class="toggle" data-act="collapse" title="Minimize / expand. Drag to move.">🎧</button>
      <button class="primary" data-act="readToggle" title="Read the important parts of this page (Alt+R)">▶ Read</button>
      <button class="secondary" data-act="prev" title="Previous sentence">⏮</button>
      <button class="secondary" data-act="next" title="Next sentence">⏭</button>
      <button class="secondary" data-act="stop" title="Stop">■</button>
      <button class="ask" data-act="ask" title="Ask a question by voice (Alt+A)">🎤 Ask</button>
      <button data-act="save" title="Save the highlighted text to memory (Alt+S)">★ Save</button>
      <select class="rate secondary" title="Speed"><option value="0.8">0.8×</option><option value="0.9">0.9×</option><option value="1">1.0×</option><option value="1.05">1.05×</option><option value="1.15">1.15×</option><option value="1.25">1.25×</option><option value="1.4">1.4×</option><option value="1.6">1.6×</option></select>
      <button class="secondary" data-act="openIn" title="Discuss this page in ChatGPT or Claude.ai">↗</button>
      <button class="secondary" data-act="panel" title="Notes, review and chat">≡</button>
      <button class="more" data-act="more" title="More">⋯</button>
      <button class="close" data-act="close" title="Hide the widget. Alt+R, right-click the page, or the Notes panel brings it back.">✕</button>
    </div>
    <div class="toast"></div>
  </div>`;
  const $ = (sel) => root.querySelector(sel);
  const ui = { wrap: $('.wrap'), bubble: $('.bubble'), st: $('.st'), text: $('.text'), err: $('.err'), actions: $('.actions'), qrow: $('.qrow'), q: $('input.q'), terms: $('.terms'), pill: $('.pill'), read: $('[data-act=readToggle]'), ask: $('[data-act=ask]'), save: $('[data-act=save]'), rate: $('select.rate'), toast: $('.toast') };

  function mount() {
    if (!document.body) return setTimeout(mount, 200);
    document.body.appendChild(host);
    applyPos(); setTimeout(applyPos, 100);
  }

  function setStatus(s) { ui.st.textContent = s; }
  function setText(t, cls = '') { ui.text.textContent = t || ''; ui.text.className = 'text ' + cls; ui.bubble.classList.add('show'); }
  function setError(e) { ui.err.textContent = e || ''; if (e) ui.bubble.classList.add('show'); }
  function showBubble(v = true) { ui.bubble.classList.toggle('show', v); }
  let toastT; function toast(msg) { ui.toast.textContent = msg; ui.toast.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => ui.toast.classList.remove('show'), 2200); }
  function setActions(list) {
    ui.actions.innerHTML = '';
    for (const a of list) { const b = document.createElement('button'); b.className = 'small' + (a.ghost ? ' ghost' : ''); b.textContent = a.label; b.onclick = trusted(a.fn); ui.actions.appendChild(b); }
  }
  function showInput(placeholder, mode) { ui.qrow.style.display = 'flex'; ui.q.placeholder = placeholder; ui.q.dataset.mode = mode || 'ask'; showBubble(); ui.q.focus(); }

  // ---------- settings / voices ----------
  async function loadSettings() {
    S.settings = await SN.getSettings();
    ui.rate.value = String(S.settings.rate);
    if (![...ui.rate.options].some(o => o.value === ui.rate.value)) ui.rate.value = '1.05';
    const got = await chrome.storage.local.get(['widgetState', 'widgetHiddenSites']);
    W.pos = got.widgetState?.pos || null;
    W.collapsed = !!got.widgetState?.collapsed;
    W.hiddenSites = got.widgetHiddenSites || [];
    ui.pill.classList.toggle('collapsed', W.collapsed);
    if (W.collapsed) showBubble(false);
    renderVisibility();
    applyPos();
    pickVoice();
  }

  // ---------- widget position, drag, minimize, hide ----------
  const W = { pos: null, collapsed: false, hidden: false, hiddenSites: [], drag: null, justDragged: 0, saveT: null, narrow: false };
  const siteKey = () => location.hostname || location.protocol;
  function siteHidden() { return W.hiddenSites.includes(siteKey()); }
  function renderVisibility() { host.style.display = (S.settings.widgetEnabled && !W.hidden && !siteHidden()) ? '' : 'none'; }
  function applyPos() {
    const vw = innerWidth, vh = innerHeight;
    const narrow = vw < 640;
    if (narrow !== W.narrow) { W.narrow = narrow; ui.wrap.classList.toggle('narrow', narrow); updateButtons(); }
    const w = ui.pill.offsetWidth || 320, h = ui.pill.offsetHeight || 40;
    let x, y;
    if (W.pos) { x = W.pos.x; y = W.pos.y; } else { x = S.settings.widgetSide === 'left' ? 18 : vw - w - 18; y = vh - h - 18; }
    x = Math.max(4, Math.min(x, vw - w - 4)); y = Math.max(4, Math.min(y, vh - h - 4));
    ui.wrap.style.left = x + 'px'; ui.wrap.style.top = y + 'px';
    const left = x + w / 2 < vw / 2;
    ui.wrap.classList.toggle('q-top', y + h / 2 < vh / 2);
    ui.wrap.classList.toggle('q-left', left);
    ui.bubble.style.maxWidth = Math.max(220, left ? vw - x - 16 : x + w - 16) + 'px';
  }
  function saveWidgetState() {
    clearTimeout(W.saveT);
    W.saveT = setTimeout(() => chrome.storage.local.set({ widgetState: { pos: W.pos, collapsed: W.collapsed } }).catch(() => {}), 150);
  }
  function startDrag(e, el) {
    if (e.button !== 0 || W.drag) return;
    const r = ui.wrap.getBoundingClientRect();
    W.drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false, el };
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  }
  function moveDrag(e) {
    const d = W.drag; if (!d || e.pointerId !== d.id) return;
    if (!d.moved) { if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return; d.moved = true; ui.wrap.classList.add('dragging'); }
    W.pos = { x: e.clientX - d.dx, y: e.clientY - d.dy };
    applyPos(); e.preventDefault();
  }
  function endDrag(e) {
    const d = W.drag; if (!d || e.pointerId !== d.id) return;
    W.drag = null; ui.wrap.classList.remove('dragging');
    try { d.el.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    if (d.moved) { W.justDragged = Date.now(); W.pos = { x: parseFloat(ui.wrap.style.left), y: parseFloat(ui.wrap.style.top) }; saveWidgetState(); }
  }
  function toggleCollapsed(force) {
    W.collapsed = typeof force === 'boolean' ? force : !W.collapsed;
    ui.pill.classList.toggle('collapsed', W.collapsed);
    if (W.collapsed) showBubble(false);
    applyPos(); saveWidgetState();
  }
  function floatingNote(msg) {
    const n = document.createElement('div');
    n.textContent = msg;
    n.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#111;color:#fff;padding:9px 14px;border-radius:10px;font:13px -apple-system,"Segoe UI",Roboto,Arial,sans-serif;z-index:2147483647;box-shadow:0 6px 20px rgba(0,0,0,.3);pointer-events:none';
    document.body.appendChild(n); setTimeout(() => n.remove(), 3200);
  }
  function hideWidget() { W.hidden = true; renderVisibility(); floatingNote('Study Narrator hidden. Alt+R, right-click the page, or the Notes panel brings it back.'); }
  function showWidget() {
    W.hidden = false;
    if (siteHidden()) { W.hiddenSites = W.hiddenSites.filter(h => h !== siteKey()); chrome.storage.local.set({ widgetHiddenSites: W.hiddenSites }).catch(() => {}); }
    if (!S.settings.widgetEnabled) SN.saveSettings({ widgetEnabled: true });
    renderVisibility(); if (W.collapsed) toggleCollapsed(false); applyPos();
  }
  function toggleSiteHidden() {
    if (siteHidden()) { showWidget(); floatingNote('Study Narrator will show on ' + siteKey() + ' again.'); return; }
    W.hiddenSites = [...W.hiddenSites, siteKey()];
    chrome.storage.local.set({ widgetHiddenSites: W.hiddenSites }).catch(() => {});
    renderVisibility(); floatingNote('Study Narrator hidden on ' + siteKey() + '. Right-click the page to bring it back.');
  }
  window.addEventListener('resize', () => applyPos());
  function pickVoice() {
    S.voices = speechSynthesis.getVoices();
    S.voice = SN.pickVoice(S.voices, S.settings.voiceName);
  }
  speechSynthesis.addEventListener('voiceschanged', pickVoice);
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.settings || ch.widgetState || ch.widgetHiddenSites)) loadSettings(); });

  // ---------- TTS core ----------
  function speakText(text, onEnd) {
    const gen = ++S.gen;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (!S.voice) pickVoice();
    if (S.voice) u.voice = S.voice;
    u.rate = Number(S.settings.rate) || 1;
    u.onend = () => { if (gen === S.gen) onEnd && onEnd(true); };
    u.onerror = (e) => { if (gen !== S.gen) return; if (e.error === 'interrupted' || e.error === 'canceled') return; setError('Speech error: ' + e.error); onEnd && onEnd(false); };
    S.utter = u; // keep a reference: Chromium drops GC'd utterances mid-speech
    setTimeout(() => { if (gen === S.gen) speechSynthesis.speak(u); }, 40);
    return gen;
  }
  function stopSpeech() { S.gen++; speechSynthesis.cancel(); }

  // ---------- page extraction ----------
  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const blocks = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'UL', 'OL', 'TABLE', 'DD', 'DT', 'FIGCAPTION', 'BR']);
    let out = '';
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.nodeValue.replace(/\s+/g, ' '); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG') return;
      if (tag === 'PRE') { const c = n.textContent.trim(); out += '\n\nCode example: ' + c.slice(0, 400).replace(/\s+/g, ' ') + (c.length > 400 ? ' …' : '') + '\n\n'; return; }
      if (/^H[1-6]$/.test(tag)) out += '\n\n';
      if (tag === 'TD' || tag === 'TH') out += ' | ';
      for (const c of n.childNodes) walk(c);
      if (blocks.has(tag)) out += '\n\n';
    };
    walk(doc.body);
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function extractPage() {
    let text = '', title = document.title;
    try {
      const clone = document.cloneNode(true);
      clone.querySelectorAll('#study-narrator-host').forEach(e => e.remove());
      const art = new Readability(clone, { charThreshold: 200 }).parse();
      if (art && art.content) { text = htmlToText(art.content); title = art.title || title; }
    } catch (_) { /* fall back below */ }
    if (text.length < 300) text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length > 60000) text = text.slice(0, 60000) + '\n\n(The rest of this page was cut off because it is very long.)';
    S.rawText = text; S.title = title; S.url = location.href;
    return { title, url: S.url, text };
  }

  // ---------- narration ----------
  function dedupeTerms(terms) {
    for (const t of terms || []) {
      if (!t || !t.term) continue;
      const k = t.term.toLowerCase();
      if (!S.terms.some(x => x.term.toLowerCase() === k)) S.terms.push({ term: String(t.term), definition: String(t.definition || '') });
    }
    renderTerms();
  }
  function renderTerms() {
    if (!S.terms.length) { ui.terms.style.display = 'none'; return; }
    ui.terms.style.display = '';
    ui.terms.innerHTML = `<div class="status"><span><b>Key terms</b> (${S.terms.length})</span><button class="link" data-act="saveAllTerms">Save all</button></div>`;
    for (const t of S.terms) {
      const d = document.createElement('div'); d.className = 'term';
      const saved = S.savedTerms.has(t.term.toLowerCase());
      d.innerHTML = `<b>${SN.escapeHtml(t.term)}</b><span>${SN.escapeHtml(t.definition)}</span><button class="small ${saved ? 'ghost' : ''}">${saved ? 'Saved' : '+ Save'}</button>`;
      d.querySelector('button').onclick = trusted(() => saveTerm(t));
      ui.terms.appendChild(d);
    }
    ui.terms.querySelector('[data-act=saveAllTerms]').onclick = trusted(async () => { for (const t of S.terms) await saveTerm(t, true); toast('All key terms saved'); });
  }
  async function saveTerm(t, quiet) {
    const r = await send({ type: 'saveNote', note: { kind: 'card', term: t.term, definition: t.definition, text: t.term, url: S.url, title: S.title, tags: ['key-term'] } });
    if (r && !r.error) { S.savedTerms.add(t.term.toLowerCase()); if (!quiet) toast(r.duplicate ? 'Already in memory' : 'Saved: ' + t.term); renderTerms(); }
    else if (!quiet) setError(r?.error || 'Save failed');
  }

  function prepare() {
    if (S.preparing) return;
    const page = extractPage();
    if (!page.text) { setError('Nothing readable on this page.'); return; }
    S.preparing = true; S.prepared = false; S.sentences = []; S.idx = 0; S.terms = [];
    setStatus('Preparing the narration…'); setText('Reading the page and picking out what matters. The first part starts in a few seconds.');
    let port;
    try { port = chrome.runtime.connect({ name: 'narrate' }); }
    catch (e) { S.preparing = false; S.playing = false; updateButtons(); setStatus('Reload needed'); setError('Study Narrator was updated. Reload this page (F5) to continue.'); return; }
    S.port = port;
    let announced = false;
    port.onMessage.addListener((m) => {
      if (m.type === 'chunk') {
        const sents = SN.splitSentences(SN.cleanForSpeech(m.script));
        const wasEmpty = S.sentences.length === 0;
        S.sentences.push(...sents);
        dedupeTerms(m.terms);
        send({ type: 'setTabContext', context: { title: S.title, url: S.url, script: S.sentences.join(' ') } });
        if (!announced) { announced = true; setStatus(m.cached ? 'Ready (cached)' : `Reading… part ${m.index + 1} of ${m.total}`); }
        if (wasEmpty && S.playing) playFrom(0);
        else if (S.waiting && S.playing) { S.waiting = false; playFrom(S.idx); }
      } else if (m.type === 'error') {
        setError('AI: ' + m.error + (m.index != null ? ' (reading that part as plain text instead)' : ''));
      } else if (m.type === 'done') {
        S.prepared = true; S.preparing = false;
        if (!S.sentences.length) { setStatus('Nothing to read'); setText('The AI found no substantive content on this page.'); S.playing = false; updateButtons(); }
        try { port.disconnect(); } catch (_) { /* ignore */ }
      }
    });
    port.onDisconnect.addListener(() => { S.preparing = false; if (!S.prepared && !S.sentences.length) { setError('Lost connection to the extension. Reload the page and try again.'); S.playing = false; updateButtons(); } });
    port.postMessage({ type: 'prepare', title: page.title, url: page.url, text: page.text });
  }

  function playFrom(i) {
    S.idx = Math.max(0, i);
    if (S.idx >= S.sentences.length) {
      if (S.prepared) { S.playing = false; setStatus('Finished'); setText('That is the end of this page.'); updateButtons(); return; }
      S.waiting = true; setStatus('Waiting for the next part…'); return;
    }
    S.playing = true; updateButtons();
    const sentence = S.sentences[S.idx];
    setStatus(`Reading ${S.idx + 1} / ${S.sentences.length}${S.prepared ? '' : '+'}`);
    setText(sentence);
    speakText(sentence, (ok) => { if (!S.playing) return; if (ok) playFrom(S.idx + 1); else { S.playing = false; updateButtons(); } });
  }
  function readToggle() {
    if (S.playing) { pause(); return; }
    if (!S.sentences.length && !S.preparing) { S.playing = true; updateButtons(); prepare(); return; }
    S.playing = true; updateButtons();
    if (S.sentences.length) playFrom(S.idx); else setStatus('Preparing…');
  }
  function pause() { S.playing = false; S.waiting = false; stopSpeech(); setStatus('Paused'); updateButtons(); }
  function stopAll() { S.playing = false; S.waiting = false; S.resumeAfter = false; stopSpeech(); stopListening(); S.idx = 0; setStatus('Stopped'); updateButtons(); }
  function updateButtons() {
    const n = W.narrow;
    ui.read.textContent = S.playing ? (n ? '⏸' : '⏸ Pause') : (S.idx > 0 && S.idx < S.sentences.length ? (n ? '▶' : '▶ Resume') : (n ? '▶' : '▶ Read'));
    ui.ask.classList.toggle('live', S.listening);
    ui.ask.textContent = S.listening ? (n ? '●' : '● Listening') : (S.thinking ? '…' : (n ? '🎤' : '🎤 Ask'));
    ui.save.textContent = n ? '★' : '★ Save';
  }
  function showMore() {
    const rate = Number(S.settings.rate) || 1;
    setStatus('More'); setText('');
    setActions([
      { label: '⏮ Back', ghost: true, fn: () => { if (S.sentences.length) { S.playing = true; playFrom(Math.max(0, S.idx - 1)); } } },
      { label: '⏭ Next', ghost: true, fn: () => { if (S.sentences.length) { S.playing = true; playFrom(S.idx + 1); } } },
      { label: '■ Stop', ghost: true, fn: stopAll },
      { label: `Slower (${rate.toFixed(2)}×)`, ghost: true, fn: async () => { await SN.saveSettings({ rate: Math.max(0.6, +(rate - 0.1).toFixed(2)) }); showMore(); if (S.playing) playFrom(S.idx); } },
      { label: 'Faster', ghost: true, fn: async () => { await SN.saveSettings({ rate: Math.min(2, +(rate + 0.1).toFixed(2)) }); showMore(); if (S.playing) playFrom(S.idx); } },
      { label: '↗ Discuss in…', fn: showOpenIn },
      { label: '≡ Notes', fn: async () => { const r = await send({ type: 'openPanel' }); if (!r?.ok) toast('Click the Study Narrator icon in the toolbar to open notes'); } },
    ]);
  }

  // ---------- voice questions ----------
  function startListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (S.speakingAnswer) { stopSpeech(); S.speakingAnswer = false; }
    if (S.playing) { S.resumeAfter = !!S.settings.autoResume; S.playing = false; S.waiting = false; stopSpeech(); }
    if (!SR) { setError('Voice input is not available in this browser. Type your question instead.'); showInput('Type your question…', 'ask'); return; }
    stopListening();
    const rec = new SR();
    rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let finalText = '';
    rec.onstart = () => { S.listening = true; updateButtons(); setStatus('Listening… ask your question'); setText('', 'interim'); setError(''); };
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript; }
      setText((finalText + ' ' + interim).trim(), 'interim');
    };
    rec.onerror = (e) => {
      S.listening = false; updateButtons();
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { setError('The microphone is blocked for this site. Click the lock icon in the address bar and allow the microphone, or type your question below.'); showInput('Type your question…', 'ask'); }
      else if (e.error === 'no-speech') { setStatus('Did not hear anything'); setText('Tap Ask and speak, or type below.'); showInput('Type your question…', 'ask'); maybeResume(); }
      else if (e.error !== 'aborted') { setError('Voice input error: ' + e.error); showInput('Type your question…', 'ask'); }
    };
    rec.onend = () => {
      S.listening = false; S.rec = null; updateButtons();
      const q = finalText.trim();
      if (q) ask(q); else if (ui.st.textContent.startsWith('Listening')) { setStatus('Did not catch that'); maybeResume(); }
    };
    S.rec = rec;
    try { rec.start(); } catch (e) { setError('Could not start the microphone: ' + e.message); }
  }
  function stopListening() { if (S.rec) { try { S.rec.abort(); } catch (_) { /* ignore */ } S.rec = null; } S.listening = false; updateButtons(); }
  function maybeResume() {
    if (S.resumeAfter) { S.resumeAfter = false; S.playing = true; updateButtons(); setTimeout(() => { if (S.playing) playFrom(S.idx); }, 700); }
  }
  async function ask(question) {
    if (!question) return;
    if (S.playing) { S.resumeAfter = !!S.settings.autoResume; S.playing = false; S.waiting = false; stopSpeech(); }
    S.thinking = true; updateButtons();
    setStatus('Thinking…'); setText('You asked: ' + question); setError('');
    const context = { title: S.title, url: S.url, script: S.sentences.length ? S.sentences.join(' ') : (S.rawText || extractPage().text), current: S.sentences[S.idx] || '' };
    const r = await send({ type: 'ask', question, context, history: S.history });
    S.thinking = false; updateButtons();
    if (!r || r.error) { setError(r?.error || 'No answer'); setStatus('Error'); maybeResume(); return; }
    S.history.push({ role: 'user', text: question }, { role: 'assistant', text: r.answer });
    S.history = S.history.slice(-16);
    setStatus('Answer'); setText(r.answer, 'answer');
    setActions([{ label: '🎤 Follow up', fn: startListening }, { label: 'Repeat', ghost: true, fn: () => speakAnswer(r.answer) }, { label: '★ Save answer', ghost: true, fn: async () => { const s = await send({ type: 'saveNote', note: { kind: 'note', text: r.answer, note: 'Q: ' + question, url: S.url, title: S.title, tags: ['answer'] } }); toast(s?.duplicate ? 'Already saved' : 'Answer saved'); } }]);
    speakAnswer(r.answer);
  }
  function speakAnswer(text) {
    S.speakingAnswer = true;
    speakText(text, () => { S.speakingAnswer = false; maybeResume(); });
  }

  // ---------- memory ----------
  function currentSelection() { return (window.getSelection()?.toString() || '').trim(); }
  async function saveSelection(selText) {
    const text = (selText || currentSelection()).trim();
    if (!text) { showInput('Type a term or text to remember…', 'save'); setStatus('Save to memory'); return; }
    S.lastSelection = text;
    const r = await send({ type: 'saveNote', note: { kind: 'highlight', text, url: S.url, title: S.title } });
    if (r?.error) { setError(r.error); return; }
    toast(r.duplicate ? 'Already in memory' : 'Saved to memory');
    setStatus('Saved'); setText(text);
    setActions([{ label: 'Explain with AI', fn: () => explainText(text, r.note?.id) }, { label: 'Read it', ghost: true, fn: () => readSelection(text) }]);
  }
  async function explainText(text, noteId) {
    if (!text) return;
    if (S.playing) { S.resumeAfter = !!S.settings.autoResume; S.playing = false; stopSpeech(); }
    setStatus('Explaining…'); setText(text); setError('');
    const context = { title: S.title, url: S.url, script: S.sentences.length ? S.sentences.join(' ') : (S.rawText || extractPage().text) };
    const r = await send({ type: 'explain', text, save: !noteId, context });
    if (!r || r.error) { setError(r?.error || 'No explanation'); maybeResume(); return; }
    if (noteId) await send({ type: 'updateNote', id: noteId, patch: { definition: r.explanation, kind: 'card', term: text.length <= 80 ? text : '' } });
    toast('Explanation saved as a review card');
    setStatus('Explanation'); setText(r.explanation, 'answer');
    setActions([{ label: '🎤 Ask more', fn: startListening }, { label: 'Repeat', ghost: true, fn: () => speakAnswer(r.explanation) }]);
    speakAnswer(r.explanation);
  }
  function readSelection(selText) {
    const text = SN.cleanForSpeech(selText || currentSelection());
    if (!text) { toast('Highlight some text first'); return; }
    if (S.playing) { S.playing = false; S.waiting = false; stopSpeech(); }
    const parts = SN.splitSentences(text); let i = 0;
    setStatus('Reading selection'); showBubble();
    const step = () => { if (i >= parts.length) { setStatus('Done'); return; } setText(parts[i]); speakText(parts[i++], (ok) => ok && step()); };
    step();
  }

  // ---------- hand the page to a web AI ----------
  function pageContext() { return { title: S.title, url: S.url, script: S.sentences.length ? S.sentences.join(' ') : (S.rawText || extractPage().text) }; }
  function openIn(target, selection) {
    const sel = (selection || currentSelection()).trim();
    const question = sel ? `Explain this part to me: "${sel.slice(0, 1200)}"` : '';
    send({ type: 'openIn', target, context: pageContext(), question });
  }
  function showOpenIn() {
    const sel = currentSelection();
    setStatus('Discuss this page in…'); setText(sel ? `With your highlight: "${sel.slice(0, 160)}${sel.length > 160 ? '…' : ''}"` : "Opens a new chat with this page's content preloaded.");
    setActions([{ label: 'ChatGPT', fn: () => openIn('chatgpt') }, { label: 'Claude.ai', fn: () => openIn('claude') }, { label: 'Perplexity', ghost: true, fn: () => openIn('perplexity') }]);
  }

  // ---------- messaging ----------
  function send(msg) { return new Promise((resolve) => { try { chrome.runtime.sendMessage(msg, (r) => { if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message }); else resolve(r); }); } catch (e) { resolve({ error: /invalidated/i.test(e.message) ? 'Study Narrator was updated. Reload this page (F5) to continue.' : e.message }); } }); }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'command') return;
    if (msg.command === 'toggleWidget') { if (host.style.display === 'none') showWidget(); else hideWidget(); sendResponse({ ok: true }); return; }
    if (msg.command === 'toggleSiteWidget') { toggleSiteHidden(); sendResponse({ ok: true }); return; }
    if (msg.command === 'showWidget') { showWidget(); sendResponse({ ok: true }); return; }
    if (msg.command === 'resetWidget') { W.pos = null; toggleCollapsed(false); showWidget(); saveWidgetState(); sendResponse({ ok: true }); return; }
    if (msg.command !== 'status') showWidget();
    switch (msg.command) {
      case 'readToggle': case 'readPage': readToggle(); break;
      case 'ask': startListening(); break;
      case 'saveSelection': saveSelection(msg.selection); break;
      case 'explainSelection': { const t = (msg.selection || currentSelection()).trim(); if (t) explainText(t); else toast('Highlight some text first'); break; }
      case 'readSelection': readSelection(msg.selection); break;
      case 'openChatGPT': openIn('chatgpt', msg.selection); break;
      case 'openClaude': openIn('claude', msg.selection); break;
      case 'speak': readSelection(msg.text); break;
      case 'status': sendResponse({ playing: S.playing, idx: S.idx, total: S.sentences.length, title: S.title }); return;
      default: break;
    }
    sendResponse({ ok: true });
  });

  // ---------- widget events ----------
  ui.pill.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted) return;
    const handle = e.target.closest('[data-act=drag], [data-act=collapse]');
    if (handle || e.target === ui.pill) startDrag(e, handle || ui.pill);
  });
  ui.bubble.addEventListener('pointerdown', (e) => { if (!e.isTrusted) return; const h = e.target.closest('.handle'); if (h) startDrag(e, h); });
  root.addEventListener('pointermove', trusted(moveDrag));
  root.addEventListener('pointerup', trusted(endDrag));
  root.addEventListener('pointercancel', trusted(endDrag));
  root.addEventListener('click', async (e) => {
    if (!e.isTrusted) return;
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (Date.now() - W.justDragged < 350) return; // a drag, not a click
    switch (b.dataset.act) {
      case 'readToggle': readToggle(); break;
      case 'prev': if (S.sentences.length) { const p = Math.max(0, S.idx - 1); S.playing = true; playFrom(p); } break;
      case 'next': if (S.sentences.length) { S.playing = true; playFrom(S.idx + 1); } break;
      case 'stop': stopAll(); break;
      case 'ask': if (S.listening) { stopListening(); setStatus('Cancelled'); maybeResume(); } else startListening(); break;
      case 'save': saveSelection(); break;
      case 'panel': { const r = await send({ type: 'openPanel' }); if (!r?.ok) toast('Click the Study Narrator icon in the toolbar to open notes'); break; }
      case 'hide': showBubble(false); break;
      case 'openIn': showOpenIn(); break;
      case 'collapse': toggleCollapsed(); break;
      case 'close': hideWidget(); break;
      case 'drag': break;
      case 'more': showMore(); break;
      case 'send': submitTyped('ask'); break;
      case 'saveTyped': submitTyped('save'); break;
      default: break;
    }
  });
  ui.q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.isTrusted) { e.preventDefault(); submitTyped(ui.q.dataset.mode === 'save' ? 'save' : 'ask'); } e.stopPropagation(); });
  ui.q.addEventListener('keyup', (e) => e.stopPropagation());
  function submitTyped(mode) {
    const v = ui.q.value.trim(); if (!v) return; ui.q.value = '';
    if (mode === 'save') saveSelection(v); else ask(v);
  }
  ui.rate.addEventListener('change', async (e) => { if (!e.isTrusted) return; await SN.saveSettings({ rate: Number(ui.rate.value) }); if (S.playing) playFrom(S.idx); });
  document.addEventListener('selectionchange', () => { const t = currentSelection(); if (t) S.lastSelection = t; });

  // SPA navigation: reset when the URL changes.
  setInterval(() => {
    if (location.href !== S.url && !S.preparing) {
      const wasPlaying = S.playing;
      stopAll(); S.sentences = []; S.prepared = false; S.terms = []; S.history = []; S.url = location.href; S.title = document.title; renderTerms();
      setStatus('New page'); if (wasPlaying) setText('Press Read to narrate this page.');
    }
  }, 1000);

  loadSettings().then(mount);
})();
