// Study Narrator service worker: AI backends, ChatGPT web bridge, notes store, context menus, commands.
importScripts('lib/common.js');

const HOST = 'study_narrator'; // the native host name registered by host/install.py
const MAX_CONTEXT = 24000;

// ---------- prompts ----------
const NARRATION_SYSTEM = (style) => `You prepare web page text for a student who is LISTENING to it, not reading it.
Return ONLY a JSON object: {"script": "...", "terms": [{"term": "...", "definition": "..."}]}

"script" rules:
- Keep the substantive content in its original order and, where possible, its original wording. ${style === 'full'
  ? 'Keep everything that carries meaning; only remove page furniture.'
  : 'Keep every fact, instruction, step, example, definition and caveat. Do not summarize details away, but drop filler and repetition.'}
- Drop page furniture: navigation, menus, breadcrumbs, page numbers, progress indicators, footers, headers, cookie and legal notices, social links, "click here" and "next lesson" instructions, author bios, related-content lists, image alt text or captions that add nothing.
- Make it flow for the ear: turn headings into short spoken lead-ins (for example "Next, ..."), expand abbreviations on first use, read numbers and units naturally, and describe code or commands briefly in plain words instead of reading symbols.
- Plain text only. No markdown, no bullet symbols, no asterisks. Separate paragraphs with a blank line.
- If the text contains no substantive content, return an empty script.

"terms": up to 8 key terms or concepts worth remembering, each with a one-sentence definition taken from this text. Use [] if there are none.`;

const ANSWER_SYSTEM = `You are a friendly study tutor talking out loud with a student who is listening to a web page being read.
Answer in natural spoken English, conversational and clear, usually two to five sentences. Go longer only when the question truly needs it.
No markdown, no bullet points, no headings, no code blocks, no URLs. Spell out symbols in words.
Ground your answer in the page content when it is relevant, and say plainly when something is not covered on the page.
If the student asks you to repeat, slow down, or explain more simply, do exactly that.`;

const EXPLAIN_SYSTEM = `Explain the given term or passage to a student in one to three plain spoken sentences, in the context of the page excerpt provided. No markdown.`;

const QUIZ_Q_SYSTEM = `You write one short quiz question that checks whether a student really understands a saved note.
Return ONLY JSON: {"question": "...", "answer": "..."}. The question must be answerable out loud in a sentence or two. The answer is the model answer.`;

const QUIZ_GRADE_SYSTEM = `You grade a spoken quiz answer kindly but honestly.
Return ONLY JSON: {"result": "correct" | "partial" | "incorrect", "feedback": "one or two spoken sentences, no markdown"}.
Accept paraphrases and reasonable wording; mark partial when a key element is missing.`;

// ---------- AI backends ----------
// Every backend takes {system, prompt, kind: 'narration'|'answer'} and returns text.
function normalizeBackend(b) { return b === 'native' ? 'claude-code' : b === 'api' ? 'anthropic-api' : (b || 'claude-code'); }

async function callAI({ system, prompt, kind }) {
  const s = Object.assign({}, await SN.getSettings(), await SN.getSecrets());
  const backend = normalizeBackend(s.backend);
  switch (backend) {
    case 'claude-code': {
      const model = kind === 'narration' ? s.narrationModel : s.answerModel;
      const r = await sendNative({ action: 'claude', system, prompt, model, account: s.account, timeout: 240 });
      if (!r?.ok) throw new Error(r?.error || 'No reply from the local AI host');
      return r.text;
    }
    case 'codex': {
      const model = kind === 'narration' ? s.codexNarrationModel : s.codexAnswerModel;
      const r = await sendNative({ action: 'codex', system, prompt, model, account: s.codexAccount, timeout: 300 });
      if (!r?.ok) throw new Error(r?.error || 'No reply from the local AI host');
      return r.text;
    }
    case 'chatgpt-web':
      return chatgptWebAsk(system + '\n\n' + prompt, kind);
    case 'anthropic-api': {
      if (!s.apiKey) throw new Error('No Anthropic API key set (Settings)');
      const model = kind === 'narration' ? s.apiNarrationModel : s.apiAnswerModel;
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model, max_tokens: 8000, system, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `Anthropic API error ${res.status}`);
      return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    }
    case 'openai-api': {
      const base = (s.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      if (!SN.validBaseUrl(base)) throw new Error('The endpoint must use https (http is allowed only for localhost)');
      const needsKey = /api\.openai\.com|openrouter\.ai|groq\.com|together|mistral|deepseek|x\.ai/i.test(base);
      if (needsKey && !s.openaiKey) throw new Error('No API key set for the OpenAI-compatible endpoint (Settings)');
      const model = kind === 'narration' ? s.openaiNarrationModel : s.openaiAnswerModel;
      const headers = { 'content-type': 'application/json' };
      if (s.openaiKey) headers.authorization = 'Bearer ' + s.openaiKey;
      const res = await fetch(base + '/chat/completions', {
        method: 'POST', headers,
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || data?.error || `API error ${res.status}`);
      return data.choices?.[0]?.message?.content || '';
    }
    case 'gemini-api': {
      if (!s.geminiKey) throw new Error('No Gemini API key set (Settings)');
      const model = kind === 'narration' ? s.geminiNarrationModel : s.geminiAnswerModel;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': s.geminiKey },
        body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `Gemini API error ${res.status}`);
      return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    }
    default:
      throw new Error('Unknown backend ' + backend);
  }
}

