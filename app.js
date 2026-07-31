import { NostrP2P, signPayload } from 'lib/nostr-p2p.js?v=10';
import { generateSecretKey, bytesToHex, hexToBytes, nip19, nip44, finalizeEvent, schnorr, sha256 } from 'lib/nostr-deps.js?v=10';
import { openDB } from 'lib/idb.js?v=10';

// ---------------------------------------------------------------- utilities

function escapeHtml(text) {
    if (!text) return '';
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

function timeAgo(timestamp) {
    const s = Math.floor((Date.now() - Number(timestamp)) / 1000);
    if (isNaN(s) || s < 0) return 'just now';
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}

function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i); h |= 0;
    }
    return Math.abs(h);
}

function validNpub(str) {
    try { return typeof str === 'string' && nip19.decode(str).type === 'npub'; }
    catch { return false; }
}

const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------- identity

let nsecHex = localStorage.getItem('pidge_nsec');
let firstRun = false;
if (!nsecHex) {
    nsecHex = bytesToHex(generateSecretKey());
    localStorage.setItem('pidge_nsec', nsecHex);
    firstRun = true;
}

// ---------------------------------------------------------------- database

const db = await openDB('pidge-p2p', 2, {
    upgrade(db, oldVersion) {
        if (oldVersion < 1) {
            const posts = db.createObjectStore('posts', { keyPath: 'key' });
            posts.createIndex('by-author', 'author');
            posts.createIndex('by-ts', 'timestamp');
            const likes = db.createObjectStore('likes', { keyPath: 'key' });
            likes.createIndex('by-post', ['postAuthor', 'postId']);
            db.createObjectStore('profiles', { keyPath: 'npub' });
        }
        if (oldVersion < 2) {
            db.createObjectStore('files', { keyPath: 'id' });
        }
    },
});

// ---------------------------------------------------------------- peers + p2p

const peers = new Set(JSON.parse(localStorage.getItem('pidge_peers') || '[]'));
function savePeers() { localStorage.setItem('pidge_peers', JSON.stringify([...peers])); }

const postElements = new Map();   // post key -> DOM element
let feedFilter = 'following';     // 'following' | 'everything'

const p2p = new NostrP2P(nsecHex, {
    peers,
    open: false,
    onConnect: onPeerConnect,
    onDisconnect: onPeerDisconnect,
    onMessage: onPeerMessage,
});
const myNpub = p2p.npub;

// Debug handle for poking at the internals from the console.
window.__pidge = { p2p };

// Prod the p2p layer back to life whenever the app may have been frozen:
// tab switch, sleep/wake, network restore. Without this, reconnects wait
// out (throttled) timers instead of happening right away.
document.addEventListener('visibilitychange', () => { if (!document.hidden) p2p.resume(); });
window.addEventListener('focus', () => p2p.resume());
window.addEventListener('online', () => p2p.resume());
window.addEventListener('pageshow', () => p2p.resume());

// Sign an app payload the same way the library does, so we can store the
// signed envelope ('raw') and gossip it later with the original signature.
function signMsg(payload) {
    const msg = { ...payload, sender: myNpub };
    // The wire format drops undefined keys (JSON) but the library's canonical
    // signing form keeps them — strip them so signatures verify after send.
    for (const k of Object.keys(msg)) if (msg[k] === undefined) delete msg[k];
    msg.signature = signPayload(msg, nsecHex);
    return msg;
}

function gossip(raw, exceptNpub) {
    try { p2p.broadcast(raw, exceptNpub ? [exceptNpub] : []); } catch { /* no peers yet */ }
}

// ---------------------------------------------------------------- profiles

const profileCache = new Map();   // npub -> profile record

async function loadProfiles() {
    for (const p of await db.getAll('profiles')) profileCache.set(p.npub, p);
    if (!profileCache.has(myNpub)) {
        const raw = signMsg({ type: 'profile', username: '', avatarUrl: '', bio: '', timestamp: Date.now() });
        const me = { npub: myNpub, username: '', avatarUrl: '', bio: '', timestamp: raw.timestamp, raw };
        await db.put('profiles', me);
        profileCache.set(myNpub, me);
    }
}

function getProfile(npub) {
    return profileCache.get(npub) || null;
}

function displayName(npub) {
    const p = getProfile(npub);
    return (p && p.username) ? p.username : npub.slice(0, 8);
}

async function handleProfile(npub, msg) {
    const existing = profileCache.get(msg.sender);
    if (existing && existing.timestamp >= msg.timestamp) return;
    const rec = {
        npub: msg.sender,
        username: String(msg.username || '').slice(0, 40),
        avatarUrl: String(msg.avatarUrl || ''),
        bio: String(msg.bio || '').slice(0, 160),
        timestamp: msg.timestamp,
        raw: msg,
    };
    await db.put('profiles', rec);
    profileCache.set(msg.sender, rec);
    refreshAuthorNodes(msg.sender);
    renderPeerList();
    if (msg.sender === myNpub) renderComposerAvatar();
    gossip(msg, npub);
}

function refreshAuthorNodes(npub) {
    const name = displayName(npub);
    document.querySelectorAll(`[data-author]`).forEach(el => {
        if (el.dataset.author === npub && el.classList.contains('post-author')) {
            el.textContent = name;
            el.classList.remove('unknown');
        }
        if (el.dataset.author === npub && el.classList.contains('post-avatar')) {
            paintAvatar(el, npub);
        }
    });
}

function paintAvatar(el, npub) {
    const p = getProfile(npub);
    if (p && p.avatarUrl) {
        el.style.backgroundColor = '';
        el.innerHTML = `<img src="${escapeHtml(p.avatarUrl)}" alt="" onerror="this.remove()">`;
    } else {
        el.style.backgroundColor = `hsl(${hashCode(npub) % 360}, 60%, 70%)`;
        el.innerHTML = '';
    }
}

// ---------------------------------------------------------------- posts

function postKey(author, id) { return `${author}|${id}`; }

