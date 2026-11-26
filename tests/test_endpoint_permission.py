"""Offline checks for the custom endpoint host permission prompt."""
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
const elements = new Map();
function element(selector) {
  if (!elements.has(selector)) elements.set(selector, {
    value: selector === '#backend' ? 'openai-api' : selector === '#openaiBaseUrl' ? 'http://localhost:11434/v1' : '',
    checked: false, textContent: '', className: '', innerHTML: '',
    classList: { toggle() {} }, addEventListener(name, fn) { this['on_' + name] = fn; }
  });
  return elements.get(selector);
}
const requested = [], permissionState = { contains: false };
const chrome = {
  permissions: {
    contains: async () => permissionState.contains,
    request: async (arg) => { requested.push(arg); return true; }
  },
  storage: { local: { remove: async () => {} } },
  runtime: { lastError: null, sendMessage: (msg, cb) => cb({ allowed: true }) }
};
const SN = {
  DEFAULTS: {},
  getSettings: async () => ({}), getSecrets: async () => ({}),
  saveSettings: async () => {}, saveSecrets: async () => {},
  pickVoice: () => null, escapeHtml: (s) => s
};
const document = {
  querySelector: element,
  querySelectorAll: () => []
};
const speechSynthesis = { addEventListener() {}, getVoices: () => [] };
const ctx = { chrome, SN, document, speechSynthesis, navigator: {}, console, URL, setTimeout: () => 0, clearTimeout() {} };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(EXT, 'options.js'), 'utf8'), ctx);

(async () => {
  await elements.get('#save').on_click();
  const localhostRequest = requested.slice();
  permissionState.contains = true;
  await elements.get('#save').on_click();
  const countWhenGranted = requested.length;
  element('#openaiBaseUrl').value = 'https://api.openai.com/v1';
  await elements.get('#save').on_click();
  process.stdout.write(JSON.stringify({ localhostRequest, countWhenGranted, finalCount: requested.length }));
})().catch(e => { console.error(e); process.exit(1); });
"""


@pytest.fixture(scope="module")
def result(tmp_path_factory):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    script = tmp_path_factory.mktemp("endpoint") / "harness.js"
    script.write_text(HARNESS, encoding="utf-8")
    p = subprocess.run([node, str(script), EXT], capture_output=True, text=True, timeout=60,
                       creationflags=NO_WINDOW)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def test_custom_local_endpoint_requests_origin_permission(result):
    assert result["localhostRequest"] == [{"origins": ["http://localhost:11434/*"]}]


def test_existing_permission_skips_request(result):
    assert result["countWhenGranted"] == 1


def test_openai_host_permission_does_not_crash(result):
    assert result["finalCount"] == 1
