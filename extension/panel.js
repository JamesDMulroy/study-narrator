// Study Narrator side panel: memory list, spaced-repetition review, voice quiz, chat.
const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r)));
let settings = Object.assign({}, SN.DEFAULTS);
let notes = [];

// ---------- tabs ----------
document.querySelectorAll('header button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('header button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('main section').forEach(s => s.classList.toggle('on', s.id === b.dataset.tab));
  if (b.dataset.tab === 'review') renderDue();
  if (b.dataset.tab === 'chat') renderChat();
}));

// ---------- speech (panel has its own voice) ----------
let voice = null;
function pickVoice() { voice = SN.pickVoice(speechSynthesis.getVoices(), settings.voiceName); }
speechSynthesis.addEventListener('voiceschanged', pickVoice);
function speak(text, onEnd) {
  speechSynthesis.cancel();
  const parts = SN.splitSentences(SN.cleanForSpeech(text)); let i = 0;
  const step = () => {
    if (i >= parts.length) { onEnd && onEnd(); return; }
    const u = new SpeechSynthesisUtterance(parts[i++]);
    if (!voice) pickVoice(); if (voice) u.voice = voice; u.rate = Number(settings.rate) || 1;
    u.onend = step; u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') step(); };
    window.__u = u; setTimeout(() => speechSynthesis.speak(u), 30);
  };
  step();
}
function listen(onText, onErr) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return onErr('Voice input is not available here. Type instead.');
  const rec = new SR(); rec.lang = navigator.language || 'en-US'; rec.interimResults = true; let fin = '';
  rec.onresult = (e) => { let interim = ''; for (let i = e.resultIndex; i < e.results.length; i++) { if (e.results[i].isFinal) fin += e.results[i][0].transcript; else interim += e.results[i][0].transcript; } onText((fin + ' ' + interim).trim(), false); };
  rec.onerror = (e) => onErr(e.error === 'not-allowed' ? 'Microphone not allowed for the extension yet. Open Settings and click "Allow microphone".' : 'Voice error: ' + e.error);
  rec.onend = () => { if (fin.trim()) onText(fin.trim(), true); else onErr('Did not catch that.'); };
  rec.start();
  return rec;
}

