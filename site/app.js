  import { joinRoom } from 'https://esm.run/trystero';

  // ---------- Version / Migration ----------
  const APP_VERSION = 2;
  if (parseInt(localStorage.getItem('pidge_version') || '0') !== APP_VERSION) {
    ['pidge_id','pidge_privateKey','pidge_publicKey','pidge_friends','pidge_postCache',
     'pidge_profiles','pidge_friendLastSeen','pidge_pendingFriendReqs','pidge_propagated']
      .forEach(k => localStorage.removeItem(k));
    localStorage.setItem('pidge_version', String(APP_VERSION));
  }

  // ---------- Crypto Helpers ----------
  function ab2hex(buf) {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function hex2ab(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    return bytes.buffer;
  }
  function canonicalJson(obj) {
    if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
    if (typeof obj === 'object' && obj !== null) {
      const keys = Object.keys(obj).sort();
      return '{' + keys.map(k => `"${k}":${canonicalJson(obj[k])}`).join(',') + '}';
    }
    return JSON.stringify(obj);
  }
  async function signPayload(payload, privateKey) {
    const data = new TextEncoder().encode(canonicalJson(payload));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
    return ab2hex(sig);
  }
  async function verifyPayload(payload, sigHex, publicKey) {
    const data = new TextEncoder().encode(canonicalJson(payload));
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, hex2ab(sigHex), data);
  }
  async function importPublicKey(jwk) {
    return await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  }
  async function deriveIdFromPublicKey(publicKey) {
    const spki = await crypto.subtle.exportKey('spki', publicKey);
    const hash = await crypto.subtle.digest('SHA-256', spki);
    return ab2hex(hash);
  }

  // ---------- Identity ----------
  const IDENTITY = await (async () => {
    let privJwk = localStorage.getItem('pidge_privateKey');
    let pubJwk = localStorage.getItem('pidge_publicKey');
    let id = localStorage.getItem('pidge_id');

    if (!privJwk || !pubJwk || !id) {
      const keypair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const priv = JSON.stringify(await crypto.subtle.exportKey('jwk', keypair.privateKey));
      const pub = JSON.stringify(await crypto.subtle.exportKey('jwk', keypair.publicKey));
      const publicKey = await importPublicKey(JSON.parse(pub));
      id = await deriveIdFromPublicKey(publicKey);
      localStorage.setItem('pidge_id', id);
      localStorage.setItem('pidge_privateKey', priv);
      localStorage.setItem('pidge_publicKey', pub);
      return { id, privateKey: keypair.privateKey, publicKey, publicJwk: JSON.parse(pub) };
    }

    const privateKey = await crypto.subtle.importKey('jwk', JSON.parse(privJwk), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const publicKey = await importPublicKey(JSON.parse(pubJwk));
    const derived = await deriveIdFromPublicKey(publicKey);
    if (derived !== id) {
      localStorage.clear(); location.reload();
    }
    return { id, privateKey, publicKey, publicJwk: JSON.parse(pubJwk) };
  })();

  const USER_ID = IDENTITY.id;

  // ---------- Profile System ----------
  let myProfile = JSON.parse(localStorage.getItem('pidge_myProfile') || '{}');
  const profileCache = new Map(JSON.parse(localStorage.getItem('pidge_profiles') || '[]'));
  function saveMyProfile() { localStorage.setItem('pidge_myProfile', JSON.stringify(myProfile)); }
  function cacheProfile(userId, profile) { profileCache.set(userId, { ...profile, userId }); localStorage.setItem('pidge_profiles', JSON.stringify([...profileCache])); }
  function getProfile(userId) { return profileCache.get(userId) || { displayName: userId.slice(0, 8), avatarUrl: '', bio: '' }; }

  // ---------- UI Setup ----------
  document.getElementById('modal-user-id').textContent = USER_ID;
  const composerAvatar = document.getElementById('composer-avatar');
  function updateComposerAvatar() {
    if (myProfile.avatarUrl) { composerAvatar.innerHTML = `<img src="${escapeHtml(myProfile.avatarUrl)}" alt="">`; }
    else { composerAvatar.innerHTML = ''; composerAvatar.style.backgroundColor = `hsl(${hashCode(USER_ID) % 360}, 60%, 70%)`; }
  }
  updateComposerAvatar();
  document.getElementById('profile-name').value = myProfile.displayName || '';
  document.getElementById('profile-avatar').value = myProfile.avatarUrl || '';
  document.getElementById('profile-bio').value = myProfile.bio || '';

  // ---------- Trystero Room ----------
  const iceServers = [
      { urls: 'stun:openrelay.metered.ca:80' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
  ];
  const room = joinRoom({ appId: 'pidge-v2', relays: ['wss://relay.damus.io','wss://nos.lol','wss://relay.primal.net'], rtcConfig: { iceServers }, }, 'pidge-global');

  const peerMap = new Map();
  const peerToUserId = new Map();
  const peerPublicKeys = new Map();
  let friends = new Set(JSON.parse(localStorage.getItem('pidge_friends') || '[]'));

  // Raw actions
  const [broadcastHelloRaw, receiveHelloRaw] = room.makeAction('hello');
  const [sendPostRaw, receivePostRaw] = room.makeAction('post');
  const [sendFriendReqRaw, receiveFriendReqRaw] = room.makeAction('friend-req');
  const [sendFriendAcceptRaw, receiveFriendAcceptRaw] = room.makeAction('friend-accept');
  const [sendProfileRaw, receiveProfileRaw] = room.makeAction('profile');
  const [requestProfileRaw, receiveProfileRequestRaw] = room.makeAction('profile-req');
  const [sendLikeRaw, receiveLikeRaw] = room.makeAction('like');

  // ---------- Pending / Last Seen ----------
  const pendingFriendReqs = new Set(JSON.parse(localStorage.getItem('pidge_pendingFriendReqs') || '[]'));
  const friendReqSentPeers = new Set();
  function savePendingFriendReqs() { localStorage.setItem('pidge_pendingFriendReqs', JSON.stringify([...pendingFriendReqs])); }
  const friendLastSeen = new Map(JSON.parse(localStorage.getItem('pidge_friendLastSeen') || '[]'));
  function saveFriendLastSeen() { localStorage.setItem('pidge_friendLastSeen', JSON.stringify([...friendLastSeen])); }

  // ---------- Discovery ----------
  room.onPeerJoin(async peerId => {
    const payload = { userId: USER_ID, publicKeyJwk: IDENTITY.publicJwk, profile: myProfile };
    const sig = await signPayload(payload, IDENTITY.privateKey);
    broadcastHelloRaw({ payload, sig });
  });

  receiveHelloRaw(async ({ payload, sig }, peerId) => {
    const { userId, publicKeyJwk, profile } = payload;
    let pubKey;
    try { pubKey = await importPublicKey(publicKeyJwk); } catch (e) { return; }
    const derivedId = await deriveIdFromPublicKey(pubKey);
    if (derivedId !== userId) return;
    const valid = await verifyPayload(payload, sig, pubKey);
    if (!valid) return;

    peerPublicKeys.set(userId, pubKey);
    peerMap.set(userId, peerId);
    peerToUserId.set(peerId, userId);
    if (profile) cacheProfile(userId, profile);

    if (pendingFriendReqs.has(userId) && !friends.has(userId) && !friendReqSentPeers.has(peerId)) {
      const reqPayload = { from: USER_ID };
      const reqSig = await signPayload(reqPayload, IDENTITY.privateKey);
      sendFriendReqRaw({ payload: reqPayload, sig: reqSig }, peerId);
      friendReqSentPeers.add(peerId);
    }

    if (friends.has(userId)) {
      const lastSeen = friendLastSeen.get(userId) || 0;
      sendMissedPosts(userId, peerId, lastSeen);
      friendLastSeen.delete(userId);
      saveFriendLastSeen();
    }
    updateFriendsListUI();
    updatePostAuthors(userId);
  });

  room.onPeerLeave(peerId => {
    const userId = peerToUserId.get(peerId);
    if (userId) {
      if (friends.has(userId)) { friendLastSeen.set(userId, Date.now()); saveFriendLastSeen(); }
      peerMap.delete(userId);
      peerToUserId.delete(peerId);
    }
    updateFriendsListUI();
  });

  setTimeout(async () => {
    const payload = { userId: USER_ID, publicKeyJwk: IDENTITY.publicJwk, profile: myProfile };
    const sig = await signPayload(payload, IDENTITY.privateKey);
    broadcastHelloRaw({ payload, sig });
  }, 500);

  // ---------- Profile Network ----------
  receiveProfileRequestRaw(async ({ payload, sig }, peerId) => {
    const sender = peerToUserId.get(peerId);
    if (!sender) return;
    const key = peerPublicKeys.get(sender);
    if (!key) return;
    if (!await verifyPayload(payload, sig, key)) return;
    const respPayload = { userId: USER_ID, profile: myProfile };
    const respSig = await signPayload(respPayload, IDENTITY.privateKey);
    sendProfileRaw({ payload: respPayload, sig: respSig }, peerId);
  });

  receiveProfileRaw(async ({ payload, sig }) => {
    const { userId, profile } = payload;
    const key = peerPublicKeys.get(userId);
    if (!key) return;
    if (!await verifyPayload(payload, sig, key)) return;
    cacheProfile(userId, profile);
    updatePostAuthors(userId);
    if (currentProfileUserId === userId) renderProfileModal(userId);
  });

  async function requestUserProfile(userId) {
    const peerId = peerMap.get(userId);
    if (!peerId) return;
    const payload = { req: true };
    const sig = await signPayload(payload, IDENTITY.privateKey);
    requestProfileRaw({ payload, sig }, peerId);
  }

  // ---------- Friend Management ----------
  function saveFriends() { localStorage.setItem('pidge_friends', JSON.stringify([...friends])); updateFriendsListUI(); }

  function updateFriendsListUI() {
    const list = document.getElementById('friend-list');
    if (!list) return;
    list.innerHTML = '';
    friends.forEach(fid => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      const prof = getProfile(fid);
      span.textContent = prof.displayName || fid.slice(0, 8) + '…';
      span.style.cursor = 'pointer';
      span.addEventListener('click', () => openProfile(fid));
      const dot = document.createElement('span');
      dot.className = peerMap.has(fid) ? 'online-dot' : 'online-dot offline-dot';
      li.appendChild(span); li.appendChild(dot); list.appendChild(li);
    });
  }

  document.getElementById('add-friend-btn').addEventListener('click', async () => {
    const target = document.getElementById('new-friend-id').value.trim();
    if (!target) return;
    if (target === USER_ID) return alert('You cannot add yourself.');
    if (friends.has(target)) return alert('Already a friend.');
    const peerId = peerMap.get(target);
    if (!peerId) return alert('User not online. They need to be on the app.');
    const payload = { from: USER_ID };
    const sig = await signPayload(payload, IDENTITY.privateKey);
    sendFriendReqRaw({ payload, sig }, peerId);
    alert('Friend request sent!');
  });

  receiveFriendReqRaw(async ({ payload, sig }, peerId) => {
    const { from } = payload;
    const sender = peerToUserId.get(peerId);
    if (sender !== from) return;
    const key = peerPublicKeys.get(from);
    if (!key) return;
    if (!await verifyPayload(payload, sig, key)) return;
    if (confirm(`${from.slice(0,8)} wants to be your friend. Accept?`)) {
      friends.add(from);
      pendingFriendReqs.delete(from); savePendingFriendReqs(); saveFriends();
      const acceptPayload = { accepted: true, from: USER_ID };
      const acceptSig = await signPayload(acceptPayload, IDENTITY.privateKey);
      sendFriendAcceptRaw({ payload: acceptPayload, sig: acceptSig }, peerId);
    }
  });

  receiveFriendAcceptRaw(async ({ payload, sig }, peerId) => {
    const { accepted, from } = payload;
    const sender = peerToUserId.get(peerId);
    if (sender !== from) return;
    const key = peerPublicKeys.get(from);
    if (!key) return;
    if (!await verifyPayload(payload, sig, key)) return;
    if (accepted) {
      friends.add(from);
      pendingFriendReqs.delete(from); savePendingFriendReqs(); saveFriends();
    }
  });

  // ---------- Post Cache ----------
  const postCache = new Map(JSON.parse(localStorage.getItem('pidge_postCache') || '[]'));
  postCache.forEach(p => { if (!p.lastModified) p.lastModified = p.timestamp; });

  function cachePost(p) { postCache.set(p.id, p); localStorage.setItem('pidge_postCache', JSON.stringify([...postCache])); }
  function getPost(id) { return postCache.get(id); }

  // ---------- Catch-up ----------
  function sendMissedPosts(friendId, peerId, lastSeen) {
    let count = 0;
    postCache.forEach(post => {
      const modified = post.lastModified || post.timestamp;
      if (post.timestamp > lastSeen || modified > lastSeen) {
        sendPostRaw(post, peerId);
        count++;
      }
    });
    if (count > 0) console.log(`Catch-up: sent ${count} missed posts to ${friendId.slice(0,8)}`);
  }

  // ---------- Posting ----------
  document.getElementById('post-button').addEventListener('click', async () => {
    const text = document.getElementById('post-text').value.trim();
    const imageUrl = document.getElementById('post-image-url').value.trim();
    if (!text && !imageUrl) return;
    const timestamp = Date.now();
    const id = crypto.randomUUID();
    const base = { id, author: USER_ID, content: text, imageUrl: imageUrl || null, timestamp };
    const authorSig = await signPayload(base, IDENTITY.privateKey);
    const post = { ...base, lastModified: timestamp, authorSig, likes: 0, likers: [], likeSigs: {} };
    cachePost(post); displayPost(post);
    friends.forEach(fId => { const pId = peerMap.get(fId); if (pId) sendPostRaw(post, pId); });
    document.getElementById('post-text').value = '';
    document.getElementById('post-image-url').value = '';
    updateCharCount();
  });

  // ---------- Receive Post ----------
  receivePostRaw(async (post, peerId) => {
    const senderUserId = peerToUserId.get(peerId);
    if (!senderUserId || !friends.has(senderUserId)) return;

    const authorKey = peerPublicKeys.get(post.author);
    if (!authorKey) { console.warn('Unknown author', post.author); return; }
    const authorPayload = { id: post.id, author: post.author, content: post.content, imageUrl: post.imageUrl, timestamp: post.timestamp };
    if (!await verifyPayload(authorPayload, post.authorSig, authorKey)) { console.warn('Bad post sig', post.author); return; }

    const existing = getPost(post.id);
    if (existing) {
      let changed = false;
      for (const [liker, likeSig] of Object.entries(post.likeSigs || {})) {
        if (!existing.likers.includes(liker)) {
          const likerKey = peerPublicKeys.get(liker);
          if (likerKey) {
            const likePayload = { type: 'like', postId: post.id, liker };
            if (await verifyPayload(likePayload, likeSig, likerKey)) {
              existing.likers.push(liker); existing.likeSigs[liker] = likeSig; changed = true;
            }
          }
        }
      }
      if (changed) {
        existing.likes = existing.likers.length; existing.lastModified = Date.now();
        cachePost(existing); updatePostDisplay(existing);
      }
    } else {
      const likers = []; const verifiedLikeSigs = {};
      for (const [liker, likeSig] of Object.entries(post.likeSigs || {})) {
        const likerKey = peerPublicKeys.get(liker);
        if (likerKey) {
          const likePayload = { type: 'like', postId: post.id, liker };
          if (await verifyPayload(likePayload, likeSig, likerKey)) { likers.push(liker); verifiedLikeSigs[liker] = likeSig; }
        }
      }
      post.likers = likers; post.likeSigs = verifiedLikeSigs; post.likes = likers.length;
      if (!post.lastModified) post.lastModified = post.timestamp;
      cachePost(post); displayPost(post);
    }

    const postToForward = getPost(post.id) || post;
    friends.forEach(fId => {
      if (fId === senderUserId) return;
      const pId = peerMap.get(fId); if (pId) sendPostRaw(postToForward, pId);
    });
  });

  // ---------- Likes ----------
  async function likePost(postId) {
    const post = getPost(postId);
    if (!post) return;
    if (post.likers.includes(USER_ID)) { alert('You already liked this post.'); return; }
    const likePayload = { type: 'like', postId, liker: USER_ID };
    const likeSig = await signPayload(likePayload, IDENTITY.privateKey);
    post.likers.push(USER_ID); post.likeSigs[USER_ID] = likeSig;
    post.likes = post.likers.length; post.lastModified = Date.now();
    cachePost(post); updatePostDisplay(post);
    friends.forEach(fId => { const pId = peerMap.get(fId); if (pId) sendLikeRaw({ payload: likePayload, sig: likeSig }, pId); });
  }

  receiveLikeRaw(async ({ payload, sig }, peerId) => {
    const senderUserId = peerToUserId.get(peerId);
    if (!senderUserId || !friends.has(senderUserId)) return;
    const { postId, liker } = payload;
    const likerKey = peerPublicKeys.get(liker);
    if (!likerKey) return;
    if (!await verifyPayload(payload, sig, likerKey)) return;
    const post = getPost(postId);
    if (!post || post.likers.includes(liker)) return;
    post.likers.push(liker); post.likeSigs[liker] = sig;
    post.likes = post.likers.length; post.lastModified = Date.now();
    cachePost(post); updatePostDisplay(post);
    friends.forEach(fId => { if (fId === senderUserId) return; const pId = peerMap.get(fId); if (pId) sendLikeRaw({ payload, sig }, pId); });
  });

  // ---------- Feed Rendering ----------
  function displayPost(post) {
    const feed = document.getElementById('feed-content');
    let el = document.getElementById(`post-${post.id}`);
    if (!el) {
      el = document.createElement('article');
      el.id = `post-${post.id}`; el.className = 'post';
      const profile = getProfile(post.author);
      const avatarHtml = profile.avatarUrl ? `<img src="${escapeHtml(profile.avatarUrl)}" alt="">` : '';
      const avatarBg = profile.avatarUrl ? '' : `background-color: hsl(${hashCode(post.author) % 360}, 60%, 70%);`;
      el.innerHTML = `
        <div class="post-avatar" style="${avatarBg}" data-author="${post.author}">${avatarHtml}</div>
        <div class="post-content">
          <div class="post-header">
            <span class="post-author" data-author="${post.author}">${escapeHtml(profile.displayName || post.author.slice(0,8))}</span>
            <span class="post-handle">@${post.author.slice(0,8)}</span>
            <span class="post-time"> · ${timeAgo(post.timestamp)}</span>
          </div>
          <div class="post-text">${escapeHtml(post.content)}</div>
          ${post.imageUrl ? `<img class="post-image" src="${escapeHtml(post.imageUrl)}" alt="Post image" onerror="this.style.display='none'">` : ''}
          <div class="post-actions">
            <button class="action-button like-btn">❤️ <span>${post.likes}</span></button>
          </div>
        </div>`;
      feed.prepend(el);
      el.querySelector('.like-btn').addEventListener('click', e => { e.stopPropagation(); likePost(post.id); });
      el.querySelector('.post-author').addEventListener('click', e => { e.stopPropagation(); openProfile(post.author); });
      el.querySelector('.post-avatar').addEventListener('click', e => { e.stopPropagation(); openProfile(post.author); });
    } else { updatePostDisplay(post); }
  }

  function updatePostDisplay(post) {
    const el = document.getElementById(`post-${post.id}`);
    if (!el) return;
    const likeBtn = el.querySelector('.like-btn');
    if (likeBtn) {
      likeBtn.querySelector('span').textContent = post.likes;
      if (post.likers.includes(USER_ID)) likeBtn.classList.add('liked'); else likeBtn.classList.remove('liked');
    }
    const profile = getProfile(post.author);
    const authorEl = el.querySelector('.post-author');
    if (authorEl) authorEl.textContent = escapeHtml(profile.displayName || post.author.slice(0,8));
    const avatarEl = el.querySelector('.post-avatar');
    if (avatarEl) {
      if (profile.avatarUrl) { avatarEl.style.backgroundColor = ''; if (!avatarEl.querySelector('img')) avatarEl.innerHTML = `<img src="${escapeHtml(profile.avatarUrl)}" alt="">`; }
      else { avatarEl.innerHTML = ''; avatarEl.style.backgroundColor = `hsl(${hashCode(post.author) % 360}, 60%, 70%)`; }
    }
  }

  function updatePostAuthors(userId) { postCache.forEach(post => { if (post.author === userId) updatePostDisplay(post); }); }

  function timeAgo(timestamp) {
    const s = Math.floor((Date.now() - timestamp) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }
  function escapeHtml(text) { if (!text) return ''; const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }
  function hashCode(str) { let h = 0; for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; } return Math.abs(h); }

  postCache.forEach(p => displayPost(p));

  // ---------- Profile Modal ----------
  let currentProfileUserId = null;
  function openProfile(userId) {
    currentProfileUserId = userId; renderProfileModal(userId);
    document.getElementById('profile-modal').classList.add('active');
    if (userId !== USER_ID) requestUserProfile(userId);
  }
  function renderProfileModal(userId) {
    const profile = getProfile(userId);
    document.getElementById('profile-view-name').textContent = escapeHtml(profile.displayName || 'Anonymous');
    document.getElementById('profile-view-id').textContent = userId;
    document.getElementById('profile-view-bio').textContent = escapeHtml(profile.bio) || 'No bio yet.';
    const avatarEl = document.getElementById('profile-view-avatar');
    if (profile.avatarUrl) { avatarEl.innerHTML = `<img src="${escapeHtml(profile.avatarUrl)}" alt="">`; }
    else { avatarEl.innerHTML = ''; avatarEl.style.backgroundColor = `hsl(${hashCode(userId) % 360}, 60%, 70%)`; }
    const postsEl = document.getElementById('profile-view-posts');
    postsEl.innerHTML = '';
    const userPosts = [...postCache.values()].filter(p => p.author === userId).sort((a,b) => b.timestamp - a.timestamp);
    if (!userPosts.length) { postsEl.innerHTML = '<p style="color:#666;font-size:0.9rem;">No posts yet.</p>'; return; }
    userPosts.forEach(post => {
      const pDiv = document.createElement('div'); pDiv.className = 'post';
      pDiv.innerHTML = `
        <div class="post-content" style="flex:1;">
          <div class="post-header"><span class="post-time">· ${timeAgo(post.timestamp)}</span></div>
          <div class="post-text">${escapeHtml(post.content)}</div>
          ${post.imageUrl ? `<img class="post-image" src="${escapeHtml(post.imageUrl)}" alt="Post image" onerror="this.style.display='none'">` : ''}
          <div class="post-actions"><button class="action-button like-btn">❤️ <span>${post.likes}</span></button></div>
        </div>`;
      const btn = pDiv.querySelector('.like-btn');
      if (post.likers.includes(USER_ID)) btn.classList.add('liked');
      btn.addEventListener('click', e => { e.stopPropagation(); likePost(post.id); renderProfileModal(userId); });
      postsEl.appendChild(pDiv);
    });
  }

  // ---------- Settings & Events ----------
  const settingsModal = document.getElementById('settings-modal');
  const profileModal = document.getElementById('profile-modal');

  document.getElementById('settings-button').addEventListener('click', () => { settingsModal.classList.add('active'); document.getElementById('new-friend-id').value = ''; updateFriendsListUI(); });
  document.querySelectorAll('.close-modal').forEach(btn => btn.addEventListener('click', () => { const id = btn.dataset.modal; document.getElementById(id).classList.remove('active'); if (id === 'profile-modal') currentProfileUserId = null; }));
  [settingsModal, profileModal].forEach(modal => modal.addEventListener('click', e => { if (e.target === modal) { modal.classList.remove('active'); if (modal === profileModal) currentProfileUserId = null; } }));

  document.getElementById('copy-id').addEventListener('click', () => navigator.clipboard.writeText(USER_ID).then(() => alert('ID copied!')));

  const shareLinkInput = document.getElementById('share-link');
  const shareLinkBtn = document.getElementById('copy-link');
  if (shareLinkInput) shareLinkInput.value = `${window.location.origin}${window.location.pathname}?friend=${encodeURIComponent(USER_ID)}`;
  if (shareLinkBtn) shareLinkBtn.addEventListener('click', () => navigator.clipboard.writeText(shareLinkInput.value).then(() => alert('Invite link copied!')));

  document.getElementById('save-profile').addEventListener('click', async () => {
    myProfile.displayName = document.getElementById('profile-name').value.trim();
    myProfile.avatarUrl = document.getElementById('profile-avatar').value.trim();
    myProfile.bio = document.getElementById('profile-bio').value.trim();
    saveMyProfile(); cacheProfile(USER_ID, myProfile); updateComposerAvatar(); updatePostAuthors(USER_ID);
    const payload = { userId: USER_ID, publicKeyJwk: IDENTITY.publicJwk, profile: myProfile };
    const sig = await signPayload(payload, IDENTITY.privateKey);
    broadcastHelloRaw({ payload, sig });
    alert('Profile saved!');
  });

  composerAvatar.addEventListener('click', () => openProfile(USER_ID));

  const postText = document.getElementById('post-text');
  const charCount = document.getElementById('char-count');
  function updateCharCount() { charCount.textContent = `${postText.value.length}/280`; }
  postText.addEventListener('input', updateCharCount); updateCharCount();

  // ---------- URL Friend Add ----------
  async function handleUrlFriendAdd() {
    const urlParams = new URLSearchParams(window.location.search);
    const urlFriendId = urlParams.get('friend');
    if (!urlFriendId) return;
    if (urlFriendId === USER_ID) { alert('That is your own ID.'); }
    else if (friends.has(urlFriendId)) { alert('You are already friends with this user.'); }
    else {
      pendingFriendReqs.add(urlFriendId); savePendingFriendReqs();
      const peerId = peerMap.get(urlFriendId);
      if (peerId && !friendReqSentPeers.has(peerId)) {
        const payload = { from: USER_ID };
        const sig = await signPayload(payload, IDENTITY.privateKey);
        sendFriendReqRaw({ payload, sig }, peerId);
        friendReqSentPeers.add(peerId);
        alert('Friend request sent!');
      } else {
        alert('Friend request queued. They will be added when they come online.');
      }
    }
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  await handleUrlFriendAdd();
  updateFriendsListUI();