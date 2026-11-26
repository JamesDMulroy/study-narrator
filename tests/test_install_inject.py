"""Install-time tab injection remains best effort when scripting is denied."""
import json
import os
import shutil
import subprocess

import pytest

EXT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

HARNESS = r"""
const fs = require('fs'), path = require('path'), vm = require('vm');
const EXT = process.argv[2], listeners = {}, attempted = [], errors = [];
process.on('unhandledRejection', e => errors.push(String(e)));
process.on('uncaughtException', e => errors.push(String(e)));
const on = name => ({ addListener: fn => (listeners[name] = fn) });
const chrome = {
  runtime: { id: 'ext', lastError: null, getURL: p => 'chrome-extension://ext/' + p,
    onConnect: on('connect'), onMessage: on('message'), onInstalled: on('installed') },
  permissions: { contains: async () => true },
  tabs: { query: async () => [
    { id: 11, url: 'http://one.example/' }, { id: 12, url: 'https://two.example/' }
  ], onRemoved: on('removed'), sendMessage: async () => {} },
  scripting: {
    executeScript: details => { attempted.push(details.target.tabId); return Promise.reject(new Error('denied')); },
    insertCSS: () => Promise.reject(new Error('denied'))
  },
  contextMenus: { onClicked: on('clicked'), removeAll: cb => cb && cb(), create: () => {} },
  commands: { onCommand: on('command') },
  sidePanel: { setPanelBehavior: async () => {} },
  storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } }
};
const ctx = { chrome, console, setTimeout, clearTimeout, URL, TextEncoder,
  importScripts: () => {}, fetch: async () => { throw new Error('unexpected network'); } };
ctx.self = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx);
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
(async () => {
  listeners.installed();
  await tick();
  process.stdout.write(JSON.stringify({ attempted, errors }));
})().catch(e => { process.stdout.write(JSON.stringify({ attempted, errors: [...errors, String(e)] })); });
"""


@pytest.fixture(scope="module")
def result(tmp_path_factory):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    script = tmp_path_factory.mktemp("install-inject") / "harness.js"
    script.write_text(HARNESS, encoding="utf-8")
    proc = subprocess.run([node, str(script), EXT], capture_output=True, text=True, timeout=60,
                          creationflags=NO_WINDOW)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_install_injection_failures_are_silent_and_best_effort(result):
    assert result["errors"] == []
    assert sorted(result["attempted"]) == [11, 12]
