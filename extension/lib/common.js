// Shared helpers for Study Narrator (loaded by the service worker, content script and pages).
(function (root) {
  const SN = {};

  SN.DEFAULTS = {
    // backend: 'claude-code' | 'codex' | 'chatgpt-web' | 'anthropic-api' | 'openai-api' | 'gemini-api'
    backend: 'claude-code',
    account: 'default',         // Claude Code profile on the host: 'default' (your normal login) or a name from the host's config.json
    narrationModel: 'haiku',
    answerModel: 'sonnet',
    codexAccount: 'default',    // Codex profile on the host: 'default' or a name from the host's config.json
    codexNarrationModel: '',    // '' = the Codex CLI's default model
    codexAnswerModel: '',
    chatgptModel: '',
    chatgptTemporary: true,     // use ChatGPT temporary chats so study sessions do not clutter history
    apiKey: '',                 // Anthropic API
    apiNarrationModel: 'claude-haiku-5-5',
    apiAnswerModel: 'claude-sonnet-5-5',
    openaiKey: '', openaiBaseUrl: 'https://api.openai.com/v1', openaiNarrationModel: 'gpt-5-mini', openaiAnswerModel: 'gpt-5',
    geminiKey: '', geminiNarrationModel: 'gemini-2.5-flash', geminiAnswerModel: 'gemini-2.5-pro',
    voiceName: '',              // '' = best natural voice available
    rate: 1.05,
    autoResume: true,           // resume narration after an answer
    narrationStyle: 'focused',  // 'focused' (important parts) or 'full' (everything, cleaned)
    widgetEnabled: true,
    widgetSide: 'right',
  };

  SN.SECRET_KEYS = ['apiKey', 'openaiKey', 'geminiKey'];

  SN.validBaseUrl = (u) => {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    } catch (_) { return false; }
  };

  SN.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  SN.getSettings = async () => {
    const got = await chrome.storage.local.get('settings');
    const settings = Object.assign({}, SN.DEFAULTS, got.settings || {});
    for (const key of SN.SECRET_KEYS) delete settings[key];
    return settings;
  };
  SN.saveSettings = async (patch) => {
    const cur = await SN.getSettings();
    const safePatch = Object.assign({}, patch);
    for (const key of SN.SECRET_KEYS) delete safePatch[key];
    const next = Object.assign({}, cur, safePatch);
    await chrome.storage.local.set({ settings: next });
    return next;
  };

  SN.getSecrets = async () => {
    const got = await chrome.storage.local.get(['settings', 'secrets']);
    const settings = Object.assign({}, got.settings || {});
    const secrets = Object.assign({ apiKey: '', openaiKey: '', geminiKey: '' }, got.secrets || {});
    let migrated = false;
    for (const key of SN.SECRET_KEYS) {
      if (Object.prototype.hasOwnProperty.call(settings, key)) {
        if (!got.secrets || !Object.prototype.hasOwnProperty.call(got.secrets, key)) secrets[key] = settings[key];
        delete settings[key];
        migrated = true;
      }
    }
    if (migrated) await chrome.storage.local.set({ settings, secrets });
    return secrets;
  };
  SN.saveSecrets = async (patch) => {
    const got = await chrome.storage.local.get('secrets');
    const secrets = Object.assign({ apiKey: '', openaiKey: '', geminiKey: '' }, got.secrets || {});
    for (const key of SN.SECRET_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch || {}, key)) secrets[key] = patch[key];
    }
    await chrome.storage.local.set({ secrets });
    return secrets;
  };

  // Split narration text into speakable sentences (keeps them short so the browser's TTS never stalls).
  SN.splitSentences = (text) => {
    const out = [];
    const paras = String(text || '').replace(/\r/g, '').split(/\n+/);
    for (const p of paras) {
      const t = p.trim();
      if (!t) continue;
      const parts = t.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || [t];
      let buf = '';
      for (let s of parts) {
        s = s.trim();
        if (!s) continue;
        if ((buf + ' ' + s).length > 260 && buf) { out.push(buf); buf = s; }
        else buf = buf ? buf + ' ' + s : s;
      }
      if (buf) out.push(buf);
    }
    return out;
  };

  // Light cleanup so the voice does not read symbols or markdown.
  SN.cleanForSpeech = (text) => String(text || '')
    .replace(/```[\s\S]*?```/g, ' code example omitted. ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_]{1,3}([^*_\n]+)[*_]{1,3}/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Pick the most natural voice the browser offers. Edge exposes "Microsoft X Online (Natural)".
  SN.pickVoice = (voices, preferredName) => {
    if (!voices || !voices.length) return null;
    if (preferredName) {
      const v = voices.find(v => v.name === preferredName);
      if (v) return v;
    }
    const score = (v) => {
      let s = 0;
      const n = v.name;
      if (/Online \(Natural\)/i.test(n)) s += 100;
      if (/Natural/i.test(n)) s += 40;
      if (/Multilingual/i.test(n)) s += 10;
      if (/Andrew/i.test(n)) s += 8; else if (/Ava|Brian|Emma/i.test(n)) s += 6;
      if (/^en/i.test(v.lang)) s += 20;
      if (/en-US/i.test(v.lang)) s += 5;
      if (/Google/i.test(n)) s += 15;
      if (/David|Zira|Mark/i.test(n) && !/Natural/i.test(n)) s -= 10;
      return s;
    };
    return voices.slice().sort((a, b) => score(b) - score(a))[0];
  };

  // Robust JSON extraction from a model reply (handles ```json fences and leading prose).
  SN.extractJSON = (text) => {
    if (!text) return null;
    let t = String(text).trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    try { return JSON.parse(t); } catch (_) { /* fall through */ }
    const start = t.indexOf('{'); const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { /* ignore */ }
    }
    return null;
  };

  // Spaced repetition (SM-2 style). grade: 0 again, 1 hard, 2 good, 3 easy.
  SN.srsRate = (srs, grade) => {
    const s = Object.assign({ reps: 0, interval: 0, ease: 2.5, due: 0 }, srs || {});
    const day = 86400000;
    if (grade === 0) { s.reps = 0; s.interval = 0; s.ease = Math.max(1.3, s.ease - 0.2); s.due = Date.now() + 10 * 60000; return s; }
    if (s.reps === 0) s.interval = grade === 3 ? 4 : 1;
    else if (s.reps === 1) s.interval = grade === 3 ? 7 : 3;
    else s.interval = Math.round(s.interval * s.ease * (grade === 1 ? 0.7 : grade === 3 ? 1.3 : 1));
    s.ease = Math.max(1.3, s.ease + (grade === 1 ? -0.15 : grade === 3 ? 0.15 : 0));
    s.reps += 1;
    s.due = Date.now() + s.interval * day;
    return s;
  };

  SN.hash = (str) => {
    let h = 0; const s = String(str || '');
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(36);
  };

  // SHA-256 hex digest; used where a collision would matter (the narration cache key).
  SN.sha256 = async (str) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str ?? '')));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  };

  SN.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  root.SN = SN;
})(typeof self !== 'undefined' ? self : globalThis);
