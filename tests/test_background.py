"""Unit checks of the service worker's narration port, run in Node with a stand-in `chrome` object.

No browser and no AI tool are needed:
    python -m pytest tests/test_background.py
Covers: a tab is freed as soon as its narration port disconnects (S-11), the chunk loop stops for a page
that has gone, and the narration cache key is a SHA-256 of the full text (S-12).
"""
import json
import os
import shutil
import subprocess

import pytest

EXT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

HARNESS = r"""
const fs = require('fs'), path = require('path'), vm = require('vm');
const EXT = process.argv[2];
const listeners = {};
const on = (name) => ({ addListener: (fn) => { (listeners[name] = listeners[name] || []).push(fn); } });
const store = {};
const native = []; // pending native-host calls: {msg, reply}
const chrome = {
  runtime: { id: 'ext', lastError: null, getURL: (p) => 'chrome-extension://ext/' + p,
    onConnect: on('connect'), onMessage: on('message'), onInstalled: on('installed'),
    sendNativeMessage: (host, msg, cb) => native.push({ msg, reply: cb }) },
  storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) },
             session: { get: async (k) => ({ [k]: store['s:' + k] }), set: async (o) => { for (const k in o) store['s:' + k] = o[k]; } } },
  tabs: { onRemoved: on('tabRemoved'), sendMessage: async () => {} },
  contextMenus: { onClicked: on('menu'), removeAll: () => {}, create: () => {} },
  commands: { onCommand: on('command') },
  sidePanel: { setPanelBehavior: async () => {} },
};
const ctx = { chrome, console, crypto: globalThis.crypto, TextEncoder, URL, setTimeout, clearTimeout, fetch: async () => { throw new Error('no network'); } };
ctx.self = ctx; ctx.globalThis = ctx;
ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx); };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx);

function makePort(tabId) {
  const port = { name: 'narrate', sender: { id: 'ext', tab: { id: tabId }, url: 'https://example.com/a' },
    sent: [], msgFns: [], discFns: [],
    postMessage(m) { if (port.closed) throw new Error('closed'); port.sent.push(m); },
    onMessage: { addListener: (fn) => port.msgFns.push(fn) },
    onDisconnect: { addListener: (fn) => port.discFns.push(fn) } };
  for (const fn of listeners.connect) fn(port);
  return port;
}
const tick = () => new Promise(r => setTimeout(r, 20));
const errors = (p) => p.sent.filter(m => m.type === 'error').map(m => m.error);

(async () => {
  const out = {};
  const text = 'Sentence one. '.repeat(1200); // several chunks
  // 1. First narration starts; the AI call is in flight.
  const a = makePort(7);
  a.msgFns.forEach(f => f({ type: 'prepare', title: 't', url: 'https://example.com/a', text }));
  await tick();
  out.callsBefore = native.length;
  // 2. The page navigates: the port disconnects. A new Read on the same tab must be accepted at once.
  a.closed = true; a.discFns.forEach(f => f());
  const b = makePort(7);
  b.msgFns.forEach(f => f({ type: 'prepare', title: 't', url: 'https://example.com/b', text: 'Short page.' }));
  await tick();
  out.secondErrors = errors(b);
  out.callsAfterSecond = native.length;
  // 3. The first page's AI call returns: its loop must stop, not ask for the next chunk.
  native[0].reply({ ok: true, text: '{"script":"x","terms":[]}' });
  await tick();
  out.callsAfterFirstReturn = native.length;
  // 4. Finish the second narration; its cache key is a SHA-256 hex digest.
  native[1].reply({ ok: true, text: '{"script":"Short page.","terms":[]}' });
  await tick();
  out.secondDone = b.sent.some(m => m.type === 'done');
  out.cacheKeys = Object.keys(store.narrationCache || {});
  // 5. While b's tab is busy, a second port on the same tab is still refused.
  const c = makePort(9), d = makePort(9);
  c.msgFns.forEach(f => f({ type: 'prepare', title: 't', url: 'u', text: 'Another page.' }));
  await tick();
  d.msgFns.forEach(f => f({ type: 'prepare', title: 't', url: 'u', text: 'Another page.' }));
  await tick();
  out.busyErrors = errors(d);
  process.stdout.write(JSON.stringify(out));
})().catch(e => { console.error(e); process.exit(1); });
"""


@pytest.fixture(scope="module")
def result(tmp_path_factory):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    script = tmp_path_factory.mktemp("bg") / "harness.js"
    script.write_text(HARNESS, encoding="utf-8")
    p = subprocess.run([node, str(script), EXT], capture_output=True, text=True, timeout=60,
                       creationflags=NO_WINDOW)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def test_disconnect_frees_the_tab(result):
    assert result["callsBefore"] == 1
    assert result["secondErrors"] == []
    assert result["callsAfterSecond"] == 2


def test_closed_port_stops_the_chunk_loop(result):
    assert result["callsAfterFirstReturn"] == 2


def test_cache_key_is_full_sha256(result):
    assert result["secondDone"] is True
    assert len(result["cacheKeys"]) == 1
    key = result["cacheKeys"][0]
    assert key.startswith("n2:") and len(key) == 3 + 64
    int(key[3:], 16)


def test_busy_tab_still_refused(result):
    assert result["busyErrors"] == ["A narration is already being prepared for this tab."]
