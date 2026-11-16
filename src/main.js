/*
 * My Facebook - Friends & Following Only
 * Runs inside the page (MAIN world) at document_start.
 *
 * Facebook keeps every story it is about to render in its own client-side data
 * store, including whether it is sponsored, "unconnected" (suggested), a group
 * post, and whether you follow the author. This script reads that store to
 * decide what stays, and only falls back to looking at the rendered post when
 * the store cannot be read.
 *
 *  - Home feed:   a post is shown only if it comes from a friend or an account
 *                 you follow. Ads, suggestions, shelves and (optionally) group
 *                 posts never get painted.
 *  - Unfollow:    a post's "..." menu gets an Unfollow / Follow again entry. It unfollows
 *                 the account on Facebook (through Facebook's own action) and puts it
 *                 on the extension's hide list, which applies from the next page load.
 *  - Replay:      reels from friends / followed accounts are remembered and replayed
 *                 newest first, in a loop, once Facebook has nothing new to serve.
 *  - Reels mode:  'following' (friends + followed, the default), 'friends' (only
 *                 people on your synced friends list) or 'all' (leave reels alone).
 *  - Reel viewer: playback is kept on Facebook's own "Following" reel feed. The list
 *                 that feed plays from is cleaned and filled ahead of the viewer:
 *                 unwanted reels are taken out before they are reached, more of the
 *                 feed is fetched in the background, and the remembered reels are added
 *                 to the same list when there is nothing new (see "Reel queue"). If
 *                 that cannot work, unwanted reels are clicked past one at a time.
 */
