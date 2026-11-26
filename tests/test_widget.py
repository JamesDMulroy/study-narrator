"""Headless Edge check of the widget window behaviour: drag, minimize, hide, restore, remembered position.

The widget is driven with real mouse input and read from the extension's isolated world (see widget_driver).
"""
import json, os, sys, tempfile, time, shutil
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from widget_driver import Widget, launch, serve  # noqa: E402

HTML = "<!doctype html><html><head><title>Widget test</title></head><body><article><h1>T</h1><p>" + ("Some text. " * 80) + "</p></article></body></html>"


def main():
    tmp = tempfile.mkdtemp(prefix="sn-widget-")
    open(os.path.join(tmp, "t.html"), "w", encoding="utf-8").write(HTML)
    srv, base = serve(tmp)
    r, ok = {}, {}
    try:
        with sync_playwright() as p:
            ctx, sw = launch(p, os.path.join(tmp, "profile"), viewport={"width": 1400, "height": 900})
            try:
                page = ctx.new_page(); errs = []
                page.on("pageerror", lambda e: errs.append(str(e)))
                page.goto(base + "/t.html")
                page.wait_for_selector("#study-narrator-host", state="attached"); time.sleep(0.6)
                w = Widget(page, sw)

                def pos():
                    b = w.get("rect", ".wrap")
                    return {"x": round(b["x"]), "y": round(b["y"]), "w": round(b["w"]), "h": round(b["h"]), "cls": w.get("class", ".wrap")}

                r["initial"] = pos()
                # drag by the grip to the top-left area
                gx, gy = w.center("[data-act=drag]")
                page.mouse.move(gx, gy); page.mouse.down(); page.mouse.move(gx - 300, gy - 200, steps=12); page.mouse.move(100, 120, steps=12); page.mouse.up(); time.sleep(0.5)
                r["after_drag"] = pos()
                r["saved_state"] = sw.evaluate("async () => (await chrome.storage.local.get('widgetState')).widgetState")
                # bubble opens below when the pill is in the top half
                w.click("[data-act=openIn]")
                pill, bubble = w.get("rect", ".pill"), w.get("rect", ".bubble")
                width = page.evaluate("() => innerWidth")
                r["bubble_below_pill"] = bubble["y"] > pill["y"] + pill["h"] and bubble["x"] >= 0 and bubble["x"] + bubble["w"] <= width
                # minimize
                w.click("[data-act=collapse]", settle=0.3)
                r["collapsed"] = {"cls": w.get("class", ".pill"), "readVisible": w.get("visible", "[data-act=readToggle]"),
                                  "width": round(w.get("rect", ".pill")["w"])}
                # drag the collapsed dot
                dx, dy = w.center("[data-act=collapse]")
                page.mouse.move(dx, dy); page.mouse.down(); page.mouse.move(dx + 400, dy + 500, steps=15); page.mouse.up(); time.sleep(0.4)
                r["dot_after_drag"] = pos()
                w.click("[data-act=collapse]", settle=0.3)
                r["expanded_again"] = w.get("visible", "[data-act=readToggle]")
                # hide, then restore by command
                w.click("[data-act=close]", settle=0.3)
                r["hidden"] = page.evaluate("() => document.querySelector('#study-narrator-host').style.display")
                sw.evaluate("async (id) => chrome.tabs.sendMessage(id, {type:'command', command:'showWidget'})", w.tab_id); time.sleep(0.3)
                r["restored"] = page.evaluate("() => document.querySelector('#study-narrator-host').style.display")
                # hide on this site, then allow again
                sw.evaluate("async (id) => chrome.tabs.sendMessage(id, {type:'command', command:'toggleSiteWidget'})", w.tab_id); time.sleep(0.4)
                r["site_hidden"] = {"display": page.evaluate("() => document.querySelector('#study-narrator-host').style.display"), "list": sw.evaluate("async () => (await chrome.storage.local.get('widgetHiddenSites')).widgetHiddenSites")}
                sw.evaluate("async (id) => chrome.tabs.sendMessage(id, {type:'command', command:'toggleSiteWidget'})", w.tab_id); time.sleep(0.4)
                r["site_allowed"] = page.evaluate("() => document.querySelector('#study-narrator-host').style.display")
                # position survives a reload
                page.reload(); page.wait_for_selector("#study-narrator-host", state="attached"); time.sleep(0.8)
                r["after_reload"] = pos()
                # narrow viewport clamps it into view
                page.set_viewport_size({"width": 500, "height": 600}); time.sleep(0.4)
                pill = w.get("rect", ".pill")
                r["narrow"] = {"cls": w.get("class", ".wrap"), "fits": pill["x"] >= 0 and pill["x"] + pill["w"] <= 500,
                               "read": w.get("text", "[data-act=readToggle]"), "prevHidden": not w.get("visible", "[data-act=prev]"),
                               "moreVisible": w.get("visible", "[data-act=more]")}
                w.click("[data-act=more]")
                r["more_menu_actions"] = w.get("texts", ".actions button")
                r["page_errors"] = errs
                saved = r["saved_state"] or {}
                after_drag, dot = r["after_drag"], r["dot_after_drag"]
                reload_pos = r["after_reload"]
                hidden_sites = r["site_hidden"]["list"] or []
                ok = {
                    "drag_saved_position": (after_drag != r["initial"] and
                                            abs(after_drag["x"] - saved.get("pos", {}).get("x", float("inf"))) <= 2 and
                                            abs(after_drag["y"] - saved.get("pos", {}).get("y", float("inf"))) <= 2),
                    "bubble_below_pill": r["bubble_below_pill"],
                    "collapsed_and_read_hidden": "collapsed" in r["collapsed"]["cls"] and not r["collapsed"]["readVisible"],
                    "expanded_again": r["expanded_again"],
                    "hidden_and_restored": r["hidden"] == "none" and r["restored"] == "",
                    "site_hidden": r["site_hidden"]["display"] == "none" and urlsplit(page.url).hostname in hidden_sites,
                    "site_allowed": r["site_allowed"] == "",
                    "position_survives_reload": abs(reload_pos["x"] - dot["x"]) <= 2 and abs(reload_pos["y"] - dot["y"]) <= 2,
                    "narrow_layout": r["narrow"]["fits"] and r["narrow"]["prevHidden"] and r["narrow"]["moreVisible"],
                    "more_menu_actions": bool(r["more_menu_actions"]),
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
