// Study Narrator bridge for the real ChatGPT web app (chatgpt.com).
// The background worker sends a prompt; this script types it into ChatGPT's composer, presses send,
// waits for the reply to finish streaming and returns its text. Works with the account signed in here.
(() => {
  if (window.__snChatGPTBridge) return;
  window.__snChatGPTBridge = true;

  const q = (sel) => document.querySelector(sel);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function composer() {
    return q('#prompt-textarea') || q('div.ProseMirror[contenteditable="true"]') || q('textarea[data-id]') || q('form textarea');
  }
  function sendButton() {
    return q('button[data-testid="send-button"]') || q('#composer-submit-button') || q('button[aria-label="Send prompt"]') || q('button[aria-label*="Send"]');
  }
  function stopButton() {
    return q('button[data-testid="stop-button"]') || q('button[aria-label="Stop streaming"]') || q('button[aria-label="Stop generating"]');
  }
  // ChatGPT's DOM changes often; try the known shapes in order and fall back to rendered markdown blocks.
  // Nov 2026 UI: turns carry data-turn-key, user bubbles carry class "group/user-message", assistant text sits in a
  // "MarkdownRoot-<hash>" block. Older shapes are kept for safety.
  const ASSISTANT_SELECTORS = ['[data-message-author-role="assistant"]', 'article[data-turn="assistant"]', '[class*="MarkdownRoot"]',
    '[data-turn-key]:not(:has([class~="group/user-message"]))', '[data-testid^="conversation-turn"] .markdown', 'div.markdown'];
  const USER_SELECTOR = '[data-message-author-role="user"], article[data-turn="user"], [class~="group/user-message"]';
  function assistantMessages() {
    for (const sel of ASSISTANT_SELECTORS) { const els = [...document.querySelectorAll(sel)]; if (els.length) return els; }
    return [];
  }
  function messageText(el) {
    const md = (el.matches && (el.matches('.markdown') || el.matches('[class*="MarkdownRoot"]'))) ? el : (el.querySelector('.markdown, [class*="MarkdownRoot"]') || el);
    return (md.innerText || md.textContent || '').replace(/^ChatGPT said:\s*/i, '').trim();
  }
  function debugInfo() {
    const counts = {}; for (const sel of ASSISTANT_SELECTORS) counts[sel] = document.querySelectorAll(sel).length;
    const last = assistantMessages().slice(-1)[0];
    const sb = sendButton();
    const main = document.querySelector('main') || document.body;
    const testids = new Set(), turns = new Set(), classes = new Set(), roles = new Set();
    for (const el of main.querySelectorAll('*')) {
      for (const a of el.attributes) {
        if (a.name === 'data-testid') testids.add(a.value.replace(/\d+/g, 'N'));
        else if (a.name.startsWith('data-turn') || a.name.startsWith('data-message') || a.name.startsWith('data-author') || a.name.startsWith('data-role')) turns.add(a.name + '=' + a.value.slice(0, 24));
        else if (a.name === 'role') roles.add(a.value);
      }
      for (const c of el.classList) if (/markdown|prose|message|turn|assistant|response|agent|composer/i.test(c)) classes.add(c);
    }
    const textHits = [];
    for (const el of main.querySelectorAll('div,p,span,article,section')) {
      const t = (el.innerText || '').trim();
      if (t === 'ready' || t.startsWith('Worked for') || t.startsWith('Thought for')) textHits.push(el.tagName + '.' + [...el.classList].slice(0, 4).join('.') + ' > ' + el.parentElement?.tagName + '.' + [...(el.parentElement?.classList || [])].slice(0, 3).join('.'));
    }
    return { testids: [...testids].slice(0, 40), turns: [...turns].slice(0, 20), classes: [...classes].slice(0, 30), roles: [...roles], textHits: textHits.slice(0, 8), mainText: (main.innerText || '').slice(0, 300), counts, userTurns: document.querySelectorAll(USER_SELECTOR).length, composer: !!composer(), composerTag: composer()?.tagName, composerId: composer()?.id,
      send: sb ? (sb.getAttribute('aria-label') || sb.id || sb.getAttribute('data-testid') || 'found') + (sb.disabled ? ' (disabled)' : '') : null, stop: !!stopButton(), last: last ? messageText(last).slice(0, 200) : null, job, url: location.href, title: document.title };
  }
  function blocked() {
    const t = (document.body?.innerText || '').slice(0, 4000);
    if (/verify you are human|just a moment|checking your browser/i.test(t) && !composer()) return 'ChatGPT is showing a human-verification page. Open the ChatGPT tab once and complete it.';
    if (/log in|sign up/i.test(t) && !composer()) return 'ChatGPT asks you to sign in. Sign in on the ChatGPT tab, then retry.';
    return null;
  }

  async function waitFor(fn, ms, step = 250) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step); }
    return null;
  }

  async function typeInto(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // ProseMirror contenteditable: select-all then insertText keeps the editor's state in sync.
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    const ok = document.execCommand('insertText', false, text);
    if (!ok || !(el.innerText || '').trim()) {
      // fallback: paste event with plain text
      const dt = new DataTransfer(); dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    await sleep(150);
  }

  // One request at a time. ask() sends the prompt and returns immediately; status() reports progress,
  // so the background worker (which never freezes) owns the waiting.
  let job = null; // { before, started, last, stableSince, done, text, error }
  async function ask(text) {
    const err0 = blocked(); if (err0) throw new Error(err0);
    const box = await waitFor(composer, 15000);
    if (!box) throw new Error(blocked() || 'ChatGPT composer not found. Is the page loaded and signed in?');
    if (stopButton()) { stopButton().click(); await sleep(800); }
    const before = assistantMessages().length;
    await typeInto(box, text);
    const typed = (box.tagName === 'TEXTAREA' ? box.value : box.innerText || '').trim();
    if (!typed) throw new Error('Could not type into the ChatGPT composer.');
    const composerText = () => { const b = composer(); return b ? (b.tagName === 'TEXTAREA' ? b.value : b.innerText || '').trim() : ''; };
    const userTurnsBefore = document.querySelectorAll(USER_SELECTOR).length;
    const sentOk = () => composerText() === '' || document.querySelectorAll(USER_SELECTOR).length > userTurnsBefore;
    let btn = await waitFor(() => { const b = sendButton(); return b && !b.disabled ? b : null; }, 5000);
    let how = 'none';
    if (btn) { btn.click(); how = 'button'; }
    if (!(await waitFor(sentOk, 2500))) {
      const b2 = composer(); b2.focus();
      b2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      how += '+enter';
      if (!(await waitFor(sentOk, 2500))) {
        const f = b2.closest('form'); if (f) { f.requestSubmit ? f.requestSubmit() : f.submit(); how += '+form'; }
        if (!(await waitFor(sentOk, 2500))) throw new Error('ChatGPT did not accept the message (send button: ' + (btn ? btn.getAttribute('aria-label') || btn.id || 'found' : 'not found') + ').');
      }
    }
    job = { before, started: Date.now(), last: '', stableSince: Date.now(), done: false, text: '', error: null, stage: 'sent:' + how };
    return { sent: true, how };
  }
  function status() {
    if (!job) return { done: true, error: 'no request in flight' };
    if (job.done) return { done: true, text: job.text, error: job.error, stage: job.stage };
    const msgs = assistantMessages();
    const started = msgs.length > job.before;
    const cur = started ? messageText(msgs[msgs.length - 1]) : '';
    if (cur !== job.last) { job.last = cur; job.stableSince = Date.now(); }
    const streaming = !!stopButton();
    const stableFor = Date.now() - job.stableSince;
    if (started) job.stage = streaming ? 'streaming' : 'answered';
    if (started && cur && !streaming && stableFor > 2000) { job.done = true; job.text = cur; }
    else if (started && cur && stableFor > 12000) { job.done = true; job.text = cur; }  // stop button never went away
    else if (!started && Date.now() - job.started > 90000) { job.done = true; job.error = blocked() || 'ChatGPT did not start answering (usage limit, or the message was not sent).'; }
    return { done: job.done, text: job.text, error: job.error, stage: job.stage, chars: cur.length, streaming };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'chatgpt.ping') { sendResponse({ ready: !!composer(), loaded: document.readyState, blocked: blocked() }); return; }
    if (msg.type === 'chatgpt.status') { sendResponse(status()); return; }
    if (msg.type === 'chatgpt.debug') { sendResponse(debugInfo()); return; }
    if (msg.type !== 'chatgpt.ask') return;
    if (job && !job.done) { sendResponse({ error: 'ChatGPT bridge is busy with another request' }); return; }
    ask(msg.text).then(r => sendResponse(r), e => sendResponse({ error: String(e.message || e) }));
    return true;
  });
})();
