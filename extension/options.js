const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r)));
let settings;

const FIELDS = {
  text: ['account', 'codexAccount', 'codexNarrationModel', 'codexAnswerModel', 'apiKey', 'apiNarrationModel', 'apiAnswerModel', 'openaiBaseUrl', 'openaiKey', 'openaiNarrationModel', 'openaiAnswerModel', 'geminiKey', 'geminiNarrationModel', 'geminiAnswerModel'],
  select: ['backend', 'narrationModel', 'answerModel', 'style', 'side'],
  check: ['chatgptTemporary', 'autoResume', 'widgetEnabled'],
};
const MAP = { style: 'narrationStyle', side: 'widgetSide' };
const key = (id) => MAP[id] || id;

function fillVoices() {
  if (!settings) return;
  const voices = speechSynthesis.getVoices();
  const auto = SN.pickVoice(voices, '');
  const sel = $('#voice');
  sel.innerHTML = `<option value="">Automatic${auto ? ' (' + SN.escapeHtml(auto.name) + ')' : ''}</option>` +
    voices.slice().sort((a, b) => (/Natural/i.test(b.name) - /Natural/i.test(a.name)) || a.name.localeCompare(b.name))
      .map(v => `<option value="${SN.escapeHtml(v.name)}">${SN.escapeHtml(v.name)} (${SN.escapeHtml(v.lang)})</option>`).join('');
  sel.value = settings.voiceName || '';
}
speechSynthesis.addEventListener('voiceschanged', fillVoices);

function showBackendBox() {
  const b = $('#backend').value;
  document.querySelectorAll('.box').forEach(x => x.classList.toggle('on', x.id === 'box-' + b));
}

async function load() {
  settings = await SN.getSettings();
  const secrets = await SN.getSecrets();
  if (settings.backend === 'native') settings.backend = 'claude-code';
  if (settings.backend === 'api') settings.backend = 'anthropic-api';
  fillVoices();
  for (const id of FIELDS.text) $('#' + id).value = ['apiKey', 'openaiKey', 'geminiKey'].includes(id) ? (secrets[id] ?? '') : (settings[key(id)] ?? '');
  for (const id of FIELDS.select) $('#' + id).value = settings[key(id)] ?? '';
  for (const id of FIELDS.check) $('#' + id).checked = !!settings[key(id)];
  $('#rate').value = settings.rate; $('#rateVal').textContent = settings.rate + '×';
  showBackendBox();
  navigator.permissions?.query({ name: 'microphone' }).then(p => { $('#micStatus').textContent = 'Status: ' + p.state; }).catch(() => {});
}

function collect() {
  const out = { voiceName: $('#voice').value, rate: Number($('#rate').value) };
  for (const id of FIELDS.text) out[key(id)] = $('#' + id).value.trim();
  for (const k of ['account', 'codexAccount']) if (!out[k]) out[k] = 'default';
  for (const id of FIELDS.select) out[key(id)] = $('#' + id).value;
  for (const id of FIELDS.check) out[key(id)] = $('#' + id).checked;
  for (const k of ['apiNarrationModel', 'apiAnswerModel', 'openaiBaseUrl', 'openaiNarrationModel', 'openaiAnswerModel', 'geminiNarrationModel', 'geminiAnswerModel', 'codexNarrationModel', 'codexAnswerModel']) if (!out[k]) out[k] = SN.DEFAULTS[k];
  return out;
}

async function ensureHostPermission(baseUrl) {
  try {
    const origin = new URL(baseUrl).origin + '/*';
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) return chrome.permissions.request({ origins: [origin] });
    return true;
  } catch (_) { return false; }
}

async function save() {
  const s = collect();
  const secrets = {};
  for (const id of ['apiKey', 'openaiKey', 'geminiKey']) secrets[id] = s[id];
  for (const id of ['apiKey', 'openaiKey', 'geminiKey']) delete s[id];
  if (s.backend === 'openai-api') {
    const ok = await ensureHostPermission(s.openaiBaseUrl);
    if (!ok) { $('#saved').textContent = 'Saved, but permission for that endpoint was not granted.'; }
  }
  await SN.saveSettings(s);
  await SN.saveSecrets(secrets);
  $('#saved').textContent = $('#saved').textContent || 'Saved.'; setTimeout(() => { $('#saved').textContent = ''; }, 2500);
  return s;
}

$('#resetWidget').addEventListener('click', async () => { await chrome.storage.local.remove(['widgetState', 'widgetHiddenSites']); $('#resetStatus').textContent = 'Reset. Pages pick it up immediately.'; });
async function refreshAllSites() { const r = await send({ type: 'hasAllSites' }); $('#allSitesStatus').textContent = r?.allowed ? 'Allowed. Open tabs get new versions automatically.' : 'Not allowed yet.'; $('#allSitesStatus').className = r?.allowed ? 'ok' : 'muted'; return !!r?.allowed; }
$('#allowAllSites').addEventListener('click', async () => {
  let ok = false;
  try { ok = await chrome.permissions.request({ origins: ['<all_urls>'] }); } catch (e) { $('#allSitesStatus').textContent = 'Could not request: ' + e.message; return; }
  if (ok) { const r = await send({ type: 'injectNow' }); $('#allSitesStatus').textContent = `Allowed. Updated the widget in ${r?.tabs ?? 0} open tab(s).`; $('#allSitesStatus').className = 'ok'; }
  else { $('#allSitesStatus').textContent = 'Permission was declined.'; }
});
refreshAllSites();
$('#backend').addEventListener('change', showBackendBox);
$('#rate').addEventListener('input', () => { $('#rateVal').textContent = $('#rate').value + '×'; });
$('#save').addEventListener('click', save);

$('#testBtn').addEventListener('click', async () => {
  await save();
  $('#testStatus').textContent = 'Testing… (CLI backends take 5–20 s)'; $('#testStatus').className = 'muted';
  const r = await send({ type: 'testBackend' });
  if (r?.ok) { $('#testStatus').textContent = `Works. ${r.backend} replied in ${(r.ms / 1000).toFixed(1)} s: "${r.text}"`; $('#testStatus').className = 'ok'; }
  else { $('#testStatus').textContent = r?.error || 'No reply'; $('#testStatus').className = 'bad'; }
});

$('#chatgptDebug').addEventListener('click', async () => { $('#chatgptDebugOut').textContent = 'DEBUG: …'; const r = await send({ type: 'chatgptDebug' }); $('#chatgptDebugOut').textContent = 'DEBUG: ' + JSON.stringify(r); });
$('#openChatGPTTab').addEventListener('click', () => send({ type: 'openChatGPTTab' }));

$('#testVoice').addEventListener('click', () => {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance('Hi. This is the voice Study Narrator will use to read your course material and answer your questions.');
  const v = SN.pickVoice(speechSynthesis.getVoices(), $('#voice').value); if (v) u.voice = v;
  u.rate = Number($('#rate').value); window.__u = u; speechSynthesis.speak(u);
});

$('#micBtn').addEventListener('click', async () => {
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); $('#micStatus').textContent = 'Microphone allowed.'; $('#micStatus').className = 'ok'; }
  catch (e) { $('#micStatus').textContent = 'Not allowed: ' + e.message; $('#micStatus').className = 'bad'; }
});

load();