(() => {
  'use strict';
  if (window.__ffoLoaded) return;
  window.__ffoLoaded = true;

  const html = document.documentElement;
  const LS_KEY = '__ffo_settings';
  const DEFAULTS = {
    enabled: true,
    showGroups: false,        // posts from groups you joined, written by non-friends
    reelsMode: 'following',   // whose reels to show: 'friends' | 'following' (friends + followed) | 'all'
    hideSideAds: true,        // "Sponsored" block in the right-hand column
    loadAhead: true,          // keep a few approved posts loaded below the screen
    // What facebook.com shows: 'mine' (home page filled with friends' posts and Pages you follow),
    // 'main' (Facebook's own mix, filtered), 'friends' or 'pages' (Facebook's feeds of that name).
    homeFeed: 'mine',
    feedV: 2,                 // marks settings saved since 'mine' exists (see normalize)
    debug: false            // show hidden posts dimmed with the reason, log to console
  };

  function normalize(raw) {
    const s = Object.assign({}, DEFAULTS, raw);
    if (!['friends', 'following', 'all'].includes(s.reelsMode)) s.reelsMode = 'following';
    if (!['mine', 'main', 'friends', 'pages'].includes(s.homeFeed)) s.homeFeed = 'mine';
    // Settings saved before 'mine' existed carry 'main' only because it was the default then.
    if (raw && raw.feedV !== 2 && s.homeFeed === 'main') s.homeFeed = 'mine';
    s.feedV = 2;
    // Settings saved by version 1.0 had an on/off switch instead of a mode.
    if (raw && raw.reelsMode == null && raw.reelsFollowingOnly === false) s.reelsMode = 'all';
    delete s.reelsFollowingOnly;
    delete s.filterReelShelf;
    return s;
  }

  let settings = normalize(null);
  try { settings = normalize(JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) { /* first run */ }

  // Facebook has feeds of its own that hold only friends' posts, or only posts from
  // Pages you follow, newest first. Its server does the filtering there, so they arrive
  // several times faster than the main feed, where most stories get thrown away here.
  const FEED_URLS = { friends: '/?filter=friends&sk=h_chr', pages: '/?filter=pages&sk=h_chr' };
  const MAIN_FEED_HASH = '#ffo-main';   // "show me the main feed this once"
  const onPlainHome = () => (location.pathname === '/' || location.pathname === '/home.php') &&
    !/[?&](filter|sk)=/.test(location.search) && location.hash !== MAIN_FEED_HASH;
  function goChosenFeed() {
    const target = settings.enabled ? FEED_URLS[settings.homeFeed] : null;
    if (!target || !onPlainHome()) return false;
    location.replace(target);
    return true;
  }
  goChosenFeed();

  const now = () => Date.now();
  const log = (...a) => { if (settings.debug) console.debug('[My Facebook]', ...a); };
  const setFlag = (name, on) => {
    if (on) { if (!html.hasAttribute(name)) html.setAttribute(name, ''); }
    else if (html.hasAttribute(name)) html.removeAttribute(name);
  };
  const toBridge = (type, payload) => {
    try { window.postMessage(Object.assign({ __ffo: 'main', type }, payload), location.origin); } catch (e) { /* ignore */ }
  };

  /* ------------------------------------------------------------------ */
  /* Facebook's data store                                               */
  /* ------------------------------------------------------------------ */

  let relayEnv = null;
  function source() {
    try {
      if (!relayEnv) {
        if (typeof window.require !== 'function') return null;
        relayEnv = window.require('CometRelayEnvironment');
        hookFeedRequests();   // as early as possible, so Facebook's first "load more" request is seen
        hookStore();
      }
      return relayEnv.getStore().getSource();
    } catch (e) {
      relayEnv = null;
      return null;
    }
  }

  // Store fields are keyed "name" or "name(args)"; return the first variant that has a value.
  function field(rec, name) {
    if (!rec) return undefined;
    if (rec[name] != null) return rec[name];
    const prefix = name + '(';
    let sawKey = name in rec;
    for (const k in rec) {
      if (k.startsWith(prefix)) {
        if (rec[k] != null) return rec[k];
        sawKey = true;
      }
    }
    return sawKey ? null : undefined;
  }
  const deref = (src, v) => (v && v.__ref ? src.get(v.__ref) || null : null);
  const derefs = (src, v) => (v && v.__refs ? v.__refs.map((id) => (id == null ? null : src.get(id))).filter(Boolean) : []);
  const viewerRecord = (src) => src.get('client:root:viewer') || deref(src, (src.get('client:root') || {}).viewer);

  let cachedViewerId = null;
  function viewerId() {
    if (cachedViewerId) return cachedViewerId;
    try { cachedViewerId = String(window.require('CurrentUserInitialData').USER_ID || '') || null; } catch (e) { /* not ready */ }
    if (!cachedViewerId) {
      const m = document.cookie.match(/(?:^|; )c_user=(\d+)/);
      if (m) cachedViewerId = m[1];
    }
    return cachedViewerId;
  }

  /* ------------------------------------------------------------------ */
  /* Who counts as "mine": friends and followed accounts                 */
  /* ------------------------------------------------------------------ */

  const connected = new Set();   // account ids seen posting in the feed as a friend / followed account
  let connectedOutbox = [];
  let connectedTimer = 0;
  function rememberConnected(id) {
    if (!id || connected.has(id)) return;
    connected.add(id);
    connectedOutbox.push(id);
    clearTimeout(connectedTimer);
    connectedTimer = setTimeout(() => {
      toBridge('connected', { ids: connectedOutbox });
      connectedOutbox = [];
    }, 2000);
  }

  // Accounts unfollowed from a post's "..." menu. They are unfollowed on Facebook where
  // possible (see fbSetFollow) and always kept on this list, which is what hides them here
  // and what makes "Follow again" possible. `unfollowed` is the live list, used for the
  // menu label; `hiddenActors` is the list as it was when the page loaded, used for
  // filtering, so an unfollow only takes effect after a refresh and can be undone first.
  const UNF_KEY = '__ffo_unfollowed';
  const unfollowed = new Map();   // account id -> name
  const unfollowedReal = new Map();   // account id -> true when it was also unfollowed on Facebook
  let pendingFollow = [];         // [{ id, name, user }] waiting to be followed again on Facebook
  let pendingUnfollow = [];       // [{ id, name, user }] unfollowed on the manage page, not yet on Facebook
  const followTried = new Set();  // one attempt per account per page load
  let followBusy = false;
  let hiddenActors = new Set();
  let unfollowedLoaded = false;
  try { for (const id of JSON.parse(localStorage.getItem(UNF_KEY) || '[]')) hiddenActors.add(String(id)); } catch (e) { /* none yet */ }
  const isHidden = (actor) => !!actor && !!actor.id && hiddenActors.has(String(actor.id));

  function isMine(actor) {
    if (!actor || isHidden(actor)) return false;
    if (actor.subscribe_status === 'IS_SUBSCRIBED') return true;
    if (actor.is_viewer_friend === true || actor.friendship_status === 'ARE_FRIENDS') return true;
    if (actor.id && (connected.has(actor.id) || actor.id === viewerId())) return true;
    return false;
  }

  // Friends proper. Facebook's reel data marks friends and followed accounts the same
  // way, so this relies on the ids read from the friends list page (see syncFriends).
  const friends = new Set();
  function isFriend(actor) {
    if (!actor || isHidden(actor)) return false;
    if (actor.is_viewer_friend === true || actor.friendship_status === 'ARE_FRIENDS') return true;
    return !!actor.id && (friends.has(String(actor.id)) || actor.id === viewerId());
  }
  // Friends-only needs a synced friends list; until there is one it behaves like 'following'.
  const friendsOnly = () => settings.reelsMode === 'friends' && friends.size > 0;
  const reelOwnerOk = (actor) => (friendsOnly() ? isFriend(actor) : isMine(actor));

  /* ------------------------------------------------------------------ */
  /* Replay list                                                         */
  /* ------------------------------------------------------------------ */
  // Facebook's Following reel feed only serves reels you have not watched yet, so it
  // cannot loop. Every reel from a friend or followed account that comes by (in the
  // viewer, or as a post in the home feed) is remembered here, and the viewer replays
  // this list, newest first, once there is nothing new. Stored locally by the bridge.

  const library = new Map();   // reel id -> { id, t: posted (unix s), o: owner id, a: id of who posted/shared it }
  let reelOutbox = [];
  let reelOutboxTimer = 0;

  function rememberReel(id, ownerId, actorId, time) {
    if (!id || !/^\d+$/.test(String(id))) return;
    id = String(id);
    const had = library.get(id);
    const rec = had || { id, t: 0, o: '', a: '' };
    const before = rec.t + '|' + rec.o + '|' + rec.a;
    if (Number(time) > 0) rec.t = Number(time);
    if (!rec.t) rec.t = Math.floor(now() / 1000);
    if (ownerId) rec.o = String(ownerId);
    if (actorId) rec.a = String(actorId);
    if (had && before === rec.t + '|' + rec.o + '|' + rec.a) return;
    library.set(id, rec);
    reelOutbox.push(rec);
    clearTimeout(reelOutboxTimer);
    reelOutboxTimer = setTimeout(() => {
      toBridge('reels', { items: reelOutbox });
      reelOutbox = [];
    }, 2000);
  }

  // Reel ids to replay for the current mode, newest first.
  function playlist() {
    const onlyFriends = friendsOnly();
    const items = [];
    for (const r of library.values()) {
      if (hiddenActors.has(r.o) || hiddenActors.has(r.a)) continue;   // unfollowed in the extension
      if (!onlyFriends || friends.has(r.o) || friends.has(r.a)) items.push(r);
    }
    items.sort((x, y) => (y.t || 0) - (x.t || 0));
    return items.map((r) => r.id);
  }

  /* ------------------------------------------------------------------ */
  /* Home feed                                                           */
  /* ------------------------------------------------------------------ */

  let isHome = false;
  let isReel = false;
  const postCache = new WeakMap();   // post element -> { pos, key, validated, shelf }
  const verdicts = new Map();        // story key -> 'show' | reason
  const pending = new Set();         // posts waiting for the store or for their content
  let pendingTimer = 0;
  let firstPostAt = 0;
  let statsTimer = 0;

  const SHOW = { show: true, reason: '' };
  const hide = (reason) => ({ show: false, reason });

  function feedEdgeLists(src) {
    const viewer = viewerRecord(src);
    // The "__CometNewsFeed..." connection is the list the feed renders from. The raw
    // "news_feed(...)" records are individual fetches (some stale), used only as a fallback.
    const rendered = [];
    const raw = [];
    if (!viewer) return rendered;
    for (const k in viewer) {
      if (!k.includes('news_feed')) continue;
      // On the home page those two are fetched for filling the feed, not what is on the page.
      if (ownFeedKey(k) && !/[?&]filter=/.test(location.search)) continue;
      const conn = deref(src, viewer[k]);
      const refs = conn && conn.edges && conn.edges.__refs;
      if (refs && refs.length) (k.startsWith('__') ? rendered : raw).push(refs);
    }
    const lists = rendered.length ? rendered : raw;
    lists.sort((a, b) => b.length - a.length);
    return lists;
  }

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function storyNames(src, story) {
    const names = [];
    for (const a of derefs(src, field(story, 'actors'))) if (a.name) names.push(clean(a.name));
    const group = deref(src, story.target_group);
    if (group && group.name) names.push(clean(group.name));
    return names;
  }

  function headingText(el) {
    const h = el.querySelector('h2, h3, h4');
    return h ? clean(h.textContent) : '';
  }

  function reelIdFromUrl(url) {
    const m = String(url || '').match(/\/reel\/(\d+)/);
    return m ? m[1] : null;
  }

  function storyVideoId(src, story) {
    const att = derefs(src, field(story, 'attachments'))[0];
    const media = att && deref(src, att.media);
    if (media && media.__typename === 'Video' && media.id) return String(media.id);
    return reelIdFromUrl(field(story, 'url')) || (media ? reelIdFromUrl(media.permalink_url) : null);
  }

  // Cards of a "Reels" shelf: [{ id, ok }]
  function shelfItems(src, unit) {
    const items = [];
    for (const k in unit) {
      if (!k.startsWith('showcase_item')) continue;
      for (const item of derefs(src, unit[k])) {
        const att = deref(src, item.attachment);
        const story = att && deref(src, att.story);
        if (!story) continue;
        const ctx = deref(src, story.short_form_video_context);
        let owner = ctx && deref(src, ctx.video_owner);
        if (!owner) owner = derefs(src, field(story, 'actors'))[0] || null;
        items.push({ id: storyVideoId(src, story), ok: reelOwnerOk(owner) });
      }
    }
    return items;
  }

  function judge(src, story, edge) {
    if (story.__typename !== 'Story') {
      // Reels shelf, People you may know, group / page suggestions, promos...
      const items = shelfItems(src, story);
      if (items.length) {
        if (settings.reelsMode === 'all') return SHOW;
        return items.some((i) => i.ok) ? { show: true, reason: '', shelf: items } : hide('reels');
      }
      return hide('other');
    }
    if (story.sponsored_data != null) return hide('sponsored');
    const category = edge && deref(src, edge.category_sensitive);
    if (category && /SPONSOR|PROMOT/i.test(String(category.cat || ''))) return hide('sponsored');

    const actors = derefs(src, field(story, 'actors'));
    if (actors.some(isHidden)) return hide('unfollowed');
    if (field(story, 'unconnected_waist_data') != null) return hide('suggested');
    if (actors.some((a) => a.subscribe_status === 'CAN_SUBSCRIBE')) return hide('suggested');
    const sections = deref(src, field(story, 'comet_sections'));
    if (sections && field(sections, 'follow_button') != null && !actors.some(isMine)) return hide('suggested');

    if (story.target_group != null) {
      const fromMine = actors.some(isMine);
      if (!settings.showGroups && !fromMine) return hide('group');
      if (fromMine) harvestStoryReel(src, story, actors);
      return SHOW;
    }
    for (const a of actors) rememberConnected(a.id);
    harvestStoryReel(src, story, actors);
    return SHOW;
  }

  // A friend's / followed account's post that carries a reel (their own or one they
  // shared) goes on the replay list.
  function harvestStoryReel(src, story, actors) {
    const attached = deref(src, story.attached_story);
    for (const s of [story, attached]) {
      if (!s) continue;
      const att = derefs(src, field(s, 'attachments'))[0];
      const media = att && deref(src, att.media);
      if (!media || media.__typename !== 'Video' || !media.id) continue;
      const isReel = reelIdFromUrl(media.permalink_url) || reelIdFromUrl(media.shareable_url) ||
        reelIdFromUrl(field(s, 'url')) || reelIdFromUrl(att.url);
      if (!isReel) continue;
      const owner = deref(src, media.owner);
      const actor = actors.find(isFriend) || actors[0];
      rememberReel(media.id, owner && owner.id, actor && actor.id, s.creation_time || story.creation_time);
      return;
    }
  }

  function verdictFromStore(src, el, idx) {
    const lists = feedEdgeLists(src);
    if (!lists.length) return null;
    const head = headingText(el);
    const pick = (refs, i) => {
      const edge = refs[i] != null ? src.get(refs[i]) : null;
      const node = edge && deref(src, edge.node);
      return node ? { edge, node, i } : null;
    };
    const finish = (c) => {
      const v = judge(src, c.node, c.edge);
      const author = derefs(src, field(c.node, 'actors'))[0];
      return {
        show: v.show, reason: v.reason, shelf: v.shelf, key: c.node.__id || c.node.id || 'i' + c.i, validated: !!head,
        // Who posted it, plus what Facebook's own follow / unfollow action needs (see fbSetFollow).
        actor: author && author.id && author.name ? {
          id: String(author.id),
          name: clean(author.name),
          user: author.__typename === 'User',
          follows: author.subscribe_status !== 'CAN_SUBSCRIBE',
          tracking: typeof c.node.tracking === 'string' ? c.node.tracking : '',
          encrypted: c.node.encrypted_tracking != null
        } : null
      };
    };
    for (const refs of lists) {
      const c = pick(refs, idx);
      if (!c) continue;
      const names = head ? storyNames(src, c.node) : [];
      if (!names.length || names.some((n) => head.includes(n))) return finish(c);
    }
    if (head) {
      // The position drifted: find the story by its author / group name instead.
      for (const refs of lists) {
        let best = null;
        for (let i = 0; i < refs.length; i++) {
          const c = pick(refs, i);
          if (!c || !storyNames(src, c.node).some((n) => head.includes(n))) continue;
          if (!best || Math.abs(i - idx) < Math.abs(best.i - idx)) best = c;
        }
        if (best) { log('position drift', idx, '->', best.i); return finish(best); }
      }
    }
    return null;
  }

  // Fallback when the store cannot be read: judge by what the rendered post shows.
  function verdictFromDom(el) {
    if (!el.querySelector('h2, h3, h4, [role="button"]')) return null;   // not rendered yet
    for (const b of el.querySelectorAll('[role="button"]')) {
      const label = clean(b.getAttribute('aria-label') || b.textContent);
      if (/^(Follow|Join)( |$)/.test(label)) return Object.assign(hide('suggested'), { validated: true });
    }
    if (el.querySelector('a[href*="/ads/about"], a[aria-label="Sponsored"], [data-ad-rendering-role^="cta"], [attributionsrc*="/privacy_sandbox/comet/register/source/"]')) {
      return Object.assign(hide('sponsored'), { validated: true });
    }
    const headLink = el.querySelector('h2 a[href], h3 a[href], h4 a[href]');
    if (!headLink) return Object.assign(hide('other'), { validated: true });
    if (!settings.showGroups && /\/groups\//.test(headLink.getAttribute('href') || '')) return Object.assign(hide('group'), { validated: true });
    return { show: true, reason: '', validated: true };
  }

  function filterShelfCards(el, items) {
    const okById = new Map();
    for (const it of items) if (it.id) okById.set(it.id, it.ok);
    const anchors = el.querySelectorAll('a[href*="/reel/"]');
    const countIn = (node) => node.querySelectorAll('a[href*="/reel/"]').length;
    for (const a of anchors) {
      const id = reelIdFromUrl(a.getAttribute('href'));
      let card = a;
      while (card.parentElement && card.parentElement !== el && countIn(card.parentElement) <= 1) card = card.parentElement;
      const want = okById.get(id) === true ? 'show' : 'hide';
      if (card.getAttribute('data-ffo-card') !== want) card.setAttribute('data-ffo-card', want);
    }
  }

  // A feed entry is a post inside a stack of single-child wrappers, one of which carries
  // the spacing between posts. Marking them lets a hidden post take up no room at all;
  // otherwise every hidden post leaves that spacing behind and they add up to a gap.
  const WRAP_LEVELS = 12;
  function markWrappers(post, hidden) {
    let el = post;
    for (let i = 0; i < WRAP_LEVELS; i++) {
      const parent = el.parentElement;
      if (!parent || parent.children.length !== 1 || parent.hasAttribute('role') || parent === document.body) break;
      el = parent;
      if (hidden) { if (!el.hasAttribute('data-ffo-wrap')) el.setAttribute('data-ffo-wrap', ''); }
      else if (el.hasAttribute('data-ffo-wrap')) el.removeAttribute('data-ffo-wrap');
    }
  }

  function applyVerdict(el, v, pos) {
    const val = v.show ? 'show' : 'hide';
    if (el.getAttribute('data-ffo') !== val) el.setAttribute('data-ffo', val);
    markWrappers(el, !v.show);
    if ((el.getAttribute('data-ffo-reason') || '') !== v.reason) el.setAttribute('data-ffo-reason', v.reason);
    if (v.shelf) filterShelfCards(el, v.shelf);
    postCache.set(el, { pos, validated: !!v.validated, shelf: !!v.shelf, actor: v.actor || null });
    const key = v.key || 'pos' + pos;
    const tag = v.show ? 'show' : v.reason;
    if (verdicts.get(key) !== tag) {
      verdicts.set(key, tag);
      log(v.show ? 'show' : 'hide (' + v.reason + ')', 'post', pos);
      queueStats();
    }
  }

  function classify(el) {
    if (!isHome || !el.isConnected) return;
    const pos = parseInt(el.getAttribute('aria-posinset'), 10);
    if (!pos) return;
    const parentPost = el.parentElement && el.parentElement.closest('[aria-posinset]');
    if (parentPost) return;   // nested list inside a post, not a feed unit
    const cached = postCache.get(el);
    if (cached && cached.pos === pos && cached.validated && !cached.shelf) return;
    if (!firstPostAt) firstPostAt = now();

    const src = source();
    let v = src ? verdictFromStore(src, el, pos - 1) : null;
    if (src) setFlag('data-ffo-strict', true);
    if (!v) v = verdictFromDom(el);
    if (!v) {
      // Nothing to go on yet. Stay hidden and try again shortly; if the store never
      // shows up, stop hiding by default so the feed cannot end up blank.
      if (!src && now() - firstPostAt > 8000) setFlag('data-ffo-strict', false);
      pending.add(el);
      if (!pendingTimer) pendingTimer = setTimeout(retryPending, 250);
      return;
    }
    pending.delete(el);
    applyVerdict(el, v, pos);
  }

  function retryPending() {
    pendingTimer = 0;
    const batch = Array.from(pending);
    pending.clear();
    for (const el of batch) if (el.isConnected) classify(el);
    if (pending.size && !pendingTimer) pendingTimer = setTimeout(retryPending, 400);
  }

  function rescanFeed() {
    if (!isHome) return;
    for (const el of document.querySelectorAll('div[aria-posinset]')) {
      postCache.delete(el);
      classify(el);
    }
    scheduleSideAds();
  }

  function clearFeedMarks() {
    for (const el of document.querySelectorAll('[data-ffo], [data-ffo-card], [data-ffo-hidden], [data-ffo-wrap], [data-ffo-pull]')) {
      el.removeAttribute('data-ffo');
      el.removeAttribute('data-ffo-reason');
      el.removeAttribute('data-ffo-card');
      el.removeAttribute('data-ffo-hidden');
      el.removeAttribute('data-ffo-wrap');
      el.removeAttribute('data-ffo-pull');
    }
    pullEl = null;
  }

  function queueStats() {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = 0;
      const stats = { shown: 0, hidden: 0, reasons: {} };
      for (const tag of verdicts.values()) {
        if (tag === 'show') stats.shown++;
        else { stats.hidden++; stats.reasons[tag] = (stats.reasons[tag] || 0) + 1; }
      }
      toBridge('stats', { stats });
    }, 600);
  }

  /* ---------------- My feed: friends and Pages on the home page ---------------- */
  // Facebook's main feed is mostly things that get thrown away here, and its server sends
  // them about one a second. Its Friends feed and Pages feed hold only what is wanted, so
  // with the "My feed" home feed the normal home page stays open and its feed is filled from
  // those two instead: they are requested with the very request (and settings) the page
  // itself uses to load more posts, and their posts are placed into the page's own list,
  // newest first, at most MIX_MAX_RUN Pages posts in a row. Entries of Facebook's own mix
  // that would be removed anyway are dropped before the page draws them. Only the part of
  // the feed that is not on the page yet is touched, so nothing already drawn moves.

  const FRIENDS_STYLE = 'MOST_RECENT_FRIENDS_FEED';
  const PAGES_STYLE = 'MOST_RECENT_PAGES_FEED';
  const FEED_QUERY = 'CometNewsFeedPaginationQuery';
  const MIX_GAP_MS = 300;         // pause between two requests to the same feed
  const MIX_TICK_MS = 150;        // how often to look while an answer is arriving
  const MIX_RETRY_MS = 15000;     // ...and after one that failed
  const MIX_MAX_FAILS = 3;
  const MIX_BACKLOG = 10;         // placed posts waiting to be drawn before more are placed
  const MIX_QUEUE = 6;            // posts kept in hand per feed before more are requested
  const MIX_WAIT_MS = 20000;      // how long to push the feed along to see Facebook's own request
  const MIX_MAX_RUN = 3;          // Pages posts in a row; a busy Page would otherwise bury friends' posts
  const REAL_TIME = 1e9;          // a creation time below this is a placeholder (ads have one)
  let mix = null;                 // state while "My feed" is filling the home page
  let feedVars = null;            // settings of Facebook's own latest "load more posts" request
  let feedVarsLive = false;       // seen on this page (true), or remembered from an earlier page load
  let feedVarsSaved = '';
  let mixTimer = 0;

  function scheduleMix(ms) {
    if (mixTimer) return;
    mixTimer = setTimeout(() => { mixTimer = 0; mixTick(); }, ms);
  }

  // Facebook only sends its own "load more" request a few seconds into a page load. The
  // settings are remembered (in the extension's storage, minus everything tied to one
  // request) so that on the next page load the two feeds can be asked for straight away.
  function rememberFeedVars(vars) {
    feedVars = vars;
    feedVarsLive = true;
    try {
      const keep = {};
      for (const k in vars) {
        if (k.startsWith('__relay_internal__') || k === 'cursor' || k === 'recentVPVs' || k === 'clientQueryId' || k === 'clientSession') continue;
        keep[k] = vars[k];
      }
      const text = JSON.stringify(keep);
      if (text !== feedVarsSaved && text.length < 20000) {
        feedVarsSaved = text;
        toBridge('feedVars', { vars: JSON.parse(text) });
      }
    } catch (e) { /* not worth failing over */ }
  }

  const mixWanted = () => settings.enabled && settings.homeFeed === 'mine';
  const mixing = () => mixWanted() && isHome && !/[?&]filter=/.test(location.search) && location.hash !== MAIN_FEED_HASH;
  const styleMark = (style) => 'feed_style:"' + style + '"';
  const ownFeedKey = (k) => k.includes(styleMark(FRIENDS_STYLE)) || k.includes(styleMark(PAGES_STYLE));
  const newStream = (style, pages) => ({
    style, pages, busy: false, ticket: 0, started: false, done: false, fails: 0, lastAt: 0, queue: [], oldest: 0, retained: null
  });
  const streamOver = (st) => st.done || st.fails >= MIX_MAX_FAILS;

  function stopMix() {
    if (!mix) return;
    for (const st of mix.streams) {
      if (st.retained) { try { st.retained.dispose(); } catch (e) { /* ignore */ } }
    }
    mix = null;
  }

  // The settings Facebook's own "load more posts" request was last sent with.
  function hookFeedRequests() {
    const env = relayEnv;
    if (!env || typeof env.execute !== 'function' || env.__ffoHooked) return;
    env.__ffoHooked = true;
    const original = env.execute;
    env.execute = function (config) {
      try {
        const request = config && config.operation && config.operation.request;
        const params = request && request.node && request.node.params;
        const vars = request && request.variables;
        if (params && params.name === FEED_QUERY && vars && vars.feedStyle !== FRIENDS_STYLE && vars.feedStyle !== PAGES_STYLE) {
          rememberFeedVars(vars);
        }
        if (params && params.name === FOLLOWING_QUERY && vars && !rqOwn) {
          // Facebook's own "more reels" request: its settings, and that one is on its way.
          followingVars = vars;
          fbReelPage = { cursor: vars.cursor, at: now() };
        }
      } catch (e) { /* never get in the way of the page's own request */ }
      return original.apply(this, arguments);
    };
  }

  // Facebook's store says "something changed" through this. The reel viewer's list is
  // looked at right then, so unwanted reels are gone before the viewer draws them.
  function hookStore() {
    try {
      const store = relayEnv.getStore();
      if (!store || typeof store.notify !== 'function' || store.__ffoHooked) return;
      store.__ffoHooked = true;
      const original = store.notify;
      store.notify = function () {
        const result = original.apply(this, arguments);
        if (isReel && !rqSoon) {
          rqSoon = true;
          queueMicrotask(() => {
            rqSoon = false;
            try { reelQueueTick(); } catch (e) { log('reel queue failed', e); }
          });
        }
        return result;
      };
    } catch (e) { /* the timer-driven check still runs */ }
  }

  // The list the page draws from (Facebook's own feed), and the two fetched for filling it.
  function hostConnection(src) {
    const viewer = viewerRecord(src);
    let best = null;
    if (!viewer) return null;
    for (const k in viewer) {
      if (!k.startsWith('__') || !k.includes('news_feed') || ownFeedKey(k)) continue;
      const conn = deref(src, viewer[k]);
      const refs = conn && conn.edges && conn.edges.__refs;
      if (refs && (!best || refs.length > best.edges.__refs.length)) best = conn;
    }
    return best;
  }
  function streamConnection(src, style) {
    const viewer = viewerRecord(src);
    if (!viewer) return null;
    for (const k in viewer) {
      if (k.startsWith('__') && k.includes('news_feed') && k.includes(styleMark(style))) return deref(src, viewer[k]);
    }
    return null;
  }

  function fetchStream(src, st) {
    const state = mix;
    let relay = null;
    let query = null;
    try {
      relay = window.require('relay-runtime');
      query = window.require(FEED_QUERY + '.graphql');
    } catch (e) { /* handled below */ }
    if (!relay || !query || typeof relay.fetchQuery !== 'function') {
      // Early in a page load Facebook's feed code is not there yet: try again shortly.
      if (now() - state.since > MIX_WAIT_MS) st.fails = MIX_MAX_FAILS;
      return;
    }
    const live = feedVarsLive;
    const conn = streamConnection(src, st.style);
    const page = conn && deref(src, conn.page_info);
    const vars = {};
    for (const k in feedVars) if (!k.startsWith('__relay_internal__')) vars[k] = feedVars[k];
    vars.feedStyle = st.style;
    vars.orderby = ['MOST_RECENT'];
    vars.cursor = st.started && page && page.end_cursor ? page.end_cursor : null;   // null = from the newest post
    vars.recentVPVs = [];
    if (!('clientSession' in vars)) vars.clientSession = null;
    try { vars.clientQueryId = crypto.randomUUID(); } catch (e) { /* keep the copied one */ }
    st.busy = true;
    st.lastAt = now();
    const ticket = ++st.ticket;
    const finish = (ok) => {
      if (!st.busy || st.ticket !== ticket) return;   // already settled, or a later request
      st.busy = false;
      st.lastAt = now();
      if (ok) {
        st.started = true;
        st.fails = 0;
      } else if (!live && !feedVarsLive) {
        // The remembered settings no longer work: wait for Facebook's own request instead.
        feedVars = null;
        log('my feed: remembered request settings were refused');
      } else {
        st.fails++;
        log('my feed: request failed', st.style);
      }
      if (state === mix) setTimeout(mixTick, 0);
    };
    try {
      if (typeof relay.createOperationDescriptor === 'function' && typeof relayEnv.retain === 'function') {
        // Keeps the fetched posts in Facebook's store until they have been placed in the feed.
        const keep = relayEnv.retain(relay.createOperationDescriptor(query, vars));
        if (st.retained) { try { st.retained.dispose(); } catch (e) { /* ignore */ } }
        st.retained = keep;
      }
      relay.fetchQuery(relayEnv, query, vars, { networkCacheConfig: { force: true } })
        .subscribe({ complete: () => finish(true), error: () => finish(false) });
    } catch (e) {
      finish(false);
    }
    setTimeout(() => finish(false), 30000);
  }

  function mixTick() {
    if (!mixWanted()) { stopMix(); return; }
    // Away from the home page the state is kept: Facebook keeps the feed too, and coming
    // back should carry on where it was instead of fetching everything again.
    if (!mixing()) return;
    const src = source();
    if (!src) return;
    // The page's own list may not exist yet this early; the two feeds are asked for anyway.
    const host = hostConnection(src);
    const hostRefs = (host && host.edges && host.edges.__refs) || [];
    if (mix && mix.placed.size && hostRefs.length && !hostRefs.some((id) => mix.placed.has(id))) stopMix();   // Facebook started the feed over
    if (!mix) {
      mix = { since: now(), run: 0, seen: new Set(), placed: new Set(), posts: new Set(),
        streams: [newStream(FRIENDS_STYLE, false), newStream(PAGES_STYLE, true)] };
      // Whatever the two feeds' lists still hold from an earlier visit is not new.
      for (const st of mix.streams) {
        const old = streamConnection(src, st.style);
        for (const id of (old && old.edges && old.edges.__refs) || []) if (id != null) mix.seen.add(id);
      }
    }
    hookFeedRequests();

    const storyOf = (edgeId) => {
      const edge = edgeId != null ? src.get(edgeId) : null;
      const node = edge && deref(src, edge.node);
      return node && node.__typename ? { edge, node } : null;
    };
    const timeOf = (s) => (s && s.node.__typename === 'Story' && s.node.creation_time > REAL_TIME ? s.node.creation_time : 0);
    // Facebook gives the same post a new story record on every fetch; post_id stays the same.
    const postKey = (s) => (s.node.post_id != null ? 'p' + s.node.post_id : s.edge.node.__ref);

    const inFeed = new Set();   // posts the page's list already has
    for (const id of hostRefs) {
      const s = storyOf(id);
      if (s) inFeed.add(postKey(s));
    }

    // Take in what the two feeds have delivered: keep the posts that would be shown.
    for (const st of mix.streams) {
      // Read while the answer is still arriving: its posts come in one at a time.
      const conn = streamConnection(src, st.style);
      const refs = (conn && conn.edges && conn.edges.__refs) || [];
      for (const id of refs) {
        if (id == null) continue;
        const s = storyOf(id);
        if (!s) continue;   // still arriving
        const t = timeOf(s);
        if (t) st.oldest = t;
        if (mix.seen.has(id)) continue;
        mix.seen.add(id);
        const key = postKey(s);
        if (!t || inFeed.has(key) || mix.posts.has(key) || !judge(src, s.node, s.edge).show) continue;
        mix.posts.add(key);
        st.queue.push({ id, t, key });
      }
      const page = conn && deref(src, conn.page_info);
      if (st.started && !st.busy && page && page.has_next_page === false) st.done = true;
    }

    let drawn = 0;   // feed entries already on the page
    for (const el of document.querySelectorAll('div[aria-posinset]')) {
      if (el.parentElement && el.parentElement.closest('[aria-posinset]')) continue;
      const pos = parseInt(el.getAttribute('aria-posinset'), 10);
      if (pos > drawn) drawn = pos;
    }
    const cut = Math.min(drawn, hostRefs.length);
    const dropUnwanted = !settings.debug;   // "Show what is being hidden" needs them drawn
    let waiting = 0;    // our posts placed but not drawn yet
    let unwanted = 0;   // entries of Facebook's own mix that would only be hidden
    for (let i = cut; i < hostRefs.length; i++) {
      const id = hostRefs[i];
      if (mix.placed.has(id)) { waiting++; continue; }
      const s = storyOf(id);
      if (dropUnwanted && s && !judge(src, s.node, s.edge).show) unwanted++;
    }

    // Next posts: the newer of what the two feeds have in hand, each feed newest first.
    // Nothing waits for the other feed, so the order across the two is close to, not
    // exactly, by time; getting posts on the page quickly matters more here.
    const friends = mix.streams[0];
    const pages = mix.streams[1];
    const picks = [];
    // Skips posts that reached the page's list some other way since they were taken in.
    const head = (st) => {
      while (st.queue.length && inFeed.has(st.queue[0].key)) st.queue.shift();
      return st.queue[0];
    };
    while (hostRefs.length && waiting + picks.length < MIX_BACKLOG) {
      const f = head(friends);
      const p = head(pages);
      let takePage;
      if (f && p) takePage = p.t > f.t && mix.run < MIX_MAX_RUN;
      else if (f) takePage = false;
      else if (p && (mix.run < MIX_MAX_RUN || streamOver(friends))) takePage = true;
      else break;
      if (takePage) { picks.push(pages.queue.shift()); mix.run++; } else { picks.push(friends.queue.shift()); mix.run = 0; }
    }

    if (picks.length || unwanted) {
      try {
        const relay = window.require('relay-runtime');
        const hostId = host.__id;
        relay.commitLocalUpdate(relayEnv, (store) => {
          const conn = hostId && store.get(hostId);
          const edges = conn && conn.getLinkedRecords('edges');
          if (!edges) return;
          const at = Math.min(drawn, edges.length);
          const ours = [];
          const theirs = [];
          for (const rec of edges.slice(at)) {
            const id = rec ? rec.getDataID() : null;
            if (id != null && mix.placed.has(id)) { ours.push(rec); continue; }
            const s = id != null ? storyOf(id) : null;
            if (dropUnwanted && s && !judge(src, s.node, s.edge).show) continue;   // would only be hidden: never draw it
            theirs.push(rec);
          }
          for (const c of picks) {
            const add = store.get(c.id);
            if (add) { ours.push(add); mix.placed.add(c.id); }
          }
          // Ours first, then whatever of Facebook's own mix is still wanted or still arriving.
          conn.setLinkedRecords(edges.slice(0, at).concat(ours, theirs), 'edges');
        });
        log('my feed: placed', picks.length, 'dropped', unwanted);
        if (picks.length) scheduleAhead(0);
      } catch (e) {
        log('my feed: could not place posts', e);
        for (const st of mix.streams) st.fails = MIX_MAX_FAILS;
      }
    }

    // Keep a few posts in hand from each feed.
    if (feedVars) {
      for (const st of mix.streams) {
        if (st.busy || streamOver(st) || st.queue.length >= MIX_QUEUE) continue;
        if (now() - st.lastAt < (st.fails ? MIX_RETRY_MS : MIX_GAP_MS)) continue;
        fetchStream(src, st);
      }
    }
    if (mix.streams.some((st) => st.busy)) scheduleMix(MIX_TICK_MS);
  }

  /* ---------------- Loading ahead ---------------- */
  // Facebook sends the feed a few stories at a time, about one a second, and only asks
  // for more when an empty marker element after the last post comes on screen. With most
  // stories filtered out, that means a wait after nearly every post. So while fewer than
  // AHEAD_POSTS approved posts are waiting below the screen, the marker is pinned inside
  // the viewport (invisibly), which makes Facebook keep loading in the background.

  const AHEAD_POSTS = 8;         // approved posts to keep ready below the screen
  const AHEAD_MAX_ENTRIES = 100; // never run further than this many feed entries past the screen
  const AHEAD_STALL_MS = 12000;  // marker pinned this long with nothing arriving: stop for a while
  const AHEAD_PAUSE_MS = 20000;
  let pullEl = null;             // the marker currently pinned
  let pullAt = 0;
  let pullPausedUntil = 0;
  let aheadTimer = 0;

  function stopPull() {
    if (pullEl) { pullEl.removeAttribute('data-ffo-pull'); pullEl = null; }
  }

  function scheduleAhead(delay) {
    if (aheadTimer || !isHome || !settings.loadAhead) return;
    aheadTimer = setTimeout(() => { aheadTimer = 0; mixTick(); loadAhead(); }, delay == null ? 250 : delay);
  }

  // The element whose children are the feed's entries, found from the last post.
  function feedList() {
    const posts = document.querySelectorAll('div[aria-posinset]');
    let el = posts[posts.length - 1];
    if (!el) return null;
    const outer = el.parentElement && el.parentElement.closest('[aria-posinset]');
    if (outer) el = outer;   // the last match was a list inside a post
    for (let i = 0; i < WRAP_LEVELS && el.parentElement && el.parentElement.children.length === 1; i++) el = el.parentElement;
    const list = el.parentElement;
    return list && list !== document.body && list.children.length > 1 ? list : null;
  }

  function loadAhead() {
    if (!isHome || !settings.loadAhead || document.visibilityState !== 'visible') { stopPull(); return; }
    const list = feedList();
    if (!list) { stopPull(); return; }
    const bottom = window.innerHeight;
    let marker = null;
    let seenPost = false;
    let ready = 0;
    let past = 0;
    for (let i = list.children.length - 1; i >= 0; i--) {
      const entry = list.children[i];
      if (!entry.firstElementChild) {
        if (!seenPost) marker = entry;   // ends up as the first empty element after the last post
        continue;
      }
      const post = entry.querySelector('div[aria-posinset]');
      if (!post) continue;               // the "Loading..." placeholder at the end
      seenPost = true;
      if (post.getBoundingClientRect().top <= bottom) break;
      past++;
      if (post.getAttribute('data-ffo') === 'show') ready++;
    }
    // The combined feed copies the settings of Facebook's own "load more" request, so until
    // one has gone out (and for a short while only) keep loading even with enough posts ready.
    const wantRequest = !!mix && !feedVars && now() - mix.since < MIX_WAIT_MS;
    if (!marker || (ready >= AHEAD_POSTS && !wantRequest) || past >= AHEAD_MAX_ENTRIES || now() < pullPausedUntil) { stopPull(); return; }
    if (pullEl !== marker) {
      stopPull();
      marker.setAttribute('data-ffo-pull', '');
      pullEl = marker;
      pullAt = now();
    } else if (now() - pullAt > AHEAD_STALL_MS) {
      // Nothing came (end of the feed, or offline). Let go and try again later.
      stopPull();
      pullPausedUntil = now() + AHEAD_PAUSE_MS;
      log('load ahead: nothing arrived, pausing');
      return;
    }
    scheduleAhead(400);
  }

  /* Right-hand column "Sponsored" block */
  let sideAdsTimer = 0;
  function scheduleSideAds() {
    if (sideAdsTimer || !isHome || !settings.hideSideAds) return;
    sideAdsTimer = setTimeout(() => { sideAdsTimer = 0; hideSideAds(); }, 500);
  }
  function hideSideAds() {
    if (!isHome || !settings.hideSideAds) return;
    for (const rail of document.querySelectorAll('[role="complementary"]')) {
      const marks = Array.from(rail.querySelectorAll('h2, h3, h4')).filter((h) => clean(h.textContent) === 'Sponsored');
      // Language-independent: ad links in the rail carry an attribution source.
      for (const a of rail.querySelectorAll('a[attributionsrc^="/privacy_sandbox/comet/register/"], a[target="rhcad2"]')) marks.push(a);
      for (const h of marks) {
        if (h.closest('[data-ffo-hidden]')) continue;
        let node = h;
        // Grow to the whole section: stop before swallowing another section's heading.
        while (node.parentElement && node.parentElement !== rail &&
               node.parentElement.querySelectorAll('h2, h3, h4').length === 1) {
          node = node.parentElement;
        }
        if (node !== rail && !node.hasAttribute('data-ffo-hidden')) node.setAttribute('data-ffo-hidden', '');
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* "Unfollow" / "Follow again" in a post's ... menu                    */
  /* ------------------------------------------------------------------ */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  let menuCtx = null;   // { actor, opener } for the post whose "..." button was last used
  let menuTimer = 0;

  function noteMenuOpener(target) {
    if (!isHome || !target || target.nodeType !== 1) return;
    const opener = target.closest('[aria-haspopup="menu"]');
    // Only a post's own "..." button (the first menu button in the post), not the menus
    // on its comments or the entries inside an already open menu.
    const post = opener && opener.closest('div[aria-posinset]');
    if (!post || post.querySelector('[aria-haspopup="menu"]') !== opener) return;
    const cached = postCache.get(post);
    const actor = cached && cached.actor;
    menuCtx = actor && actor.id !== viewerId() ? { actor, opener } : null;
    if (menuCtx) watchPostMenu();
  }
  window.addEventListener('click', (ev) => noteMenuOpener(ev.target), true);
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') noteMenuOpener(ev.target); }, true);

  const menuIsOpen = () => !!menuCtx && menuCtx.opener.isConnected && menuCtx.opener.getAttribute('aria-expanded') === 'true';

  // The menu that belongs to the post's "..." button: on screen, and the top-level one
  // (it holds the "More options" entry, which opens the submenu).
  function openPostMenu() {
    const shown = Array.from(document.querySelectorAll('[role="menu"]')).filter((m) => m.getClientRects().length > 0);
    return shown.find((m) => m.querySelector('[aria-haspopup="menu"]')) || (shown.length === 1 ? shown[0] : null);
  }

  // Facebook sometimes builds a fresh menu, sometimes re-shows the one it built before, and
  // rebuilds its entries when the follow state changes. So rather than react to one of
  // those moments, keep our entry in place for as long as the menu is open.
  function watchPostMenu() {
    clearInterval(menuTimer);
    let closedTicks = 0;
    const tick = () => {
      if (!menuCtx || !menuCtx.opener.isConnected) { clearInterval(menuTimer); return; }
      if (!menuIsOpen()) { if (++closedTicks > 20) clearInterval(menuTimer); return; }
      closedTicks = 0;
      const menu = openPostMenu();
      if (menu) ensureUnfollowItem(menu);
    };
    menuTimer = setInterval(tick, 200);
    setTimeout(tick, 0);
  }

  // Facebook's own follow / unfollow actions: the same functions its "Follow" button on a
  // post calls, with the same arguments. They are only loaded on pages that show such
  // buttons (the home feed). The parameter counts are checked so that, if Facebook ever
  // reshapes them, nothing is sent and the unfollow simply stays local.
  const FOLLOW_LOCATION = 'IFR_POST_IN_NEWS_FEED';
  function fbFollowActions() {
    try {
      const follow = window.require('CometPFTFFollowMutation');
      const unfollow = window.require('CometPFTFUnfollowMutation');
      const env = window.require('CometRelayEnvironment');
      if (follow && unfollow && env && typeof follow.commit === 'function' && typeof unfollow.commit === 'function' &&
          follow.commit.length === 9 && unfollow.commit.length === 8) return { follow, unfollow, env };
    } catch (e) { /* not on this page */ }
    return null;
  }

  // Follow (on = true) or unfollow the account on Facebook itself.
  // done(true) = Facebook accepted it, done(false) = it failed, done(null) = not available on this page.
  function fbSetFollow(actor, on, done) {
    const fb = fbFollowActions();
    if (!fb) { done(null); return; }
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; done(ok === true); } };
    const isUser = actor.user !== false;
    const tracking = actor.tracking || '';
    const encrypted = !!actor.encrypted;
    try {
      if (on) fb.follow.commit(fb.env, actor.id, FOLLOW_LOCATION, isUser, tracking, encrypted, {}, undefined, finish);
      else fb.unfollow.commit(fb.env, actor.id, FOLLOW_LOCATION, isUser, tracking, encrypted, undefined, finish);
    } catch (e) {
      log('follow action failed', e);
      finish(false);
    }
    setTimeout(() => finish(false), 15000);
  }

  function setUnfollowed(actor, off) {
    const name = actor.name;
    const undo = ' Use this menu again to undo.';
    if (off) {
      unfollowed.set(actor.id, name);
      const save = (real) => {
        unfollowedReal.set(actor.id, real);
        toBridge('unfollow', { id: actor.id, name, off: true, real, user: actor.user !== false });
      };
      if (actor.follows === false) {
        // Not someone you follow on Facebook (for example another member of a group).
        save(false);
        toast('Hidden ' + name + ' in My Facebook. Their posts and reels disappear after you refresh.' + undo, 8000);
        return;
      }
      fbSetFollow(actor, false, (ok) => {
        save(ok === true);
        toast(ok === true
          ? 'Unfollowed ' + name + ' on Facebook. Their posts and reels disappear after you refresh.' + undo
          : 'Facebook did not confirm the unfollow, so ' + name + ' is only hidden in My Facebook (after a refresh).' + undo, 9000);
      });
      return;
    }
    const wasReal = unfollowedReal.get(actor.id) === true;
    unfollowed.delete(actor.id);
    unfollowedReal.delete(actor.id);
    toBridge('unfollow', { id: actor.id, name, off: false });
    if (!wasReal) { toast('Showing ' + name + ' again in My Facebook.', 6000); return; }
    fbSetFollow(actor, true, (ok) => {
      if (ok === true) { toast('Following ' + name + ' again on Facebook.', 6000); return; }
      // Leave it queued; it is retried the next time the home feed is open.
      toBridge('followPending', { id: actor.id, name, user: actor.user !== false });
      toast('Could not follow ' + name + ' again on Facebook just now. It will be retried when your feed is next open.', 9000);
    });
  }

  // Changes queued from the popup or the manage page (or after a failed attempt): accounts
  // to follow again, and accounts to unfollow, on Facebook itself. They are carried out in
  // any Facebook tab where Facebook's own follow actions happen to be loaded.
  function processPendingFollows() {
    if (followBusy || (!pendingFollow.length && !pendingUnfollow.length) || !fbFollowActions()) return;
    let on = false;
    let next = pendingUnfollow.find((p) => !followTried.has('u' + p.id));
    if (!next) { on = true; next = pendingFollow.find((p) => !followTried.has('f' + p.id)); }
    if (!next) return;
    followTried.add((on ? 'f' : 'u') + next.id);
    followBusy = true;
    fbSetFollow({ id: next.id, user: next.user }, on, (ok) => {
      followBusy = false;
      const who = next.name || 'that account';
      if (on) {
        if (ok === true) {
          pendingFollow = pendingFollow.filter((p) => p.id !== next.id);
          toBridge('followDone', { id: next.id });
          toast('Following ' + who + ' again on Facebook.', 6000);
        } else {
          toBridge('followFailed', { id: next.id });
        }
      } else if (ok === true) {
        pendingUnfollow = pendingUnfollow.filter((p) => p.id !== next.id);
        unfollowedReal.set(next.id, true);
        toBridge('unfollowDone', { id: next.id });
        toast('Unfollowed ' + who + ' on Facebook.', 6000);
      } else {
        toBridge('unfollowFailed', { id: next.id });
      }
    });
  }

  function drawPersonIcon(svg, plus) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const add = (tag, attrs) => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const k in attrs) el.setAttribute(k, attrs[k]);
      svg.appendChild(el);
    };
    add('circle', { cx: '8', cy: '6', r: '3.5' });
    add('path', { d: 'M1.5 17.5c0-3.6 2.9-6.2 6.5-6.2s6.5 2.6 6.5 6.2v.5h-13z' });
    add('rect', { x: '14', y: '5.25', width: '5.5', height: '1.5', rx: '.75' });
    if (plus) add('rect', { x: '16', y: '3.25', width: '1.5', height: '5.5', rx: '.75' });
  }

  function ensureUnfollowItem(menu) {
    if (!menuCtx) return;
    const existing = menu.querySelector('[data-ffo-menu]');
    if (existing) {
      // Already there (possibly from an earlier opening of this menu): keep it current.
      if (existing.__ffoActorId === menuCtx.actor.id) { existing.__ffoPaint(); return; }
      existing.remove();
    }
    // Copy one of Facebook's own entries so ours looks and behaves like the rest.
    // Prefer one that is not the focused entry, or the copy keeps its focus ring.
    let template = null;
    for (const b of menu.querySelectorAll('div[role="button"]')) {
      if (!b.querySelector('svg') || !b.querySelector('span[dir="auto"]')) continue;
      if (!template) template = b;
      if (b.getAttribute('tabindex') === '-1') { template = b; break; }
    }
    if (!template || !template.parentElement) return;
    const actor = menuCtx.actor;
    const item = template.cloneNode(true);
    item.setAttribute('data-ffo-menu', '');
    item.setAttribute('tabindex', '-1');
    for (const el of item.querySelectorAll('[id]')) el.removeAttribute('id');
    const label = item.querySelector('span[dir="auto"]');
    const icon = item.querySelector('svg');
    let painted = null;
    const paint = () => {
      const off = unfollowed.has(actor.id);
      if (off === painted) return;
      painted = off;
      label.textContent = off ? 'Follow ' + actor.name + ' again' : 'Unfollow ' + actor.name;
      item.setAttribute('aria-label', label.textContent);
      drawPersonIcon(icon, off);
    };
    const toggle = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setUnfollowed(actor, !unfollowed.has(actor.id));
      paint();
    };
    item.addEventListener('click', toggle);
    item.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') toggle(ev); });
    // Facebook switches its hover highlight on from script, so a copied entry never gets
    // it (or keeps it forever, if the original was hovered when copied). Do the same here.
    const overlay = item.querySelector('div[role="none"]');
    const highlight = (on) => {
      if (!overlay) return;
      overlay.style.opacity = on ? '1' : '0';
      overlay.style.backgroundColor = on ? 'var(--hover-overlay, rgba(127, 127, 127, 0.15))' : 'transparent';
    };
    highlight(false);
    item.addEventListener('mouseenter', () => highlight(true));
    item.addEventListener('mouseleave', () => highlight(false));
    item.addEventListener('focus', () => highlight(true));
    item.addEventListener('blur', () => highlight(false));
    item.__ffoActorId = actor.id;
    item.__ffoPaint = paint;
    paint();
    const list = template.parentElement;
    list.insertBefore(item, list.querySelector(':scope > hr'));   // end of the first group; appended if there is no divider
  }

  /* ------------------------------------------------------------------ */
  /* Reel viewer                                                         */
  /* ------------------------------------------------------------------ */

  const FOLLOWING_URL = '/reel/following/';
  const RESTART_KEY = '__ffo_reel_restarts';
  const TOAST_KEY = '__ffo_toast';
  const allowedIds = new Set();   // reels the user opened directly (e.g. from a friend's post)
  let followingSticky = false;
  let lastDir = 1;
  let goingAt = 0;
  let goingTries = 0;
  let skipId = null;
  let skipStart = 0;
  let skipAt = 0;
  let nextOffSince = 0;           // when the "Next" button was first seen disabled on this reel
  const REPLAY_KEY = '__ffo_replay';
  let replay = null;              // { list, idx, ... } while playing from the replay list
  let pendingResume = null;       // reel id to resume a replay on after a page load
  let harvestAt = 0;
  let selfNav = false;            // true while the extension itself is writing to the history
  const MAX_SKIPS_IN_A_ROW = 40;
  const skippedIds = new Set();   // reels passed over since the last one that was shown
  let unknownSince = 0;
  let urlChangedAt = now();
  let reelTickTimer = 0;
  let endTimer = 0;
  let reelGiveUp = false;
  const EMPTY_KEY = '__ffo_reel_empty_pass';
  let reelEmpty = false;          // a whole pass over the feed had nothing to show
  let shownThisPass = 0;
  let lastShownId = null;
  let noticeTimer = 0;
  let warnedNoFriends = false;
  let syncing = false;            // a friends-list sync is running (see syncFriends)
  let order = [];                 // reels visited this cycle, in feed order
  let cursor = -1;

  const reelId = () => {
    const m = location.pathname.match(/^\/reel\/(\d+)/);
    return m ? m[1] : null;
  };
  const followingLink = () => document.querySelector('a[href*="/reel/following"]');
  const cardButton = (dir) => document.querySelector('[role="button"][aria-label="' + (dir > 0 ? 'Next Card' : 'Previous Card') + '" i]');

  // true = Following feed, false = "For you", null = cannot tell yet
  function followingMode() {
    const onFollowingUrl = /^\/reel\/following/.test(location.pathname);
    const link = followingLink();
    if (link) return onFollowingUrl || link.getAttribute('aria-current') === 'page';
    if (onFollowingUrl || followingSticky) return true;
    return null;
  }

  function reelFeedPos(src, id) {
    const viewer = viewerRecord(src);
    if (!viewer) return null;
    let best = null;
    for (const k in viewer) {
      if (!k.includes('video_feed_unit_feed')) continue;
      const conn = deref(src, viewer[k]);
      const refs = conn && conn.edges && conn.edges.__refs;
      if (!refs) continue;
      for (let i = 0; i < refs.length; i++) {
        const edge = refs[i] != null ? src.get(refs[i]) : null;
        const story = edge && deref(src, edge.node);
        if (!story || storyVideoId(src, story) !== id) continue;
        if (best && best.total >= refs.length) continue;
        const page = deref(src, conn.page_info);
        best = { index: i, total: refs.length, hasNext: page ? page.has_next_page !== false : true, sponsored: story.sponsored_data != null, time: story.creation_time };
      }
    }
    return best;
  }

  // true = from a friend / followed account, false = not, null = unknown so far
  function reelStatus(mode) {
    const id = reelId();
    const src = source();
    if (id && src) {
      const pos = reelFeedPos(src, id);
      if (pos && pos.sponsored) return false;
      const video = src.get(id);
      const owner = video && deref(src, video.owner);
      if (isHidden(owner)) return false;
      if (owner && friendsOnly()) return isFriend(owner);
      if (owner) {
        if (isMine(owner)) return true;
        if (owner.subscribe_status === 'CAN_SUBSCRIBE') return false;
        // Accounts that cannot be followed: trust Facebook's Following feed, reject elsewhere.
        if (owner.subscribe_status === 'CANNOT_SUBSCRIBE' && mode !== true) return false;
      }
    }
    if (now() - urlChangedAt < 700) return null;   // the page may still show the previous reel
    // The page only says "Following", never "friend": with no data, a friends-only pass moves on.
    if (friendsOnly()) return now() - urlChangedAt > 1500 ? false : null;
    const main = document.querySelector('div[role="main"]') || document;
    for (const b of main.querySelectorAll('[role="button"][aria-label]')) {
      const label = b.getAttribute('aria-label');
      if (/^Following /.test(label)) return true;
      if (/^Follow /.test(label)) return false;
    }
    return null;
  }

  // A message that stays on screen (over the blanked player, or during a friends sync); '' removes it.
  function notice(text) {
    let n = document.getElementById('ffo-notice');
    if (!text) { if (n) n.remove(); return; }
    if (!document.body) return;
    if (!n) { n = document.createElement('div'); n.id = 'ffo-notice'; document.body.appendChild(n); }
    if (n.textContent !== text) n.textContent = text;
  }

  function blockReel(on) {
    setFlag('data-ffo-reel-block', on);
    if (on) {
      for (const v of document.querySelectorAll('div[role="main"] video')) { try { v.pause(); } catch (e) { /* ignore */ } }
      if (!noticeTimer && !reelEmpty) {
        // Only say something if the search takes long enough to be noticed.
        noticeTimer = setTimeout(() => {
          noticeTimer = 0;
          if (!html.hasAttribute('data-ffo-reel-block') || reelEmpty) return;
          notice(friendsOnly() ? 'Looking for reels from your friends...' : 'Looking for reels from accounts you follow...');
        }, 2500);
      }
    } else {
      clearTimeout(noticeTimer);
      noticeTimer = 0;
      if (!syncing) notice('');
    }
  }

  function toast(text, ms) {
    const show = () => {
      if (!document.body) return;
      let t = document.getElementById('ffo-toast');
      if (!t) { t = document.createElement('div'); t.id = 'ffo-toast'; document.body.appendChild(t); }
      t.textContent = text;
      clearTimeout(t.__timer);
      t.__timer = setTimeout(() => t.remove(), ms || 2600);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
  }

  // The feed ran out. Normally: start over from the newest reel. If the whole pass had
  // nothing to show (likely in friends-only mode), try one more batch, then say so and
  // stop instead of reloading forever.
  function endOfFeed(asked) {
    if (rq && rq.lined > 0 && playlist().length >= RQ_MIN_LOOP) {
      // The remembered reels were part of the list and all of it has been played. Starting
      // over reloads the viewer, and with it goes the way back up through what was watched,
      // so it only happens on a second scroll down; until then scrolling up still works.
      if (asked === false) return;   // a timer, not the user
      const since = now() - rq.endAskedAt;
      if (since > RQ_AGAIN_MIN && since < RQ_AGAIN_MAX) { restartFollowing('Back to the newest reel'); return; }
      if (since >= RQ_AGAIN_MAX) {
        rq.endAskedAt = now();
        toast('That was the last reel. Scroll down again to start over from the newest.', 6000);
      }
      return;
    }
    if (startReplay()) return;   // nothing new left: loop over the remembered reels
    if (shownThisPass > 0) { restartFollowing('End of your reels - back to the newest'); return; }
    let rec = { t: 0, n: 0 };
    try { rec = JSON.parse(sessionStorage.getItem(EMPTY_KEY) || '') || rec; } catch (e) { /* none yet */ }
    if (now() - rec.t > 5 * 60000) rec = { t: now(), n: 0 };
    rec.n++;
    try { sessionStorage.setItem(EMPTY_KEY, JSON.stringify(rec)); } catch (e) { /* ignore */ }
    if (rec.n < 2) { restartFollowing(''); return; }
    showEmpty();
  }

  // Nothing to show: keep the player blank and say why, rather than searching forever.
  function showEmpty() {
    if (startReplay()) return;
    try { sessionStorage.removeItem(EMPTY_KEY); } catch (e) { /* ignore */ }
    skippedIds.clear();
    reelEmpty = true;
    blockReel(true);
    notice(friendsOnly()
      ? 'No recent reels from your friends. To see more, change the Reels setting from the My Facebook icon.'
      : 'No recent reels from accounts you follow. To see more, change the Reels setting from the My Facebook icon.');
  }

  // Full reload onto the Following feed, which always starts at the newest reel.
  function restartFollowing(message) {
    let rec = { t: 0, n: 0 };
    try { rec = JSON.parse(sessionStorage.getItem(RESTART_KEY) || '') || rec; } catch (e) { /* none yet */ }
    if (now() - rec.t > 20000) rec = { t: now(), n: 0 };
    rec.n++;
    try { sessionStorage.setItem(RESTART_KEY, JSON.stringify(rec)); } catch (e) { /* ignore */ }
    if (rec.n > 3) {
      // Something is off (no followed reels, or Facebook changed); stop steering rather than reload forever.
      reelGiveUp = true;
      blockReel(false);
      log('reel steering paused: too many restarts');
      return;
    }
    if (message) { try { sessionStorage.setItem(TOAST_KEY, message); } catch (e) { /* ignore */ } }
    blockReel(true);
    location.assign(FOLLOWING_URL);
  }

  // Switch the viewer from "For you" to the Following feed without a reload when possible.
  function goFollowing() {
    // Facebook can finish opening "For you" after our switch; retry a few times before reloading.
    if (goingAt && now() - goingAt < 1500) return;
    goingAt = now();
    goingTries++;
    if (goingTries > 4) { goingTries = 0; restartFollowing(''); return; }
    const attempt = (left) => {
      if (!isReel) return;
      const link = followingLink();
      if (link) { followingSticky = true; order = []; cursor = -1; link.click(); scheduleReelTick(300); return; }
      if (left <= 0) { restartFollowing(''); return; }
      setTimeout(() => attempt(left - 1), 150);
    };
    attempt(10);
  }

  // Facebook also greys out "Next" for a moment while it loads more reels, so a disabled
  // button only means "end of the feed" once it has stayed disabled for a while.
  function watchNextButton() {
    const next = cardButton(1);
    if (next && next.getAttribute('aria-disabled') === 'true') { if (!nextOffSince) nextOffSince = now(); }
    else nextOffSince = 0;
  }
  const nextStuckOff = () => nextOffSince > 0 && now() - nextOffSince > 2500;

  function atEnd(lenient) {
    const next = cardButton(1);
    watchNextButton();
    if (rqCanSupply()) return false;   // more reels are on their way into the list
    if (rq && rq.on && rq.atLast) return true;   // the queue has nothing more to add after this one
    if (nextStuckOff()) return true;
    const src = source();
    const id = reelId();
    const pos = src && id ? reelFeedPos(src, id) : null;
    if (pos) {
      if (pos.index < pos.total - 1) return false;
      return !pos.hasNext || !!lenient;
    }
    return !!lenient && !next;
  }

  function scheduleEndCheck() {
    clearTimeout(endTimer);
    const href = location.href;
    endTimer = setTimeout(() => {
      if (!isReel || reelGiveUp || location.href !== href || followingMode() !== true) return;
      if (atEnd(true)) endOfFeed(false);
    }, 3500);
  }

  function skipReel() {
    const id = reelId() || location.pathname;
    if (skipId !== id) { skipId = id; skipStart = now(); skipAt = 0; skippedIds.add(id); }
    // The Following feed can be hundreds of reels long. Stop after a stretch with nothing
    // to show instead of paging through all of it (every reel passed counts as watched).
    if (skippedIds.size > MAX_SKIPS_IN_A_ROW) { skipId = null; showEmpty(); return; }
    if (now() - skipAt < 350) { scheduleReelTick(150); return; }
    skipAt = now();
    const usable = (b) => !!b && b.getAttribute('aria-disabled') !== 'true';
    let btn = cardButton(lastDir);
    if (!usable(btn) && lastDir < 0) { lastDir = 1; btn = cardButton(1); }   // nothing earlier: turn around
    if (usable(btn)) btn.click();
    watchNextButton();
    // Out of reels: "Next" has stayed disabled, or nothing has moved for several seconds.
    if (nextStuckOff() || now() - skipStart > 7000) { skipId = null; endOfFeed(); return; }
    scheduleReelTick(200);
  }

  /* ---- Reel queue: Facebook's own reel list, cleaned and filled ahead of the viewer ---- */
  // The Following viewer plays from a list in Facebook's store that grows five reels at a
  // time, and much of it can be unwanted: ads, accounts unfollowed here, non-friends in
  // friends-only mode, reels listed twice. Clicking past those one at a time is slow and
  // shows (a blank player, a "Looking for reels" message). So the part of the list after
  // the reel on screen is rewritten before the viewer gets there:
  //   - unwanted and repeated reels are taken out,
  //   - more of the feed is requested in the background until RQ_AHEAD good reels wait,
  //   - when the feed has nothing new, the remembered reels (see "Replay list") are loaded
  //     and added to the same list, so they scroll exactly like new ones.
  // The viewer shows whatever is at its position in the list, so nothing before the reel
  // on screen is ever removed or moved: that part is the history, and scrolling up always
  // goes back through it, one reel at a time. The one exception is an unwanted reel that
  // is itself on screen: taking it out puts the next good one there.
  // The list ends when every remembered reel has been played. The viewer does not show a
  // reel twice in one list, so going round again needs a fresh list, which means a fresh
  // history: that is only done when asked for with a second scroll (see endOfFeed).

  const RQ_AHEAD = 10;            // good reels kept waiting after the one on screen
  const RQ_PAGE = 10;             // feed entries asked for per request (Facebook itself asks for 5)
  const RQ_RESERVE = 3;           // remembered reels lined up while the feed is still being searched
  const RQ_GRACE = 300;           // ...but not before the feed has had this long to offer a new reel first
  const RQ_DRY_MAX = 150;         // unwanted feed entries in a row before the feed is given up on
  const RQ_MAX_FAILS = 3;
  const RQ_STORY_PARALLEL = 2;    // remembered reels loaded at the same time (one more when few are waiting)
  const RQ_WARM = 4;              // remembered reels loaded ahead of time on the home page
  const RQ_WARM_DELAY = 5000;     // ...this long after the home page opened
  const RQ_STORY_MAX_AGE = 30 * 60000;   // a loaded reel's video addresses do not stay valid forever
  const RQ_MIN_LOOP = 4;          // fewer remembered reels than this: the old one-by-one replay loops them
  const RQ_AGAIN_MIN = 1500;      // a second scroll at the end counts as "start over" after this long...
  const RQ_AGAIN_MAX = 15000;     // ...and up to this long after the first
  const RQ_EDGE = 'client:ffo:reel:';
  const FOLLOWING_QUERY = 'FBUnifiedVideoFollowingPaginationQuery';
  const REEL_ROOT_QUERY = 'FBUnifiedVideoRootWithEntrypointQuery';
  const REEL_SEEN_MUTATION = 'FBUnifiedVideoSeenStateMutation';

  let rq = null;                  // the queue's state while a Following viewer is open
  let rqSoon = false;             // a look at the list is already scheduled (see hookStore)
  let rqOwn = false;              // true while the extension itself sends a "more reels" request
  let rqBroken = false;           // Facebook's pieces were not where expected: the old skipping is used
  let rqMissingSince = 0;
  let followingVars = null;       // settings of Facebook's own latest "more reels" request
  let fbReelPage = null;          // { cursor, at } of that request
  const reelStories = new Map();  // reel id -> { state: 'busy' | 'ready' | 'failed' | 'gone', at, story, keep, tries }
  let storyBusy = 0;
  let storyFails = 0;             // failures in a row
  let storyDrops = 0;             // remembered reels found deleted since the page loaded
  const reelSeenSent = new Set();
  let reelSeenOut = [];
  let reelSeenTimer = 0;
  let reelSeenCount = 0;
  let warmWant = 0;               // remembered reels to have loaded before the viewer is open
  let warmTimer = 0;
  let warmTries = 0;
  let warmAt = 0;

  const newQueue = (connId) => ({
    conn: connId, on: false, cur: -1, len: 0, lostSince: 0, atLast: false, since: now(),
    pageBusy: false, pageTicket: 0, pageFails: 0, pageAt: 0, feedOff: false, feedDone: false, dry: 0,
    counted: new Set(),           // feed entries already judged once (for `dry` and the replay list)
    libList: null, libPos: 0, libDone: false, lined: 0, endAskedAt: 0,
    saidCaughtUp: false, waitToastAt: 0
  });

  function dropQueue() {
    rq = null;
    rqMissingSince = 0;
  }

  function rqTools() {
    try {
      const relay = window.require('relay-runtime');
      const page = window.require(FOLLOWING_QUERY + '.graphql');
      if (!relay || !page || typeof relay.fetchQuery !== 'function' || typeof relay.commitLocalUpdate !== 'function') return null;
      return { relay, page };
    } catch (e) {
      return null;
    }
  }

  // The list the Following viewer draws from: { conn, key }.
  function followingConn(src) {
    const viewer = viewerRecord(src);
    if (!viewer) return null;
    let best = null;
    for (const k in viewer) {
      if (!k.startsWith('__') || !k.includes('video_feed_unit_feed') || !/following/i.test(k)) continue;
      const conn = deref(src, viewer[k]);
      const refs = conn && conn.edges && conn.edges.__refs;
      if (refs && (!best || refs.length > best.conn.edges.__refs.length)) best = { conn, key: k };
    }
    return best;
  }

  function reelEdgeInfo(src, ref) {
    const edge = ref != null ? src.get(ref) : null;
    const story = edge && deref(src, edge.node);
    if (!story) return null;
    const att = derefs(src, field(story, 'attachments'))[0];
    const media = att && deref(src, att.media);
    return {
      ref,
      id: media && media.id ? String(media.id) : storyVideoId(src, story),
      owner: media ? deref(src, media.owner) : null,
      ad: story.sponsored_data != null,
      time: story.creation_time,
      ours: String(ref).startsWith(RQ_EDGE)
    };
  }

  // 'show', or why not: 'ad', 'hidden' (an account unfollowed here), 'other'.
  // Same rules as reelStatus() applies to the reel on screen in the Following feed.
  function reelVerdict(info) {
    if (info.ad) return 'ad';
    const owner = info.owner;
    if (!owner) return friendsOnly() ? 'other' : 'show';
    if (isHidden(owner)) return 'hidden';
    if (friendsOnly()) return isFriend(owner) ? 'show' : 'other';
    if (isMine(owner)) return 'show';
    return owner.subscribe_status === 'CAN_SUBSCRIBE' ? 'other' : 'show';
  }

  function writeReelList(tools, connId, want) {
    try {
      tools.relay.commitLocalUpdate(relayEnv, (store) => {
        const conn = store.get(connId);
        if (!conn) return;
        const out = [];
        for (const ref of want) {
          const edge = store.get(ref);
          if (edge) out.push(edge);
        }
        conn.setLinkedRecords(out, 'edges');
      });
      return true;
    } catch (e) {
      log('reel queue: could not write the list', e);
      return false;
    }
  }

  // Facebook marks a reel as seen when the viewer leaves it, and its Following feed keeps
  // offering reels that are not marked. Reels from accounts unfollowed here used to get
  // marked while they were clicked past; now that they are taken out unseen they are marked
  // directly, or the same ones would head the feed on every visit. Only those: reels that
  // are merely outside the current "Reels from" choice stay new.
  function markReelSeen(id) {
    if (!id || reelSeenSent.has(id)) return;
    reelSeenSent.add(id);
    reelSeenOut.push(id);
    if (!reelSeenTimer) reelSeenTimer = setTimeout(sendReelSeen, 1500);
  }
  function sendReelSeen() {
    reelSeenTimer = 0;
    const ids = reelSeenOut.splice(0, 10);
    if (!ids.length) return;
    try {
      const relay = window.require('relay-runtime');
      const mutation = window.require(REEL_SEEN_MUTATION + '.graphql');
      const actor = viewerId();
      if (relay && mutation && actor && typeof relay.commitMutation === 'function') {
        relay.commitMutation(relayEnv, {
          mutation,
          variables: { input: { video_ids: ids, actor_id: actor, client_mutation_id: 'ffo' + (++reelSeenCount) } },
          onError: () => { /* not worth retrying */ }
        });
      }
    } catch (e) { /* Facebook's viewer code is not there: nothing to mark with */ }
    if (reelSeenOut.length) reelSeenTimer = setTimeout(sendReelSeen, 1500);
  }

  const reelScale = () => (followingVars && followingVars.scale) || (feedVars && feedVars.scale) || 1;

  // Ask for the next stretch of the Following feed, the way the viewer itself does.
  function fetchReelPage(tools, found, cursor) {
    const q = rq;
    let base = followingVars;
    if (!base) {
      // Facebook's own request has not been seen: the list's name carries the same settings.
      const m = found.key.match(/video_feed_context_data:(\{.*\})\)$/);
      let context = null;
      try { context = m ? JSON.parse(m[1]) : null; } catch (e) { /* handled below */ }
      if (!context) { q.pageFails = RQ_MAX_FAILS; return; }
      base = { scale: reelScale(), should_use_stream: true, stream_initial_count: 1, useDefaultActor: false, video_feed_context_data: context };
    }
    const vars = {};
    for (const k in base) if (!k.startsWith('__relay_internal__')) vars[k] = base[k];
    vars.count = RQ_PAGE;
    vars.cursor = cursor;
    q.pageBusy = true;
    q.pageAt = now();
    const ticket = ++q.pageTicket;
    const done = (ok) => {
      if (q !== rq || !q.pageBusy || q.pageTicket !== ticket) return;
      q.pageBusy = false;
      q.pageAt = now();
      if (ok) {
        // An answer that did not move the feed along counts as a failure, or it would be asked for again at once.
        const src = source();
        const conn = src && src.get(q.conn);
        const page = conn && deref(src, conn.page_info);
        if (page && page.end_cursor === cursor && page.has_next_page !== false) ok = false;
      }
      if (ok) q.pageFails = 0; else { q.pageFails++; log('reel queue: feed request failed'); }
      scheduleReelTick(ok ? 0 : 1200);
    };
    try {
      rqOwn = true;
      tools.relay.fetchQuery(relayEnv, tools.page, vars, { networkCacheConfig: { force: true } })
        .subscribe({ complete: () => done(true), error: () => done(false) });
    } catch (e) {
      done(false);
    } finally {
      rqOwn = false;
    }
    setTimeout(() => done(false), 20000);
  }

  // The request Facebook sends when one specific reel is opened.
  function reelRootVars(id) {
    return {
      count: 1, initial_node_id: id, isAggregationProfileViewerOrShouldShowReelsForPage: false, page_id: '',
      root_video_id: id, scale: reelScale(), should_include_comet_reels_seo_llm_content: false,
      should_use_stream: true, shouldIncludeInitialNodeFetch: true, shouldShowReelsForPage: false,
      shouldShowReelsForUser: false, stream_initial_count: 0, useDefaultActor: false, user_id: '',
      video_feed_context_data: {
        arltw_feed_section_type: 'FB_SHORTS_CHAINING', in_session_watched_video: null, is_async_ads_enabled: true,
        is_async_ads_headload_coupling_enabled: true, player_behavior: 'UNIFIED_PLAYER_VDD',
        real_time_ranking_context_data: { recent_vpvs_v2: [] }, request_type: 'NORMAL', seed_video_id: id,
        shorts_search_params: {}, surface_type: 'FEED_VIDEO_DEEP_DIVE', tracking_code: '',
        video_channel_entry_point: 'NEWSFEED'
      }
    };
  }

  const storyUsable = (st) => !!st && st.state === 'ready' && now() - st.at < RQ_STORY_MAX_AGE;

  // Load one remembered reel into Facebook's store. False when Facebook's reel code is not loaded.
  function fetchReelStory(id) {
    let relay = null;
    let query = null;
    try {
      relay = window.require('relay-runtime');
      query = window.require(REEL_ROOT_QUERY + '.graphql');
    } catch (e) { /* handled below */ }
    if (!relay || !query || typeof relay.fetchQuery !== 'function') return false;
    const had = reelStories.get(id);
    if (had && had.keep) { try { had.keep.dispose(); } catch (e) { /* ignore */ } }
    const st = { state: 'busy', at: now(), story: '', keep: null, tries: had ? had.tries || 0 : 0 };
    reelStories.set(id, st);
    storyBusy++;
    const vars = reelRootVars(id);
    // `early`: part of the answer has arrived; enough if the reel itself is in it.
    const done = (ok, early) => {
      if (st.state !== 'busy') return;
      const src = ok ? source() : null;
      const video = src && src.get(id);
      const story = video && deref(src, video.creation_story);
      if (early && !story) return;
      storyBusy--;
      if (story) {
        st.state = 'ready';
        st.at = now();
        st.story = story.__id;
        storyFails = 0;
      } else if (ok && src && (src.get('client:root') || {})['video(id:"' + id + '")'] === null && storyDrops < 5) {
        // Facebook answered that there is no such reel: deleted, or no longer visible to you.
        // (Capped, so a change on Facebook's side cannot empty the remembered list.)
        storyDrops++;
        st.state = 'gone';
        library.delete(id);
        toBridge('reelDrop', { id });
      } else {
        st.tries++;
        st.state = st.tries >= 2 ? 'gone' : 'failed';
        storyFails++;
        log('reel queue: a remembered reel could not be loaded');
      }
      if (st.state !== 'ready' && st.keep) { try { st.keep.dispose(); } catch (e) { /* ignore */ } st.keep = null; }
      if (isReel) scheduleReelTick(0);
      if (warmWant) warmReels(warmWant);
    };
    try {
      // Keeps the reel in Facebook's store until it has been put in the list.
      if (typeof relay.createOperationDescriptor === 'function' && typeof relayEnv.retain === 'function') {
        st.keep = relayEnv.retain(relay.createOperationDescriptor(query, vars));
      }
      relay.fetchQuery(relayEnv, query, vars, { networkCacheConfig: { force: true } })
        .subscribe({ next: () => done(true, true), complete: () => done(true), error: () => done(false) });
    } catch (e) {
      done(false);
    }
    setTimeout(() => done(false), 20000);
    return true;
  }

  // Load the newest `n` remembered reels before they are needed, so the viewer can start on
  // one at once. Does nothing until Facebook's reel code is loaded.
  function warmReels(n) {
    warmWant = n;
    let count = 0;
    for (const id of playlist()) {
      if (count >= n) break;
      const st = reelStories.get(id);
      if (st && st.state === 'gone') continue;
      count++;
      if (st && (st.state === 'busy' || storyUsable(st))) continue;
      if (storyBusy >= RQ_STORY_PARALLEL) return;   // continued when one of those finishes
      if (storyFails >= 4 || !fetchReelStory(id)) { warmWant = 0; return; }
    }
    warmWant = 0;   // all loaded, or on their way
  }

  const reelCodeLoaded = () => {
    try { return !!window.require(REEL_ROOT_QUERY + '.graphql'); } catch (e) { return false; }
  };

  // On the home page Facebook's reel code is not loaded. Facebook loads it when the pointer
  // goes over a link to Reels, so the page is told exactly that, once, a few seconds in;
  // the first remembered reels are then loaded and wait for the viewer to be opened.
  function scheduleWarm() {
    if (warmTimer || !isHome || !settings.enabled || settings.reelsMode === 'all' || warmTries >= 3) return;
    warmTimer = setTimeout(warmHome, RQ_WARM_DELAY);
  }
  function warmHome() {
    warmTimer = 0;
    if (!isHome || !settings.enabled || settings.reelsMode === 'all' || document.hidden) return;   // tried again on returning to the tab
    if (!playlist().length) return;
    if (reelCodeLoaded()) { warmTries = 3; warmReels(RQ_WARM); return; }
    if (++warmTries > 2) return;   // Facebook did not take the hint: the reels load when the viewer opens
    let link = null;
    for (const a of document.querySelectorAll('a[href*="/reel/"]')) {
      let path = '';
      try { path = new URL(a.href, location.origin).pathname; } catch (e) { /* ignore */ }
      if (path !== '/reel/' && path !== '/reel') continue;
      if (!link) link = a;
      if (a.textContent.trim()) { link = a; break; }   // a link with its name written out shows no tooltip
    }
    if (link) {
      // An icon-only link answers with a tooltip: keep it out of sight for the moment this takes.
      setFlag('data-ffo-warm', true);
      setTimeout(() => setFlag('data-ffo-warm', false), 2000);
      const box = link.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, composed: true, view: window, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
      try {
        link.dispatchEvent(new PointerEvent('pointerover', Object.assign({ pointerType: 'mouse' }, at)));
        link.dispatchEvent(new MouseEvent('mouseover', at));
        setTimeout(() => {
          link.dispatchEvent(new PointerEvent('pointerout', Object.assign({ pointerType: 'mouse' }, at)));
          link.dispatchEvent(new MouseEvent('mouseout', at));
        }, 300);
      } catch (e) { /* ignore */ }
    }
    warmTimer = setTimeout(warmHome, 1200);
  }

  // Remembered reels, newest first: load the next ones and add those that are ready to the
  // end of the list, in order. `need` is how many more reels should be waiting.
  function lineUpRemembered(q, tools, src, infos, need, place) {
    if (!q.libList) {
      const here = new Set();
      for (const info of infos) if (info && info.id) here.add(info.id);
      q.libList = playlist().filter((id) => !here.has(id));   // the rest is in the list already
      q.libPos = 0;
    }
    const add = [];
    while (place && add.length < need && q.libPos < q.libList.length) {
      const id = q.libList[q.libPos];
      const st = reelStories.get(id);
      if (st && st.state === 'gone') { q.libPos++; continue; }
      if (!storyUsable(st)) break;   // in order: wait for this one
      add.push(id);
      q.libPos++;
    }
    // Load what comes next, a couple at a time.
    let wanted = need - add.length + 1;
    const parallel = RQ_STORY_PARALLEL + (need > RQ_AHEAD / 2 ? 1 : 0);
    for (let i = q.libPos; i < q.libList.length && wanted > 0 && storyBusy < parallel; i++) {
      const st = reelStories.get(q.libList[i]);
      if (st && st.state === 'gone') continue;
      wanted--;
      if (st && (st.state === 'busy' || storyUsable(st))) continue;
      if (storyFails >= 4 || !fetchReelStory(q.libList[i])) { q.libDone = true; break; }   // not possible here
    }
    if (q.libPos >= q.libList.length) q.libDone = true;
    if (!add.length) return;
    try {
      tools.relay.commitLocalUpdate(relayEnv, (store) => {
        const conn = store.get(q.conn);
        if (!conn) return;
        const edges = (conn.getLinkedRecords('edges') || []).filter(Boolean);
        const type = edges.length ? edges[0].getType() : 'VideoFeedUnitsEdge';
        for (const id of add) {
          const st = reelStories.get(id);
          const story = st && store.get(st.story);
          if (!story) continue;
          const edgeId = RQ_EDGE + id;
          const edge = store.get(edgeId) || store.create(edgeId, type);
          edge.setLinkedRecord(story, 'node');
          edge.setValue(null, 'cursor');
          if (edges.some((e) => e.getDataID() === edgeId)) continue;
          edges.push(edge);
          q.lined++;
        }
        conn.setLinkedRecords(edges, 'edges');
      });
    } catch (e) {
      log('reel queue: could not add remembered reels', e);
      q.libDone = true;
    }
  }

  // True while the queue can still put another reel after the one on screen.
  const rqCanSupply = () => !!rq && rq.on && (!rq.feedDone || !rq.libDone || rq.pageBusy || storyBusy > 0);

  // One look at the list. Returns null when the queue is not in charge (the old skipping
  // then applies), else { status } for the reel on screen: true = show it, false = it is
  // unwanted and nothing is ready to take its place yet, null = cannot tell yet.
  function reelQueueTick() {
    if (!isReel || reelGiveUp || replay || rqBroken || followingMode() !== true) { if (rq) rq.on = false; return null; }
    const src = source();
    const found = src && followingConn(src);
    if (!found) {
      // The viewer is still loading: use the time to load the first remembered reels.
      if (now() - warmAt > 400) { warmAt = now(); warmReels(RQ_RESERVE); }
      if (rq) rq.on = false;
      return null;
    }
    const tools = rqTools();
    if (!tools) {
      // The list is there but Facebook's code for it is not (yet): give it a moment.
      if (!rqMissingSince) rqMissingSince = now();
      if (now() - rqMissingSince > 4000) { rqBroken = true; log('reel queue: not available, skipping reels one at a time'); }
      if (rq) rq.on = false;
      return null;
    }
    rqMissingSince = 0;
    const conn = found.conn;
    const refs = conn.edges.__refs;
    // A new list, or Facebook started this one over (it only ever grows otherwise).
    if (!rq || rq.conn !== conn.__id || refs.length < rq.len) rq = newQueue(conn.__id);
    const q = rq;
    const infos = refs.map((r) => reelEdgeInfo(src, r));

    // Where the viewer is. A reel can be listed more than once; the entry nearest to where
    // the viewer was last seen is the one on screen.
    const id = reelId();
    let cur = -1;
    if (id) {
      let best = Infinity;
      for (let i = 0; i < infos.length; i++) {
        if (!infos[i] || infos[i].id !== id) continue;
        const d = Math.abs(i - Math.max(q.cur, 0));
        if (d < best) { best = d; cur = i; }
      }
      if (cur < 0) {
        // The address is not one of the listed reels (yet), e.g. just after the list changed.
        if (!q.lostSince) q.lostSince = now();
        q.on = now() - q.lostSince < 2500;
        return q.on ? { status: null } : null;
      }
    }
    q.lostSince = 0;
    q.cur = cur;
    q.on = true;

    const libOk = new Set(playlist());
    const verdict = (info) => (info.ours ? (libOk.has(info.id) ? 'show' : 'other') : reelVerdict(info));
    const keep = [];
    const have = new Set();   // reels up to and including the one on screen
    for (let i = 0; i <= cur; i++) {
      keep.push(refs[i]);
      if (infos[i] && infos[i].id) have.add(infos[i].id);
    }
    const fresh = [];         // good reels from the feed, in feed order
    const freshIds = new Set();
    let lined = [];           // remembered reels, in the order they were added
    for (let i = cur + 1; i < refs.length; i++) {
      const info = infos[i];
      if (!info) continue;    // an empty entry
      const v = verdict(info);
      if (!info.ours && !q.counted.has(info.ref)) {
        q.counted.add(info.ref);
        if (v === 'show') q.dry = 0; else q.dry++;
        if (!info.ad && info.id && info.owner && isMine(info.owner)) rememberReel(info.id, info.owner.id, '', info.time);
        if (v === 'hidden') markReelSeen(info.id);
      }
      if (v !== 'show') continue;
      if (info.ours) { lined.push(info); continue; }
      if (info.id) {
        if (have.has(info.id) || freshIds.has(info.id)) continue;   // listed twice
        freshIds.add(info.id);
      }
      fresh.push(info.ref);
    }
    // A remembered reel the feed now offers as new plays once, as the new one.
    lined = lined.filter((info) => !freshIds.has(info.id) && !have.has(info.id)).map((info) => info.ref);

    // The reel on screen.
    let status = null;
    let stepBack = false;
    if (cur >= 0 && infos[cur]) {
      const v = allowedIds.has(id) ? 'show' : verdict(infos[cur]);
      status = v === 'show';
      if (!status && (fresh.length || lined.length)) {
        // Unwanted, and a good one is waiting: take it out and the next one is on screen.
        keep.pop();
        if (v === 'hidden') markReelSeen(id);
        // Reached by scrolling up: the reel now on screen is the one just left, so go one
        // further back, to the reel that was before the unwanted one.
        stepBack = lastDir < 0 && keep.length > 0;
      }
    }

    const want = keep.concat(fresh, lined);
    let changed = want.length !== refs.length;
    for (let i = 0; !changed && i < want.length; i++) changed = want[i] !== refs[i];
    if (changed && !writeReelList(tools, conn.__id, want)) { rqBroken = true; q.on = false; return null; }
    q.len = want.length;
    if (stepBack) {
      setTimeout(() => {
        const prev = cardButton(-1);
        if (prev && prev.getAttribute('aria-disabled') !== 'true') prev.click();
      }, 0);
    }
    // Reels after the one that is, or is about to be, on screen.
    const swapped = keep.length <= cur;
    const waiting = fresh.length + lined.length - (swapped || cur < 0 ? 1 : 0);
    q.atLast = waiting <= 0;

    // More of the feed.
    const page = deref(src, conn.page_info);
    if (!q.feedOff && (q.dry >= RQ_DRY_MAX || q.pageFails >= RQ_MAX_FAILS)) {
      q.feedOff = true;
      log('reel queue: leaving the feed alone', q.dry, q.pageFails);
    }
    // The feed has nothing more. (A list that has only just appeared also says "no more"
    // for a moment, before its first answer has arrived: that one has no position yet.)
    q.feedDone = q.feedOff || (!!page && page.has_next_page === false && (!!page.end_cursor || now() - q.since > 4000));
    // Facebook's own request for the same stretch may be on its way: let it finish first.
    const fbBusy = !!fbReelPage && !!page && fbReelPage.cursor === page.end_cursor && now() - fbReelPage.at < 4000;
    if (!q.feedDone && !q.pageBusy && !fbBusy && fresh.length < RQ_AHEAD && page && page.end_cursor &&
        now() - q.pageAt > (q.pageFails ? 1500 : 250)) {
      fetchReelPage(tools, found, page.end_cursor);
    }

    // Remembered reels: all that are needed once the feed is done, a few in reserve before.
    // On opening the viewer the feed gets a moment to come up with a new reel to start on;
    // the remembered ones are loaded meanwhile and only go in the list after that.
    const target = q.feedDone ? RQ_AHEAD : RQ_RESERVE;
    if (!q.libDone && waiting < target) {
      const place = q.feedDone || now() - q.since > RQ_GRACE;
      lineUpRemembered(q, tools, src, infos, target - waiting, place);
      if (!place) scheduleReelTick(RQ_GRACE - (now() - q.since) + 20);
    }

    if (cur >= 0 && infos[cur] && infos[cur].ours && q.feedDone && !q.saidCaughtUp) {
      q.saidCaughtUp = true;
      toast(friendsOnly() ? 'Replaying reels from your friends, newest first' : 'All caught up - replaying your reels from the newest', 4000);
    }
    return { status, swapped };
  }

  /* ---- Replay: play the remembered reels, newest first, round and round ---- */

  // Records every followed / friend reel Facebook has lined up in the viewer, not just
  // the one on screen, so the list fills quickly.
  function harvestViewer() {
    if (now() - harvestAt < 1500) return;
    harvestAt = now();
    const src = source();
    const viewer = src && viewerRecord(src);
    if (!viewer) return;
    for (const k in viewer) {
      if (!k.includes('video_feed_unit_feed')) continue;
      const conn = deref(src, viewer[k]);
      const refs = conn && conn.edges && conn.edges.__refs;
      if (!refs) continue;
      for (const r of refs) {
        const edge = r != null ? src.get(r) : null;
        const story = edge && deref(src, edge.node);
        if (!story || story.sponsored_data != null) continue;
        const att = derefs(src, field(story, 'attachments'))[0];
        const media = att && deref(src, att.media);
        const owner = media && deref(src, media.owner);
        if (media && media.id && owner && isMine(owner)) rememberReel(media.id, owner.id, '', story.creation_time);
      }
    }
  }

  function rememberShown(id) {
    const src = source();
    const video = src && src.get(id);
    const owner = video && deref(src, video.owner);
    if (!owner || !isMine(owner)) return;   // e.g. a stranger's reel the user opened on purpose
    const pos = reelFeedPos(src, id);
    rememberReel(id, owner.id, '', pos && pos.time);
  }

  // Open one specific reel inside the viewer without reloading the page: put the address
  // in the history and tell Facebook's router the history moved.
  function gotoReel(id) {
    allowedIds.add(id);
    replay.navAt = now();
    replay.arrived = false;
    replay.checked = false;
    replay.confirmed = false;   // set once Facebook itself puts this reel in the address bar
    try { sessionStorage.setItem(REPLAY_KEY, JSON.stringify({ id, at: now() })); } catch (e) { /* ignore */ }
    if (reelId() === id) { replay.confirmed = true; return; }
    try {
      selfNav = true;
      history.pushState(null, '', '/reel/' + id + '/');
      selfNav = false;
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    } catch (e) {
      selfNav = false;
      location.assign('/reel/' + id + '/');
    }
    scheduleReelTick(300);
  }

  // Switch from Facebook's feed to the replay list. False when there is nothing to replay.
  function startReplay() {
    const list = playlist();
    if (!list.length) return false;
    let idx = 0;
    if (list[0] === reelId() && list.length > 1) idx = 1;   // already watching the newest one
    replay = { list, idx, navAt: 0, arrived: false, checked: false, loadedAt: 0 };
    reelEmpty = false;
    skippedIds.clear();
    blockReel(false);
    toast(friendsOnly() ? 'Replaying reels from your friends, newest first' : 'All caught up - replaying your reels from the newest', 4000);
    gotoReel(list[idx]);
    return true;
  }

  function replayStep(dir) {
    if (!replay || now() - replay.navAt < 500) return;   // one step per gesture
    let idx = replay.idx + dir;
    if (idx >= replay.list.length) {
      // Went all the way round: pick up anything added since and start again at the newest.
      const fresh = playlist();
      if (fresh.length) replay.list = fresh;
      idx = 0;
      if (replay.list.length > 1) toast('Back to the newest reel');
    } else if (idx < 0) {
      idx = replay.list.length - 1;
    }
    if (replay.list[idx] === reelId()) {
      replay.idx = idx;
      replay.navAt = now();
      toast('This is the only reel on your replay list so far.', 4000);
      return;
    }
    replay.idx = idx;
    gotoReel(replay.list[idx]);
  }

  function replayTick() {
    const want = replay.list[replay.idx];
    const id = reelId();
    if (id === want && replay.confirmed) {
      replay.strayAt = 0;
      if (!replay.arrived) { replay.arrived = true; replay.loadedAt = now(); }
      blockReel(false);
      if (!replay.checked && now() - replay.loadedAt > 9000) {
        replay.checked = true;
        if (!document.querySelector('div[role="main"] video')) {
          // Deleted or no longer visible to you: forget it and move on.
          library.delete(want);
          toBridge('reelDrop', { id: want });
          replay.list.splice(replay.idx, 1);
          if (!replay.list.length) { replay = null; showEmpty(); return; }
          replay.idx = replay.idx % replay.list.length;
          gotoReel(replay.list[replay.idx]);
        }
      }
      return;
    }
    if (!replay.arrived) {
      // Still on its way; if the in-page navigation did not take, load the reel the plain way.
      if (now() - replay.navAt > 4500) { replay.navAt = now(); location.assign('/reel/' + want + '/'); }
      else scheduleReelTick(300);
      return;
    }
    // Facebook moved by itself (for example a click beside the video). The address can
    // flicker while the player settles, so only act once it has stayed put.
    if (!replay.strayAt) replay.strayAt = now();
    if (now() - replay.strayAt < 900) { scheduleReelTick(300); return; }
    replay.strayAt = 0;
    const at = id ? replay.list.indexOf(id) : -1;
    if (at >= 0) { replay.idx = at; replay.loadedAt = now(); replay.checked = false; return; }
    replay.navAt = 0;
    replayStep(1);
  }

  // After a full page load in the middle of a replay, carry on from the same reel.
  function resumeReplay() {
    if (replay || !pendingResume || !isReel) return;
    const id = reelId();
    if (id !== pendingResume) { pendingResume = null; return; }
    const list = playlist();
    const at = list.indexOf(id);
    if (at < 0) return;   // the list may not have arrived from storage yet
    pendingResume = null;
    replay = { list, idx: at, navAt: now(), arrived: true, confirmed: true, checked: false, loadedAt: now() };
  }

  // Keeps track of where we are in this pass over the feed, so a reel Facebook
  // repeats (it re-lists the reel you entered on) is skipped instead of replayed.
  function noteArrival(id) {
    if (!id || order[cursor] === id) return false;
    if (lastDir > 0) {
      if (order[cursor + 1] === id) { cursor++; return false; }
      if (order.includes(id)) return true;   // repeat
      order.splice(cursor + 1, 0, id);
      cursor++;
      return false;
    }
    if (cursor > 0 && order[cursor - 1] === id) { cursor--; return false; }
    const at = order.indexOf(id);
    if (at >= 0) cursor = at; else { order.splice(Math.max(cursor, 0), 0, id); cursor = Math.max(cursor, 0); }
    return false;
  }

  function hideForYouTab() {
    const f = followingLink();
    if (!f) return;
    let node = f;
    for (let i = 0; i < 4 && node.parentElement; i++) {
      node = node.parentElement;
      const others = Array.from(node.querySelectorAll('a[href]')).filter((a) => a !== f);
      if (!others.length) continue;
      for (const a of others) {
        let path = '';
        try { path = new URL(a.href, location.origin).pathname; } catch (e) { /* ignore */ }
        if ((path === '/reel/' || path === '/reel') && !a.hasAttribute('data-ffo-hidden')) a.setAttribute('data-ffo-hidden', '');
      }
      return;
    }
  }

  function scheduleReelTick(delay) {
    if (reelTickTimer) return;
    reelTickTimer = setTimeout(() => { reelTickTimer = 0; reelTick(); }, delay == null ? 120 : delay);
  }

  function markShown(id) {
    if (!id || id === lastShownId) return;
    lastShownId = id;
    shownThisPass++;
    skippedIds.clear();
    rememberShown(id);
    try { sessionStorage.removeItem(EMPTY_KEY); } catch (e) { /* ignore */ }
  }

  function reelTick() {
    if (!isReel || reelGiveUp) { blockReel(false); return; }
    if (reelEmpty) { blockReel(true); return; }
    hideForYouTab();
    if (settings.reelsMode === 'friends' && !friends.size && !warnedNoFriends) {
      warnedNoFriends = true;
      toast('Friends-only reels needs your friends list: click the My Facebook icon and press Sync. Showing friends + following until then.', 9000);
    }
    harvestViewer();
    resumeReplay();
    if (replay) { replayTick(); return; }
    const path = location.pathname;
    if (path === '/reel/' || path === '/reel') {   // generic "Reels" entry: never the For-you feed
      blockReel(true);
      // Without the queue, friends-only goes straight to the remembered friends' reels:
      // clicking through the Following feed to find them would mark all of it as watched.
      if (rqBroken && friendsOnly() && startReplay()) return;
      if (!rqBroken) warmReels(RQ_RESERVE);
      goFollowing();
      return;
    }
    const id = reelId();
    const mode = followingMode();
    // In the Following feed the queue decides (see reelQueueTick); elsewhere, and when the
    // queue cannot work, the reel on screen is judged by itself and unwanted ones are skipped.
    const queued = mode === true ? reelQueueTick() : null;
    const status = queued ? queued.status : reelStatus(mode);
    const allowed = status === true || (id != null && allowedIds.has(id));
    watchNextButton();
    if (status === false && !allowed && !queued && friendsOnly() && startReplay()) return;

    if (mode === true) {
      goingTries = 0;
      if (status === false) {
        blockReel(true);
        // The queue has put a good reel in its place, or is still finding one.
        if (queued && (queued.swapped || rqCanSupply())) { skipId = null; scheduleReelTick(250); return; }
        skipReel();
        return;
      }
      if (status === true) { blockReel(false); skipId = null; markShown(id); }
      else {
        // No verdict (e.g. an account that cannot be followed): trust the Following feed
        // rather than leave the player blank.
        if (now() - urlChangedAt > 1500) blockReel(false);
        scheduleReelTick(400);
      }
      return;
    }
    if (allowed) { blockReel(false); unknownSince = 0; markShown(id); return; }
    if (status === false) {
      blockReel(true);
      if (mode === false) { goFollowing(); return; }
      // Tabs not rendered yet: give the viewer a moment, then reload onto Following.
      if (!unknownSince) unknownSince = now();
      if (now() - unknownSince > 2500) { unknownSince = 0; restartFollowing(''); return; }
    }
    scheduleReelTick(400);
  }

  function inSidePanelScroller(target) {
    for (let n = target; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 4) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && !n.querySelector('video')) return true;   // comments etc.
      }
    }
    return false;
  }

  function onIntent(dir, ev) {
    if (!isReel || reelGiveUp || !ev.isTrusted) return;
    lastDir = dir;
    if (replay) {
      // Replaying: the extension, not Facebook, decides what comes next.
      ev.preventDefault();
      ev.stopImmediatePropagation();
      replayStep(dir);
      return;
    }
    const mode = followingMode();
    if (mode === false) {
      // "For you": Facebook would pick a random reel next. Go to the Following feed instead.
      ev.preventDefault();
      ev.stopImmediatePropagation();
      goFollowing();
      return;
    }
    if (mode === true && dir > 0) {
      if (rq && rq.on && rq.atLast && rqCanSupply()) {
        // Nothing after this one yet; it is being fetched.
        if (now() - rq.waitToastAt > 4000) { rq.waitToastAt = now(); toast('Loading more reels...', 2000); }
        scheduleReelTick(0);
      }
      if (atEnd(false)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        endOfFeed();
        return;
      }
      scheduleEndCheck();
    }
  }

  window.addEventListener('wheel', (ev) => {
    if (!isReel || Math.abs(ev.deltaY) < 8) return;
    if (ev.target && ev.target.nodeType === 1 && inSidePanelScroller(ev.target)) return;
    onIntent(ev.deltaY > 0 ? 1 : -1, ev);
  }, { capture: true, passive: false });

  window.addEventListener('keydown', (ev) => {
    if (!isReel) return;
    const t = ev.target;
    if (t && t.nodeType === 1 && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (ev.key === 'ArrowDown' || ev.key === 'PageDown') onIntent(1, ev);
    else if (ev.key === 'ArrowUp' || ev.key === 'PageUp') onIntent(-1, ev);
  }, true);

  window.addEventListener('click', (ev) => {
    if (!isReel || !ev.target || ev.target.nodeType !== 1) return;
    const btn = ev.target.closest('[aria-label="Next Card" i], [aria-label="Previous Card" i]');
    if (btn) onIntent(/^next/i.test(btn.getAttribute('aria-label')) ? 1 : -1, ev);
  }, true);

  /* ------------------------------------------------------------------ */
  /* Page tracking                                                       */
  /* ------------------------------------------------------------------ */

  const isReelPath = (p) => /^\/reel(\/|$)/.test(p);
  let lastPath = location.pathname;

  function updatePage() {
    const p = location.pathname;
    isHome = settings.enabled && (p === '/' || p === '/home.php');
    isReel = settings.enabled && settings.reelsMode !== 'all' && isReelPath(p);
    setFlag('data-ffo-on', settings.enabled);
    setFlag('data-ffo-home', isHome);
    setFlag('data-ffo-debug', settings.enabled && settings.debug);
    if (isHome) { if (!html.hasAttribute('data-ffo-home-init')) { html.setAttribute('data-ffo-home-init', ''); setFlag('data-ffo-strict', true); } }
    else { html.removeAttribute('data-ffo-home-init'); setFlag('data-ffo-strict', false); firstPostAt = 0; }
    if (!isReel) { reelEmpty = false; blockReel(false); }
    if (isHome) scheduleWarm();
    if (!isHome) stopPull();
    if (!mixWanted()) stopMix();
  }

  function onUrl() {
    const path = location.pathname;
    if (path === lastPath) return;
    const prev = lastPath;
    lastPath = path;
    urlChangedAt = now();
    nextOffSince = 0;
    const id = reelId();
    if (id && !isReelPath(prev)) allowedIds.add(id);   // opened one specific reel from elsewhere
    if (/^\/reel\/following/.test(path)) followingSticky = true;
    if (!isReelPath(path)) {
      followingSticky = false; order = []; cursor = -1; goingAt = 0; goingTries = 0; reelGiveUp = false; unknownSince = 0;
      reelEmpty = false; shownThisPass = 0; lastShownId = null;
      replay = null; pendingResume = null;
      dropQueue();
      try { sessionStorage.removeItem(REPLAY_KEY); } catch (e) { /* ignore */ }
    }
    if (goChosenFeed()) return;
    updatePage();
    if (isReel) {
      // (With the queue in charge, repeats are taken out of the list before they are reached.)
      if (!replay && id && followingMode() === true && noteArrival(id) && !(rq && rq.on)) { blockReel(true); skipReel(); return; }
      reelTick();
    }
    if (isHome) rescanFeed();
  }

  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    history[name] = function () {
      const result = original.apply(this, arguments);
      // Facebook's router answering a replay jump by writing that reel's address itself.
      if (replay && !selfNav && arguments.length > 2 && String(arguments[2]).includes(replay.list[replay.idx])) replay.confirmed = true;
      try { onUrl(); } catch (e) { log('url handler failed', e); }
      return result;
    };
  }
  window.addEventListener('popstate', () => { try { onUrl(); } catch (e) { /* ignore */ } });

  /* ------------------------------------------------------------------ */
  /* DOM watching                                                        */
  /* ------------------------------------------------------------------ */

  const observer = new MutationObserver((mutations) => {
    if (!settings.enabled) return;
    if (isHome) {
      const todo = new Set();
      for (const m of mutations) {
        const target = m.target;
        if (target.nodeType !== 1) continue;
        if (m.type === 'attributes') { if (target.hasAttribute('aria-posinset')) todo.add(target); continue; }
        const host = target.closest('[aria-posinset]');
        if (host) todo.add(host);
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.hasAttribute('aria-posinset')) todo.add(n);
          if (n.firstElementChild) for (const p of n.querySelectorAll('[aria-posinset]')) todo.add(p);
        }
      }
      todo.forEach(classify);
      scheduleSideAds();
      if (pullEl && (!pullEl.isConnected || pullEl.firstElementChild)) {
        // Facebook used up the pinned marker: let go of it and pin the next one promptly.
        stopPull();
        clearTimeout(aheadTimer);
        aheadTimer = 0;
        scheduleAhead(60);
      } else {
        scheduleAhead();
      }
      if (menuIsOpen()) {
        // The page changed while a post's "..." menu is open: put our entry in (or back)
        // right away rather than on the next timer tick.
        const menu = openPostMenu();
        if (menu) ensureUnfollowItem(menu);
      }
    }
    if (isReel) scheduleReelTick();
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-posinset'] });

  /* ------------------------------------------------------------------ */
  /* Settings                                                            */
  /* ------------------------------------------------------------------ */

  let settingsSynced = false;   // the saved settings have arrived from the extension
  function applySettings(next) {
    const before = JSON.stringify(settings);
    const feedBefore = settings.homeFeed;
    settings = normalize(next);
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
    const first = !settingsSynced;
    settingsSynced = true;
    // The saved settings have arrived (Facebook clears the copy kept in the page, so at
    // first the defaults were in use): open the chosen home feed if this is the plain home.
    if (first && goChosenFeed()) return;
    if (JSON.stringify(settings) === before) return;
    if (!first && settings.homeFeed !== feedBefore && settings.enabled && location.hash !== MAIN_FEED_HASH &&
        (location.pathname === '/' || location.pathname === '/home.php')) {
      // The home feed choice was changed while a feed is open: go to the newly chosen one,
      // unless that is the feed already open (Friends and Friends + Pages share one).
      const target = FEED_URLS[settings.homeFeed] || '/';
      if (location.pathname + location.search !== target) { location.assign(target); return; }
    }
    refreshAll();
  }

  // Settings or the friends list changed: drop every mark and decide again from scratch.
  function refreshAll() {
    reelGiveUp = false;
    reelEmpty = false;
    shownThisPass = 0;
    lastShownId = null;
    warnedNoFriends = false;
    skippedIds.clear();
    replay = null;
    pendingResume = null;
    dropQueue();
    rqBroken = false;
    try { sessionStorage.removeItem(REPLAY_KEY); } catch (e) { /* ignore */ }
    if (!syncing) notice('');
    try { sessionStorage.removeItem(EMPTY_KEY); } catch (e) { /* ignore */ }
    for (const el of document.querySelectorAll('[data-ffo-card], [data-ffo-hidden]')) {
      el.removeAttribute('data-ffo-card');
      el.removeAttribute('data-ffo-hidden');
    }
    if (!settings.enabled) clearFeedMarks();
    updatePage();
    if (isHome) rescanFeed();
    if (isReel) reelTick();
    pullPausedUntil = 0;
    loadAhead();
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.__ffo !== 'bridge') return;
    if (Array.isArray(d.connected)) for (const id of d.connected) connected.add(String(id));
    if (Array.isArray(d.unfollowed)) {
      unfollowed.clear();
      unfollowedReal.clear();
      for (const u of d.unfollowed) {
        if (!u || !u.id) continue;
        unfollowed.set(String(u.id), String(u.name || ''));
        unfollowedReal.set(String(u.id), u.real === true);
      }
      try { localStorage.setItem(UNF_KEY, JSON.stringify(Array.from(unfollowed.keys()))); } catch (e) { /* ignore */ }
      if (!unfollowedLoaded) {
        // First delivery after a page load: this is the list the page filters with.
        unfollowedLoaded = true;
        const next = new Set(unfollowed.keys());
        const same = next.size === hiddenActors.size && Array.from(next).every((id) => hiddenActors.has(id));
        hiddenActors = next;
        if (!same) refreshAll();
      }
    }
    if (Array.isArray(d.pendingFollow)) {
      pendingFollow = d.pendingFollow.filter((p) => p && p.id).map((p) => ({ id: String(p.id), name: String(p.name || ''), user: p.user !== false }));
      if (pendingFollow.length) setTimeout(processPendingFollows, 2500);
    }
    if (Array.isArray(d.pendingUnfollow)) {
      pendingUnfollow = d.pendingUnfollow.filter((p) => p && p.id).map((p) => ({ id: String(p.id), name: String(p.name || ''), user: p.user !== false }));
      if (pendingUnfollow.length) setTimeout(processPendingFollows, 2500);
    }
    if (Array.isArray(d.reels)) {
      // The stored replay list (on start, or after another tab or the popup changed it).
      library.clear();
      for (const r of d.reels) {
        if (r && r.id) library.set(String(r.id), { id: String(r.id), t: Number(r.t) || 0, o: String(r.o || ''), a: String(r.a || '') });
      }
      for (const r of reelOutbox) library.set(r.id, r);   // not saved yet
      if (isReel) scheduleReelTick(0);
    }
    if (Array.isArray(d.friends)) {
      const before = friends.size;
      friends.clear();
      for (const id of d.friends) friends.add(String(id));
      if (friends.size !== before && settings.reelsMode === 'friends') refreshAll();
    }
    if (d.feedVars && typeof d.feedVars === 'object' && !feedVars) {
      // Remembered from an earlier page load, so the feeds can be asked for before
      // Facebook's own first request of this page load has been seen.
      feedVars = d.feedVars;
      try { feedVarsSaved = JSON.stringify(d.feedVars); } catch (e) { /* ignore */ }
      scheduleMix(0);
    }
    if (d.settings) applySettings(d.settings);
  });

  /* ------------------------------------------------------------------ */
  /* Friends list sync                                                   */
  /* ------------------------------------------------------------------ */
  // The popup's "Sync" button opens facebook.com/friends/list#ffo-sync. On that page the
  // full friends list is in Facebook's store once the list has been scrolled to its end,
  // so this scrolls it and records the ids (plus name, address and picture for the manage
  // page). The manage page's other "Sync" button does the same for the accounts you follow,
  // on facebook.com/me/following#ffo-sync. Nothing leaves the browser.

  const SYNC_HASH = '#ffo-sync';
  let syncRequested = location.hash === SYNC_HASH;

  const personPicture = (src, rec) => {
    for (const k in rec) {
      if (!k.startsWith('profile_picture') && !k.startsWith('image')) continue;
      const pic = deref(src, rec[k]);
      if (pic && typeof pic.uri === 'string') return pic.uri;
    }
    return '';
  };

  function collectFriends(src) {
    const ids = new Set();
    const items = new Map();
    let most = -1;
    let hasNext = null;
    const viewer = viewerRecord(src);
    if (!viewer) return { ids, hasNext };
    for (const k in viewer) {
      if (!k.includes('all_friends')) continue;
      const conn = deref(src, viewer[k]);
      const refs = conn && conn.edges && conn.edges.__refs;
      if (!refs) continue;
      for (const r of refs) {
        const edge = r != null ? src.get(r) : null;
        const node = edge && deref(src, edge.node);
        if (!node || !node.id) continue;
        const id = String(node.id);
        ids.add(id);
        if (!items.has(id)) {
          items.set(id, { id, name: clean(node.name), url: typeof node.url === 'string' ? node.url : '', pic: personPicture(src, node) });
        }
      }
      if (refs.length > most) {
        most = refs.length;
        const page = deref(src, conn.page_info);
        hasNext = page ? page.has_next_page : null;
      }
    }
    return { ids, hasNext, items };
  }

  // The "Following" list on your own profile: [{ id, name, url, pic }]
  function collectFollowing(src) {
    const items = new Map();
    let hasNext = null;
    let found = false;
    for (const recId of src.getRecordIDs()) {
      const col = src.get(recId);
      if (!col || col.__typename !== 'TimelineAppCollection' || col.tab_key !== 'following') continue;
      for (const k in col) {
        if (!k.includes('pageItems')) continue;
        const conn = deref(src, col[k]);
        const refs = conn && conn.edges && conn.edges.__refs;
        if (!refs) continue;
        found = true;
        for (const r of refs) {
          const edge = r != null ? src.get(r) : null;
          const item = edge && deref(src, edge.node);
          const node = item && deref(src, item.node);
          if (!node || !node.id || !/^\d+$/.test(String(node.id))) continue;
          const title = deref(src, item.title);
          const url = field(item, 'url');
          items.set(String(node.id), {
            id: String(node.id),
            name: clean(title && title.text),
            url: typeof url === 'string' ? url : '',
            pic: personPicture(src, item)
          });
        }
        const page = deref(src, conn.page_info);
        hasNext = page ? page.has_next_page : null;
      }
    }
    return { items, hasNext, found };
  }

  function syncFollowing() {
    if (syncing) return;
    syncing = true;
    notice('My Facebook is reading the list of accounts you follow...');
    let rounds = 0;
    let unchanged = 0;
    let lastCount = -1;
    const finish = (items, complete) => {
      syncing = false;
      syncRequested = false;
      notice('');
      window.scrollTo(0, 0);
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* ignore */ }
      if (!items.size) { toast('My Facebook could not read who you follow. Press Sync again to retry.', 8000); return; }
      toBridge('following', { items: Array.from(items.values()), complete });
      toast('Following list synced: ' + items.size + (items.size === 1 ? ' account' : ' accounts') + '. You can close this tab.', 9000);
    };
    const step = () => {
      const src = source();
      const got = src ? collectFollowing(src) : { items: new Map(), hasNext: null, found: false };
      rounds++;
      if (got.items.size === lastCount) unchanged++; else { unchanged = 0; lastCount = got.items.size; }
      if (got.found && got.hasNext === false) { finish(got.items, true); return; }
      if (rounds > 200 || unchanged >= 15) { finish(got.items, false); return; }
      // The list loads its next part when the page is scrolled *to* its end, so back off and return.
      const end = document.documentElement.scrollHeight;
      window.scrollTo(0, Math.max(0, end - window.innerHeight - 600));
      setTimeout(() => { window.scrollTo(0, document.documentElement.scrollHeight); }, 250);
      setTimeout(step, 900);
    };
    setTimeout(step, 1500);
  }

  function friendsListScroller() {
    let best = null;
    let bestLinks = 0;
    for (const d of document.querySelectorAll('div[role="navigation"], div[role="navigation"] div')) {
      if (d.scrollHeight <= d.clientHeight + 50) continue;
      if (!/(auto|scroll)/.test(getComputedStyle(d).overflowY)) continue;
      const links = d.querySelectorAll('a[role="link"]').length;
      if (links > bestLinks) { best = d; bestLinks = links; }
    }
    return best;
  }

  function syncFriends() {
    if (syncing) return;
    syncing = true;
    notice('My Facebook is reading your friends list...');
    let rounds = 0;
    let unchanged = 0;
    let lastCount = -1;
    const finish = (ids, complete, items) => {
      syncing = false;
      syncRequested = false;
      notice('');
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* ignore */ }
      if (!ids.size) { toast('My Facebook could not read your friends list. Press Sync again to retry.', 8000); return; }
      if (complete) friends.clear();
      ids.forEach((id) => friends.add(id));
      toBridge('friends', { ids: Array.from(friends), complete, items: Array.from(items.values()) });
      toast('Friends list synced: ' + friends.size + ' friends. You can close this tab.', 9000);
    };
    const step = () => {
      const src = source();
      const got = src ? collectFriends(src) : { ids: new Set(), hasNext: null, items: new Map() };
      rounds++;
      if (got.ids.size === lastCount) unchanged++; else { unchanged = 0; lastCount = got.ids.size; }
      if (got.ids.size && got.hasNext === false) { finish(got.ids, true, got.items); return; }
      if (rounds > 90 || (got.ids.size && unchanged >= 15)) { finish(got.ids, false, got.items); return; }
      // Facebook loads the next page when the list is scrolled *to* its end, so back off and return.
      const list = friendsListScroller();
      if (list) {
        list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight - 600);
        setTimeout(() => { list.scrollTop = list.scrollHeight; }, 250);
      }
      setTimeout(step, 900);
    };
    setTimeout(step, 1200);
  }

  /* ------------------------------------------------------------------ */
  /* Start                                                               */
  /* ------------------------------------------------------------------ */

  if (reelId()) allowedIds.add(reelId());   // loaded directly on one specific reel
  try {
    const saved = JSON.parse(sessionStorage.getItem(REPLAY_KEY) || 'null');
    if (saved && saved.id === reelId() && now() - saved.at < 20000) pendingResume = saved.id;
  } catch (e) { /* ignore */ }
  if (/^\/reel\/following/.test(location.pathname)) followingSticky = true;
  updatePage();
  toBridge('hello', {});

  if (isReel && (location.pathname === '/reel/' || location.pathname === '/reel')) {
    blockReel(true);
    location.replace(FOLLOWING_URL);
  }
  try {
    const msg = sessionStorage.getItem(TOAST_KEY);
    if (msg) { sessionStorage.removeItem(TOAST_KEY); toast(msg); }
  } catch (e) { /* ignore */ }

  const boot = () => {
    if (isHome) rescanFeed();
    if (isReel) reelTick();
    if (syncRequested && /^\/friends\/list/.test(location.pathname)) syncFriends();
    if (syncRequested && /\/following\/?$/.test(location.pathname)) syncFollowing();
  };
  document.addEventListener('DOMContentLoaded', boot);
  window.addEventListener('load', boot);
  setInterval(() => {
    if (!settings.enabled) return;
    try { onUrl(); } catch (e) { /* ignore */ }
    if (isReel) scheduleReelTick(0);
    if (pendingFollow.length || pendingUnfollow.length) processPendingFollows();
    if (isHome) { mixTick(); scheduleAhead(); }
  }, 1000);
  // Scrolling uses up the posts that were loaded ahead; coming back to the tab resumes loading.
  window.addEventListener('scroll', () => { if (isHome) scheduleAhead(); }, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { if (isHome) { pullPausedUntil = 0; scheduleAhead(0); scheduleWarm(); } });
})();
