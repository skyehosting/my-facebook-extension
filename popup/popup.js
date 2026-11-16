'use strict';

const DEFAULTS = {
  enabled: true,
  showGroups: false,
  reelsMode: 'following',   // 'friends' | 'following' | 'all'
  hideSideAds: true,
  loadAhead: true,          // keep a few approved posts loaded below the screen
  homeFeed: 'main',         // what facebook.com opens: 'main' | 'both' | 'friends' | 'pages'
  checkUpdates: true,      // ask GitHub once a day whether a newer version exists
  autoReload: true,         // load a new version by itself once the updater has installed it
  debug: false
};
const CHECKBOXES = ['enabled', 'showGroups', 'loadAhead', 'hideSideAds', 'debug', 'checkUpdates', 'autoReload'];
const VERSION = chrome.runtime.getManifest().version;
const CHANGES_URL = 'https://github.com/skyehosting/my-facebook-extension/commits/main';
const REASON_LABELS = {
  sponsored: 'ads',
  suggested: 'suggested',
  group: 'group posts',
  reels: 'reel shelves',
  unfollowed: 'unfollowed',
  other: 'other'
};
const REEL_HINTS = {
  friends: 'Only reels posted or shared by your friends, replayed newest first in a loop.',
  following: 'New reels from friends and accounts you follow, then a replay loop, newest first. Never "For you".',
  all: 'Facebook\'s normal reels, including "For you" and the Reels shelf in your feed.'
};
const FEED_HINTS = {
  main: "Facebook's own mix. Most of it gets filtered out here, so posts arrive slowly.",
  both: "Friends' posts and Pages you follow in one list, newest first. Loads several times faster than Main.",
  friends: "Facebook's Friends feed: only friends' posts, newest first. Loads several times faster.",
  pages: "Facebook's Pages feed: only Pages you follow, newest first. Loads several times faster."
};
const SYNC_URL = 'https://www.facebook.com/friends/list#ffo-sync';

const $ = (id) => document.getElementById(id);
let settings = Object.assign({}, DEFAULTS);
let friends = null;   // { ids, syncedAt, complete } once synced
let reels = [];       // replay list: [{ id, t, o, a }]
let unfollowed = [];  // [{ id, name, at, real, user }] unfollowed from a post's menu
let pendingFollow = []; // [{ id, name, user, tries }] waiting to be followed again on Facebook
let update = null;      // from the background worker: { latest, checkedAt, onDisk, error }
let checking = false;

