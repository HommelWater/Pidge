import { joinRoom } from 'https://esm.run/trystero';

// ---------- Identity ----------
const USER_ID = (() => {
  let id = localStorage.getItem('pidge_id');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('pidge_id', id); }
  return id;
})();

// ---------- Profile System ----------
let myProfile = JSON.parse(localStorage.getItem('pidge_myProfile') || '{}');
const profileCache = new Map(JSON.parse(localStorage.getItem('pidge_profiles') || '[]'));

function saveMyProfile() {
  localStorage.setItem('pidge_myProfile', JSON.stringify(myProfile));
}
function cacheProfile(userId, profile) {
  profileCache.set(userId, { ...profile, userId });
  localStorage.setItem('pidge_profiles', JSON.stringify([...profileCache]));
}
function getProfile(userId) {
  return profileCache.get(userId) || { displayName: userId.slice(0, 8), avatarUrl: '', bio: '' };
}

// ---------- UI Setup ----------
document.getElementById('modal-user-id').textContent = USER_ID;
const composerAvatar = document.getElementById('composer-avatar');

function updateComposerAvatar() {
  if (myProfile.avatarUrl) {
    composerAvatar.innerHTML = `<img src="${escapeHtml(myProfile.avatarUrl)}" alt="">`;
  } else {
    composerAvatar.innerHTML = '';
    composerAvatar.style.backgroundColor = `hsl(${hashCode(USER_ID) % 360}, 60%, 70%)`;
  }
}
updateComposerAvatar();

document.getElementById('profile-name').value = myProfile.displayName || '';
document.getElementById('profile-avatar').value = myProfile.avatarUrl || '';
document.getElementById('profile-bio').value = myProfile.bio || '';

// ---------- Trystero Room ----------
const room = joinRoom(
  { appId: 'pidge-v2', relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'] },
  'pidge-global'
);

const peerMap = new Map();
const peerToUserId = new Map();
let friends = new Set(JSON.parse(localStorage.getItem('pidge_friends') || '[]'));

// Actions
const [broadcastHello, receiveHello] = room.makeAction('hello');
const [sendPost, receivePost] = room.makeAction('post');
const [sendFriendReq, receiveFriendReq] = room.makeAction('friend-req');
const [sendFriendAccept, receiveFriendAccept] = room.makeAction('friend-accept');
const [sendProfile, receiveProfile] = room.makeAction('profile');
const [requestProfile, receiveProfileRequest] = room.makeAction('profile-req');

// ---------- Pending Friend Requests (URL adds) ----------
const pendingFriendReqs = new Set(JSON.parse(localStorage.getItem('pidge_pendingFriendReqs') || '[]'));
const friendReqSentPeers = new Set(); // session-only dedup
function savePendingFriendReqs() {
  localStorage.setItem('pidge_pendingFriendReqs', JSON.stringify([...pendingFriendReqs]));
}

// ---------- Last Seen Tracking ----------
const friendLastSeen = new Map(JSON.parse(localStorage.getItem('pidge_friendLastSeen') || '[]'));
function saveFriendLastSeen() {
  localStorage.setItem('pidge_friendLastSeen', JSON.stringify([...friendLastSeen]));
}

// ---------- Discovery ----------
room.onPeerJoin(peerId => {
  broadcastHello({ userId: USER_ID, profile: myProfile });
});
receiveHello(({ userId, profile }, peerId) => {
  peerMap.set(userId, peerId);
  peerToUserId.set(peerId, userId);
  if (profile) cacheProfile(userId, profile);

  // Auto-send queued friend requests when target comes online
  if (pendingFriendReqs.has(userId) && !friends.has(userId) && !friendReqSentPeers.has(peerId)) {
    sendFriendReq({ from: USER_ID }, peerId);
    friendReqSentPeers.add(peerId);
  }

  // Catch-up: send missed posts to friends who just came back online
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
    if (friends.has(userId)) {
      friendLastSeen.set(userId, Date.now());
      saveFriendLastSeen();
    }
    peerMap.delete(userId);
    peerToUserId.delete(peerId);
  }
  updateFriendsListUI();
});
setTimeout(() => broadcastHello({ userId: USER_ID, profile: myProfile }), 500);

// ---------- Profile Network ----------
receiveProfileRequest((_, peerId) => {
  sendProfile({ userId: USER_ID, profile: myProfile }, peerId);
});
receiveProfile(({ userId, profile }) => {
  if (!profile) return;
  cacheProfile(userId, profile);
  updatePostAuthors(userId);
  if (currentProfileUserId === userId) renderProfileModal(userId);
});