async function storePost(msg) {
    const key = postKey(msg.sender, msg.id);
    if (await db.get('posts', key)) return null;
    const rec = {
        key,
        author: msg.sender,
        id: msg.id,
        content: String(msg.content || '').slice(0, 2000),
        imageUrl: String(msg.imageUrl || ''),
        file: msg.file && msg.file.id ? {
            id: String(msg.file.id).slice(0, 40),
            name: String(msg.file.name || 'file').slice(0, 200),
            size: Number(msg.file.size) || 0,
            type: String(msg.file.type || 'application/octet-stream').slice(0, 100),
        } : null,
        timestamp: Number(msg.timestamp) || Date.now(),
        replyTo: msg.replyTo && msg.replyTo.author && msg.replyTo.id ? {
            author: String(msg.replyTo.author),
            id: String(msg.replyTo.id).slice(0, 40),
        } : null,
        raw: msg,
    };
    await db.put('posts', rec);
    noteReply(rec);
    return rec;
}

// ---------------------------------------------------------------- replies
// A reply is an ordinary signed post carrying replyTo {author, id} — it
// gossips, syncs, and is liked exactly like any other post. replyMap tracks
// parent -> replies for counts; rebuilt on full feed renders.

const replyMap = new Map(); // parent postKey -> Set of reply postKeys

function noteReply(post) {
    if (!post.replyTo) return;
    const parentKey = postKey(post.replyTo.author, post.replyTo.id);
    if (!replyMap.has(parentKey)) replyMap.set(parentKey, new Set());
    replyMap.get(parentKey).add(post.key);
}

function refreshReplyUI(post) {
    const el = postElements.get(post.key);
    if (!el) return;
    const count = replyMap.get(post.key)?.size || 0;
    const span = el.querySelector('.reply-count');
    if (span) span.textContent = count;
}

async function refreshParentReplyCount(post) {
    if (!post.replyTo) return;
    const parent = await db.get('posts', postKey(post.replyTo.author, post.replyTo.id));
    if (parent) refreshReplyUI(parent);
}

// Feed rules:
//  - Following: posts by me and my peers.
//  - Everything: only posts reposted (liked) by my peers or by me — a
//    discovery feed of what the flock is boosting, not a firehose.
function passesFilter(post, likeMap) {
    if (feedFilter === 'following') return post.author === myNpub || peers.has(post.author);
    const likers = likeMap ? likeMap.get(post.key) : null;
    if (!likers) return false;
    for (const liker of likers) {
        if (liker === myNpub || peers.has(liker)) return true;
    }
    return false;
}

async function renderPost(post, likeMap = null) {
    if (postElements.has(post.key)) return;
    if (feedFilter === 'everything' && !likeMap) {
        const likes = await db.getAllFromIndex('likes', 'by-post', [post.author, post.id]);
        likeMap = new Map([[post.key, new Set(likes.map(l => l.liker))]]);
    }
    if (!passesFilter(post, likeMap)) return;
    const feed = document.getElementById('feed-content');
    const el = document.createElement('article');
    el.className = 'post';
    el.dataset.key = post.key;

    const known = !!getProfile(post.author);
    const canAdd = post.author !== myNpub && !peers.has(post.author);
    el.innerHTML = `
        <div class="post-avatar" data-author="${post.author}"></div>
        <div class="post-content">
            <div class="post-header">
                <span class="post-author ${known ? '' : 'unknown'}" data-author="${post.author}">${escapeHtml(displayName(post.author))}</span>
                <span class="post-handle">@${post.author.slice(0, 8)}</span>
                <span class="post-time"> · ${timeAgo(post.timestamp)}</span>
                ${canAdd ? '<button class="add-peer-inline" title="Add this bird as a peer">+ Add</button>' : ''}
            </div>
            ${post.replyTo ? `<div class="reply-context" title="Jump to the original post">↩ Replying to @${escapeHtml(displayName(post.replyTo.author))}</div>` : ''}
            <div class="post-text">${escapeHtml(post.content)}</div>
            ${post.imageUrl ? `<img class="post-image" src="${escapeHtml(post.imageUrl)}" alt="Post image" onerror="this.style.display='none'">` : ''}
            ${post.file ? `
            <div class="file-card" data-file-id="${escapeHtml(post.file.id)}">
                <span class="file-icon">📎</span>
                <span class="file-meta">${escapeHtml(post.file.name)} <span class="file-size">${fmtSize(post.file.size)}</span></span>
                <button class="file-action">…</button>
            </div>` : ''}
            <div class="post-actions">
                <button class="action-button reply-btn" title="Reply"><span class="reply-count">0</span>💬</button>
                <button class="action-button like-btn"><span class="like-count">0</span>Λ</button>
            </div>
        </div>`;
    paintAvatar(el.querySelector('.post-avatar'), post.author);

    // Insert in timestamp order (feed is newest-first).
    let inserted = false;
    for (const child of feed.children) {
        const childKey = child.dataset.key;
        const other = postElements.get(childKey)?._post;
        if (other && other.timestamp < post.timestamp) { feed.insertBefore(el, child); inserted = true; break; }
    }
    if (!inserted) feed.appendChild(el);
    el._post = post;
    postElements.set(post.key, el);

    el.querySelector('.like-btn').addEventListener('click', e => { e.stopPropagation(); toggleLike(post); });
    el.querySelector('.reply-btn').addEventListener('click', e => { e.stopPropagation(); startReply(post); });
    el.querySelector('.reply-context')?.addEventListener('click', e => {
        e.stopPropagation();
        const parentEl = postElements.get(postKey(post.replyTo.author, post.replyTo.id));
        if (parentEl) {
            parentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            parentEl.classList.add('flash');
            setTimeout(() => parentEl.classList.remove('flash'), 1500);
        } else {
            toast('Original post not synced yet.');
        }
    });
    el.querySelector('.post-author').addEventListener('click', e => { e.stopPropagation(); openProfile(post.author); });
    el.querySelector('.post-avatar').addEventListener('click', e => { e.stopPropagation(); openProfile(post.author); });
    el.querySelector('.add-peer-inline')?.addEventListener('click', e => {
        e.stopPropagation();
        addPeer(post.author); // re-renders the feed, replacing the button
    });
    if (post.file) setupFileCard(el, post);

    refreshLikeUI(post);
    refreshReplyUI(post);
    // We heard from this author — ask around for their profile if unknown.
    if (!known && post.author !== myNpub) requestProfile(post.author);
}

