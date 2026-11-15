"""Local preview server for Bara that never lets the browser cache files.

    python serve.py            # http://localhost:8765/index.html
    python serve.py 8766       # another port

Same as `python -m http.server` run inside site/, but every response says "no-store", so a normal refresh
always loads the latest HTML, CSS, JavaScript and data. For development only; GitHub Pages serves the real site.
"""
import functools
import http.server
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parent / "site"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = functools.partial(NoCacheHandler, directory=str(SITE))
    with http.server.ThreadingHTTPServer(("", port), handler) as httpd:
        print(f"Bara preview: http://localhost:{port}/index.html  (no caching; press Ctrl+C to stop)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
