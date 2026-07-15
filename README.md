# ArenaSignage Player v1.4.1

This release corrects the remaining Windows/desktop-browser screenshot alignment issue while preserving the working Android PixelCopy and LG SI screenshot paths.

Changes:
- Desktop browsers capture the 70% schedule region separately.
- Builds a fresh viewport-sized screenshot canvas.
- Places the ad exactly once in the right-side 30% region.
- Prevents body/flex/html2canvas sizing differences from shifting the ad left.
- Android native PixelCopy capture is unchanged.
- LG SI DOM screenshot capture is unchanged.

Deploy `index.html`, `logo.png`, `_headers`, `version.json`, and `README.md` to the player repository root.
