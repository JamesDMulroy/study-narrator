# Contributing

Thanks for helping improve Study Narrator.

## Ground rules
- **Least privilege.** Do not add extension permissions, host permissions or content-script matches
  without explaining why in the pull request. Never put `<all_urls>` in `host_permissions`: it stays
  optional.
- **Untrusted text stays text.** Page content, AI output and saved notes go into the DOM with
  `textContent`, or through `SN.escapeHtml` when markup is unavoidable. Never use `eval` or inline
  event handlers.
- **The page cannot drive the widget.** Its shadow root stays closed and every handler that acts checks
  `event.isTrusted`. Tests drive it with real input and read it from the extension's isolated world
  (`tests/widget_driver.py`), never from the page.
- **The native host stays narrow.** It takes no command line from the extension. New actions need
  validated, typed fields, and page text goes on stdin.
- **No personal paths, accounts or keys** in code, tests or docs.

## Development
Prerequisites: Python 3.10+, Node 18+, Microsoft Edge.

1. Load `extension/` unpacked (see README).
2. After an edit, click **Reload** on the extension's card.
3. Run the checks:
   ```
   python -m pip install pytest playwright
   python -m pytest tests -q
   python tests/test_widget.py
   python tests/test_takeover.py
   python tests/test_isolation.py
   ```
4. Describe what you tested, and how, in the pull request.

## Security issues
Do not open a public issue. Follow `SECURITY.md`.

By contributing you agree that your contributions are licensed under the MIT License.