function sendNative(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(HOST, msg, (reply) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message + ' (is the native host registered? see Settings)'));
        else resolve(reply);
      });
    } catch (e) { reject(e); }
  });
}

// ---------- ChatGPT web bridge ----------
// Keeps one pinned chatgpt.com tab (temporary chat) and drives its real composer through chatgpt-bridge.js.
const CHATGPT_MARKER = '#study-narrator';
const CHATGPT_URL = 'https://chatgpt.com/?temporary-chat=true' + CHATGPT_MARKER;
let chatgptQueue = Promise.resolve();
let chatgptPageKey = null; // which page the current ChatGPT thread is about

function chatgptWebAsk(text, kind) {
  const run = async () => {
    const s = await SN.getSettings();
    const tab = await ensureChatGPTTab();
    const newChat = kind === 'narration' || !chatgptPageKey; // start a fresh temporary chat per page
    if (newChat) {
      await navigateTab(tab.id, s.chatgptTemporary === false ? 'https://chatgpt.com/' + CHATGPT_MARKER : CHATGPT_URL);
      await waitForBridge(tab.id, 60000);
      chatgptPageKey = Date.now();
    }
    let sent = null, lastErr = null;
    for (let attempt = 0; attempt < 3 && !sent; attempt++) {
      try {
        await waitForBridge(tab.id, 60000);
        sent = await tabRequest(tab.id, { type: 'chatgpt.ask', text }, 30000);
      } catch (e) {
        lastErr = e;
        if (!/Receiving end|message port closed|message channel closed/i.test(String(e.message || e))) throw new Error('ChatGPT web: ' + e.message);
        await new Promise(res => setTimeout(res, 3000));
      }
    }
    if (!sent) throw new Error('ChatGPT web: ' + (lastErr?.message || 'could not reach the ChatGPT tab'));
    if (sent.error) throw new Error('ChatGPT web: ' + sent.error);
    // poll until the reply is finished (the tab may be frozen briefly; keep trying)
    const t0 = Date.now();
    let lastStatus = null, lastOk = Date.now();
    while (Date.now() - t0 < 300000) {
      await new Promise(res => setTimeout(res, 1500));
      let st = null;
      try { st = await Promise.race([chrome.tabs.sendMessage(tab.id, { type: 'chatgpt.status' }), new Promise((_, rej) => setTimeout(() => rej(new Error('frozen')), 8000))]); }
      catch (e) { st = null; }
      if (st) { lastStatus = st; lastOk = Date.now(); }
      else if (Date.now() - lastOk > 25000) {
        const t = await chrome.tabs.get(tab.id).catch(() => null);
        throw new Error('ChatGPT web: Edge put the ChatGPT tab to sleep' + (t?.discarded ? ' (discarded)' : '') + '. In edge://settings/system add chatgpt.com under "Never put these sites to sleep", then retry.');
      }
      if (lastStatus?.done) {
        if (lastStatus.error) throw new Error('ChatGPT web: ' + lastStatus.error);
        return lastStatus.text || '';
      }
    }
    throw new Error('ChatGPT web: timed out waiting for the reply' + (lastStatus ? ` (stage ${lastStatus.stage}, ${lastStatus.chars || 0} chars so far)` : ' (the ChatGPT tab stopped responding)'));
  };
  const p = chatgptQueue.then(run, run);
  chatgptQueue = p.catch(() => {});
  return p;
}
// Navigate a tab and resolve only after the new document has finished loading (so the old
// content script cannot answer our pings during the switch).
function navigateTab(tabId, url) {
  return new Promise((resolve) => {
    let sawLoading = false;
    const done = () => { chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(t); setTimeout(resolve, 800); };
    const onUpd = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) done();
    };
    const t = setTimeout(done, 30000);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.update(tabId, { url }).catch(done);
  });
}
async function ensureChatGPTTab() {
  const saved = await chrome.storage.session.get('chatgptTabId');
  let tab = null;
  if (saved.chatgptTabId != null) {
    tab = await chrome.tabs.get(saved.chatgptTabId).catch(() => null);
    if (tab && !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || '')) tab = null;
  }
  if (!tab) {
    const pinnedTabs = await chrome.tabs.query({ pinned: true });
    tab = pinnedTabs.find(candidate => /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(candidate.url || '') && (candidate.url || '').includes(CHATGPT_MARKER)) || null;
    if (tab) await chrome.storage.session.set({ chatgptTabId: tab.id });
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url: CHATGPT_URL, active: false, pinned: true });
    await chrome.storage.session.set({ chatgptTabId: tab.id });
  }
  // keep Edge's sleeping tabs / Chromium discarding away from this tab while it works for us
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  await waitForBridge(tab.id, 60000);
  return tab;
}
async function waitForBridge(tabId, ms) {
  const t0 = Date.now();
  let reloaded = false, lastBlocked = null;
  while (Date.now() - t0 < ms) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'chatgpt.ping' });
      if (r?.ready) return r;
      if (r?.blocked) lastBlocked = r.blocked;
    } catch (_) {
      // no bridge in the tab (tab predates an extension reload, or is still loading): reload it once
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const idle = tab && (tab.status === 'complete' || tab.status === 'unloaded' || tab.discarded || tab.frozen);
      if (!reloaded && tab && (idle || Date.now() - t0 > 12000) && Date.now() - t0 > 4000) { reloaded = true; await chrome.tabs.reload(tabId).catch(() => {}); }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(lastBlocked || 'ChatGPT tab did not become ready (sign in to chatgpt.com in that tab, then retry)');
}
function tabRequest(tabId, msg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ChatGPT web: timed out waiting for the reply')), timeoutMs);
    chrome.tabs.sendMessage(tabId, msg).then(r => { clearTimeout(t); resolve(r); }, e => { clearTimeout(t); reject(e); });
  });
}

