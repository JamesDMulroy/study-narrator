# Security

## What runs where
- **The extension** runs in your browser. Settings, notes and API keys are kept in the browser's extension
  storage on your computer. Page text is sent only to the AI backend you choose.
- **The native host** (`host/host.py`) runs only when the browser starts it, and only for the extension
  IDs you registered with `host/install.py`. It opens no network port. Its only actions are `ping`,
  `claude` and `codex`. It passes page text to the AI tool on stdin, never on a command line. It checks
  model and profile names, and it runs the CLI with built-in tools and MCP servers disabled (Claude
  Code: `--tools ""` and `--strict-mcp-config`) or in a read-only sandbox (Codex). It never reads credentials; a profile can only point the CLI at another config
  folder.
- **Content scripts** run inside the pages you visit. They can use only the messages the widget needs.
  Settings, host access, note deletion and script injection are limited to the extension's own pages.
  A content script may change only a note's term, definition, kind, note and tags.
- **The widget** sits in a closed shadow root, so the page's own scripts cannot reach its controls or read
  its questions and answers, and it acts only on real (trusted) clicks and keys. Script-made events do
  nothing. As a second guard, each tab may ask, explain or start a narration only a few times a minute.

## Prompt injection
The AI reads the text of the pages you open. A page can contain text written to mislead an AI.
- With the **API backends** and **ChatGPT web**, the AI has no tools and no actions here, so the worst
  outcome is a misleading narration or answer.
- With **Claude Code**, the host removes the built-in tools and loads no MCP server or connector, so the
  same holds.
- With **Codex**, `codex exec -s read-only` still lets the model run commands that *read* files your
  account can read, and MCP servers in your Codex configuration still load. The prompt tells it not to,
  but injected page text can try to override that. A file's contents could then appear in an answer,
  which reaches only you (the page cannot read the widget). Prefer another backend for pages you do not
  trust, and keep MCP servers out of the Codex profile you use here.

Treat answers about untrusted pages with the same care as the page itself.

## Supported versions
Security fixes go to the latest version on the default branch.

## Reporting a vulnerability
Please report vulnerabilities privately by email to **hello@jamesmulroy.com**. Do not open a public
issue. Include:
- the browser and its version;
- the backend you used;
- the steps to reproduce;
- what you expected to happen.

You should get an acknowledgement within 7 days. A fix or mitigation plan follows once the report is
confirmed. Credit is given unless you prefer otherwise.
