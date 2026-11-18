# Study Narrator

A browser extension for Microsoft Edge and Google Chrome that works as a reading companion. It:
- reads the important parts of a web page aloud;
- answers your spoken questions about the page;
- keeps a memory of the terms and passages you want to keep.

It works with the AI you choose: your Claude Code or Codex command-line login (through a small native
host), the ChatGPT web app, or an API key for Anthropic, OpenAI, an OpenAI-compatible endpoint
(OpenRouter, Groq, Ollama, LM Studio) or Gemini.

## Why it exists

Online courses and long documentation pages are hard to follow on a screen for hours. Plain
text-to-speech reads everything, including the navigation, the cookie banners and the "page 3 of 12".
Study Narrator has the AI turn the page into a listening script first:
- it keeps every fact, step and caveat;
- it drops the page furniture;
- it describes code in words.

You can stop and ask a question by voice at any point, and the answer is grounded in the page.

## Who it is for

- Students and self-learners working through online courses and docs.
- People who learn better by listening, or who need a break from reading.
- Anyone who already pays for Claude or ChatGPT and wants to use that subscription while studying.

## Features

- **Read** (▶ or Alt+R). The page is extracted with Mozilla Readability and turned into a listening
  script with up to 8 key terms. It is read sentence by sentence in the best natural voice available.
  You can pause, skip, change speed and resume.
- **Ask** (🎤 or Alt+A). This pauses the narration, listens to your question, and answers out loud using
  the page and the current sentence. Then it resumes. Typed questions work too.
- **Memory.**
  - Save highlights with ★, Alt+S or the right-click menu.
  - "Explain with AI" turns a highlight into a definition card. Key terms save with one click.
  - The side panel has search, tags, notes, Markdown/JSON export, spaced-repetition review and a voice
    quiz.
- **Widget.** A small draggable window on every page. You can minimize it, hide it per tab or per site,
  and its position is remembered.
- **Discuss in.** Opens the page and your highlight in a new ChatGPT, Claude.ai or Perplexity chat. The
  title, URL and up to 6,000 characters of page text travel in the new tab's URL, so they appear in your
  browser history and reach that service.

## Requirements

- Microsoft Edge or Google Chrome 116 or newer (any Chromium browser that supports MV3 side panels).
- For the **Claude Code** or **Codex** backends:
  - Python 3.10 or newer;
  - the `claude` or `codex` command-line tool, installed and signed in.
- For the **API** backends: an API key. For a local model, a running Ollama or LM Studio server.
- Windows, macOS or Linux. The installer registers the native host for the current user only.

## Install

1. Get the code:
   ```
   git clone https://git.bastionary.com/james/study-narrator.git
   ```