// "Open in" links: hand the page + question to a web AI in a visible tab.
function openInWebAI(target, { title, url, script, question }) {
  const ctx = (script || '').slice(0, 6000);
  const text = `I'm studying this page: "${title}" (${url}).\n\n${question || 'Help me understand it. Start with the key ideas in plain language, then ask me a question to check my understanding.'}\n\nPage content:\n${ctx}`;
  const q = encodeURIComponent(text);
  const dest = target === 'claude' ? `https://claude.ai/new?q=${q}` : target === 'perplexity' ? `https://www.perplexity.ai/search?q=${q}` : `https://chatgpt.com/?q=${q}`;
  return chrome.tabs.create({ url: dest, active: true });
}

// ---------- narration ----------
function chunkText(text, first = 3500, rest = 9000) {
  const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks = []; let buf = ''; let limit = first;
  for (const p of paras) {
    if (buf && (buf.length + p.length + 2) > limit) { chunks.push(buf); buf = p; limit = rest; }
    else buf = buf ? buf + '\n\n' + p : p;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function cacheGet(key) {
  const got = await chrome.storage.local.get('narrationCache');
  return (got.narrationCache || {})[key] || null;
}
async function cachePut(key, value) {
  const got = await chrome.storage.local.get('narrationCache');
  const cache = got.narrationCache || {};
  cache[key] = Object.assign({ ts: Date.now() }, value);
  const keys = Object.keys(cache).sort((a, b) => cache[b].ts - cache[a].ts).slice(20);
  for (const k of keys) delete cache[k];
  await chrome.storage.local.set({ narrationCache: cache });
}

async function prepareNarration(port, { title, url, text }, isClosed = () => false) {
  const s = await SN.getSettings();
  // Full-text SHA-256: a page cannot craft a key that collides with another page's cached narration.
  const key = 'n2:' + await SN.sha256(JSON.stringify([url, s.narrationStyle, text]));
  const cached = await cacheGet(key);
  if (cached) {
    port.postMessage({ type: 'chunk', index: 0, total: 1, script: cached.script, terms: cached.terms, cached: true });
    port.postMessage({ type: 'done' });
    return;
  }
  const chunks = chunkText(text);
  const all = { script: [], terms: [] };
  for (let i = 0; i < chunks.length; i++) {
    if (isClosed()) return; // the page went away: make no further AI call for it
    const prompt = `Page title: ${title}\nURL: ${url}\nPart ${i + 1} of ${chunks.length}.\n\n<page_text>\n${chunks[i]}\n</page_text>`;
    let script = '', terms = [];
    try {
      const raw = await callAI({ system: NARRATION_SYSTEM(s.narrationStyle), prompt, kind: 'narration' });
      const j = SN.extractJSON(raw);
      if (j && typeof j.script === 'string') { script = j.script; terms = Array.isArray(j.terms) ? j.terms : []; }
      else script = SN.cleanForSpeech(raw);
    } catch (e) {
      port.postMessage({ type: 'error', index: i, error: String(e.message || e) });
      script = SN.cleanForSpeech(chunks[i]); // fall back to the raw text so reading still works
    }
    all.script.push(script); all.terms.push(...terms);
    try { port.postMessage({ type: 'chunk', index: i, total: chunks.length, script, terms }); } catch (_) { return; }
  }
  await cachePut(key, { script: all.script.join('\n\n'), terms: all.terms });
  try { port.postMessage({ type: 'done' }); } catch (_) { /* port closed */ }
}

// ---------- per-tab limits ----------
// A page's widget asks the AI only on a person's click or key, so a burst from one tab is refused rather than
// spending the user's AI quota. The extension's own pages are not limited.
const RATE_LIMITS = { ask: { max: 10, perMs: 60000 }, explain: { max: 10, perMs: 60000 }, prepare: { max: 4, perMs: 60000 } };
const MAX_PREPARE_CHARS = 70000; // content.js sends at most 60,000 characters plus a short note
const recentCalls = new Map(); // `${kind}:${tabId}` -> timestamps
const preparing = new Map(); // tab ID -> the port whose narration is in progress
function overLimit(kind, tabId) {
  if (tabId == null || !RATE_LIMITS[kind]) return false;
  const { max, perMs } = RATE_LIMITS[kind];
  const key = `${kind}:${tabId}`, now = Date.now();
  const times = (recentCalls.get(key) || []).filter(t => now - t < perMs);
  if (times.length >= max) { recentCalls.set(key, times); return true; }
  times.push(now); recentCalls.set(key, times);
  return false;
}
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const kind of Object.keys(RATE_LIMITS)) recentCalls.delete(`${kind}:${tabId}`);
  preparing.delete(tabId);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'narrate' || port.sender?.id !== chrome.runtime.id) return;
  const tabId = fromContentScript(port.sender) ? port.sender.tab.id : null;
  port.onMessage.addListener((msg) => {
    if (msg?.type !== 'prepare') return;
    const fail = (error) => { try { port.postMessage({ type: 'error', error }); port.postMessage({ type: 'done' }); } catch (_) { /* ignore */ } };
    if (typeof msg.text !== 'string' || msg.text.length > MAX_PREPARE_CHARS) return fail('This page is too long to narrate.');
    if (tabId != null && preparing.has(tabId)) return fail('A narration is already being prepared for this tab.');
    if (overLimit('prepare', tabId)) return fail('Too many narration requests from this tab. Wait a minute and try again.');
    if (tabId != null) preparing.set(tabId, port);
    prepareNarration(port, { title: String(msg.title || ''), url: String(msg.url || ''), text: msg.text }, () => closed)
      .catch(e => fail(String(e.message || e)))
      .finally(() => release());
  });
  // The tab navigated or closed the widget: free the tab at once and stop the chunk loop.
  let closed = false;
  const release = () => { if (tabId != null && preparing.get(tabId) === port) preparing.delete(tabId); };
  port.onDisconnect.addListener(() => { closed = true; release(); });
});

