"""Smoke test the shipped manifest in headless Edge.

Prints a JSON report and exits non-zero if any check fails.
"""
import json
import os
import shutil
import sys
import tempfile

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from widget_driver import launch, serve  # noqa: E402

HTML = "<!doctype html><html><head><title>Shipped manifest</title></head><body><article><p>Test text.</p></article></body></html>"


def main():
    tmp = tempfile.mkdtemp(prefix="sn-shipped-manifest-")
    with open(os.path.join(tmp, "t.html"), "w", encoding="utf-8") as page_file:
        page_file.write(HTML)
    srv, base = serve(tmp)
    result, ok = {}, {}
    try:
        with sync_playwright() as p:
            ctx, sw = launch(p, os.path.join(tmp, "profile"), grant_all_sites=False)
            try:
                page = ctx.new_page()
                page_errors = []
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.goto(base + "/t.html")
                page.wait_for_selector("#study-narrator-host", state="attached")
                result["widget_host_exists"] = page.evaluate("() => !!document.querySelector('#study-narrator-host')")
                result["all_sites_permission"] = sw.evaluate(
                    "async () => await chrome.permissions.contains({ origins: ['<all_urls>'] })")
                result["page_errors"] = page_errors
                ok["widget_host_exists"] = result["widget_host_exists"]
                ok["all_sites_permission_absent"] = result["all_sites_permission"] is False
                ok["page_errors_empty"] = not page_errors
            finally:
                ctx.close()
    finally:
        srv.shutdown()
        srv.server_close()
        shutil.rmtree(tmp, ignore_errors=True)
    result["ok"] = ok
    print(json.dumps(result, indent=1))
    return 0 if ok and all(ok.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
