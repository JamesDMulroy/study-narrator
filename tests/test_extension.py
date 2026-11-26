"""Load the extension into a headless Edge (throwaway profile) and exercise the real flows:
widget mounts, Read -> background -> native host -> Claude -> narration sentences, save note, panel lists it.
Run: python test_extension.py [--keep] [--codex] [--chatgpt]
"""
import argparse, json, os, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from widget_driver import Widget, launch, serve  # noqa: E402

EXT_ID = ""  # an unpacked extension's ID depends on its folder: read from the service worker URL
PAGE = """<!doctype html><html><head><title>Lesson 3: Skills in Claude Code</title></head><body>
<nav>Home | Courses | Page 3 of 12 | Next lesson</nav>
<article>
<h1>Lesson 3: What a skill is</h1>
<p>A skill is a folder containing a SKILL.md file. The file starts with YAML frontmatter that gives the skill a name and a description. Claude reads the description to decide when the skill applies, and loads the full instructions only when a task matches.</p>
<p>Skills can bundle supporting files such as scripts, templates and reference documents. Keep the description specific: it is the trigger. A vague description either fires too often or never fires at all.</p>
<h2>Progressive disclosure</h2>
<p>Only the name and description are loaded at startup. The body of SKILL.md is read on demand, and any referenced files are read later still. This keeps the context window small until the skill is actually needed.</p>
<pre>---\nname: deploy\ndescription: Deploy the app to staging\n---</pre>
<p>Cookie notice: we use cookies. Accept all. © 2026 Example Inc. Privacy policy. Terms.</p>
</article>
<footer>Page 3 of 12 · Previous · Next · Share on social media</footer>
</body></html>"""