// true when version a is higher than version b ("1.10.0" > "1.9.3")
function newer(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function renderUpdate() {
  const installed = update && update.onDisk && update.onDisk !== VERSION;   // new files are in the folder already
  const available = !installed && update && newer(update.latest, VERSION);
  let text;
  if (checking) text = 'Checking...';
  else if (installed) text = 'Version ' + update.onDisk + ' is installed and ready (running ' + VERSION + ').';
  else if (available) text = 'Version ' + update.latest + ' is available. You have ' + VERSION + '.';
  else if (update && update.error) text = 'Version ' + VERSION + '. Could not check: ' + update.error;
  else if (update && update.checkedAt) text = 'Version ' + VERSION + ' is up to date. Checked ' + ago(update.checkedAt) + '.';
  else text = 'Version ' + VERSION + '. Not checked yet.';
  $('updateInfo').textContent = text;
  $('checkUpdate').textContent = installed ? 'Load it now' : 'Check now';
  $('checkUpdate').disabled = checking;
  $('updateHow').hidden = !available;
}

function checkForUpdate(force) {
  checking = force;
  renderUpdate();
  chrome.runtime.sendMessage({ type: 'ffo-update-check', force }, (res) => {
    checking = false;
    if (!chrome.runtime.lastError && res) {
      if (res.reloading) { window.close(); return; }   // the extension is switching to the new version
      update = res;
    }
    renderUpdate();
  });
}

function normalize(raw) {
  const s = Object.assign({}, DEFAULTS, raw);
  if (!['friends', 'following', 'all'].includes(s.reelsMode)) s.reelsMode = 'following';
  if (!['main', 'both', 'friends', 'pages'].includes(s.homeFeed)) s.homeFeed = 'main';
  if (raw && raw.reelsMode == null && raw.reelsFollowingOnly === false) s.reelsMode = 'all';
  delete s.reelsFollowingOnly;
  delete s.filterReelShelf;
  return s;
}

function ago(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return days + ' days ago';
}

function render() {
  for (const key of CHECKBOXES) $(key).checked = !!settings[key];
  $('options').classList.toggle('off', !settings.enabled);
  $('reels').classList.toggle('off', !settings.enabled);
  $('feed').classList.toggle('off', !settings.enabled);
  for (const btn of document.querySelectorAll('#feedSeg button')) {
    const on = btn.dataset.feed === settings.homeFeed;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
  }
  $('feedHint').textContent = FEED_HINTS[settings.homeFeed];
  for (const btn of document.querySelectorAll('#reelsSeg button')) {
    const on = btn.dataset.mode === settings.reelsMode;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
  }
  $('reelsHint').textContent = REEL_HINTS[settings.reelsMode];

  const count = friends && Array.isArray(friends.ids) ? friends.ids.length : 0;
  $('friendsRow').hidden = settings.reelsMode !== 'friends';
  $('friendsRow').classList.toggle('need', !count);
  $('friendsInfo').textContent = count
    ? count + (count === 1 ? ' friend' : ' friends') + ' synced ' + ago(friends.syncedAt) + (friends.complete === false ? ' (partial)' : '')
    : 'Needs your friends list first. Until then this works like Friends + following.';
  $('syncFriends').textContent = count ? 'Re-sync' : 'Sync';

  // Replay list: what the reel viewer loops over once there is nothing new.
  const friendIds = new Set(count ? friends.ids : []);
  const fromFriends = reels.filter((r) => friendIds.has(r.o) || friendIds.has(r.a)).length;
  $('replayRow').hidden = settings.reelsMode === 'all';
  $('clearReplay').hidden = !reels.length;
  $('replayInfo').textContent = !reels.length
    ? 'Replay list is empty. It fills as reels from your friends and follows come by.'
    : settings.reelsMode === 'friends' && count
      ? 'Replay list: ' + fromFriends + (fromFriends === 1 ? ' reel' : ' reels') + ' from friends'
      : 'Replay list: ' + reels.length + (reels.length === 1 ? ' reel' : ' reels');

  // Accounts unfollowed from a post's menu, with a way back.
  $('unfollowedBox').hidden = !unfollowed.length && !pendingFollow.length;
  $('unfollowedTitle').textContent = 'Unfollowed (' + unfollowed.length + ')';
  $('pendingNote').hidden = !pendingFollow.length;
  $('pendingNote').textContent = 'Following again on Facebook: ' + pendingFollow.map((p) => p.name || p.id).join(', ') +
    '. This happens the next time your home feed is open.';
  const list = $('unfollowedList');
  list.textContent = '';
  for (const u of unfollowed.slice().sort((x, y) => y.at - x.at)) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = (u.name || u.id) + (u.real ? '' : ' (hidden here only)');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = u.real ? 'Follow' : 'Show';
    btn.addEventListener('click', () => {
      unfollowed = unfollowed.filter((x) => x.id !== u.id);
      if (u.real) {
        // Following again happens on Facebook itself, from a tab with your feed open.
        pendingFollow = pendingFollow.filter((p) => p.id !== u.id);
        pendingFollow.push({ id: u.id, name: u.name || '', user: u.user !== false, tries: 0 });
      }
      // An unfollow still queued from the manage page must not go through any more.
      chrome.storage.local.get({ pendingUnfollow: [] }, (d) => {
        const pendingUnfollow = (Array.isArray(d.pendingUnfollow) ? d.pendingUnfollow : []).filter((p) => p.id !== u.id);
        chrome.storage.local.set({ unfollowed, pendingFollow, pendingUnfollow });
      });
      render();
    });
    li.append(name, btn);
    list.append(li);
  }
}

