"""Input normalization checks for saved notes, using a Node chrome stub."""
import json
import os
import shutil
import subprocess

import pytest

EXT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

HARNESS = r"""
const fs = require('fs'), path = require('path'), vm = require('vm');
const EXT = process.argv[2], listeners = {}, store = {};
const on = (name) => ({ addListener: (fn) => { (listeners[name] = listeners[name] || []).push(fn); } });
const chrome = {
  runtime: { id: 'ext', lastError: null, getURL: p => 'chrome-extension://ext/' + p,
    onConnect: on('connect'), onMessage: on('message'), onInstalled: on('installed'),
    sendNativeMessage: () => {} },
  storage: { local: { get: async k => ({ [k]: store[k] }), set: async o => Object.assign(store, o) },
    session: { get: async k => ({ [k]: store['s:' + k] }), set: async o => { for (const k in o) store['s:' + k] = o[k]; } } },
  tabs: { onRemoved: on('tabRemoved'), sendMessage: async () => {} },
  contextMenus: { onClicked: on('menu'), removeAll: () => {}, create: () => {} },
  commands: { onCommand: on('command') }, sidePanel: { setPanelBehavior: async () => {} },
};
const ctx = { chrome, console, crypto: globalThis.crypto, TextEncoder, URL, setTimeout, clearTimeout,
  fetch: async () => { throw new Error('no network'); } };
ctx.self = ctx; ctx.globalThis = ctx;
ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx); };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx);

(async () => {
  const sender = { id: 'ext', url: 'chrome-extension://ext/panel.html' };
  async function save(note) {
    return await new Promise((resolve, reject) => {
      let responded = false;
      const sendResponse = value => { responded = true; resolve(value); };
      for (const fn of listeners.message) fn({ type: 'saveNote', note }, sender, sendResponse);
      setTimeout(() => { if (!responded) reject(new Error('message did not respond')); }, 1000);
    });
  }
  await save({ text: 'tag check', tags: 'abc' });
  await save({ text: 'kind check', kind: 'x' });
  await save({ text: 42 });
  process.stdout.write(JSON.stringify(store.notes));
})().catch(e => { console.error(e); process.exit(1); });
"""


@pytest.fixture(scope="module")
def notes(tmp_path_factory):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    script = tmp_path_factory.mktemp("notes") / "harness.js"
    script.write_text(HARNESS, encoding="utf-8")
    p = subprocess.run([node, str(script), EXT], capture_output=True, text=True, timeout=60,
                       creationflags=NO_WINDOW)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def test_tags_must_be_an_array(notes):
    assert next(n for n in notes if n["text"] == "tag check")["tags"] == []


def test_unknown_kind_defaults_to_highlight(notes):
    assert next(n for n in notes if n["text"] == "kind check")["kind"] == "highlight"


def test_numeric_text_is_normalized_to_string(notes):
    assert next(n for n in notes if n["text"] == "42")["text"] == "42"