// ---------- tab context (page script for the side panel) ----------
async function setTabContext(tabId, ctx) {
  const got = await chrome.storage.session.get('tabContexts');
  const all = got.tabContexts || {};
  all[tabId] = Object.assign({ ts: Date.now() }, ctx);
  await chrome.storage.session.set({ tabContexts: all });
}
async function getTabContext(tabId) {
  const got = await chrome.storage.session.get('tabContexts');
  return (got.tabContexts || {})[tabId] || null;
}
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const got = await chrome.storage.session.get('tabContexts');
  const all = got.tabContexts || {};
  if (all[tabId]) { delete all[tabId]; await chrome.storage.session.set({ tabContexts: all }); }
});

// ---------- Q&A ----------
function buildAskPrompt({ question, title, url, script, current, history }) {
  const ctx = (script || '').slice(0, MAX_CONTEXT);
  const hist = (history || []).slice(-8).map(h => `${h.role === 'user' ? 'Student' : 'Tutor'}: ${h.text}`).join('\n');
  return `Page title: ${title || ''}\nURL: ${url || ''}\n` +
    (current ? `The student is currently at this sentence: "${current}"\n` : '') +
    `\n<page_content>\n${ctx || '(no page content available)'}\n</page_content>\n` +
    (hist ? `\n<conversation_so_far>\n${hist}\n</conversation_so_far>\n` : '') +
    `\nStudent's question (spoken): ${question}\n\nAnswer out loud:`;
}

