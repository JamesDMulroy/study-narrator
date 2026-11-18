"""Headless Edge: a web page cannot drive the widget or read it, and one tab cannot flood the AI backend.

    python tests/test_isolation.py

Prints a JSON report and exits non-zero if any check fails. No AI is called: the backend is set to the
Anthropic API with no key, which fails before any network request.
"""
import json
import os
import shutil
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from widget_driver import Widget, launch, serve  # noqa: E402

HTML = ("<!doctype html><html><head><title>Isolation</title></head><body><article><h1>T</h1><p>"
        + ("Some text. " * 80) + "</p></article></body></html>")

# What a hostile page script would try: reach the widget and press its buttons.
PAGE_ATTACK = """() => {
  const host = document.querySelector('#study-narrator-host');
  const out = { host: !!host, shadowRoot: host ? host.shadowRoot !== null : null };
  try { host.click(); host.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); out.dispatched = true; }
  catch (e) { out.dispatched = String(e); }
  return out;
}"""

# Even code with the root in hand (the extension's own world) cannot act through script-made events.
UNTRUSTED_IN_ISOLATED_WORLD = """async (tabId) => (await chrome.scripting.executeScript({ target: { tabId }, func: () => {
  const root = chrome.dom.openOrClosedShadowRoot(document.querySelector('#study-narrator-host'));
  root.querySelector('[data-act=readToggle]').click();
  const q = root.querySelector('input.q');
  root.querySelector('.qrow').style.display = 'flex';
  q.value = 'untrusted question';
  q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  root.querySelector('[data-act=send]').click();
  return root.querySelector('.st').textContent;
} }))[0].result"""

FLOOD = """async (tabId) => (await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
  const one = () => new Promise(r => chrome.runtime.sendMessage({ type: 'ask', question: 'q', context: { script: 'x' }, history: [] }, r));
  const replies = [];
  for (let i = 0; i < 12; i++) replies.push(await one());
  return replies.map(r => (r && r.error) || 'answered');
} }))[0].result"""


def main():
    tmp = tempfile.mkdtemp(prefix="sn-isolation-")
    open(os.path.join(tmp, "t.html"), "w", encoding="utf-8").write(HTML)
    srv, base = serve(tmp)
    r, ok = {}, {}
    try:
        with sync_playwright() as p:
            ctx, sw = launch(p, os.path.join(tmp, "profile"))
            try:
                sw.evaluate("async () => chrome.storage.local.set({ settings: { backend: 'anthropic-api', apiKey: '' } })")
                page = ctx.new_page()
                page.goto(base + "/t.html")
                page.wait_for_selector("#study-narrator-host", state="attached")
                time.sleep(0.6)
                w = Widget(page, sw)
                r["status_before"] = w.get("text", ".st")
                r["page_attack"] = page.evaluate(PAGE_ATTACK)
                ok["page_cannot_see_shadow_root"] = r["page_attack"]["host"] and r["page_attack"]["shadowRoot"] is False
                r["status_after_untrusted"] = sw.evaluate(UNTRUSTED_IN_ISOLATED_WORLD, w.tab_id)
                time.sleep(0.5)
                r["status_after_untrusted_settled"] = w.get("text", ".st")
                ok["untrusted_events_do_nothing"] = r["status_after_untrusted_settled"] == r["status_before"]
                # positive control: a real click does act
                w.click("[data-act=openIn]")
                r["trusted_click_status"] = w.get("text", ".st")
                ok["trusted_click_acts"] = r["trusted_click_status"].startswith("Discuss")
                r["flood"] = sw.evaluate(FLOOD, w.tab_id)
                ok["one_tab_is_rate_limited"] = (all("Too many" not in x for x in r["flood"][:10])
                                                 and all("Too many" in x for x in r["flood"][10:]))
            finally:
                ctx.close()
    finally:
        srv.shutdown()
        srv.server_close()
        shutil.rmtree(tmp, ignore_errors=True)
    r["checks"] = ok
    print(json.dumps(r, indent=1))
    return 0 if ok and all(ok.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