async function renderFeed() {
    const feed = document.getElementById('feed-content');
    feed.innerHTML = '';
    postElements.clear();
    const all = await db.getAll('posts');
    all.sort((a, b) => b.timestamp - a.timestamp);
    replyMap.clear();
    for (const post of all) noteReply(post);
    let likeMap = null;
    if (feedFilter === 'everything') {
        likeMap = new Map(); // postKey -> Set of liker npubs
        for (const like of await db.getAll('likes')) {
            const key = postKey(like.postAuthor, like.postId);
            if (!likeMap.has(key)) likeMap.set(key, new Set());
            likeMap.get(key).add(like.liker);
        }
    }
    for (const post of all.slice(0, 300)) renderPost(post, likeMap);
}

// ---------------------------------------------------------------- likes

async function refreshLikeUI(post) {
    const el = postElements.get(post.key);
    if (!el) return;
    const count = await db.countFromIndex('likes', 'by-post', IDBKeyRange.only([post.author, post.id]));
    const liked = !!(await db.get('likes', `${myNpub}|${post.author}|${post.id}`));
    el.querySelector('.like-count').textContent = count;
    el.querySelector('.like-btn').classList.toggle('liked', liked);
}

async function toggleLike(post) {
    const key = `${myNpub}|${post.author}|${post.id}`;
    const existing = await db.get('likes', key);
    if (existing) {
        await db.delete('likes', key);
        gossip(signMsg({ type: 'like', postAuthor: post.author, postId: post.id, remove: true, timestamp: Date.now() }));
    } else {
        const raw = signMsg({ type: 'like', postAuthor: post.author, postId: post.id, timestamp: Date.now() });
        await db.put('likes', { key, liker: myNpub, postAuthor: post.author, postId: post.id, timestamp: raw.timestamp, raw });
        gossip(raw);
        // Liking shares the post with your peers (re-gossip the signed original).
        const full = await db.get('posts', post.key);
        if (full && full.raw && post.author !== myNpub) gossip(full.raw);
    }
    refreshLikeUI(post);
    // Your own likes count as reposts in the Everything view.
    if (feedFilter === 'everything') renderFeed();
}

const requestedPosts = new Set(); // post keys we've already asked for

async function handleLike(npub, msg) {
    if (!msg.postAuthor || !msg.postId) return;
    const key = `${msg.sender}|${msg.postAuthor}|${msg.postId}`;
    const pKey = postKey(msg.postAuthor, msg.postId);
    if (msg.remove) {
        await db.delete('likes', key);
    } else {
        if (await db.get('likes', key)) return;
        await db.put('likes', { key, liker: msg.sender, postAuthor: msg.postAuthor, postId: msg.postId, timestamp: Number(msg.timestamp) || Date.now(), raw: msg });
        gossip(msg, npub);
        // A like is a repost: if we don't have the post it points to, fetch it
        // so it is stored here too.
        if (!(await db.get('posts', pKey)) && !requestedPosts.has(pKey) && npub) {
            requestedPosts.add(pKey);
            try { p2p.send(npub, signMsg({ type: 'post_request', postAuthor: msg.postAuthor, postId: msg.postId, timestamp: Date.now() })); } catch { /* not connected */ }
        }
    }
    const el = postElements.get(pKey);
    if (el) refreshLikeUI(el._post);
    // In Everything view the feed is defined by likes, so refresh it.
    if (feedFilter === 'everything') renderFeed();
}

// ---------------------------------------------------------------- sync + requests

function requestProfile(npub) {
    const msg = signMsg({ type: 'profile_request', request: npub, timestamp: Date.now() });
    // One connected peer is enough; profile replies get gossiped onward.
    const first = p2p.connections.keys().next().value;
    if (first) { try { p2p.send(first, msg); } catch { /* not ready yet */ } }
}

async function lastTsFromAuthor(author) {
    const posts = await db.getAllFromIndex('posts', 'by-author', author);
    return posts.reduce((max, p) => Math.max(max, p.timestamp), 0);
}

async function newestTs() {
    const all = await db.getAll('posts');
    return all.reduce((max, p) => Math.max(max, p.timestamp), 0);
}

// ---------------------------------------------------------------- p2p events

async function onPeerConnect(npub) {
    updatePeerStatus();
    renderPeerList();
    if (knockOutbox.delete(npub)) saveKnocks(); // invite fulfilled

    // Share our profile and every profile we track.
    const me = profileCache.get(myNpub);
    if (me && me.raw) { try { p2p.send(npub, me.raw); } catch { /* ignore */ } }
    for (const p of profileCache.values()) {
        if (p.npub !== myNpub && p.raw) { try { p2p.send(npub, p.raw); } catch { /* ignore */ } }
    }
    // Ask for theirs, in case they have nothing to say yet.
    try { p2p.send(npub, signMsg({ type: 'profile_request', request: npub, timestamp: Date.now() })); } catch { /* ignore */ }

    // Sync: get their posts we missed, and anything new in the flock.
    try { p2p.send(npub, signMsg({ type: 'sync', since: await lastTsFromAuthor(npub) })); } catch { /* ignore */ }
    try { p2p.send(npub, signMsg({ type: 'sync_feed', since: await newestTs() })); } catch { /* ignore */ }
}

function onPeerDisconnect(npub) {
    updatePeerStatus();
    renderPeerList();
}

async function onPeerMessage(npub, msg) {
    try {
        await onPeerMessageInner(npub, msg);
    } catch (e) {
        console.error('onPeerMessage failed for type', msg && msg.type, e);
    }
}