function requestUserProfile(userId) {
  const peerId = peerMap.get(userId);
  if (peerId) requestProfile({}, peerId);
}

// ---------- Friend Management ----------
function saveFriends() {
  localStorage.setItem('pidge_friends', JSON.stringify([...friends]));
  updateFriendsListUI();
}

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
    li.appendChild(span);
    li.appendChild(dot);
    list.appendChild(li);
  });
}

document.getElementById('add-friend-btn').addEventListener('click', () => {
  const target = document.getElementById('new-friend-id').value.trim();
  if (!target) return;
  if (target === USER_ID) return alert('You cannot add yourself.');
  if (friends.has(target)) return alert('Already a friend.');
  const peerId = peerMap.get(target);
  if (!peerId) return alert('User not online. They need to be on the app.');
  sendFriendReq({ from: USER_ID }, peerId);
  alert('Friend request sent!');
});

receiveFriendReq((data, peerId) => {
  if (confirm(`${data.from.slice(0, 8)} wants to be your friend. Accept?`)) {
    friends.add(data.from);
    pendingFriendReqs.delete(data.from); // they are now friends
    savePendingFriendReqs();
    saveFriends();
    sendFriendAccept({ accepted: true, from: USER_ID }, peerId);
  }
});

receiveFriendAccept((data) => {
  if (data.accepted) {
    friends.add(data.from);
    pendingFriendReqs.delete(data.from);
    savePendingFriendReqs();
    saveFriends();
  }
});

// ---------- Post Cache ----------
const postCache = new Map(JSON.parse(localStorage.getItem('pidge_postCache') || '[]'));
postCache.forEach(p => { if (!p.lastModified) p.lastModified = p.timestamp; });

function cachePost(p) {
  postCache.set(p.id, p);
  localStorage.setItem('pidge_postCache', JSON.stringify([...postCache]));
}
function getPost(id) { return postCache.get(id); }

// ---------- Catch-up Sender ----------
function sendMissedPosts(friendId, peerId, lastSeen) {
  let count = 0;
  postCache.forEach(post => {
    const modified = post.lastModified || post.timestamp;
    if (post.timestamp > lastSeen || modified > lastSeen) {
      sendPost(post, peerId);
      count++;
    }
  });
  if (count > 0) console.log(`Catch-up: sent ${count} missed posts to ${friendId.slice(0, 8)}`);
}

// ---------- Posting ----------
document.getElementById('post-button').addEventListener('click', () => {
  const text = document.getElementById('post-text').value.trim();
  const imageUrl = document.getElementById('post-image-url').value.trim();
  if (!text && !imageUrl) return;
  const post = {
    id: crypto.randomUUID(),
    author: USER_ID,
    content: text,
    imageUrl: imageUrl || null,
    timestamp: Date.now(),
    lastModified: Date.now(),
    likes: 0,
    likers: []
  };
  cachePost(post);
  displayPost(post);
  friends.forEach(fId => {
    const pId = peerMap.get(fId);
    if (pId) sendPost(post, pId);
  });
  document.getElementById('post-text').value = '';
  document.getElementById('post-image-url').value = '';
  updateCharCount();
});

// ---------- Gossip Receive ----------
receivePost((post, peerId) => {
  const senderUserId = peerToUserId.get(peerId);
  if (!senderUserId || !friends.has(senderUserId)) return;

  const existing = getPost(post.id);
  let changed = false;

  if (existing) {
    const mergedLikers = [...new Set([...existing.likers, ...(post.likers || [])])];
    const likersChanged = mergedLikers.length !== existing.likers.length;
    const contentChanged = post.content && post.content !== existing.content;
    const imageChanged = post.imageUrl && post.imageUrl !== existing.imageUrl;

    if (likersChanged || contentChanged || imageChanged) {
      changed = true;
      existing.likers = mergedLikers;
      existing.likes = mergedLikers.length;
      if (post.content) existing.content = post.content;
      if (post.imageUrl) existing.imageUrl = post.imageUrl;
      existing.lastModified = Date.now();
      cachePost(existing);
      updatePostDisplay(existing);
    }
  } else {
    changed = true;
    if (!post.lastModified) post.lastModified = post.timestamp;
    if (!post.likers) post.likers = [];
    cachePost(post);
    displayPost(post);
  }

  if (changed) {
    const postToForward = existing || post;
    friends.forEach(fId => {
      if (fId === senderUserId) return;
      const pId = peerMap.get(fId);
      if (pId) sendPost(postToForward, pId);
    });
  }
});