async function appendTranscript(entry) {
  const got = await chrome.storage.local.get('transcript');
  const t = got.transcript || [];
  t.push(Object.assign({ ts: Date.now() }, entry));
  await chrome.storage.local.set({ transcript: t.slice(-300) });
}

// ---------- notes ----------
async function listNotes() { return (await chrome.storage.local.get('notes')).notes || []; }
async function writeNotes(notes) { await chrome.storage.local.set({ notes }); }
async function saveNote(n) {
  n = n || {};
  const notes = await listNotes();
  const stringField = (value) => String(value ?? '').trim().slice(0, 20000);
  const kind = ['highlight', 'card', 'note'].includes(n.kind) ? n.kind : 'highlight';
  const note = {
    id: SN.uid(), kind, text: stringField(n.text), term: stringField(n.term),
    definition: stringField(n.definition), note: stringField(n.note),
    tags: Array.isArray(n.tags) ? n.tags.filter(t => typeof t === 'string').slice(0, 20).map(t => t.slice(0, 40)) : [],
    url: stringField(n.url), title: stringField(n.title), created: Date.now(), srs: { reps: 0, interval: 0, ease: 2.5, due: Date.now() },
  };
  if (!note.text && !note.term) throw new Error('Nothing to save');
  const dup = notes.find(x => x.text === note.text && x.term === note.term && x.url === note.url);
  if (dup) return { note: dup, duplicate: true };
  notes.unshift(note);
  await writeNotes(notes);
  return { note, duplicate: false };
}
// What a page's widget may change on a note; extension pages may patch any field.
const CONTENT_SCRIPT_NOTE_FIELDS = ['definition', 'kind', 'term', 'note', 'tags'];
async function updateNote(id, patch) {
  const notes = await listNotes();
  const i = notes.findIndex(n => n.id === id);
  if (i < 0) throw new Error('Note not found');
  notes[i] = Object.assign({}, notes[i], patch);
  await writeNotes(notes);
  return notes[i];
}
async function deleteNote(id) { await writeNotes((await listNotes()).filter(n => n.id !== id)); }

// ---------- backend test (Settings) ----------
async function testBackend() {
  const s = await SN.getSettings();
  const backend = normalizeBackend(s.backend);
  const t0 = Date.now();
  if (backend === 'claude-code' || backend === 'codex') {
    const ping = await sendNative({ action: 'ping' });
    if (!ping?.ok) throw new Error(ping?.error || 'host did not answer');
    const found = backend === 'codex' ? ping.codex_found : ping.claude_found;
    if (!found) throw new Error(`${backend === 'codex' ? 'codex' : 'claude'} CLI not found on this PC`);
  }
  const text = await callAI({ system: 'Reply with exactly: ready', prompt: 'Say ready.', kind: 'answer' });
  return { ok: true, backend, ms: Date.now() - t0, text: String(text).slice(0, 80) };
}