async function onPeerMessageInner(npub, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
        case 'post': {
            const rec = await storePost(msg);
            if (!rec) return; // duplicate
            renderPost(rec);
            if (rec.replyTo) {
                refreshParentReplyCount(rec);
                // A reply points at a post we might not have — fetch it like
                // we do for liked posts, so threads are complete here too.
                const pKey = postKey(rec.replyTo.author, rec.replyTo.id);
                if (!(await db.get('posts', pKey)) && !requestedPosts.has(pKey) && npub) {
                    requestedPosts.add(pKey);
                    try { p2p.send(npub, signMsg({ type: 'post_request', postAuthor: rec.replyTo.author, postId: rec.replyTo.id, timestamp: Date.now() })); } catch { /* not connected */ }
                }
            }
            gossip(msg, npub);
            break;
        }
        case 'like':
            await handleLike(npub, msg);
            break;
        case 'profile':
            await handleProfile(npub, msg);
            break;
        case 'file_request': {
            // Only peers who have stored the file can relay it onward.
            const rec = await db.get('files', msg.fileId);
            if (!rec) break;
            const total = Math.ceil(rec.data.byteLength / FILE_CHUNK) || 1;
            for (let seq = 0; seq < total; seq++) {
                const slice = rec.data.slice(seq * FILE_CHUNK, (seq + 1) * FILE_CHUNK);
                try {
                    p2p.send(npub, { type: 'file_chunk', fileId: msg.fileId, seq, total, data: bufToB64(slice) });
                } catch { break; }
            }
            break;
        }
        case 'file_chunk':
            await handleFileChunk(msg);
            break;
        case 'profile_request': {
            const p = profileCache.get(msg.request);
            if (p && p.raw) { try { p2p.send(npub, p.raw); } catch { /* ignore */ } }
            break;
        }
        case 'sync': {
            // They want OUR posts newer than `since`.
            const mine = await db.getAllFromIndex('posts', 'by-author', myNpub);
            mine.sort((a, b) => b.timestamp - a.timestamp);
            let sent = 0;
            for (const post of mine) {
                if (post.timestamp <= (msg.since || 0) || sent >= 50) continue;
                try { p2p.send(npub, post.raw); sent++; } catch { break; }
            }
            break;
        }
        case 'post_request': {
            // A peer liked/reposted something they heard about from us, but
            // they don't have the post itself — give them our stored copy.
            const post = await db.get('posts', postKey(msg.postAuthor, msg.postId));
            if (post && post.raw) { try { p2p.send(npub, post.raw); } catch { /* ignore */ } }
            break;
        }
        case 'sync_feed': {
            // They want anything newer than `since` — capped, newest first.
            const all = await db.getAll('posts');
            all.sort((a, b) => b.timestamp - a.timestamp);
            let sent = 0;
            const sentKeys = new Set();
            for (const post of all) {
                if (sent >= 50) break;
                if (post.timestamp <= (msg.since || 0)) continue;
                try { p2p.send(npub, post.raw); sent++; sentKeys.add(post.key); } catch { break; }
            }
            // Liked posts are reposts: share them (and the likes) regardless of
            // age, so they sync to peers that missed the original broadcast.
            const myLikes = (await db.getAll('likes')).filter(l => l.liker === myNpub);
            myLikes.sort((a, b) => b.timestamp - a.timestamp);
            for (const like of myLikes.slice(0, 50)) {
                const post = await db.get('posts', postKey(like.postAuthor, like.postId));
                if (post && post.raw && !sentKeys.has(post.key)) {
                    try { p2p.send(npub, post.raw); } catch { break; }
                }
                if (like.raw) { try { p2p.send(npub, like.raw); } catch { break; } }
            }
            break;
        }
    }
}

// ---------------------------------------------------------------- peer UI

function updatePeerStatus() {
    const connecting = [...p2p.sessions.values()].filter(s => s.phase === 'connecting').length;
    document.getElementById('peer-status').textContent =
        `${p2p.connections.size}/${peers.size} peers` + (connecting ? ' (connecting…)' : '');
}

async function renderPeerList() {
    const list = document.getElementById('friend-list');
    if (!list) return;
    list.innerHTML = '';
    for (const npub of peers) {
        const li = document.createElement('li');
        const online = p2p.isConnected(npub);
        li.innerHTML = `
            <span class="peer-name" title="${npub}">${escapeHtml(displayName(npub))}</span>
            <span class="online-dot ${online ? '' : 'offline-dot'}" title="${online ? 'connected' : 'offline'}"></span>
            <button data-remove="${npub}">Remove</button>`;
        li.querySelector('.peer-name').addEventListener('click', () => openProfile(npub));
        li.querySelector('[data-remove]').addEventListener('click', () => removePeer(npub));
        list.appendChild(li);
    }
    if (!peers.size) {
        const li = document.createElement('li');
        li.innerHTML = '<span class="peer-name" style="color:#666;">No peers yet — share your invite link or add an npub.</span>';
        list.appendChild(li);
    }
}

function addPeer(npub, via = 'add') {
    npub = (npub || '').trim();
    if (!validNpub(npub)) { toast('That does not look like an npub.'); return false; }
    if (npub === myNpub) { toast('That is you!'); return false; }
    if (peers.has(npub)) { toast('Peer already added.'); return false; }
    peers.add(npub);
    savePeers();
    p2p.addPeer(npub);
    requestProfile(npub);
    renderPeerList();
    updatePeerStatus();
    renderFeed(); // their stored posts now belong in the Following feed
    // Peering is mutual — knock so they get a prompt to add us back.
    if (!p2p.isConnected(npub)) sendInviteKnock(npub, via);
    toast('Peer added — invite sent, connecting once they accept.');
    return true;
}

async function removePeer(npub) {
    peers.delete(npub);
    savePeers();
    p2p.removePeer(npub);
    renderPeerList();
    updatePeerStatus();
    renderFeed();
}

// ---------------------------------------------------------------- profile modal

let profileViewNpub = null;

