import shutil
import subprocess
from pathlib import Path

import pytest


def test_valid_base_url():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is required")
    common = Path(__file__).resolve().parents[1] / "extension" / "lib" / "common.js"
    script = r"""
const fs = require('fs');
const vm = require('vm');
const context = { chrome: { storage: { local: {} } }, URL };
context.globalThis = context;
vm.runInNewContext(fs.readFileSync(process.argv[1], 'utf8'), context);
const cases = [
  ['https://api.openai.com/v1', true],
  ['http://localhost:11434/v1', true],
  ['http://127.0.0.1:1234/v1', true],
  ['http://example.com/v1', false],
  ['ftp://x', false],
  ['javascript:alert(1)', false],
  ['', false],
];
for (const [url, expected] of cases) {
  if (context.SN.validBaseUrl(url) !== expected) throw new Error(`unexpected result for ${url}`);
}
"""
    subprocess.run([node, "-e", script, str(common)], check=True)
