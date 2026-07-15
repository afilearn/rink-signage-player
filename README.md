# ArenaSignage Player v1.4.2

LG SI screenshot-only fix.

Changes:
- Adds a dedicated LG SI capture path for Chrome 79/webOS.
- Temporarily removes the fixed live ad column before DOM capture while preserving the 70% schedule layout.
- Normalizes the LG screenshot to 1280x720 and composites the active ad once into the right 30%.
- Image ads are drawn into the screenshot; unsupported hardware-decoded video uses the proof-of-play panel.
- Android PixelCopy capture is unchanged.
- Windows/browser screenshot capture is unchanged.
- Live TV playback and layout are unchanged.

Deploy `index.html`, `logo.png`, `_headers`, `version.json`, and `README.md` to the player repository root.
