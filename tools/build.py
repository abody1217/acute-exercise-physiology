"""Add the standalone editor to the original self-contained presentation."""
from pathlib import Path
from html.parser import HTMLParser
import json
import re

ROOT = Path(__file__).resolve().parents[1]


class IdentifySlides(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=False)
        self.source = source
        self.offsets = [0]
        for line in source.splitlines(keepends=True):
            self.offsets.append(self.offsets[-1] + len(line))
        self.slide = 0
        self.inside = False
        self.element = 0
        self.insertions = []

    def handle_starttag(self, tag, attrs):
        if tag == 'section':
            self.slide += 1
            self.element = 0
            self.inside = True
        if not self.inside:
            return
        raw = self.get_starttag_text()
        line, col = self.getpos()
        at = self.offsets[line - 1] + col + len(raw) - (2 if raw.endswith('/>') else 1)
        self.insertions.append((at, f' data-pe-id="s{self.slide:02d}-e{self.element:04d}"'))
        self.element += 1

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == 'section':
            self.inside = False


def build():
    html = (ROOT / 'source/base.html').read_text()
    pattern = r'(<script type="__bundler/template">)(.*?)(</script>)'
    match = re.search(pattern, html, re.S)
    template = json.loads(match.group(2))
    parser = IdentifySlides(template)
    parser.feed(template)
    assert 1 <= parser.slide <= 500, 'The presentation must contain between 1 and 500 slides.'
    for at, addition in reversed(parser.insertions):
        template = template[:at] + addition + template[at:]
    css = '\n'.join((ROOT / 'editor' / name).read_text() for name in ['editor-ui.css', 'editor.css'])
    js = '\n'.join((ROOT / 'editor' / name).read_text() for name in ['editor-ui.js', 'editor-files.js', 'editor.js'])
    # Preserve the canonical bundle for export before its loader swaps the DOM.
    bootstrap = """
  window.__peBundleHtml = '<!DOCTYPE html>\\n' + document.documentElement.outerHTML;
  try { window.__peSeed = JSON.parse(document.getElementById('pe-seed').textContent); }
  catch (error) { window.__peSeed = null; }
"""
    marker = "document.addEventListener('DOMContentLoaded', async function() {"
    assert html.count(marker) == 1
    html = html.replace(marker, marker + bootstrap, 1)
    template = template.replace('</head>', '<style id="presentation-editor-css">' + css + '</style></head>', 1)
    template = template.replace('</head>', '<script id="presentation-editor-js">' + js.replace('</script', '<\\/script') + '</script></head>', 1)
    encoded = json.dumps(template, ensure_ascii=False).replace('</', '<\\/')
    html = re.sub(pattern, lambda m: m.group(1) + encoded + m.group(3), html, count=1, flags=re.S)
    seed = {'format': 'acute-exercise-editor', 'version': 1, 'deckId': 'acute-exercise-v1',
            'documentId': 'acute-exercise-main-v1', 'patches': {}}
    # Keep client edits when rebuilding an index.html that was uploaded through the editor.
    existing = ROOT / 'index.html'
    if existing.exists():
        saved = re.search(r'<script[^>]*id="pe-seed"[^>]*>(.*?)</script>', existing.read_text(), re.S)
        if saved:
            value = json.loads(saved.group(1))
            if value.get('format') != seed['format'] or value.get('version') != 1:
                raise ValueError('The existing index.html uses an incompatible editor format.')
            seed = value
    html = html.replace('</body>', '<script type="application/json" id="pe-seed">' + json.dumps(seed).replace('<', '\\u003c') + '</script>\n</body>')
    (ROOT / 'index.html').write_text(html)
    print(f'Built {parser.slide} slides, {len(parser.insertions)} stable element IDs, {len(html.encode()):,} bytes.')


if __name__ == '__main__':
    build()
