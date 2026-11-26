"""Headless Edge: a newer content script injected into a tab replaces an older widget already on the page."""
import json, os, sys, tempfile, time, shutil
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from widget_driver import Widget, launch, serve  # noqa: E402

HTML = "<!doctype html><html><head><title>Takeover</title></head><body><p>" + ("Text. " * 50) + "</p></body></html>"
INJECT = "async (id) => { try { await chrome.scripting.executeScript({ target: { tabId: id }, files: ['lib/Readability.js', 'lib/common.js', 'content.js'] }); return 'ok'; } catch (e) { return String(e.message || e); } }"


def main():
    tmp = tempfile.mkdtemp(prefix="sn-takeover-")
    open(os.path.join(tmp, "t.html"), "w", encoding="utf-8").write(HTML)
    # served over loopback http: real pages are http(s), and file:// needs a separate Edge permission anyway
    srv, base = serve(tmp)
    r, ok = {"url": base + "/t.html"}, {}
    try:
        with sync_playwright() as p:
            ctx, sw = launch(p, os.path.join(tmp, "profile"))
            try:
                page = ctx.new_page(); errs = []
                page.on("pageerror", lambda e: errs.append(str(e)))
                page.goto(r["url"])
                page.wait_for_selector("#study-narrator-host", state="attached"); time.sleep(0.5)
                w = Widget(page, sw)
                # pretend the widget on the page came from an older build: strip its grip and close button, and mark the
                # old version (the marker lives in the extension's isolated world, as an old build would leave it)
                w.get("remove", "[data-act=drag]"); w.get("remove", "[data-act=close]")
                sw.evaluate("async (id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => { window.__studyNarratorVersion = '0.0.1'; } })", w.tab_id)
                time.sleep(0.3)
                r["before"] = {"hosts": page.evaluate("() => document.querySelectorAll('#study-narrator-host').length"), "grip": w.get("exists", "[data-act=drag]")}
                r["inject"] = sw.evaluate(INJECT, w.tab_id)
                time.sleep(0.6)
                r["after"] = {"hosts": page.evaluate("() => document.querySelectorAll('#study-narrator-host').length"),
                              "grip": w.get("exists", "[data-act=drag]"), "close": w.get("exists", "[data-act=close]")}
                r["version_marker"] = sw.evaluate("async (id) => (await chrome.scripting.executeScript({ target: { tabId: id }, func: () => window.__studyNarratorVersion }))[0].result", w.tab_id)
                # injecting the same build again must be a no-op
                sw.evaluate(INJECT, w.tab_id); time.sleep(0.4)
                r["after_same_build"] = page.evaluate("() => document.querySelectorAll('#study-narrator-host').length")
                # the widget still works after the takeover
                w.click("[data-act=openIn]")
                r["bubble_works"] = "show" in (w.get("class", ".bubble") or "")
                r["page_errors"] = errs
                manifest_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'extension', "manifest.json")
                with open(manifest_path, encoding="utf-8") as manifest_file:
                    manifest_version = json.load(manifest_file)["version"]
                ok = {
                    "old_widget_state": r["before"]["hosts"] == 1 and r["before"]["grip"] is False,
                    "inject_succeeded": r["inject"] == "ok",
                    "takeover_restored_controls": r["after"]["hosts"] == 1 and r["after"]["grip"] and r["after"]["close"],
                    "version_marker": r["version_marker"] == manifest_version,
                    "same_build_is_noop": r["after_same_build"] == 1,
                    "bubble_works": r["bubble_works"],
                    "no_page_errors": r["page_errors"] == [],
                }
            finally:
                ctx.close()
    finally:
        srv.shutdown()
        srv.server_close()
        shutil.rmtree(tmp, ignore_errors=True)
    r["checks"] = ok
    print(json.dumps(r, indent=1))
    sys.exit(0 if ok and all(ok.values()) else 1)


if __name__ == "__main__":
    main()
