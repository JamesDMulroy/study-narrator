import json
from pathlib import Path


def test_manifest_permissions():
    manifest_path = Path(__file__).resolve().parents[1] / "extension" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    host_permissions = manifest["host_permissions"]
    removed_origins = {
        "http://localhost/*",
        "http://127.0.0.1/*",
        "https://openrouter.ai/*",
        "https://api.groq.com/*",
    }
    assert removed_origins.isdisjoint(host_permissions)
    assert "<all_urls>" not in host_permissions
    assert "<all_urls>" in manifest["optional_host_permissions"]
    assert manifest["permissions"] == [
        "storage",
        "activeTab",
        "scripting",
        "nativeMessaging",
        "contextMenus",
        "sidePanel",
        "tabs",
    ]
