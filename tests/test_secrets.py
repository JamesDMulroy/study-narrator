"""Checks that API secrets are stored separately from ordinary settings."""
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
const store = {};
const chrome = { storage: { local: {
  get: async (keys) => {
    const out = {};
    for (const key of (Array.isArray(keys) ? keys : [keys])) out[key] = store[key];
    return out;
  },
  set: async (values) => Object.assign(store, values),
} } };
const ctx = { chrome };
ctx.self = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(EXT, 'lib', 'common.js'), 'utf8'), ctx);
(async () => {
  const out = {};
  store.settings = { apiKey: 'K' };
  out.secretsAfterMigration = (await ctx.SN.getSecrets()).apiKey;
  out.settingsAfterMigration = await ctx.SN.getSettings();
  await ctx.SN.saveSettings({ apiKey: 'X', rate: 1.2 });
  out.secretAfterSettingsSave = store.secrets.apiKey;
  const settingsBeforeSecretsSave = JSON.stringify(store.settings);
  await ctx.SN.saveSecrets({ geminiKey: 'G' });
  out.settingsAfterSecretsSave = JSON.stringify(store.settings);
  out.settingsBeforeSecretsSave = settingsBeforeSecretsSave;
  process.stdout.write(JSON.stringify(out));
})().catch(e => { console.error(e); process.exit(1); });
"""


@pytest.fixture(scope="module")
def result(tmp_path_factory):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    script = tmp_path_factory.mktemp("secrets") / "harness.js"
    script.write_text(HARNESS, encoding="utf-8")
    p = subprocess.run([node, str(script), EXT], capture_output=True, text=True, timeout=60,
                       creationflags=NO_WINDOW)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def test_secrets_migrate_out_of_settings(result):
    assert result["secretsAfterMigration"] == "K"
    assert "apiKey" not in result["settingsAfterMigration"]


def test_settings_save_does_not_overwrite_secrets(result):
    assert result["secretAfterSettingsSave"] == "K"


def test_secrets_save_does_not_touch_settings(result):
    assert result["settingsAfterSecretsSave"] == result["settingsBeforeSecretsSave"]