async function openProfile(npub) {
    profileViewNpub = npub;
    const p = getProfile(npub);
    document.getElementById('profile-view-name').textContent = displayName(npub);
    document.getElementById('profile-view-handle').textContent = `@${npub.slice(0, 12)}…`;
    document.getElementById('profile-view-bio').textContent = p ? p.bio : '';
    document.getElementById('profile-view-npub').textContent = npub;
    paintAvatar(document.getElementById('profile-view-avatar'), npub);

    const btn = document.getElementById('profile-view-peer-btn');
    if (npub === myNpub) {
        btn.textContent = 'This is you';
        btn.disabled = true;
    } else {
        btn.disabled = false;
        btn.textContent = peers.has(npub) ? 'Remove Peer' : 'Add Peer';
    }

    const postsEl = document.getElementById('profile-view-posts');
    postsEl.innerHTML = '';
    const posts = await db.getAllFromIndex('posts', 'by-author', npub);
    posts.sort((a, b) => b.timestamp - a.timestamp);
    for (const post of posts.slice(0, 20)) {
        const el = document.createElement('article');
        el.className = 'post';
        el.innerHTML = `
            <div class="post-content">
                <div class="post-header">
                    <span class="post-time">${timeAgo(post.timestamp)}</span>
                </div>
                <div class="post-text">${escapeHtml(post.content)}</div>
                ${post.imageUrl ? `<img class="post-image" src="${escapeHtml(post.imageUrl)}" alt="" onerror="this.style.display='none'">` : ''}
            </div>`;
        postsEl.appendChild(el);
    }
    document.getElementById('profile-modal').classList.add('active');
}

document.getElementById('profile-view-peer-btn').addEventListener('click', () => {
    if (!profileViewNpub || profileViewNpub === myNpub) return;
    if (peers.has(profileViewNpub)) removePeer(profileViewNpub);
    else addPeer(profileViewNpub);
    document.getElementById('profile-view-peer-btn').textContent =
        peers.has(profileViewNpub) ? 'Remove Peer' : 'Add Peer';
});

// ---------------------------------------------------------------- settings modal

function openSettings() {
    const me = getProfile(myNpub) || {};
    document.getElementById('user-id').textContent = myNpub;
    document.getElementById('profile-name').value = me.username || '';
    document.getElementById('profile-avatar').value = me.avatarUrl || '';
    showAvatarPreview(me.avatarUrl || '');
    document.getElementById('profile-bio').value = me.bio || '';
    try {
        const stored = JSON.parse(localStorage.getItem('nostr_p2p_relays') || 'null');
        if (stored) document.getElementById('relays-input').value = stored.join('\n');
    } catch { /* defaults */ }
    try {
        const turn = JSON.parse(localStorage.getItem('nostr_p2p_turn') || 'null');
        document.getElementById('turn-url').value = turn?.urls || '';
        document.getElementById('turn-username').value = turn?.username || '';
        document.getElementById('turn-credential').value = turn?.credential || '';
    } catch { /* defaults */ }
    renderPeerList();
    renderInviteList();
    document.getElementById('settings-modal').classList.add('active');
}

document.getElementById('settings-button').addEventListener('click', openSettings);
document.getElementById('header-settings-btn').addEventListener('click', openSettings);

document.querySelectorAll('.close-modal').forEach(btn =>
    btn.addEventListener('click', () => document.getElementById(btn.dataset.close).classList.remove('active')));
document.querySelectorAll('.modal').forEach(modal =>
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('active'); }));

document.getElementById('save-profile').addEventListener('click', async () => {
    const username = document.getElementById('profile-name').value.trim();
    const avatarUrl = document.getElementById('profile-avatar').value.trim();
    const bio = document.getElementById('profile-bio').value.trim();
    const raw = signMsg({ type: 'profile', username, avatarUrl, bio, timestamp: Date.now() });
    await handleProfile(null, raw); // stores, caches, paints, and gossips it
    toast('Profile saved and shared with peers.');
});

document.getElementById('add-friend-btn').addEventListener('click', () => {
    const input = document.getElementById('add-friend-input');
    if (addPeer(input.value)) input.value = '';
});

document.getElementById('copy-id').addEventListener('click', async () => {
    await navigator.clipboard.writeText(myNpub);
    toast('Pidge ID copied.');
});

document.getElementById('copy-link').addEventListener('click', async () => {
    await navigator.clipboard.writeText(`${location.origin}${location.pathname}?add=${myNpub}`);
    toast('Invite link copied.');
});

document.getElementById('show-nsec').addEventListener('click', () => {
    const field = document.getElementById('nsec-display');
    field.style.display = 'block';
    field.value = nip19.nsecEncode(hexToBytes(nsecHex));
    field.select();
});

document.getElementById('import-nsec-btn').addEventListener('click', () => {
    const val = document.getElementById('nsec-import').value.trim();
    try {
        const decoded = nip19.decode(val);
        if (decoded.type !== 'nsec') throw new Error('not nsec');
        if (!confirm('Replace your current identity? Your posts stay, but you will post as the new identity.')) return;
        localStorage.setItem('pidge_nsec', bytesToHex(decoded.data));
        location.reload();
    } catch {
        toast('Invalid nsec key.');
    }
});

document.getElementById('save-relays').addEventListener('click', () => {
    const lines = document.getElementById('relays-input').value
        .split('\n').map(s => s.trim()).filter(s => s.startsWith('ws'));
    if (lines.length) localStorage.setItem('nostr_p2p_relays', JSON.stringify(lines));
    else localStorage.removeItem('nostr_p2p_relays');
    location.reload();
});

document.getElementById('save-turn').addEventListener('click', () => {
    const urls = document.getElementById('turn-url').value.trim();
    const username = document.getElementById('turn-username').value.trim();
    const credential = document.getElementById('turn-credential').value.trim();
    if (!urls) {
        localStorage.removeItem('nostr_p2p_turn');
        location.reload();
        return;
    }
    if (!/^turns?:/.test(urls)) {
        toast('TURN URL must start with turn: or turns:');
        return;
    }
    const turn = { urls };
    if (username) turn.username = username;
    if (credential) turn.credential = credential;
    localStorage.setItem('nostr_p2p_turn', JSON.stringify(turn));
    location.reload();
});

// ---------------------------------------------------------------- composer

function renderComposerAvatar() {
    paintAvatar(document.getElementById('composer-avatar'), myNpub);
}

const postText = document.getElementById('post-text');
postText.addEventListener('input', () => {
    document.getElementById('char-count').textContent = `${postText.value.length}/280`;
});

// --- replies ------------------------------------------------------------
// Replying targets the composer at a post: the signed post carries
// replyTo {author, id} and otherwise behaves like any other post.
let pendingReply = null; // {author, id}