def main():
    global EXT_ID
    parser = argparse.ArgumentParser(description="Live extension test prerequisites: Microsoft Edge; pip install playwright; the native host registered for this test profile's extension ID with python host/install.py --extension-id <id> (the ID is printed from the service worker URL); a signed-in claude CLI; plus codex for --codex or a chatgpt.com login for --chatgpt.")
    parser.add_argument("--keep", action="store_true", help="keep the temporary browser profile")
    parser.add_argument("--codex", action="store_true", help="test the signed-in codex CLI backend")
    parser.add_argument("--chatgpt", action="store_true", help="test the chatgpt.com backend (requires login)")
    args = parser.parse_args()
    from playwright.sync_api import sync_playwright

    keep = args.keep
    tmp = tempfile.mkdtemp(prefix="sn-edge-")
    with open(os.path.join(tmp, "lesson.html"), "w", encoding="utf-8") as f:
        f.write(PAGE)
    srv, base = serve(tmp)
    results = {}
    try:
      with sync_playwright() as p:
        ctx, sw = launch(p, os.path.join(tmp, "profile"))
        try:
            EXT_ID = sw.url.split('/')[2]
            print(f"Extension ID for native host registration: {EXT_ID}")
            results["service_worker"] = True
            page = ctx.new_page()
            logs = []
            page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
            page.goto(base + "/lesson.html")
            page.wait_for_selector("#study-narrator-host", state="attached", timeout=10000)
            time.sleep(0.5)
            w = Widget(page, sw)
            results["widget_mounted"] = True
            # host ping through the real native messaging path
            ping = sw.evaluate("() => new Promise(r => chrome.runtime.sendNativeMessage('study_narrator', {action:'ping'}, x => r(chrome.runtime.lastError ? {error: chrome.runtime.lastError.message} : x)))")
            results["native_ping"] = ping
            if not isinstance(ping, dict) or ping.get("error") or ping.get("ok") is False:
                raise RuntimeError(f"Native host ping failed: {ping!r}")
            # click Read -> narration prep via Claude
            w.click("[data-act=readToggle]")
            status = ""
            for _ in range(240):  # up to 120 s
                status = w.get("text", ".st")
                err = w.get("text", ".err")
                if status.startswith("Reading") or status.startswith("Ready") or status.startswith("Nothing") or err:
                    break
                time.sleep(0.5)
            results["narration_status"] = status
            results["narration_error"] = err
            results["first_sentence"] = w.get("text", ".text")
            time.sleep(1.5)
            results["terms_html_len"] = len(w.get("text", ".terms") or "")
            results["tab_context_chars"] = sw.evaluate("async () => { const g = await chrome.storage.session.get('tabContexts'); const v = Object.values(g.tabContexts||{}); return v.length ? v[0].script.length : 0; }")
            cache = sw.evaluate("async () => { const g = await chrome.storage.local.get('narrationCache'); return Object.values(g.narrationCache||{}).map(c => ({script: c.script.slice(0, 400), terms: c.terms})); }")
            results["cache"] = cache
            # save a highlight and check the panel lists it
            page.evaluate("""() => { const p = document.querySelector('article p'); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }""")
            w.click("[data-act=save]")
            time.sleep(1)
            notes = sw.evaluate("async () => (await chrome.storage.local.get('notes')).notes || []")
            results["notes_after_save"] = [{k: n[k] for k in ('kind', 'text', 'title')} for n in notes]
            panel = ctx.new_page()
            panel.goto(f"chrome-extension://{EXT_ID}/panel.html")
            panel.wait_for_selector(".note", timeout=8000)
            results["panel_notes"] = panel.locator(".note").count()
            results["panel_host_info"] = panel.locator("#hostInfo").text_content()
            # ask a typed question through the widget (same path as voice)
            # the typed-question row is shown by the widget when voice input is unavailable; show it directly here
            sw.evaluate("async (id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => { chrome.dom.openOrClosedShadowRoot(document.querySelector('#study-narrator-host')).querySelector('.qrow').style.display = 'flex'; } })", w.tab_id)
            w.type_and_send("In one sentence, when does Claude load the body of a skill?")
            ans = ""
            for _ in range(240):
                st = w.get("text", ".st")
                if st == "Claude" or st == "Error":
                    ans = w.get("text", ".text") + " || " + w.get("text", ".err")
                    break
                time.sleep(0.5)
            results["answer"] = ans
            results["console"] = [l for l in logs if "error" in l.lower()][:10]
            # --- other backends via the Settings "test" path ---
            def set_backend(b, extra=None):
                sw.evaluate("async (p) => { const g = await chrome.storage.local.get('settings'); await chrome.storage.local.set({settings: Object.assign({}, g.settings||{}, p)}); }", dict({"backend": b}, **(extra or {})))
            def test_backend():
                return panel.evaluate("() => new Promise(r => chrome.runtime.sendMessage({type:'testBackend'}, x => r(x)))")
            if args.codex:
                set_backend("codex")
                results["codex_test"] = test_backend()
                ans = panel.evaluate("() => new Promise(r => chrome.runtime.sendMessage({type:'ask', question:'In one sentence, what is progressive disclosure here?', context:{title:'Lesson 3', url:'x', script:'Only the name and description are loaded at startup. The body of SKILL.md is read on demand.'}, history:[]}, x => r(x)))")
                results["codex_answer"] = ans
            if args.chatgpt:
                set_backend("chatgpt-web")
                results["chatgpt_test"] = test_backend()
                tabs = [t.url for t in ctx.pages]
                results["chatgpt_tabs"] = tabs
            # options + panel pages load without script errors
            opt = ctx.new_page(); errs = []
            opt.on("pageerror", lambda e: errs.append(str(e)))
            opt.goto(f"chrome-extension://{EXT_ID}/options.html"); opt.wait_for_selector("#backend"); time.sleep(0.5)
            results["options_backend_value"] = opt.evaluate("() => document.querySelector('#backend').value")
            results["options_errors"] = errs
            set_backend("claude-code")
        finally:
            ctx.close()
      srv.shutdown(); srv.server_close()
      print(json.dumps(results, indent=1))
      ok = {
        "native_ping": isinstance(results.get("native_ping"), dict) and not results["native_ping"].get("error") and results["native_ping"].get("ok") is not False,
        "narration_status": results.get("narration_status", "").startswith(("Reading", "Ready")),
        "notes_after_save": bool(results.get("notes_after_save")),
        "panel_notes": results.get("panel_notes", 0) >= 1,
        "answer": bool(results.get("answer")) and "Error" not in results.get("answer", ""),
        "options_errors": not results.get("options_errors", ["not run"]),
      }
      results["ok"] = ok
      print(json.dumps({"ok": ok}, indent=1))
      if not all(ok.values()):
          raise SystemExit(1)
    finally:
      srv.shutdown(); srv.server_close()
      if not keep:
          import shutil; shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
