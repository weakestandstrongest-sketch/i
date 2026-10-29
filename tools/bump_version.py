#!/usr/bin/env python3
"""Stamp a new asset version into index.html and sw.js.

GitHub Pages lets browsers reuse files for up to 10 minutes, so after a deploy a
phone can load the new index.html with an old styles.css or old modules. Every
local asset is therefore referenced as file?v=N (modules via the import map),
and this script bumps N everywhere at once. Run it before each commit that
changes the site:  python3 tools/bump_version.py
"""
import pathlib, re

root = pathlib.Path(__file__).resolve().parent.parent
index = root / 'index.html'
sw = root / 'sw.js'

html = index.read_text()
m = re.search(r'<meta name="asset-version" content="(\d+)"', html)
version = int(m.group(1)) + 1 if m else 1

modules = sorted(p.name for p in (root / 'js').glob('*.js'))
entries = ',\n'.join(f'        "./js/{name}": "./js/{name}?v={version}"' for name in modules)
block = f'''<script type="importmap">
    {{
      "imports": {{
        "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
        "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/",
{entries}
      }}
    }}
  </script>'''

html = re.sub(r'<script type="importmap">.*?</script>', block, html, count=1, flags=re.S)
html = re.sub(r'href="styles\.css(\?v=\d+)?"', f'href="styles.css?v={version}"', html)
html = re.sub(r'src="js/main\.js(\?v=\d+)?"', f'src="js/main.js?v={version}"', html)
if m:
    html = html.replace(m.group(0), f'<meta name="asset-version" content="{version}"')
else:
    html = html.replace('<meta charset="utf-8" />', f'<meta charset="utf-8" />\n  <meta name="asset-version" content="{version}" />', 1)
index.write_text(html)

js = sw.read_text()
js = re.sub(r"const CACHE = 'resonance-assets-v\d+';", f"const CACHE = 'resonance-assets-v{version}';", js)
js = re.sub(r"const V = '\?v=\d+';", f"const V = '?v={version}';", js)
sw.write_text(js)
print(f'asset version -> {version}')
