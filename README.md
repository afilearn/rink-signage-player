# ArenaSignage Player v1.3.6

Player-only deployment for Cloudflare Pages.

Changes from v1.3.5:
- Routes ad media through the Cloudflare Worker media proxy so browser and Android WebView screenshots can safely composite image/video ads without CORS-tainted canvases.
- Keeps native Android video playback unchanged.
- Adds a timestamped proof-of-play fallback panel only when a WebView cannot expose a hardware-decoded video frame to canvas.
- Retains responsive two-rink layout, overnight schedules, command polling, and screenshot cleanup.

Deploy `index.html`, `logo.png`, `_headers`, `version.json`, and this README at the repository root.