2. Load the extension:
   1. Open `edge://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
   2. Click **Load unpacked** and choose the `extension` folder.
   3. Copy the extension's **ID**, the 32 letters shown on its card.
3. Register the native host. This is only needed for the Claude Code and Codex backends:
   ```
   python host/install.py --extension-id <the ID you copied>
   ```
   This registers a host named `study_narrator` that only that extension ID may start. Use
   `--extension-id` once per browser if you use more than one. `python host/install.py --uninstall`
   removes it.
4. Open the extension's **Settings** (right-click the toolbar icon > Extension options), pick a backend,
   then click **Save and test this AI**.

## Quick start

1. Open any article or course page.
2. Press **Alt+R**. The first sentences start in about 10 to 20 seconds while the rest is prepared.
3. Press **Alt+A** and ask a question out loud, for example "What does that term mean?"
4. Highlight a sentence and press **Alt+S** to save it. Click the toolbar icon to open your notes.

## Configuring the native host (optional)

The host uses your normal `claude` / `codex` login and finds the tools on `PATH`. To point it at a
specific install, or to add named profiles (for example a second login), create `config.json`:
- Windows: `%APPDATA%\StudyNarrator\config.json`
- macOS: `~/Library/Application Support/StudyNarrator/config.json`
- Linux: `~/.config/StudyNarrator/config.json`

`$STUDY_NARRATOR_CONFIG` overrides the location.

```json
{
  "claude_path": "/usr/local/bin/claude",
  "codex_path": "/usr/local/bin/codex",
  "claude_profiles": { "second": { "CLAUDE_CONFIG_DIR": "/path/to/second/claude-config" } },
  "codex_profiles": { "second": { "CODEX_HOME": "/path/to/second/codex-home" } },
  "fallback_profile": "second"
}
```

Each key works as follows:
- `claude_path` and `codex_path` point at a specific install of each tool.
- A profile sets only `CLAUDE_CONFIG_DIR` (Claude) or `CODEX_HOME` (Codex). It never holds a token or a
  password.
- `fallback_profile` is tried once when a profile reports a usage limit.

To use a profile, type its name in Settings > Profile.

The host's log holds request metadata only, never page text:
- Windows: `%LOCALAPPDATA%\StudyNarrator\host.log`
- macOS: `~/Library/Application Support/StudyNarrator/host.log`
- Linux: `~/.local/share/StudyNarrator/host.log`

## The ChatGPT web backend

This backend keeps one pinned `chatgpt.com` tab (a temporary chat) and types into it through
`extension/chatgpt-bridge.js`. You must be signed in to ChatGPT in that browser.

Browsers put background tabs to sleep, so add `chatgpt.com` to the browser's "always keep active"
list:
- Edge: Settings > System and performance.
- Chrome: Settings > Performance.

ChatGPT's page markup changes from time to time. The selectors are at the top of `chatgpt-bridge.js`,
and **Diagnose the ChatGPT tab** in Settings shows what the bridge sees.

## Permissions, and why

| Permission | Why |
|---|---|
| Content script on `http`, `https` and `file` pages | The widget appears on the pages you read. File pages also need the browser's "Allow access to file URLs" toggle. |
| `storage` | Settings, notes, the narration cache and the widget position, all in your browser. |
| `activeTab`, `tabs`, `scripting` | Find the active tab and talk to its widget. Re-inject the widget into open tabs after an update. |
| `contextMenus`, `sidePanel` | The right-click entries and the notes panel. |
| `nativeMessaging` | The Claude Code and Codex backends. |
| `host_permissions` for the AI APIs, `localhost`, `127.0.0.1` and `chatgpt.com` | Calls to the backend you choose, local model servers, and the ChatGPT bridge. |
| Optional: all sites | Asked only if you enable "Allow updating the widget in open tabs", or use a custom API endpoint. |

API keys are stored in the browser's extension storage on your computer. They are sent only to the API
you configured.

## Tests

```
python -m pip install pytest playwright
python -m pytest tests/test_host.py tests/test_install.py   # offline: host protocol, validation, installer
python tests/test_widget.py                                  # headless Edge: widget drag/minimize/hide/restore
python tests/test_takeover.py                                # headless Edge: a new build replaces an old widget
python tests/test_isolation.py                               # headless Edge: pages cannot drive or read the widget
python tests/test_extension.py                               # headless Edge + registered host + Claude Code
python tests/test_host.py --claude                           # a live round trip through your Claude login
```

The browser tests use a throwaway profile in headless Edge (`channel="msedge"`). No window opens.

## Layout

- **`extension/`:** the MV3 extension.
  - `background.js`: the AI backends, the ChatGPT bridge driver and the notes store.
  - `content.js`: the widget.
  - `chatgpt-bridge.js`: runs on chatgpt.com.
  - `panel.*`: the notes side panel.
  - `options.*`: settings.
  - `lib/common.js`: shared helpers.
  - `lib/Readability.js`: Mozilla Readability.
- **`host/host.py`:** the native-messaging host. Its only actions are `ping`, `claude` and `codex`.
- **`host/install.py`:** registers or removes the host for the current user.
- **`tests/`:** host and installer unit tests, and headless browser tests.

## License

MIT, see `LICENSE`. `extension/lib/Readability.js` is Mozilla Readability, licensed under the Apache
License 2.0; see `THIRD-PARTY-NOTICES.md`. Contributions are welcome: see `CONTRIBUTING.md`. To report
a security problem, see `SECURITY.md`.