// ---------- messages ----------
// Content scripts run inside arbitrary web pages, so they get only the messages the widget needs. Everything
// else (settings tests, host ping, note deletion, other tabs' context, script injection) is for the
// extension's own pages (panel, options), whether shown in the side panel or opened in a tab.
const CONTENT_SCRIPT_MESSAGES = new Set(['ask', 'explain', 'openIn', 'openPanel', 'saveNote', 'updateNote', 'setTabContext']);
const EXTENSION_ORIGIN = chrome.runtime.getURL('');
function fromContentScript(sender) {
  // a content script runs in a tab whose page is a web page; an extension page has the extension's own URL
  return !!sender.tab && !String(sender.url || '').startsWith(EXTENSION_ORIGIN);
}
function allowedSender(msg, sender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (!fromContentScript(sender)) return true; // an extension page
  return CONTENT_SCRIPT_MESSAGES.has(msg?.type);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!allowedSender(msg, sender)) { sendResponse({ error: 'not allowed from a web page' }); return false; }
  (async () => {
    const page = fromContentScript(sender);
    const tabId = page ? sender.tab.id : msg.tabId; // a content script can only speak for its own tab
    if (page && overLimit(msg.type, tabId)) return { error: 'Too many requests from this tab. Wait a minute and try again.' };
    switch (msg.type) {
      case 'ask': {
        const ctx = msg.context || (tabId != null ? await getTabContext(tabId) : null) || {};
        const prompt = buildAskPrompt(Object.assign({}, ctx, { question: msg.question, history: msg.history }));
        const answer = SN.cleanForSpeech(await callAI({ system: ANSWER_SYSTEM, prompt, kind: 'answer' }));
        await appendTranscript({ role: 'user', text: msg.question, title: ctx.title, url: ctx.url });
        await appendTranscript({ role: 'assistant', text: answer, title: ctx.title, url: ctx.url });
        return { answer };
      }
      case 'explain': {
        const ctx = msg.context || (tabId != null ? await getTabContext(tabId) : null) || {};
        const prompt = `Page title: ${ctx.title || ''}\n\n<page_excerpt>\n${(ctx.script || '').slice(0, 8000)}\n</page_excerpt>\n\nExplain this: ${msg.text}`;
        const explanation = SN.cleanForSpeech(await callAI({ system: EXPLAIN_SYSTEM, prompt, kind: 'answer' }));
        let saved = null;
        if (msg.save) saved = (await saveNote({ kind: 'card', term: msg.text.length <= 80 ? msg.text : '', text: msg.text, definition: explanation, url: ctx.url, title: ctx.title, tags: msg.tags || [] })).note;
        return { explanation, saved };
      }
      case 'quizQuestion': {
        const n = msg.note;
        const prompt = `Saved note (JSON): ${JSON.stringify({ term: n.term, text: n.text, definition: n.definition, note: n.note, source: n.title })}`;
        const raw = await callAI({ system: QUIZ_Q_SYSTEM, prompt, kind: 'answer' });
        return SN.extractJSON(raw) || { question: SN.cleanForSpeech(raw), answer: n.definition || n.note || n.text };
      }
      case 'quizGrade': {
        const prompt = `Question: ${msg.question}\nModel answer: ${msg.expected}\nStudent's spoken answer: ${msg.answer}`;
        const raw = await callAI({ system: QUIZ_GRADE_SYSTEM, prompt, kind: 'answer' });
        return SN.extractJSON(raw) || { result: 'partial', feedback: SN.cleanForSpeech(raw) };
      }
      case 'openIn': {
        const ctx = msg.context || (tabId != null ? await getTabContext(tabId) : null) || {};
        await openInWebAI(msg.target, Object.assign({}, ctx, { question: msg.question }));
        return { ok: true };
      }
      case 'testBackend': return await testBackend();
      case 'injectNow': return await injectIntoOpenTabs();
      case 'hasAllSites': return { allowed: await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false) };
      case 'openChatGPTTab': {
        if (page) return { error: 'not allowed from a web page' };
        const tab = await ensureChatGPTTab();
        await chrome.tabs.update(tab.id, { active: true });
        return { ok: true, tabId: tab.id };
      }
      case 'chatgptDebug': {
        const saved = await chrome.storage.session.get('chatgptTabId');
        const tab = saved.chatgptTabId == null ? null : await chrome.tabs.get(saved.chatgptTabId).catch(() => null);
        if (!tab || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || '')) return { error: 'no ChatGPT tab' };
        try { return Object.assign({ tabId: tab.id, status: tab.status, discarded: tab.discarded }, await chrome.tabs.sendMessage(tab.id, { type: 'chatgpt.debug' })); }
        catch (e) { return { tabId: tab.id, status: tab.status, discarded: tab.discarded, error: String(e.message || e) }; }
      }
      case 'saveNote': return await saveNote(msg.note);
      case 'updateNote': {
        let patch = msg.patch || {};
        if (page) patch = Object.fromEntries(Object.entries(patch).filter(([k]) => CONTENT_SCRIPT_NOTE_FIELDS.includes(k)));
        return await updateNote(msg.id, patch);
      }
      case 'deleteNote': await deleteNote(msg.id); return { ok: true };
      case 'listNotes': return await listNotes();
      case 'setTabContext': if (tabId != null) await setTabContext(tabId, msg.context); return { ok: true };
      case 'getTabContext': return await getTabContext(msg.tabId ?? tabId);
      case 'openPanel': {
        try { await chrome.sidePanel.open({ tabId }); return { ok: true }; }
        catch (e) { return { ok: false, error: String(e.message || e) }; }
      }
      case 'pingHost': return await sendNative({ action: 'ping' });
      case 'activeTab': {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return tab ? { id: tab.id, title: tab.title, url: tab.url } : null;
      }
      case 'toTab': {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) return { ok: false };
        try { return await chrome.tabs.sendMessage(tab.id, msg.payload); } catch (e) { return { ok: false, error: 'No widget on this page' }; }
      }
      default: return { ok: false, error: 'unknown message ' + msg.type };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e.message || e) }));
  return true;
});

