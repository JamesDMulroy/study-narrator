"""Checks that the ChatGPT bridge reuses only its session-owned tab."""
import json
import os
import shutil
import subprocess

import pytest

EXT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

HARNESS = r"""
const fs = require('fs'), path = require('path'), vm = require('vm');
const EXT = process.argv[2], scenario = process.argv[3], listeners = {}, store = {}, tabs = new Map();
const initial = scenario === 'restart' ? { url: 'https://chatgpt.com/?temporary-chat=true#study-narrator', pinned: true } : scenario === 'unpinned' ? { url: 'https://chatgpt.com/#study-narrator', pinned: false } : { url: 'https://chatgpt.com/', pinned: true };
tabs.set(10, { id: 10, ...initial, status: 'complete' });
let nextId = 11, created = [], navigated = [];
const on = n => ({ addListener: fn => (listeners[n] = fn) });
const chrome = {
  runtime: { id: 'ext', getURL: p => 'chrome-extension://ext/' + p, onConnect: on('connect'), onMessage: on('message'), onInstalled: on('installed') },
  storage: { session: { get: async k => ({ [k]: store[k] }), set: async o => Object.assign(store, o) }, local: { get: async () => ({}), set: async () => {} } },
  tabs: {
    onUpdated: { addListener: () => {}, removeListener: () => {} }, onRemoved: { addListener: () => {} },
    get: async id => { if (!tabs.has(id)) throw new Error('missing'); return tabs.get(id); },
    query: async q => [...tabs.values()].filter(t => !q.pinned || t.pinned),
    create: async o => { const t = { ...o, id: nextId++, status: 'complete' }; tabs.set(t.id, t); created.push(t.id); return t; },
    update: async (id, o) => { const t = tabs.get(id); if (o.url) navigated.push(id); Object.assign(t, o); return t; },
    sendMessage: async () => ({ ready: true }),
  },
  contextMenus: { onClicked: on('menu'), removeAll: () => {}, create: () => {} },
  commands: { onCommand: on('command') }, sidePanel: { setPanelBehavior: async () => {} },
};
const ctx = { chrome, console, crypto: globalThis.crypto, TextEncoder, URL, setTimeout, clearTimeout, fetch: async () => {} };
ctx.self = ctx; ctx.globalThis = ctx; ctx.importScripts = (...files) => files.forEach(f => vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx));
vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx);
const send = () => new Promise(resolve => listeners.message({ type: 'openChatGPTTab' }, { id: 'ext', url: 'chrome-extension://ext/options.html' }, resolve));
(async () => {
  const first = await send();
  const afterFirst = { first, created: [...created], navigated: [...navigated], stored: store.chatgptTabId };
  const second = await send();
  process.stdout.write(JSON.stringify({ afterFirst, second, created, navigated }));
})().catch(e => { console.error(e); process.exit(1); });
"""


@pytest.fixture(scope="module")
def result(tmp_path_factory):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    script = tmp_path_factory.mktemp("chatgpt") / "harness.js"
    script.write_text(HARNESS, encoding="utf-8")
    p = subprocess.run([node, str(script), EXT], capture_output=True, text=True, timeout=60,
                       creationflags=NO_WINDOW)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def run_scenario(tmp_path_factory, scenario):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    script = tmp_path_factory.mktemp("chatgpt-" + scenario) / "harness.js"
    script.write_text(HARNESS, encoding="utf-8")
    p = subprocess.run([node, str(script), EXT, scenario], capture_output=True, text=True, timeout=60,
                       creationflags=NO_WINDOW)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def test_restart_adopts_marked_pinned_tab(tmp_path_factory):
    result = run_scenario(tmp_path_factory, "restart")
    assert result["afterFirst"]["created"] == []
    assert result["afterFirst"]["stored"] == 10


def test_unpinned_marked_chatgpt_tab_is_not_used(tmp_path_factory):
    result = run_scenario(tmp_path_factory, "unpinned")
    assert result["afterFirst"]["created"] == [11]


def test_unmarked_pinned_chatgpt_tab_is_not_used(tmp_path_factory):
    result = run_scenario(tmp_path_factory, "unmarked")
    assert result["afterFirst"]["created"] == [11]


def test_second_open_reuses_extension_tab(tmp_path_factory):
    result = run_scenario(tmp_path_factory, "restart")
    assert result["second"] == {"ok": True, "tabId": 10}
    assert result["created"] == []
