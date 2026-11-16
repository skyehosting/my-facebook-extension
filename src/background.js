/*
 * My Facebook - Friends & Following Only
 * Background service worker: update checking.
 *
 * An extension loaded from a folder cannot replace its own files, so updating is
 * split in two:
 *   1. This worker asks GitHub once a day which version is the latest and records it;
 *      the popup and a notice on facebook.com show when a newer one exists.
 *   2. "Update My Facebook.bat" (in the extension folder) downloads the new files.
 *      This worker notices that the files on disk are newer than the version that is
 *      running and reloads the extension, so no trip to the extensions page is needed.
 */
'use strict';

const REPO = 'skyehosting/my-facebook-extension';
const BRANCH = 'main';
const REMOTE_MANIFEST = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/manifest.json';
const DAY = 24 * 60 * 60 * 1000;
const RUNNING = chrome.runtime.getManifest().version;

// The manifest in the folder right now (read from disk, not the copy loaded at start-up).
async function versionOnDisk() {
  const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
  return String((await res.json()).version || '');
}

let running = null;   // one check at a time
function check(force) {
  if (!running) running = doCheck(force).finally(() => { running = null; });
  return running;
}

async function doCheck(force) {
  const data = await chrome.storage.local.get({ settings: {}, update: {} });
  const settings = data.settings || {};
  const update = Object.assign({}, data.update, { running: RUNNING });

  let onDisk = RUNNING;
  try { onDisk = await versionOnDisk(); } catch (e) { /* keep the running version */ }
  update.onDisk = onDisk;
  if (onDisk && onDisk !== RUNNING && settings.autoReload !== false) {
    // The updater has put a different version in the folder: load it.
    await chrome.storage.local.set({ update });
    setTimeout(() => chrome.runtime.reload(), 700);
    return Object.assign({ reloading: true }, update);
  }

  const due = force || (settings.checkUpdates !== false && Date.now() - (update.checkedAt || 0) > DAY);
  if (due) {
    try {
      const res = await fetch(REMOTE_MANIFEST, { cache: 'no-store' });
      if (!res.ok) throw new Error('GitHub answered ' + res.status);
      update.latest = String((await res.json()).version || '');
      update.error = '';
    } catch (e) {
      update.error = String((e && e.message) || e);
    }
    update.checkedAt = Date.now();
  }
  await chrome.storage.local.set({ update });
  return update;
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg) return undefined;
  if (msg.type === 'ffo-update-check') {
    check(msg.force === true).then(respond, (e) => respond({ error: String((e && e.message) || e) }));
    return true;   // answer comes later
  }
  if (msg.type === 'ffo-reload') {
    respond({ ok: true });
    setTimeout(() => chrome.runtime.reload(), 300);
  }
  return undefined;
});

const schedule = () => chrome.alarms.create('ffo-update', { periodInMinutes: 60 });
chrome.runtime.onInstalled.addListener(() => { schedule(); check(false); });
chrome.runtime.onStartup.addListener(() => { schedule(); check(false); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'ffo-update') check(false); });