// ---------- memory ----------
async function load() { settings = await SN.getSettings(); pickVoice(); notes = await send({ type: 'listNotes' }); if (!Array.isArray(notes)) notes = []; renderList(); renderDue(); }
function tagsOf() { const s = new Set(); notes.forEach(n => (n.tags || []).forEach(t => s.add(t))); return [...s].sort(); }
function renderList() {
  const q = $('#search').value.trim().toLowerCase(); const tag = $('#tagFilter').value;
  const tf = $('#tagFilter'); const cur = tf.value; tf.innerHTML = '<option value="">All tags</option>' + tagsOf().map(t => `<option ${t === cur ? 'selected' : ''}>${SN.escapeHtml(t)}</option>`).join('');
  const shown = notes.filter(n => (!tag || (n.tags || []).includes(tag)) && (!q || [n.term, n.text, n.definition, n.note, n.title, ...(n.tags || [])].join(' ').toLowerCase().includes(q)));
  $('#count').textContent = `${shown.length} of ${notes.length} saved` + (notes.length ? ` · ${notes.filter(n => (n.srs?.due || 0) <= Date.now()).length} due for review` : '');
  const list = $('#list'); list.innerHTML = '';
  if (!notes.length) { list.innerHTML = '<p class="muted">Nothing saved yet. Highlight text on any page and press Alt+S, use the ★ Save button, or right-click a selection. Key terms Claude finds while reading can be saved with one click.</p>'; return; }
  for (const n of shown) {
    const d = document.createElement('div'); d.className = 'note'; d.dataset.id = n.id;
    const title = n.term || (n.kind === 'card' ? 'Card' : n.kind === 'note' ? 'Note' : 'Highlight');
    const body = n.definition ? (n.term ? n.definition : (n.text + '\n\n' + n.definition)) : n.text;
    d.innerHTML = `<div class="t">${SN.escapeHtml(title)}</div><div class="d">${SN.escapeHtml(body)}</div>` +
      (n.note ? `<div class="d muted">${SN.escapeHtml(n.note)}</div>` : '') +
      `<div class="m">${(n.tags || []).map(t => `<span class="tag">${SN.escapeHtml(t)}</span>`).join('')}${/^(https?|file):/i.test(n.url || '') ? `<a href="${SN.escapeHtml(n.url)}" target="_blank" rel="noopener noreferrer" title="${SN.escapeHtml(n.url)}">${SN.escapeHtml(n.title || n.url)}</a>` : ''}<span>${new Date(n.created).toLocaleDateString()}</span></div>` +
      `<div class="tools"><button class="btn ghost" data-a="speak">🔊</button><button class="btn ghost" data-a="explain">${n.definition ? 'Re-explain' : 'Explain'}</button><button class="btn ghost" data-a="note">Note</button><button class="btn ghost" data-a="tag">Tag</button><button class="btn ghost" data-a="del">Delete</button></div>`;
    d.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-a]'); if (!b) return;
      const a = b.dataset.a;
      if (a === 'speak') speak((n.term ? n.term + '. ' : '') + body);
      else if (a === 'explain') { b.disabled = true; b.textContent = 'Asking…'; const ctx = await send({ type: 'activeTab' }).then(t => t?.id != null ? send({ type: 'getTabContext', tabId: t.id }) : null); const r = await send({ type: 'explain', text: n.term || n.text, save: false, context: ctx || { title: n.title, script: '' } }); if (r?.explanation) { await send({ type: 'updateNote', id: n.id, patch: { definition: r.explanation, kind: 'card', term: n.term || (n.text.length <= 80 ? n.text : '') } }); speak(r.explanation); await load(); } else { b.textContent = 'Failed'; b.disabled = false; } }
      else if (a === 'note') { const v = prompt('Your note for this item:', n.note || ''); if (v !== null) { await send({ type: 'updateNote', id: n.id, patch: { note: v } }); await load(); } }
      else if (a === 'tag') { const v = prompt('Tags (comma separated):', (n.tags || []).join(', ')); if (v !== null) { await send({ type: 'updateNote', id: n.id, patch: { tags: v.split(',').map(s => s.trim()).filter(Boolean) } }); await load(); } }
      else if (a === 'del') { if (confirm('Delete this item?')) { await send({ type: 'deleteNote', id: n.id }); await load(); } }
    });
    list.appendChild(d);
  }
}
$('#search').addEventListener('input', renderList);
$('#tagFilter').addEventListener('change', renderList);
$('#addBtn').addEventListener('click', addTyped);
$('#newText').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTyped(); });
async function addTyped() {
  const v = $('#newText').value.trim(); if (!v) return;
  const tab = await send({ type: 'activeTab' });
  await send({ type: 'saveNote', note: { kind: v.length <= 80 ? 'card' : 'highlight', term: v.length <= 80 ? v : '', text: v, url: tab?.url || '', title: tab?.title || '', tags: ['manual'] } });
  $('#newText').value = ''; await load();
}
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.notes || ch.settings)) load(); if (area === 'local' && ch.transcript && $('#chat').classList.contains('on')) renderChat(); });