function startReply(post) {
    pendingReply = { author: post.author, id: post.id };
    document.getElementById('reply-bar-text').textContent =
        `Replying to @${displayName(post.author)}: ${post.content.slice(0, 60)}${post.content.length > 60 ? '…' : ''}`;
    document.getElementById('reply-bar').style.display = 'flex';
    postText.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearReply() {
    pendingReply = null;
    document.getElementById('reply-bar').style.display = 'none';
}

document.getElementById('reply-cancel').addEventListener('click', clearReply);

// --- image attachments -------------------------------------------------
// Images are downscaled to a WebRTC-safe size and embedded as data URLs in
// the signed post itself, so they sync and gossip like any other content.
const MAX_IMAGE_CHARS = 140000; // ~100KB binary — safe for datachannel messages
const MAX_AVATAR_CHARS = 40000; // avatars gossip inside profiles — keep small
const imageUrlInput = document.getElementById('post-image-url');
const imagePreviewRow = document.getElementById('image-preview-row');
const imagePreview = document.getElementById('image-preview');

function fileToDataUrl(file, maxDim = 900, maxChars = MAX_IMAGE_CHARS) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            let scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            let quality = 0.85;
            for (let attempt = 0; attempt < 6; attempt++) {
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                if (dataUrl.length <= maxChars) return resolve(dataUrl);
                scale *= 0.7;
                quality = Math.max(0.4, quality - 0.15);
            }
            reject(new Error('image too large'));
        };
        img.onerror = reject;
        img.src = url;
    });
}

function showImagePreview(dataUrl) {
    imagePreview.src = dataUrl;
    imagePreviewRow.style.display = dataUrl ? 'flex' : 'none';
}

document.getElementById('post-image-btn').addEventListener('click', () =>
    document.getElementById('post-image-file').click());

document.getElementById('post-image-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
        const dataUrl = await fileToDataUrl(file);
        imageUrlInput.value = dataUrl;
        showImagePreview(dataUrl);
    } catch {
        toast('Could not attach that image (too large?).');
    }
});

document.getElementById('image-remove').addEventListener('click', () => {
    imageUrlInput.value = '';
    showImagePreview('');
});

imageUrlInput.addEventListener('input', () => {
    const v = imageUrlInput.value.trim();
    showImagePreview(v.startsWith('data:image') || v.startsWith('http') ? v : '');
});

// --- avatar upload ------------------------------------------------------
const avatarInput = document.getElementById('profile-avatar');
const avatarPreviewRow = document.getElementById('avatar-preview-row');
const avatarPreview = document.getElementById('avatar-preview');

function showAvatarPreview(v) {
    if (v && (v.startsWith('data:image') || v.startsWith('http'))) {
        avatarPreview.src = v;
        avatarPreviewRow.style.display = 'block';
    } else {
        avatarPreviewRow.style.display = 'none';
    }
}

document.getElementById('avatar-upload-btn').addEventListener('click', () =>
    document.getElementById('avatar-file').click());

document.getElementById('avatar-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
        const dataUrl = await fileToDataUrl(file, 128, MAX_AVATAR_CHARS);
        avatarInput.value = dataUrl;
        showAvatarPreview(dataUrl);
    } catch {
        toast('Could not use that image.');
    }
});

avatarInput.addEventListener('input', () => showAvatarPreview(avatarInput.value.trim()));

// --- file attachments ---------------------------------------------------
// Files never travel automatically: a post carries only file metadata.
// Peers request the content explicitly; once they store it, they can save
// it to disk AND serve it to other peers (pull-based relay).
const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const FILE_CHUNK = 12000;          // bytes per datachannel chunk
let pendingFile = null;            // file meta attached to the next post
const activeFetches = new Map();   // fileId -> fetch state

function fmtSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(s);
}

function b64ToBuf(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
}

function clearPendingFile() {
    pendingFile = null;
    document.getElementById('file-chip-row').style.display = 'none';
}

document.getElementById('post-file-btn').addEventListener('click', () =>
    document.getElementById('post-file-file').click());

document.getElementById('post-file-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) { toast('File too large (max 1 MB).'); return; }
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const type = file.type || 'application/octet-stream';
    const data = await file.arrayBuffer();
    await db.put('files', { id, name: file.name, type, size: file.size, data });
    pendingFile = { id, name: file.name, size: file.size, type };
    document.getElementById('file-chip').textContent = `📎 ${file.name} (${fmtSize(file.size)})`;
    document.getElementById('file-chip-row').style.display = 'flex';
});

document.getElementById('file-remove').addEventListener('click', clearPendingFile);

