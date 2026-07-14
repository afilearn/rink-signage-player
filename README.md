# ArenaSignage Player v1.4.0

This release fixes Chromium/browser screenshot composition while preserving Android PixelCopy capture.

Changes:
- Removes the full live ad subtree from the html2canvas clone.
- Uses a deterministic 70% schedule / 30% ad screenshot layout.
- Clears the ad destination before inserting the current image or video frame.
- Prevents fixed-position ads from floating over the schedule.
- Keeps native Android PixelCopy screenshots unchanged.

Deploy `index.html`, `logo.png`, `_headers`, `version.json`, and `README.md` to the player repository root.