// ---------- review ----------
let queue = [], current = null;
function due() { return notes.filter(n => (n.srs?.due || 0) <= Date.now()); }
function renderDue() {
  const d = due();
  $('#dueInfo').textContent = notes.length ? `${d.length} due now · ${notes.length} total. Grades schedule the next review (spaced repetition).` : 'Save some terms or highlights first.';
  $('#startReview').disabled = !notes.length;
  $('#quizVoice').disabled = !notes.length;
}
$('#startReview').addEventListener('click', () => { queue = due(); if (!queue.length) queue = notes.slice().sort(() => Math.random() - 0.5).slice(0, 10); nextCard(); });
$('#stopSpeak').addEventListener('click', () => speechSynthesis.cancel());
function front(n) { return n.term ? `What does "${n.term}" mean?` : `What do you remember about this?\n\n${n.text.slice(0, 220)}${n.text.length > 220 ? '…' : ''}`; }
function back(n) { return n.definition || n.note || n.text; }
function nextCard() {
  const area = $('#reviewArea');
  current = queue.shift();
  if (!current) { area.innerHTML = '<p class="muted">Review done. Nice work.</p>'; renderDue(); return; }
  area.innerHTML = `<div class="card q">${SN.escapeHtml(front(current))}</div><div class="row"><button class="btn" id="reveal">Show answer</button><button class="btn ghost" id="sayQ">🔊</button></div><div class="muted">${queue.length} left</div>`;
  $('#sayQ').onclick = () => speak(front(current));
  $('#reveal').onclick = () => {
    area.innerHTML = `<div class="card q">${SN.escapeHtml(front(current))}</div><div class="card">${SN.escapeHtml(back(current))}</div><div class="grades"><button class="btn ghost" data-g="0">Again</button><button class="btn ghost" data-g="1">Hard</button><button class="btn" data-g="2">Good</button><button class="btn" data-g="3">Easy</button></div><div class="muted">${queue.length} left</div>`;
    area.querySelectorAll('[data-g]').forEach(b => b.onclick = () => grade(Number(b.dataset.g)));
    speak(back(current));
  };
}
async function grade(g) { await send({ type: 'updateNote', id: current.id, patch: { srs: SN.srsRate(current.srs, g) } }); notes = await send({ type: 'listNotes' }); nextCard(); }

// Voice quiz: Claude writes a question from a note, speaks it, listens, grades.
$('#quizVoice').addEventListener('click', voiceQuiz);
async function voiceQuiz() {
  const pool = due().length ? due() : notes;
  current = pool[Math.floor(Math.random() * pool.length)];
  const area = $('#reviewArea');
  area.innerHTML = '<div class="card">Claude is writing a question…</div>';
  const q = await send({ type: 'quizQuestion', note: current });
  if (!q || q.error || !q.question) { area.innerHTML = `<div class="err">${SN.escapeHtml(q?.error || 'Could not get a question')}</div>`; return; }
  area.innerHTML = `<div class="card q">${SN.escapeHtml(q.question)}</div><div class="card" id="ans">Listening after the question…</div><div class="row"><button class="btn live" id="mic">● Listening</button><button class="btn ghost" id="skip">Skip</button></div><div class="row"><input id="typed" placeholder="…or type your answer"><button class="btn" id="typedSend">Send</button></div>`;
  let rec = null;
  const submit = async (answer) => {
    if (rec) { try { rec.abort(); } catch (_) { /* ignore */ } rec = null; }
    $('#ans').textContent = 'You: ' + answer + '\n\nGrading…';
    const g = await send({ type: 'quizGrade', question: q.question, expected: q.answer, answer });
    const result = g?.result || 'partial';
    const fb = g?.feedback || g?.error || '';
    $('#ans').textContent = `You: ${answer}\n\n${result.toUpperCase()}: ${fb}\n\nModel answer: ${q.answer}`;
    speak(fb + (result === 'incorrect' ? ' The answer is: ' + q.answer : ''));
    const gradeMap = { correct: 2, partial: 1, incorrect: 0 };
    await send({ type: 'updateNote', id: current.id, patch: { srs: SN.srsRate(current.srs, gradeMap[result] ?? 1) } });
    notes = await send({ type: 'listNotes' });
    area.insertAdjacentHTML('beforeend', '<div class="row"><button class="btn" id="again">Next question</button></div>');
    $('#again').onclick = voiceQuiz;
  };
  const startMic = () => { rec = listen((t, final) => { $('#ans').textContent = t; if (final) submit(t); }, (err) => { $('#ans').textContent = err; $('#mic').classList.remove('live'); $('#mic').textContent = '🎤 Try again'; }); };
  $('#mic').onclick = () => { if (rec) { try { rec.abort(); } catch (_) { /* ignore */ } rec = null; } $('#mic').classList.add('live'); $('#mic').textContent = '● Listening'; startMic(); };
  $('#skip').onclick = voiceQuiz;
  $('#typedSend').onclick = () => { const v = $('#typed').value.trim(); if (v) submit(v); };
  $('#typed').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#typedSend').click(); });
  speak(q.question, startMic);
}