async function saveFileToDisk(fileId) {
    const rec = await db.get('files', fileId);
    if (!rec) return;
    const blob = new Blob([rec.data], { type: rec.type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = rec.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function setupFileCard(el, post) {
    const card = el.querySelector('.file-card');
    if (!card) return;
    const btn = card.querySelector('.file-action');
    btn.style.display = '';
    const have = await db.get('files', post.file.id);
    if (have) {
        btn.textContent = 'Save';
        btn.onclick = (e) => { e.stopPropagation(); saveFileToDisk(post.file.id); };
    } else {
        btn.textContent = 'Fetch';
        btn.onclick = (e) => { e.stopPropagation(); requestFile(post, card); };
    }
}

async function requestFile(post, card) {
    const f = post.file;
    if (activeFetches.has(f.id)) return;
    const msg = { type: 'file_request', fileId: f.id, timestamp: Date.now() };
    let sent = 0;
    // Anyone storing the file may serve it — ask the author first, then the flock.
    if (p2p.isConnected(post.author)) { try { p2p.send(post.author, msg); sent++; } catch { /* skip */ } }
    for (const npub of p2p.connections.keys()) {
        if (npub === post.author) continue;
        try { p2p.send(npub, msg); sent++; } catch { /* skip */ }
    }
    if (!sent) { toast('No connected peers to fetch the file from.'); return; }
    const btn = card.querySelector('.file-action');
    btn.style.display = 'none';
    const prog = document.createElement('span');
    prog.className = 'file-progress';
    prog.textContent = 'requested…';
    card.appendChild(prog);
    const state = { chunks: [], received: 0, total: -1, post, card, prog };
    state.timer = setTimeout(() => {
        activeFetches.delete(f.id);
        prog.remove();
        btn.style.display = '';
        toast('File fetch timed out — try again when more peers are online.');
    }, 45000);
    activeFetches.set(f.id, state);
}

async function handleFileChunk(msg) {
    const ft = activeFetches.get(msg.fileId);
    if (!ft) return;
    if (ft.total < 0) ft.total = msg.total;
    if (msg.total !== ft.total || msg.seq < 0 || msg.seq >= ft.total) return;
    if (!ft.chunks[msg.seq]) {
        ft.chunks[msg.seq] = msg.data;
        ft.received++;
        ft.prog.textContent = `${Math.round(ft.received / ft.total * 100)}%`;
    }
    if (ft.received < ft.total) return;
    clearTimeout(ft.timer);
    activeFetches.delete(msg.fileId);
    const parts = [];
    for (let i = 0; i < ft.total; i++) parts.push(b64ToBuf(ft.chunks[i]));
    const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
    let off = 0;
    for (const b of parts) { out.set(b, off); off += b.length; }
    await db.put('files', {
        id: msg.fileId,
        name: ft.post.file.name,
        type: ft.post.file.type,
        size: ft.post.file.size,
        data: out.buffer,
    });
    ft.prog.remove();
    const el = postElements.get(ft.post.key);
    if (el) setupFileCard(el, ft.post);
    toast('File stored — you can now save it and relay it to peers.');
}

document.getElementById('post-button').addEventListener('click', async () => {
    const content = postText.value.trim();
    const imageUrl = document.getElementById('post-image-url').value.trim();
    if (!content) return;
    const raw = signMsg({
        type: 'post',
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        content,
        imageUrl,
        ...(pendingFile ? { file: pendingFile } : {}),
        ...(pendingReply ? { replyTo: { author: pendingReply.author, id: pendingReply.id } } : {}),
        timestamp: Date.now(),
    });
    const rec = await storePost(raw);
    if (rec) { renderPost(rec); refreshParentReplyCount(rec); }
    gossip(raw);
    postText.value = '';
    imageUrlInput.value = '';
    showImagePreview('');
    clearPendingFile();
    clearReply();
    document.getElementById('char-count').textContent = '0/280';
});

// ---------------------------------------------------------------- feed filter

document.querySelectorAll('.filter-btn').forEach(btn =>
    btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        feedFilter = btn.dataset.filter;
        renderFeed();
    }));

// ---------------------------------------------------------------- invites
// Opening someone's invite link sends them a signed, NIP-44-encrypted
// "knock" over the relays (kind 4, so relays store it for offline owners).
// The owner gets a prompt to add the knocker back — making the peering
// mutual, which is what the WebRTC layer requires to connect.

const INVITE_KIND = 4;
const pendingInvites = new Map(JSON.parse(localStorage.getItem('pidge_invites') || '[]')); // npub -> {ts, via}
function saveInvites() { localStorage.setItem('pidge_invites', JSON.stringify([...pendingInvites])); }

// Invites we declined — future knocks from them are dropped silently.
const ignoredInvites = new Set(JSON.parse(localStorage.getItem('pidge_ignored_invites') || '[]'));
function saveIgnored() { localStorage.setItem('pidge_ignored_invites', JSON.stringify([...ignoredInvites])); }

// Outbox: knocks are re-published until the peer actually connects, so an
// offline recipient still gets the invite (relays store kind 4 for later).
const knockOutbox = new Map(JSON.parse(localStorage.getItem('pidge_knocks') || '[]')); // npub -> {via, first, last}
function saveKnocks() { localStorage.setItem('pidge_knocks', JSON.stringify([...knockOutbox])); }
const KNOCK_TTL = 7 * 24 * 3600 * 1000; // matches the invite subscription window

// Local nostr-event verification (id + schnorr signature), same scheme the
// p2p library uses for its auth events — avoids needing extra exports from
// nostr-deps.js.
function verifyNostrEvent(event) {
    try {
        const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
        const id = bytesToHex(sha256(new TextEncoder().encode(serialized)));
        if (id !== event.id) return false;
        return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
    } catch { return false; }
}

async function publishKnock(ownerNpub) {
    const rec = knockOutbox.get(ownerNpub);
    if (!rec) return;
    try {
        const ownerPk = nip19.decode(ownerNpub).data;
        const ck = nip44.getConversationKey(hexToBytes(nsecHex), ownerPk);
        const me = getProfile(myNpub) || {};
        const content = nip44.encrypt(JSON.stringify({
            type: 'pidge-invite',
            via: rec.via,
            t: rec.first,
            // Who's knocking — shown in the recipient's invite prompt.
            profile: {
                username: me.username || '',
                avatarUrl: me.avatarUrl || '',
                bio: me.bio || '',
            },
        }), ck);
        const event = finalizeEvent({
            kind: INVITE_KIND,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', ownerPk]],
            content,
        }, hexToBytes(nsecHex));
        await Promise.allSettled(p2p.pool.publish(p2p.relays, event));
        rec.last = Date.now();
        saveKnocks();
    } catch (e) { console.warn('invite knock failed', e); }
}

function sendInviteKnock(ownerNpub, via = 'add') {
    const existing = knockOutbox.get(ownerNpub);
    knockOutbox.set(ownerNpub, { via, first: existing ? existing.first : Date.now(), last: 0 });
    saveKnocks();
    publishKnock(ownerNpub);
}

// Re-publish outstanding knocks until the peer connects (or the invite ages
// out). Covers offline recipients, failed first publishes, and closed tabs.
function flushKnockOutbox() {
    let changed = false;
    for (const [npub, rec] of knockOutbox) {
        if ((peers.has(npub) && p2p.isConnected(npub)) || Date.now() - rec.first > KNOCK_TTL) {
            knockOutbox.delete(npub);
            changed = true;
            continue;
        }
        publishKnock(npub);
    }
    if (changed) saveKnocks();
}
setInterval(flushKnockOutbox, 60 * 1000);
setTimeout(flushKnockOutbox, 8000); // first flush once relay sockets are warm

let inviteSub = null;
function subscribeInvites() {
    try { inviteSub?.close(); } catch { /* ignore */ }
    try {
        inviteSub = p2p.pool.subscribeMany(
            p2p.relays,
            { kinds: [INVITE_KIND], '#p': [p2p.pk], since: Math.floor(Date.now() / 1000) - 7 * 24 * 3600 },
            { onevent: handleInviteEvent },
        );
    } catch { /* retry on next tick */ }
}
setInterval(subscribeInvites, 30 * 1000);

function handleInviteEvent(event) {
    if (!verifyNostrEvent(event)) return;
    let payload;
    try {
        const ck = nip44.getConversationKey(hexToBytes(nsecHex), event.pubkey);
        payload = JSON.parse(nip44.decrypt(event.content, ck));
    } catch { return; } // not for us / not a pidge invite
    if (!payload || payload.type !== 'pidge-invite') return;
    const npub = nip19.npubEncode(event.pubkey);
    if (npub === myNpub || peers.has(npub) || pendingInvites.has(npub) || ignoredInvites.has(npub)) return;
    const p = payload.profile && typeof payload.profile === 'object' ? payload.profile : null;
    pendingInvites.set(npub, {
        ts: Date.now(),
        via: payload.via === 'link' ? 'link' : 'add',
        profile: p ? {
            username: String(p.username || '').slice(0, 40),
            avatarUrl: String(p.avatarUrl || ''),
            bio: String(p.bio || '').slice(0, 160),
        } : null,
    });
    saveInvites();
    renderInviteList();
    showInvitePrompt(npub);
}

let invitePromptNpub = null;
function showInvitePrompt(npub) {
    // Already peers (added them ourselves since the knock) — drop the invite.
    if (peers.has(npub)) {
        pendingInvites.delete(npub);
        saveInvites();
        renderInviteList();
        return;
    }
    // Don't stack prompts — queue via the pending list; show one at a time.
    if (document.getElementById('invite-modal').classList.contains('active')) return;
    invitePromptNpub = npub;
    const rec = pendingInvites.get(npub);
    const via = (rec && typeof rec === 'object') ? rec.via : 'link'; // legacy entries were timestamps
    const invProfile = (rec && typeof rec === 'object') ? rec.profile : null;
    const action = via === 'link' ? 'used your invite link' : 'added you as a peer';
    // Show who is knocking: name, avatar and bio from the invite itself.
    document.getElementById('invite-name').textContent =
        (invProfile && invProfile.username) || displayName(npub);
    document.getElementById('invite-bio').textContent = (invProfile && invProfile.bio) || '';
    const avatarEl = document.getElementById('invite-avatar');
    if (invProfile && invProfile.avatarUrl) {
        avatarEl.style.backgroundColor = '';
        avatarEl.innerHTML = `<img src="${escapeHtml(invProfile.avatarUrl)}" alt="" onerror="this.remove()">`;
    } else {
        avatarEl.style.backgroundColor = `hsl(${hashCode(npub) % 360}, 60%, 70%)`;
        avatarEl.innerHTML = '';
    }
    document.getElementById('invite-text').textContent =
        `${npub.slice(0, 16)}… ${action} and wants to connect. Add them back?`;
    document.getElementById('invite-modal').classList.add('active');
}

function resolveInvite(npub, accept) {
    pendingInvites.delete(npub);
    saveInvites();
    renderInviteList();
    if (accept) {
        addPeer(npub);
        toast('Peer added — connecting…');
    } else {
        ignoredInvites.add(npub); // don't nag about future knocks from them
        saveIgnored();
    }
    document.getElementById('invite-modal').classList.remove('active');
    invitePromptNpub = null;
    // Show the next queued invite that we haven't already peered with.
    for (const next of pendingInvites.keys()) {
        if (!peers.has(next)) { setTimeout(() => showInvitePrompt(next), 300); break; }
    }
}

document.getElementById('invite-accept').addEventListener('click', () => resolveInvite(invitePromptNpub, true));
document.getElementById('invite-ignore').addEventListener('click', () => resolveInvite(invitePromptNpub, false));

function renderInviteList() {
    const section = document.getElementById('invites-section');
    const list = document.getElementById('invite-list');
    if (!section || !list) return;
    list.innerHTML = '';
    section.style.display = pendingInvites.size ? 'block' : 'none';
    for (const [npub, rec] of pendingInvites) {
        if (peers.has(npub)) { pendingInvites.delete(npub); saveInvites(); continue; }
        const invProfile = (rec && typeof rec === 'object') ? rec.profile : null;
        const name = (invProfile && invProfile.username) || displayName(npub);
        const li = document.createElement('li');
        li.innerHTML = `
            <span class="invite-name" title="${escapeHtml((invProfile && invProfile.bio) || npub)}">${escapeHtml(name)} · ${npub.slice(0, 16)}…</span>
            <button data-act="add">Add</button>
            <button data-act="ignore">Ignore</button>`;
        li.querySelector('[data-act="add"]').addEventListener('click', () => resolveInvite(npub, true));
        li.querySelector('[data-act="ignore"]').addEventListener('click', () => resolveInvite(npub, false));
        list.appendChild(li);
    }
}

// ---------------------------------------------------------------- boot

await loadProfiles();
renderComposerAvatar();
await renderFeed();
renderPeerList();
updatePeerStatus();
setInterval(updatePeerStatus, 5000);

// Invite links: ?add=npub1...
const invite = new URLSearchParams(location.search).get('add');
if (invite && validNpub(invite) && invite !== myNpub && !peers.has(invite)) {
    addPeer(invite, 'link');
    history.replaceState(null, '', location.pathname);
    toast('Peer added from invite link — asking them to add you back.');
}

// Listen for invite knocks addressed to us, and surface any stored ones.
subscribeInvites();
renderInviteList();
{
    const firstPending = pendingInvites.keys().next().value;
    if (firstPending && !peers.has(firstPending)) showInvitePrompt(firstPending);
}

if (firstRun) {
    toast('Welcome to Pidge! A fresh identity was created — set your profile in ⚙ Settings.');
    openSettings();
}