// ---------- Likes ----------
function likePost(postId) {
  const post = getPost(postId);
  if (!post) return;
  if (post.likers.includes(USER_ID)) {
    alert('You already liked this post.');
    return;
  }
  post.likers.push(USER_ID);
  post.likes = post.likers.length;
  post.lastModified = Date.now();
  cachePost(post);
  updatePostDisplay(post);

  friends.forEach(fId => {
    const pId = peerMap.get(fId);
    if (pId) sendPost(post, pId);
  });
}

// ---------- Feed Rendering ----------
function displayPost(post) {
  const feed = document.getElementById('feed-content');
  let el = document.getElementById(`post-${post.id}`);
  if (!el) {
    el = document.createElement('article');
    el.id = `post-${post.id}`;
    el.className = 'post';
    const profile = getProfile(post.author);
    const avatarHtml = profile.avatarUrl ? `<img src="${escapeHtml(profile.avatarUrl)}" alt="">` : '';
    const avatarBg = profile.avatarUrl ? '' : `background-color: hsl(${hashCode(post.author) % 360}, 60%, 70%);`;

    el.innerHTML = `
      <div class="post-avatar" style="${avatarBg}" data-author="${post.author}">${avatarHtml}</div>
      <div class="post-content">
        <div class="post-header">
          <span class="post-author" data-author="${post.author}">${escapeHtml(profile.displayName || post.author.slice(0, 8))}</span>
          <span class="post-handle">@${post.author.slice(0, 8)}</span>
          <span class="post-time">· ${timeAgo(post.timestamp)}</span>
        </div>
        <div class="post-text">${escapeHtml(post.content)}</div>
        ${post.imageUrl ? `<img class="post-image" src="${escapeHtml(post.imageUrl)}" alt="Post image" onerror="this.style.display='none'">` : ''}
        <div class="post-actions">
          <button class="action-button like-btn">❤️ <span>${post.likes}</span></button>
        </div>
      </div>
    `;
    feed.prepend(el);

    el.querySelector('.like-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      likePost(post.id);
    });
    el.querySelector('.post-author').addEventListener('click', (e) => {
      e.stopPropagation();
      openProfile(post.author);
    });
    el.querySelector('.post-avatar').addEventListener('click', (e) => {
      e.stopPropagation();
      openProfile(post.author);
    });
  } else {
    updatePostDisplay(post);
  }
}

function updatePostDisplay(post) {
  const el = document.getElementById(`post-${post.id}`);
  if (!el) return;
  const likeBtn = el.querySelector('.like-btn');
  if (likeBtn) {
    likeBtn.querySelector('span').textContent = post.likes;
    if (post.likers.includes(USER_ID)) likeBtn.classList.add('liked');
    else likeBtn.classList.remove('liked');
  }
  const profile = getProfile(post.author);
  const authorEl = el.querySelector('.post-author');
  if (authorEl) authorEl.textContent = escapeHtml(profile.displayName || post.author.slice(0, 8));
  const avatarEl = el.querySelector('.post-avatar');
  if (avatarEl) {
    if (profile.avatarUrl) {
      avatarEl.style.backgroundColor = '';
      if (!avatarEl.querySelector('img')) avatarEl.innerHTML = `<img src="${escapeHtml(profile.avatarUrl)}" alt="">`;
    } else {
      avatarEl.innerHTML = '';
      avatarEl.style.backgroundColor = `hsl(${hashCode(post.author) % 360}, 60%, 70%)`;
    }
  }
}

function updatePostAuthors(userId) {
  postCache.forEach(post => {
    if (post.author === userId) updatePostDisplay(post);
  });
}

function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// Initial render
postCache.forEach(p => displayPost(p));

// ---------- Profile Modal ----------
let currentProfileUserId = null;

function openProfile(userId) {
  currentProfileUserId = userId;
  renderProfileModal(userId);
  document.getElementById('profile-modal').classList.add('active');
  if (userId !== USER_ID) requestUserProfile(userId);
}

