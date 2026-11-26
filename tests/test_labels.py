import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMMENTS_AND_STRINGS = re.compile(
    r"(?P<string>'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`)|//[^\r\n]*"
)
STRINGS = re.compile(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`")


def test_ui_strings_do_not_name_claude():
    # Status and labels are backend-neutral; Claude.ai stays as the name of a site the page can be opened in.
    for filename in ("extension/content.js", "extension/panel.js"):
        source = (ROOT / filename).read_text(encoding="utf-8")
        without_comments = COMMENTS_AND_STRINGS.sub(
            lambda match: match.group("string") or "", source
        )
        for literal in STRINGS.findall(without_comments):
            assert re.search(r"\bClaude\b(?!\.ai)", literal) is None, f"{filename}: {literal}"
