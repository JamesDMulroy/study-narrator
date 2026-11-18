"""Shared helpers for the headless Edge tests.

The widget lives in a closed shadow root and acts only on trusted (real user) events, so the tests drive it
the way a person does: they read its state from the extension's own isolated world (where page scripts
cannot reach) and click or type with real input events through Playwright's mouse and keyboard.
"""
import functools
import http.server
import os
import socketserver
import threading
import time

EXT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension")

# Runs in the extension's isolated world (chrome.scripting.executeScript). chrome.dom.openOrClosedShadowRoot
# is an extension-only API: a page script has no way to get the closed root.
_PROBE = """async ([tabId, op, sel]) => (await chrome.scripting.executeScript({ target: { tabId }, args: [op, sel],
  func: (op, sel) => {
    const host = document.querySelector('#study-narrator-host');
    const root = host && chrome.dom.openOrClosedShadowRoot(host);
    if (!root) return null;
    const all = [...root.querySelectorAll(sel)], el = all[0];
    if (op === 'exists') return !!el;
    if (!el) return null;
    if (op === 'text') return el.textContent;
    if (op === 'texts') return all.map(e => e.textContent);
    if (op === 'class') return el.className;
    if (op === 'visible') return el.offsetParent !== null;
    if (op === 'rect') { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }
    if (op === 'remove') { el.remove(); return true; }
    return null;
  } }))[0].result"""


def serve(folder):
    """A loopback-only HTTP server for ``folder``; returns (server, base URL)."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=folder)
    srv = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def launch(p, profile, **kwargs):
    """Headless Edge with only this extension, in a throwaway profile. Returns (context, service worker)."""
    ctx = p.chromium.launch_persistent_context(
        profile, channel="msedge", headless=True,
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--no-first-run", "--mute-audio"],
        **kwargs)
    def ours(w):
        return w.url.startswith("chrome-extension://") and w.url.endswith("/background.js")

    try:
        sw = next((w for w in ctx.service_workers if ours(w)), None) or \
            ctx.wait_for_event("serviceworker", predicate=ours, timeout=60000)
    except Exception:
        ctx.close()
        raise RuntimeError("the extension's service worker did not start")
    return ctx, sw


class Widget:
    """The widget in one tab: state through the isolated world, input through real mouse and keyboard events."""

    def __init__(self, page, sw):
        self.page, self.sw = page, sw
        url = page.url
        self.tab_id = sw.evaluate("async (url) => (await chrome.tabs.query({})).find(t => t.url === url).id", url)

    def get(self, op, sel):
        return self.sw.evaluate(_PROBE, [self.tab_id, op, sel])

    def center(self, sel):
        r = self.get("rect", sel)
        if not r or not r["w"]:
            raise AssertionError(f"{sel} is not on screen")
        return r["x"] + r["w"] / 2, r["y"] + r["h"] / 2

    def click(self, sel, settle=0.2):
        x, y = self.center(sel)
        self.page.mouse.click(x, y)
        time.sleep(settle)

    def type_and_send(self, text, button="[data-act=send]"):
        self.click("input.q")
        self.page.keyboard.type(text)
        self.click(button)