function renderProfileModal(userId) {
  const profile = getProfile(userId);
  document.getElementById('profile-view-name').textContent = escapeHtml(profile.displayName || 'Anonymous');
  document.getElementById('profile-view-id').textContent = userId;
  document.getElementById('profile-view-bio').textContent = escapeHtml(profile.bio) || 'No bio yet.';
  const avatarEl = document.getElementById('profile-view-avatar');
  if (profile.avatarUrl) {
    avatarEl.innerHTML = `<img src="${escapeHtml(profile.avatarUrl)}" alt="">`;
  } else {
    avatarEl.innerHTML = '';
    avatarEl.style.backgroundColor = `hsl(${hashCode(userId) % 360}, 60%, 70%)`;
  }

  const postsEl = document.getElementById('profile-view-posts');
  postsEl.innerHTML = '';
  const userPosts = [...postCache.values()]
    .filter(p => p.author === userId)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (userPosts.length === 0) {
    postsEl.innerHTML = '<p style="color:#666; font-size:0.9rem;">No posts yet.</p>';
    return;
  }

  userPosts.forEach(post => {
    const pDiv = document.createElement('div');
    pDiv.className = 'post';
    pDiv.innerHTML = `
      <div class="post-content" style="flex:1;">
        <div class="post-header">
          <span class="post-time">· ${timeAgo(post.timestamp)}</span>
        </div>
        <div class="post-text">${escapeHtml(post.content)}</div>
        ${post.imageUrl ? `<img class="post-image" src="${escapeHtml(post.imageUrl)}" alt="Post image" onerror="this.style.display='none'">` : ''}
        <div class="post-actions">
          <button class="action-button like-btn">❤️ <span>${post.likes}</span></button>
        </div>
      </div>
    `;
    const btn = pDiv.querySelector('.like-btn');
    if (post.likers.includes(USER_ID)) btn.classList.add('liked');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      likePost(post.id);
      renderProfileModal(userId);
    });
    postsEl.appendChild(pDiv);
  });
}

// ---------- Settings Modal & Events ----------
const settingsModal = document.getElementById('settings-modal');
const profileModal = document.getElementById('profile-modal');

document.getElementById('settings-button').addEventListener('click', () => {
  settingsModal.classList.add('active');
  document.getElementById('new-friend-id').value = '';
  updateFriendsListUI();
});

document.querySelectorAll('.close-modal').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.modal;
    document.getElementById(id).classList.remove('active');
    if (id === 'profile-modal') currentProfileUserId = null;
  });
});

[settingsModal, profileModal].forEach(modal => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('active');
      if (modal === profileModal) currentProfileUserId = null;
    }
  });
});

document.getElementById('copy-id').addEventListener('click', () => {
  navigator.clipboard.writeText(USER_ID).then(() => alert('ID copied!'));
});

// Invite link
const shareLinkInput = document.getElementById('share-link');
const shareLinkBtn = document.getElementById('copy-link');
if (shareLinkInput) {
  shareLinkInput.value = `${window.location.origin}${window.location.pathname}?friend=${encodeURIComponent(USER_ID)}`;
}
if (shareLinkBtn) {
  shareLinkBtn.addEventListener('click', () => {
    const link = shareLinkInput.value;
    navigator.clipboard.writeText(link).then(() => alert('Invite link copied!'));
  });
}

document.getElementById('save-profile').addEventListener('click', () => {
  myProfile.displayName = document.getElementById('profile-name').value.trim();
  myProfile.avatarUrl = document.getElementById('profile-avatar').value.trim();
  myProfile.bio = document.getElementById('profile-bio').value.trim();
  saveMyProfile();
  cacheProfile(USER_ID, myProfile);
  updateComposerAvatar();
  updatePostAuthors(USER_ID);
  broadcastHello({ userId: USER_ID, profile: myProfile });
  alert('Profile saved!');
});

composerAvatar.addEventListener('click', () => openProfile(USER_ID));

// Char count
const postText = document.getElementById('post-text');
const charCount = document.getElementById('char-count');
function updateCharCount() {
  charCount.textContent = `${postText.value.length}/280`;
}
postText.addEventListener('input', updateCharCount);
updateCharCount();

// ---------- URL Friend Add ----------
function handleUrlFriendAdd() {
  const urlParams = new URLSearchParams(window.location.search);
  const urlFriendId = urlParams.get('friend');
  if (!urlFriendId) return;

  if (urlFriendId === USER_ID) {
    alert('That is your own ID.');
  } else if (friends.has(urlFriendId)) {
    alert('You are already friends with this user.');
  } else {
    pendingFriendReqs.add(urlFriendId);
    savePendingFriendReqs();

    const peerId = peerMap.get(urlFriendId);
    if (peerId && !friendReqSentPeers.has(peerId)) {
      sendFriendReq({ from: USER_ID }, peerId);
      friendReqSentPeers.add(peerId);
      alert('Friend request sent!');
    } else {
      alert('Friend request queued. They will be added when they come online.');
    }
  }

  window.history.replaceState({}, document.title, window.location.pathname);
}

handleUrlFriendAdd();
updateFriendsListUI();