function save() {
  chrome.storage.local.set({ settings });
}

for (const key of CHECKBOXES) {
  $(key).addEventListener('change', (ev) => {
    settings[key] = ev.target.checked;
    render();
    save();
    setTimeout(loadStats, 700);
  });
}

// A row of choices that works like radio buttons: click, or move with the arrow keys.
function wireChoices(selector, choose) {
  const buttons = Array.from(document.querySelectorAll(selector));
  buttons.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      choose(btn);
      render();
      save();
      setTimeout(loadStats, 700);
    });
    btn.addEventListener('keydown', (ev) => {
      const step = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      ev.preventDefault();
      const next = buttons[(i + step + buttons.length) % buttons.length];
      next.focus();
      next.click();
    });
  });
}
wireChoices('#reelsSeg button', (btn) => { settings.reelsMode = btn.dataset.mode; });
wireChoices('#feedSeg button', (btn) => { settings.homeFeed = btn.dataset.feed; });

// The page with everyone you follow, your friends and who you unfollowed.
$('openManage').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manage/manage.html') });
});

// Opens your friends list in a new tab; the extension reads it there and saves the ids locally.
$('syncFriends').addEventListener('click', () => {
  chrome.tabs.create({ url: SYNC_URL });
});

function showStats(stats) {
  const has = stats && (stats.hidden || stats.shown);
  $('stats').hidden = !has;
  $('nostats').hidden = !!has;
  if (!has) return;
  $('hiddenCount').textContent = stats.hidden;
  $('shownCount').textContent = stats.shown;
  const parts = Object.entries(stats.reasons || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => n + ' ' + (REASON_LABELS[reason] || reason));
  $('reasons').textContent = parts.join(' · ');
}

function loadStats() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;
    chrome.tabs.sendMessage(tab.id, { type: 'ffo-stats' }, (res) => {
      if (chrome.runtime.lastError || !res) { showStats(null); return; }
      if (res.path !== '/' && res.path !== '/home.php' && !(res.stats && res.stats.hidden)) {
        $('nostats').textContent = 'Go to your home feed to see what is being removed.';
      }
      showStats(res.stats);
    });
  });
}

$('checkUpdate').addEventListener('click', () => {
  if (update && update.onDisk && update.onDisk !== VERSION) {
    chrome.runtime.sendMessage({ type: 'ffo-reload' }, () => window.close());
    return;
  }
  checkForUpdate(true);
});
$('updateNotes').addEventListener('click', (ev) => {
  ev.preventDefault();
  chrome.tabs.create({ url: CHANGES_URL });
});

$('clearReplay').addEventListener('click', () => {
  reels = [];
  chrome.storage.local.set({ reels });
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.friends) friends = changes.friends.newValue || null;
  if (changes.reels) reels = Array.isArray(changes.reels.newValue) ? changes.reels.newValue : [];
  if (changes.unfollowed) unfollowed = Array.isArray(changes.unfollowed.newValue) ? changes.unfollowed.newValue : [];
  if (changes.pendingFollow) pendingFollow = Array.isArray(changes.pendingFollow.newValue) ? changes.pendingFollow.newValue : [];
  if (changes.friends || changes.reels || changes.unfollowed || changes.pendingFollow) render();
  if (changes.update) { update = changes.update.newValue || null; renderUpdate(); }
});

chrome.storage.local.get({ settings: {}, friends: null, reels: [], unfollowed: [], pendingFollow: [], update: null }, (data) => {
  update = data.update;
  renderUpdate();
  checkForUpdate(false);   // also notices a version the updater has just installed
  settings = normalize(data.settings);
  friends = data.friends;
  reels = Array.isArray(data.reels) ? data.reels : [];
  unfollowed = Array.isArray(data.unfollowed) ? data.unfollowed : [];
  pendingFollow = Array.isArray(data.pendingFollow) ? data.pendingFollow : [];
  render();
  loadStats();
});