// ---------- install: menus + side panel ----------
async function injectIntoOpenTabs() {
  // needs the optional all-sites permission (granted once from Settings); without it, open tabs keep the old widget until refreshed
  const allowed = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  if (!allowed) return { ok: false, reason: 'no all-sites permission' };
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] }).catch(() => []);
  for (const t of tabs) {
    if (!t.id || t.discarded) continue;
    if (/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(t.url || '')) {
      chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['chatgpt-bridge.js'] }).catch(() => {});
      continue;
    }
    chrome.scripting.insertCSS({ target: { tabId: t.id }, files: ['content.css'] }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['lib/Readability.js', 'lib/common.js', 'content.js'] }).catch(() => {});
  }
  return { ok: true, tabs: tabs.length };
}

chrome.runtime.onInstalled.addListener(() => {
  injectIntoOpenTabs().catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'sn-save', title: 'Save to Study Narrator memory', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'sn-explain', title: 'Explain with AI and save as card', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'sn-read-sel', title: 'Read selection aloud', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'sn-read-page', title: 'Read this page (important parts)', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'sn-open-chatgpt', title: 'Discuss this page in ChatGPT', contexts: ['page', 'selection'] });
    chrome.contextMenus.create({ id: 'sn-open-claude', title: 'Discuss this page in Claude.ai', contexts: ['page', 'selection'] });
    chrome.contextMenus.create({ id: 'sn-widget-toggle', title: 'Show / hide the Study Narrator widget', contexts: ['page', 'selection'] });
    chrome.contextMenus.create({ id: 'sn-widget-site', title: 'Hide the widget on this site (click again to allow)', contexts: ['page', 'selection'] });
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

function toTab(tabId, payload) { chrome.tabs.sendMessage(tabId, payload).catch(() => {}); }

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const map = { 'sn-save': 'saveSelection', 'sn-explain': 'explainSelection', 'sn-read-sel': 'readSelection', 'sn-read-page': 'readPage', 'sn-open-chatgpt': 'openChatGPT', 'sn-open-claude': 'openClaude', 'sn-widget-toggle': 'toggleWidget', 'sn-widget-site': 'toggleSiteWidget' };
  toTab(tab.id, { type: 'command', command: map[info.menuItemId], selection: info.selectionText || '' });
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  const map = { 'read-toggle': 'readToggle', 'ask': 'ask', 'save-selection': 'saveSelection' };
  toTab(tab.id, { type: 'command', command: map[command] });
});
