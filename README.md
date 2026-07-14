# ArenaSignage Player v1.3.7

Player-only deployment for Cloudflare Pages.

Changes from v1.3.6:
- Prevents html2canvas from capturing the ad layer before manual compositing, fixing duplicated and misaligned browser screenshot ads.
- Captures a software-decoded frame for native Android/WebView video ads when the ExoPlayer surface cannot be copied into the DOM screenshot.
- Retains the timestamped proof-of-play fallback when the WebView cannot decode the campaign format.
- Keeps instant Reload/Screenshot commands, responsive schedules, overnight bookings, media proxying, and proof-of-play reporting.

Deploy `index.html`, `logo.png`, `_headers`, `version.json`, and this README at the repository root.
