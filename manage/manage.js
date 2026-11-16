'use strict';

/*
 * My Facebook - "Who you follow" page (opened from the popup's Manage button).
 *
 * Shows three lists kept in the extension's own storage: the accounts you follow and your
 * friends (both read from Facebook by a Sync), and the accounts you unfollowed. Unfollowing
 * here hides the account in My Facebook straight away and queues the unfollow on Facebook
 * itself; a Facebook tab carries the queue out (see processPendingFollows in src/main.js).
 */

const SYNC_URLS = {
  following: 'https://www.facebook.com/me/following#ffo-sync',
  friends: 'https://www.facebook.com/friends/list#ffo-sync'
};
// The main feed is where Facebook loads its follow buttons, which the queued changes need.
const FACEBOOK_URL = 'https://www.facebook.com/#ffo-main';
const TABS = ['following', 'friends', 'unfollowed'];

const $ = (id) => document.getElementById(id);
let tab = 'following';
let following = null;      // { items: [{ id, name, url, pic }], syncedAt, complete }
let friends = null;        // { ids, items, syncedAt, complete }
let unfollowed = [];       // [{ id, name, at, real, user }]
let pendingFollow = [];    // [{ id, name, user, tries }] to follow again on Facebook
let pendingUnfollow = [];  // [{ id, name, user, tries }] to unfollow on Facebook

const list = (v) => (Array.isArray(v) ? v : []);
const people = (box) => list(box && box.items);

function ago(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return days + ' days ago';
}

/* ---------------- Changes ---------------- */

function unfollow(person) {
  unfollowed = unfollowed.filter((u) => u.id !== person.id);
  unfollowed.push({ id: person.id, name: person.name || '', at: Date.now(), real: false, user: true });
  pendingFollow = pendingFollow.filter((p) => p.id !== person.id);
  pendingUnfollow = pendingUnfollow.filter((p) => p.id !== person.id);
  pendingUnfollow.push({ id: person.id, name: person.name || '', user: true, tries: 0 });
  chrome.storage.local.set({ unfollowed, pendingFollow, pendingUnfollow });
  render();
}

function followAgain(id) {
  const entry = unfollowed.find((u) => u.id === id);
  if (!entry) return;
  const waiting = pendingUnfollow.some((p) => p.id === id);
  unfollowed = unfollowed.filter((u) => u.id !== id);
  pendingUnfollow = pendingUnfollow.filter((p) => p.id !== id);
  if (entry.real && !waiting) {
    // It was unfollowed on Facebook itself, so following again has to happen there too.
    pendingFollow = pendingFollow.filter((p) => p.id !== id);
    pendingFollow.push({ id, name: entry.name || '', user: entry.user !== false, tries: 0 });
  }
  chrome.storage.local.set({ unfollowed, pendingFollow, pendingUnfollow });
  render();
}

/* ---------------- Rows ---------------- */

function avatar(person) {
  const box = document.createElement('span');
  box.className = 'avatar';
  const letter = () => { box.textContent = (person.name || '?').trim().charAt(0).toUpperCase() || '?'; };
  if (person.pic) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', letter);   // picture addresses expire; fall back to the initial
    img.src = person.pic;
    box.append(img);
  } else {
    letter();
  }
  return box;
}

