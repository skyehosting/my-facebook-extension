# My Facebook - Friends & Following Only

A browser extension for Brave, Chrome and other Chromium browsers that turns facebook.com back into a feed of people you chose to see.

- **Home feed:** only posts from friends and accounts you follow. Ads, "Suggested for you" posts, the Reels shelf, "People you may know" and group suggestions are removed before they are drawn.
- **Loads ahead:** Facebook sends the feed a few stories at a time and most of them get filtered out, so the extension keeps a few of your posts loaded below the screen. Can be turned off in the popup.
- **My feed:** the home page is filled with friends' posts and posts from Pages you follow, newest first. They come from Facebook's own Friends and Pages feeds, which its server filters itself, so posts arrive several times faster than from the main mix. The popup can switch back to Facebook's ranked mix, or open the Friends or Pages feed alone.
- **Who you follow:** a page (the popup's Manage button) listing the accounts you follow, your friends and who you unfollowed, with Unfollow and Follow again buttons.
- **Reels:** choose whose reels you get: friends only, friends plus accounts you follow, or everything. Reels you have seen are replayed newest first in a loop when there is nothing new.
- **Unfollow from the post menu:** each post's "..." menu gets an Unfollow / Follow again entry.
- **Updates:** the extension checks this page once a day and tells you when a newer version exists.

It runs entirely in your browser. It does not send your data anywhere; the only outside request it makes is the daily version check against this GitHub repository.

## Install

1. Download the extension: **Code > Download ZIP** on this page ([direct link](https://github.com/skyehosting/my-facebook-extension/archive/refs/heads/main.zip)).
2. Unzip it somewhere it can stay, for example `Documents\My Facebook`. The browser loads the extension from this folder, so do not delete or move it afterwards.
3. Open `brave://extensions` (or `chrome://extensions`).
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and pick the unzipped folder, the one that contains `manifest.json`.
6. Open or refresh facebook.com.

Click the extension's icon for its settings. Friends-only reels needs your friends list: pick **Friends** under "Reels from" and press **Sync** once.

## Update

When a newer version is published, a notice appears in the bottom-left corner of facebook.com and in the extension's popup.

**Windows:** double-click **Update My Facebook.bat** in the extension folder. It downloads the new version into the folder, and the extension switches to it by itself the next time you open or refresh Facebook.

**Mac / Linux, or by hand:** download the ZIP again, unzip it over the same folder, then press the reload arrow on the extension's card on the extensions page.

In the popup, under **Updates**, you can:

- press **Check now** to check immediately,
- turn off **Check for updates once a day**,
- turn off **Load updates automatically** (you then press **Load it now** in the popup after running the updater).

A browser extension that is loaded from a folder cannot replace its own files, which is why installing an update takes that one double-click.

## Working on it

```
git clone https://github.com/skyehosting/my-facebook-extension.git
```

Load the cloned folder with **Load unpacked** as above. After changing files, press the reload arrow on the extension's card and refresh Facebook. In a git checkout, `Update My Facebook.bat` runs `git pull` instead of downloading a ZIP.

To publish a new version, raise `"version"` in `manifest.json` and push to `main`. Everyone's daily check compares their version with that file.

| File | What it does |
| --- | --- |
| `manifest.json` | Extension definition and version number |
| `src/main.js` | Runs inside facebook.com: feed filter, reels, post menu entry |
| `src/bridge.js` | Passes settings and saved lists between the page and the extension; shows the update notice |
| `src/background.js` | Daily update check; loads a new version once it is on disk |
| `src/style.css` | Styles for hidden posts and the extension's notices |
| `popup/` | The settings popup |
| `manage/` | The "Who you follow" page |
| `tools/update.ps1` | The updater that `Update My Facebook.bat` runs |

## Good to know

- Facebook changes its site often. When something stops being filtered, it usually means the extension needs an update.
- Unfollow uses Facebook's own follow action, so it changes who you follow on Facebook itself, not just what this extension shows.
- The parts that depend on text (a few fallbacks) assume Facebook is set to English.
