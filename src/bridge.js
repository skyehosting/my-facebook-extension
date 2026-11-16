/*
 * My Facebook - Friends & Following Only
 * Isolated-world half: carries settings from the popup (chrome.storage) to the
 * in-page script, remembers which accounts were seen as friends / followed, keeps
 * the synced friends list, and answers the popup's "what was hidden on this tab".
 */
(() => {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    showGroups: false,
    reelsMode: 'following',   // 'friends' | 'following' | 'all'
    hideSideAds: true,
    loadAhead: true,          // keep a few approved posts loaded below the screen
    homeFeed: 'mine',         // what facebook.com shows: 'mine' | 'main' | 'friends' | 'pages'
    feedV: 2,                 // marks settings saved since 'mine' exists
    checkUpdates: true,      // ask GitHub once a day whether a newer version exists
    autoReload: true,         // load a new version by itself once the updater has installed it
    debug: false
  };
  const MAX_CONNECTED = 5000;
  const MAX_FRIENDS = 10000;
  const MAX_FOLLOWING = 5000;

  function normalize(raw) {
    const s = Object.assign({}, DEFAULTS, raw);
    if (!['friends', 'following', 'all'].includes(s.reelsMode)) s.reelsMode = 'following';
    if (!['mine', 'main', 'friends', 'pages'].includes(s.homeFeed)) s.homeFeed = 'mine';
    if (raw && raw.feedV !== 2 && s.homeFeed === 'main') s.homeFeed = 'mine';   // 'main' was only the old default
    s.feedV = 2;
    if (raw && raw.reelsMode == null && raw.reelsFollowingOnly === false) s.reelsMode = 'all';
    delete s.reelsFollowingOnly;
    delete s.filterReelShelf;
    return s;
  }
  const validIds = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === 'string' && /^\d{1,32}$/.test(id)) : []);

  // Replay list entries: { id, t: posted (unix s), o: owner id, a: id of who posted/shared it }
  const MAX_REELS = 400;
  const idOrEmpty = (v) => (typeof v === 'string' && /^\d{1,32}$/.test(v) ? v : '');
  function validReels(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const r of list) {
      if (!r || !idOrEmpty(r.id)) continue;
      out.push({ id: r.id, t: Number(r.t) > 0 ? Math.floor(Number(r.t)) : 0, o: idOrEmpty(r.o), a: idOrEmpty(r.a) });
    }
    return out;
  }

  let settings = normalize(null);
  let connected = [];
  let friends = [];
  let reels = [];
  // [{ id, name, at, real, user }] accounts unfollowed from a post's menu.
  // real: also unfollowed on Facebook itself; user: a person/profile rather than a classic Page.
  let unfollowed = [];
  // [{ id, name, user, tries }] accounts to follow again on Facebook once a feed page is open.
  let pendingFollow = [];
  let stats = { shown: 0, hidden: 0, reasons: {} };
  const validUnfollowed = (list) => (Array.isArray(list)
    ? list.filter((u) => u && idOrEmpty(u.id)).map((u) => ({
      id: u.id, name: String(u.name || '').slice(0, 120), at: Number(u.at) || 0, real: u.real === true, user: u.user !== false
    }))
    : []);
  const validPending = (list) => (Array.isArray(list)
    ? list.filter((p) => p && idOrEmpty(p.id)).map((p) => ({
      id: p.id, name: String(p.name || '').slice(0, 120), user: p.user !== false, tries: Number(p.tries) || 0
    }))
    : []);
  // [{ id, name, user, tries }] accounts unfollowed on the manage page, to unfollow on Facebook too.
  let pendingUnfollow = [];
  // People for the manage page: [{ id, name, url, pic }], addresses limited to Facebook's own.
  const webAddress = (v, hosts) => {
    try {
      const u = new URL(String(v || ''));
      return u.protocol === 'https:' && hosts.test(u.hostname) && u.href.length <= 900 ? u.href : '';
    } catch (e) { return ''; }
  };
  const validPeople = (list, max) => (Array.isArray(list)
    ? list.filter((x) => x && idOrEmpty(x.id)).slice(0, max).map((x) => ({
      id: x.id,
      name: String(x.name || '').slice(0, 120),
      url: webAddress(x.url, /(^|\.)facebook\.com$/),
      pic: webAddress(x.pic, /(^|\.)(fbcdn\.net|facebook\.com)$/)
    }))
    : []);
  let loaded = false;
  let saveTimer = 0;
  let reelSaveTimer = 0;

  const alive = () => { try { return !!chrome.runtime.id; } catch (e) { return false; } };
  const send = (payload) => window.postMessage(Object.assign({ __ffo: 'bridge' }, payload), location.origin);
  // Settings of Facebook's own "load more posts" request, remembered between page loads
  // so the home feed can be filled without waiting for that request (see main.js).
  let feedVars = null;
  const validFeedVars = (v) => {
    try {
      return v && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(v).length < 20000 ? v : null;
    } catch (e) { return null; }
  };
  const sendInit = () => send({ settings, connected, friends, reels, unfollowed, pendingFollow, pendingUnfollow, feedVars });
  const saveReels = () => {
    clearTimeout(reelSaveTimer);
    reelSaveTimer = setTimeout(() => {
      reels.sort((x, y) => y.t - x.t);
      if (reels.length > MAX_REELS) reels = reels.slice(0, MAX_REELS);
      if (alive()) chrome.storage.local.set({ reels });
    }, 1000);
  };

  chrome.storage.local.get({ settings: {}, connected: [], friends: null, reels: [], unfollowed: [], pendingFollow: [], pendingUnfollow: [], feedVars: null }, (data) => {
    feedVars = validFeedVars(data.feedVars);
    pendingFollow = validPending(data.pendingFollow);
    pendingUnfollow = validPending(data.pendingUnfollow);
    settings = normalize(data.settings);
    connected = validIds(data.connected);
    friends = validIds(data.friends && data.friends.ids);
    reels = validReels(data.reels);
    unfollowed = validUnfollowed(data.unfollowed);
    loaded = true;
    sendInit();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = normalize(changes.settings.newValue);
      send({ settings });
    }
    if (changes.friends) {
      friends = validIds(changes.friends.newValue && changes.friends.newValue.ids);
      send({ friends });
    }
    if (changes.reels) {
      reels = validReels(changes.reels.newValue);
      send({ reels });
    }
    if (changes.unfollowed) {
      unfollowed = validUnfollowed(changes.unfollowed.newValue);
      send({ unfollowed });
    }
    if (changes.pendingFollow) {
      pendingFollow = validPending(changes.pendingFollow.newValue);
      send({ pendingFollow });
    }
    if (changes.pendingUnfollow) {
      pendingUnfollow = validPending(changes.pendingUnfollow.newValue);
      send({ pendingUnfollow });
    }
  });

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.__ffo !== 'main') return;
    if (d.type === 'hello') { if (loaded) sendInit(); return; }
    if (d.type === 'stats' && d.stats) { stats = d.stats; return; }
    if (d.type === 'feedVars') {
      const vars = validFeedVars(d.vars);
      if (vars && alive()) { feedVars = vars; chrome.storage.local.set({ feedVars: vars }); }
      return;
    }
    if (d.type === 'friends') {
      // Result of a friends-list sync on facebook.com/friends/list.
      const ids = validIds(d.ids).slice(0, MAX_FRIENDS);
      if (ids.length && alive()) {
        chrome.storage.local.set({ friends: { ids, syncedAt: Date.now(), complete: d.complete === true, items: validPeople(d.items, MAX_FRIENDS) } });
      }
      return;
    }
    if (d.type === 'following') {
      // Result of a sync of the accounts you follow, on your profile's Following list.
      const items = validPeople(d.items, MAX_FOLLOWING);
      if (items.length && alive()) chrome.storage.local.set({ following: { items, syncedAt: Date.now(), complete: d.complete === true } });
      return;
    }
    if ((d.type === 'unfollowDone' || d.type === 'unfollowFailed') && idOrEmpty(d.id)) {
      // An unfollow queued on the manage page was carried out on Facebook, or was refused.
      const had = pendingUnfollow.find((p) => p.id === d.id);
      pendingUnfollow = pendingUnfollow.filter((p) => p.id !== d.id);
      if (d.type === 'unfollowDone') {
        unfollowed = unfollowed.map((u) => (u.id === d.id ? Object.assign({}, u, { real: true }) : u));
      } else if (had && had.tries < 2) {
        pendingUnfollow.push(Object.assign({}, had, { tries: had.tries + 1 }));   // dropped after three failures
      }
      if (alive()) chrome.storage.local.set({ unfollowed, pendingUnfollow });
      return;
    }
    if (d.type === 'reels') {
      // Reels from friends / followed accounts seen on this tab: merge into the replay list.
      const byId = new Map(reels.map((r) => [r.id, r]));
      let changed = false;
      for (const r of validReels(d.items)) {
        const old = byId.get(r.id);
        if (old && old.t === r.t && old.o === r.o && old.a === r.a) continue;
        byId.set(r.id, r);
        changed = true;
      }
      if (changed) { reels = Array.from(byId.values()); saveReels(); }
      return;
    }
    if (d.type === 'unfollow' && idOrEmpty(d.id)) {
      // "Unfollow" / "Follow again" clicked in a post's menu.
      unfollowed = unfollowed.filter((u) => u.id !== d.id);
      if (d.off === true) {
        unfollowed.push({ id: d.id, name: String(d.name || '').slice(0, 120), at: Date.now(), real: d.real === true, user: d.user !== false });
        // Unfollowed again: a queued "follow again" for the same account no longer applies.
        pendingFollow = pendingFollow.filter((p) => p.id !== d.id);
      }
      // Either way the post menu has now dealt with this account, so drop a queued unfollow.
      pendingUnfollow = pendingUnfollow.filter((p) => p.id !== d.id);
      if (alive()) chrome.storage.local.set({ unfollowed, pendingFollow, pendingUnfollow });
      return;
    }
    if ((d.type === 'followPending' || d.type === 'followDone' || d.type === 'followFailed') && idOrEmpty(d.id)) {
      const had = pendingFollow.find((p) => p.id === d.id);
      pendingFollow = pendingFollow.filter((p) => p.id !== d.id);
      if (d.type === 'followPending') {
        pendingFollow.push({ id: d.id, name: String(d.name || '').slice(0, 120), user: d.user !== false, tries: 0 });
      } else if (d.type === 'followFailed' && had && had.tries < 2) {
        pendingFollow.push(Object.assign({}, had, { tries: had.tries + 1 }));   // dropped after three failures
      }
      if (alive()) chrome.storage.local.set({ pendingFollow });
      return;
    }
    if (d.type === 'reelDrop' && idOrEmpty(d.id)) {
      const kept = reels.filter((r) => r.id !== d.id);
      if (kept.length !== reels.length) { reels = kept; saveReels(); }
      return;
    }
    if (d.type === 'connected' && Array.isArray(d.ids)) {
      const known = new Set(connected);
      for (const id of validIds(d.ids)) {
        if (!known.has(id)) { known.add(id); connected.push(id); }
      }
      if (connected.length > MAX_CONNECTED) connected = connected.slice(-MAX_CONNECTED);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { if (alive()) chrome.storage.local.set({ connected }); }, 1500);
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg && msg.type === 'ffo-stats') respond({ stats, path: location.pathname });
  });

  /* ---------------- Update notice (only ever shown on facebook.com) ---------------- */

  const VERSION = chrome.runtime.getManifest().version;
  const SNOOZE_MS = 24 * 60 * 60 * 1000;
  let update = null;        // what the background worker last learned: { latest, checkedAt, ... }
  let snooze = null;        // { version, until } after "Later"
  let reloadedTo = '';      // set when the extension has just loaded a new version under this page

  // true when version a is higher than version b ("1.10.0" > "1.9.3")
  function newer(a, b) {
    const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    }
    return false;
  }

  function renderUpdateNotice() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', renderUpdateNotice, { once: true }); return; }
    const old = document.getElementById('ffo-update');
    let text = '';
    let button = '';
    if (reloadedTo) {
      text = (reloadedTo === '?' ? 'My Facebook was updated or reloaded.' : 'My Facebook was updated to version ' + reloadedTo + '.') +
        ' Refresh this page to start using the current version.';
      button = 'Refresh';
    } else if (settings.enabled !== false && settings.checkUpdates !== false && update && newer(update.latest, VERSION) &&
               !(snooze && snooze.version === update.latest && Date.now() < snooze.until)) {
      text = 'My Facebook ' + update.latest + ' is available (you have ' + VERSION + '). ' +
        'To install it, double-click "Update My Facebook.bat" in the extension folder.';
      button = 'Later';
    }
    if (!text) { if (old) old.remove(); return; }
    const box = old || document.createElement('div');
    box.id = 'ffo-update';
    box.textContent = '';
    const msg = document.createElement('span');
    msg.textContent = text;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = button;
    btn.addEventListener('click', () => {
      if (reloadedTo) { location.reload(); return; }
      snooze = { version: update.latest, until: Date.now() + SNOOZE_MS };
      if (alive()) chrome.storage.local.set({ updateSnooze: snooze });
      renderUpdateNotice();
    });
    box.append(msg, btn);
    if (!old) document.body.appendChild(box);
  }

  chrome.storage.local.get({ update: null, updateSnooze: null }, (data) => {
    update = data.update;
    snooze = data.updateSnooze;
    renderUpdateNotice();
    // Opening Facebook is also a moment to look for updates (at most one real check a day).
    try {
      chrome.runtime.sendMessage({ type: 'ffo-update-check' }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        if (res.reloading) { reloadedTo = res.onDisk || ''; renderUpdateNotice(); }
      });
    } catch (e) { /* extension was reloaded under this page */ }
  });

  // Once the extension has been reloaded (for example after an update), the copy of it
  // running in this page is cut off and the page keeps the old version until refreshed.
  const cutOffWatch = setInterval(() => {
    if (alive()) return;
    clearInterval(cutOffWatch);
    if (!reloadedTo) reloadedTo = '?';
    renderUpdateNotice();
  }, 5000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.update) update = changes.update.newValue || null;
    if (changes.updateSnooze) snooze = changes.updateSnooze.newValue || null;
    if (changes.update || changes.updateSnooze || changes.settings) renderUpdateNotice();
  });
})();