// ---------- chat ----------
async function renderChat() {
  const t = (await chrome.storage.local.get('transcript')).transcript || [];
  const log = $('#chatLog'); log.innerHTML = '';
  for (const m of t.slice(-60)) { const d = document.createElement('div'); d.className = 'msg ' + m.role; d.textContent = m.text; log.appendChild(d); }
  log.scrollTop = log.scrollHeight;
}
async function chatAsk(q) {
  if (!q) return;
  $('#chatErr').textContent = ''; $('#chatSend').disabled = true;
  const tab = await send({ type: 'activeTab' });
  let ctx = tab?.id != null ? await send({ type: 'getTabContext', tabId: tab.id }) : null;
  if (!ctx) ctx = { title: tab?.title || '', url: tab?.url || '', script: '' };
  const hist = ((await chrome.storage.local.get('transcript')).transcript || []).slice(-8);
  const r = await send({ type: 'ask', question: q, context: ctx, history: hist, tabId: tab?.id });
  $('#chatSend').disabled = false;
  if (!r || r.error) { $('#chatErr').textContent = r?.error || 'No answer'; return; }
  await renderChat(); speak(r.answer);
}
$('#chatSend').addEventListener('click', () => { const v = $('#chatQ').value.trim(); $('#chatQ').value = ''; chatAsk(v); });
$('#chatQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#chatSend').click(); });
$('#chatMic').addEventListener('click', () => { $('#chatMic').classList.add('live'); listen((t, final) => { $('#chatQ').value = t; if (final) { $('#chatMic').classList.remove('live'); chatAsk(t); $('#chatQ').value = ''; } }, (err) => { $('#chatMic').classList.remove('live'); $('#chatErr').textContent = err; }); });
$('#clearChat').addEventListener('click', async () => { await chrome.storage.local.set({ transcript: [] }); renderChat(); });

// ---------- more ----------
function download(name, text, type = 'text/plain') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
$('#exportMd').addEventListener('click', () => {
  const by = {}; notes.forEach(n => { (by[n.title || n.url || 'Untitled'] ||= []).push(n); });
  let md = '# Study Narrator memory\n\n';
  for (const [src, items] of Object.entries(by)) {
    md += `## ${src}\n` + (items[0].url ? `${items[0].url}\n\n` : '\n');
    for (const n of items) md += (n.term ? `- **${n.term}**: ${n.definition || n.text}` : `- ${n.text}${n.definition ? `\n  - ${n.definition}` : ''}`) + (n.note ? `\n  - Note: ${n.note}` : '') + ((n.tags || []).length ? ` _(${n.tags.join(', ')})_` : '') + '\n';
    md += '\n';
  }
  download('study-narrator-memory.md', md, 'text/markdown');
});
$('#exportJson').addEventListener('click', () => download('study-narrator-memory.json', JSON.stringify(notes, null, 2), 'application/json'));
$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const arr = JSON.parse(await f.text()); let added = 0; for (const n of arr) { const r = await send({ type: 'saveNote', note: n }); if (r && !r.duplicate && !r.error) added++; } alert(`Imported ${added} items`); await load(); } catch (err) { alert('Import failed: ' + err.message); }
});
$('#openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#showWidget').addEventListener('click', () => send({ type: 'toTab', payload: { type: 'command', command: 'showWidget' } }));
$('#resetWidget').addEventListener('click', async () => { await chrome.storage.local.remove('widgetState'); send({ type: 'toTab', payload: { type: 'command', command: 'resetWidget' } }); });
$('#readSel').addEventListener('click', () => send({ type: 'toTab', payload: { type: 'command', command: 'readSelection' } }));
send({ type: 'pingHost' }).then(r => { $("#hostInfo").textContent = r?.ok ? `Local AI host v${r.version}: claude ${r.claude_found ? "found" : "missing"}, codex ${r.codex_found ? "found" : "missing"}` : "Local AI host: " + (r?.error || "not reachable"); });

load();