function row(person, status, waiting, buttonText, secondary, onClick) {
  const li = document.createElement('li');
  const who = document.createElement('div');
  who.className = 'who';
  const link = document.createElement('a');
  link.href = person.url || 'https://www.facebook.com/profile.php?id=' + person.id;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = person.name || 'Account ' + person.id;
  who.append(link);
  if (status) {
    const small = document.createElement('small');
    if (waiting) small.className = 'wait';
    small.textContent = status;
    who.append(small);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  if (secondary) btn.className = 'secondary';
  btn.textContent = buttonText;
  btn.setAttribute('aria-label', buttonText + ' ' + (person.name || person.id));
  btn.addEventListener('click', onClick);
  li.append(avatar(person), who, btn);
  return li;
}

/* ---------------- Page ---------------- */

function rowsFor(which) {
  const off = new Map(unfollowed.map((u) => [u.id, u]));
  const waitingOff = new Set(pendingUnfollow.map((p) => p.id));
  const waitingOn = new Set(pendingFollow.map((p) => p.id));
  const followRow = (p) => row(p, waitingOn.has(p.id) ? 'Following again on Facebook is waiting for a Facebook tab' : '',
    waitingOn.has(p.id), 'Unfollow', true, () => unfollow(p));

  if (which === 'following') {
    return people(following).filter((p) => !off.has(p.id)).map((p) => ({ name: p.name, el: () => followRow(p) }));
  }
  if (which === 'friends') {
    return people(friends).map((p) => ({
      name: p.name,
      el: () => (off.has(p.id)
        ? row(p, 'Unfollowed: still your friend, but their posts are hidden', false, 'Follow again', false, () => followAgain(p.id))
        : followRow(p))
    }));
  }
  // Unfollowed: newest first, with picture and address where a synced list knows them.
  const known = new Map();
  for (const p of people(friends)) known.set(p.id, p);
  for (const p of people(following)) known.set(p.id, p);
  return unfollowed.slice().sort((a, b) => b.at - a.at).map((u) => {
    const info = known.get(u.id) || {};
    const person = { id: u.id, name: u.name || info.name || '', url: info.url || '', pic: info.pic || '' };
    const waiting = waitingOff.has(u.id);
    const status = waiting
      ? 'Hidden in My Facebook. The unfollow on Facebook is waiting for a Facebook tab.'
      : u.real
        ? 'Unfollowed on Facebook' + (u.at ? ', ' + ago(u.at) : '')
        : 'Hidden in My Facebook only' + (u.at ? ', ' + ago(u.at) : '');
    return {
      name: person.name,
      el: () => row(person, status, waiting, u.real || waiting ? 'Follow again' : 'Show again', false, () => followAgain(u.id))
    };
  });
}

function syncedText(box, noun) {
  const n = people(box).length;
  if (!box || !n) return '';
  return n + ' ' + noun + (n === 1 ? '' : 's') + ', synced ' + ago(box.syncedAt) + (box.complete === false ? ' (partial)' : '');
}

function render() {
  const off = new Set(unfollowed.map((u) => u.id));
  const counts = {
    following: people(following).filter((p) => !off.has(p.id)).length,
    friends: people(friends).length,
    unfollowed: unfollowed.length
  };
  for (const name of TABS) {
    const btn = $('tab-' + name);
    const on = name === tab;
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
    btn.querySelector('.count').textContent = '(' + counts[name] + ')';
  }
  $('panel').setAttribute('aria-labelledby', 'tab-' + tab);

  // What is still waiting to be carried out on Facebook itself.
  const parts = [];
  if (pendingUnfollow.length) parts.push('unfollow ' + pendingUnfollow.map((p) => p.name || p.id).join(', '));
  if (pendingFollow.length) parts.push('follow ' + pendingFollow.map((p) => p.name || p.id).join(', ') + ' again');
  $('pending').hidden = !parts.length;
  $('pendingText').textContent = 'Still to do on Facebook: ' + parts.join('; ') +
    '. It happens in an open Facebook tab once Facebook has loaded its follow buttons there, which can take a while.' +
    ' In the meantime My Facebook already hides or shows these accounts.';

  const source = tab === 'following' ? following : tab === 'friends' ? friends : null;
  $('sync').hidden = tab === 'unfollowed';
  $('sync').textContent = people(source).length ? 'Re-sync' : 'Sync';
  $('synced').textContent = tab === 'following' ? syncedText(following, 'account') : tab === 'friends' ? syncedText(friends, 'friend') : '';
  $('intro').textContent = tab === 'following'
    ? 'Accounts and Pages you follow on Facebook. Unfollowing takes effect in your feed after you refresh Facebook.'
    : tab === 'friends'
      ? 'Unfollowing a friend keeps them as a friend and only hides their posts.'
      : 'Accounts you unfollowed. Follow again puts their posts back after you refresh Facebook.';

  const query = $('search').value.trim().toLowerCase();
  const all = rowsFor(tab);
  const shown = query ? all.filter((r) => (r.name || '').toLowerCase().includes(query)) : all;
  const ul = $('list');
  ul.textContent = '';
  for (const r of shown) ul.append(r.el());

  const needsNames = tab === 'friends' && !people(friends).length && friends && list(friends.ids).length;
  let empty = '';
  if (!shown.length) {
    if (query && all.length) empty = 'Nobody matches "' + $('search').value.trim() + '".';
    else if (tab === 'unfollowed') empty = 'You have not unfollowed anyone with My Facebook.';
    else if (needsNames) empty = 'Your friends list was synced by an older version, without names. Sync it again to see it here.';
    else if (people(source).length) empty = 'Everyone on this list is on the Unfollowed tab.';
    else empty = tab === 'following'
      ? 'Sync to load the accounts you follow. It opens your Following list on Facebook in a new tab and reads it there.'
      : 'Sync to load your friends. It opens your friends list on Facebook in a new tab and reads it there.';
  }
  $('empty').hidden = !empty;
  $('emptyText').textContent = empty;
  $('emptySync').hidden = tab === 'unfollowed' || (query && all.length > 0) || (people(source).length > 0 && !needsNames);
  $('search').hidden = !all.length;
}

function selectTab(name, focus) {
  tab = name;
  $('search').value = '';
  render();
  if (focus) $('tab-' + name).focus();
}

TABS.forEach((name, i) => {
  const btn = $('tab-' + name);
  btn.addEventListener('click', () => selectTab(name, false));
  btn.addEventListener('keydown', (ev) => {
    const step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    selectTab(TABS[(i + step + TABS.length) % TABS.length], true);
  });
});

const startSync = () => { if (SYNC_URLS[tab]) chrome.tabs.create({ url: SYNC_URLS[tab] }); };
$('sync').addEventListener('click', startSync);
$('emptySync').addEventListener('click', startSync);
$('openFacebook').addEventListener('click', () => chrome.tabs.create({ url: FACEBOOK_URL }));
$('search').addEventListener('input', render);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.following) following = changes.following.newValue || null;
  if (changes.friends) friends = changes.friends.newValue || null;
  if (changes.unfollowed) unfollowed = list(changes.unfollowed.newValue);
  if (changes.pendingFollow) pendingFollow = list(changes.pendingFollow.newValue);
  if (changes.pendingUnfollow) pendingUnfollow = list(changes.pendingUnfollow.newValue);
  if (changes.following || changes.friends || changes.unfollowed || changes.pendingFollow || changes.pendingUnfollow) render();
});

chrome.storage.local.get({ following: null, friends: null, unfollowed: [], pendingFollow: [], pendingUnfollow: [] }, (data) => {
  following = data.following;
  friends = data.friends;
  unfollowed = list(data.unfollowed);
  pendingFollow = list(data.pendingFollow);
  pendingUnfollow = list(data.pendingUnfollow);
  if (location.hash === '#friends' || location.hash === '#unfollowed') tab = location.hash.slice(1);
  render();
});
