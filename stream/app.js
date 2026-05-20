import { joinRoom } from 'https://esm.run/trystero';

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
const headerAvatar = document.getElementById('header-avatar');
function updateHeaderAvatar() {
    if (myProfile.avatarUrl) { headerAvatar.innerHTML = `<img src="${escapeHtml(myProfile.avatarUrl)}" alt="">`; }
    else { headerAvatar.innerHTML = ''; headerAvatar.style.backgroundColor = `hsl(${hashCode(USER_ID) % 360}, 60%, 70%)`; }
}
updateHeaderAvatar();
document.getElementById('profile-name').value = myProfile.displayName || '';
document.getElementById('profile-avatar').value = myProfile.avatarUrl || '';
document.getElementById('profile-bio').value = myProfile.bio || '';

// ---------- Trystero Room ----------
const iceServers = [
    { urls: "stun:stun.relay.metered.ca:80" },
    { urls: "turn:global.relay.metered.ca:80", username: "b93e531ccf3bc10247719c15", credential: "Q7k84R5DmVFvQ7Nq" },
    { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: "b93e531ccf3bc10247719c15", credential: "Q7k84R5DmVFvQ7Nq" },
    { urls: "turn:global.relay.metered.ca:443", username: "b93e531ccf3bc10247719c15", credential: "Q7k84R5DmVFvQ7Nq" },
    { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: "b93e531ccf3bc10247719c15", credential: "Q7k84R5DmVFvQ7Nq" },
];
const room = joinRoom({ appId: 'pidge-live-v1', relays: ['wss://relay.damus.io','wss://nos.lol','wss://relay.primal.net'], rtcConfig: { iceServers } }, 'pidge-live-global');

const peerMap = new Map();
const peerToUserId = new Map();
const peerPublicKeys = new Map();
let friends = new Set(JSON.parse(localStorage.getItem('pidge_friends') || '[]'));

// Raw actions
const [broadcastHelloRaw, receiveHelloRaw] = room.makeAction('hello');
const [sendStreamStartRaw, receiveStreamStartRaw] = room.makeAction('stream-start');
const [sendStreamChunkRaw, receiveStreamChunkRaw] = room.makeAction('stream-chunk');
const [sendStreamStopRaw, receiveStreamStopRaw] = room.makeAction('stream-stop');
const [sendChatRaw, receiveChatRaw] = room.makeAction('chat');
const [sendFriendReqRaw, receiveFriendReqRaw] = room.makeAction('friend-req');
const [sendFriendAcceptRaw, receiveFriendAcceptRaw] = room.makeAction('friend-accept');
const [sendProfileRaw, receiveProfileRaw] = room.makeAction('profile');
const [requestProfileRaw, receiveProfileRequestRaw] = room.makeAction('profile-req');

// ---------- Pending / Last Seen ----------
const pendingFriendReqs = new Set(JSON.parse(localStorage.getItem('pidge_pendingFriendReqs') || '[]'));
const friendReqSentPeers = new Set();
function savePendingFriendReqs() { localStorage.setItem('pidge_pendingFriendReqs', JSON.stringify([...pendingFriendReqs])); }
const friendLastSeen = new Map(JSON.parse(localStorage.getItem('pidge_friendLastSeen') || '[]'));
function saveFriendLastSeen() { localStorage.setItem('pidge_friendLastSeen', JSON.stringify([...friendLastSeen])); }

// ---------- Stream State ----------
let mediaRecorder = null;
let localStream = null;
let isLive = false;
let streamMimeType = '';
let mediaSource = null;
let sourceBuffer = null;
let chunkQueue = [];
let isSourceOpen = false;
let currentStreamer = null;
const liveChannels = new Map(); // userId -> { mimeType, timestamp }

// ---------- Discovery ----------
room.onPeerJoin(async peerId => {
    const payload = { userId: USER_ID, publicKeyJwk: IDENTITY.publicJwk, profile: myProfile };
    const sig = await signPayload(payload, IDENTITY.privateKey);
    broadcastHelloRaw({ payload, sig });

    if (isLive) {
        const sPayload = { streamerId: USER_ID, mimeType: streamMimeType, timestamp: Date.now() };
        const sSig = await signPayload(sPayload, IDENTITY.privateKey);
        sendStreamStartRaw({ payload: sPayload, sig: sSig }, peerId);
    }
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

    updateFriendsListUI();
    updateViewerCount();
});

room.onPeerLeave(peerId => {
    const userId = peerToUserId.get(peerId);
    if (userId) {
        if (friends.has(userId)) { friendLastSeen.set(userId, Date.now()); saveFriendLastSeen(); }
        peerMap.delete(userId);
        peerToUserId.delete(peerId);

        if (liveChannels.has(userId)) {
            liveChannels.delete(userId);
            if (currentStreamer === userId) {
                currentStreamer = null;
                cleanupMediaSource();
                updateStreamUI();
            }
            renderChannelsList();
        }
    }
    updateFriendsListUI();
    updateViewerCount();
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
    if (currentProfileUserId === userId) renderProfileModal(userId);
    renderChannelsList(); // names may have updated
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

// ---------- Stream Logic ----------
async function startStream() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 360 } },
            audio: true
        });

        const videoEl = document.getElementById('main-video');
        videoEl.srcObject = localStream;
        videoEl.muted = true;

        const mimeTypes = [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm;codecs=h264,opus',
            'video/webm'
        ];
        const mimeType = mimeTypes.find(mt => MediaRecorder.isTypeSupported(mt)) || '';
        if (!mimeType) { alert('Browser does not support a compatible MediaRecorder codec.'); return; }

        streamMimeType = mimeType;
        mediaRecorder = new MediaRecorder(localStream, { mimeType, videoBitsPerSecond: 800000 });

        mediaRecorder.ondataavailable = async (e) => {
            if (e.data.size === 0) return;
            const base64 = await blobToBase64(e.data);
            sendStreamChunkRaw({ chunk: base64, mimeType: streamMimeType });
        };

        mediaRecorder.onstop = () => {
            sendStreamStopRaw({ streamerId: USER_ID });
            isLive = false;
            updateStreamUI();
        };

        mediaRecorder.start(200);

        const payload = { streamerId: USER_ID, mimeType: streamMimeType, timestamp: Date.now() };
        const sig = await signPayload(payload, IDENTITY.privateKey);
        sendStreamStartRaw({ payload, sig });

        isLive = true;
        currentStreamer = USER_ID;
        updateStreamUI();
    } catch (err) {
        console.error(err);
        alert('Could not start stream: ' + err.message);
    }
}

function stopStream() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    const videoEl = document.getElementById('main-video');
    videoEl.srcObject = null;
    videoEl.src = '';
    videoEl.muted = true;
    isLive = false;
    currentStreamer = null;
    cleanupMediaSource();
    updateStreamUI();
}

receiveStreamStartRaw(async ({ payload, sig }, peerId) => {
    const sender = peerToUserId.get(peerId);
    if (!sender) return;
    const key = peerPublicKeys.get(sender);
    if (!key) return;
    if (!await verifyPayload(payload, sig, key)) return;

    const { streamerId, mimeType } = payload;
    if (streamerId === USER_ID) return;

    liveChannels.set(streamerId, { mimeType, timestamp: payload.timestamp });
    renderChannelsList();

    if (!currentStreamer || currentStreamer === streamerId) {
        switchToStreamer(streamerId, mimeType);
    }
});

receiveStreamChunkRaw(({ streamerId, chunk }, peerId) => {
    // Verify the chunk is actually coming from the claimed streamer (if we know them)
    const sender = peerToUserId.get(peerId);
    if (sender && sender !== streamerId) return;

    if (!chunk || currentStreamer !== streamerId) return;

    try {
        const buffer = base64ToArrayBuffer(chunk);
        appendChunk(buffer);
    } catch (e) {
        console.warn('Dropped corrupt chunk:', e);
    }
});


receiveStreamStopRaw(({ streamerId }) => {
    liveChannels.delete(streamerId);
    renderChannelsList();
    if (currentStreamer === streamerId) {
        currentStreamer = null;
        cleanupMediaSource();
        updateStreamUI();
    }
});

// ---------- MediaSource Management ----------
function switchToStreamer(streamerId, mimeType) {
    if (currentStreamer === streamerId) return;
    cleanupMediaSource();
    currentStreamer = streamerId;

    const videoEl = document.getElementById('main-video');
    videoEl.srcObject = null;
    videoEl.src = '';
    videoEl.muted = false;

    if (streamerId === USER_ID && localStream) {
        videoEl.srcObject = localStream;
        videoEl.muted = true;
        updateStreamUI();
        return;
    }

    mediaSource = new MediaSource();
    videoEl.src = URL.createObjectURL(mediaSource);

    mediaSource.addEventListener('sourceopen', () => {
        isSourceOpen = true;
        const codec = mimeType || 'video/webm; codecs="vp8,opus"';
        try {
            sourceBuffer = mediaSource.addSourceBuffer(codec);
            sourceBuffer.addEventListener('updateend', processChunkQueue);
            processChunkQueue();
        } catch (e) {
            console.error('addSourceBuffer failed:', e);
        }
    });

    mediaSource.addEventListener('sourceended', () => { isSourceOpen = false; });
    mediaSource.addEventListener('error', (e) => { console.error('MediaSource error:', e); });

    updateStreamUI();
}

function appendChunk(buffer) {
    chunkQueue.push(buffer);
    processChunkQueue();
}

function processChunkQueue() {
    if (!sourceBuffer || !isSourceOpen || sourceBuffer.updating || chunkQueue.length === 0) return;
    const chunk = chunkQueue.shift();
    try {
        sourceBuffer.appendBuffer(chunk);
    } catch (e) {
        if (e.name === 'QuotaExceededError') {
            try {
                const video = document.getElementById('main-video');
                if (video.buffered.length > 0) {
                    const start = video.buffered.start(0);
                    const end = video.currentTime - 5;
                    if (end > start) sourceBuffer.remove(start, end);
                }
            } catch (e2) {}
            chunkQueue.unshift(chunk);
        } else {
            console.warn('appendBuffer error:', e);
        }
    }
}

function cleanupMediaSource() {
    isSourceOpen = false;
    if (sourceBuffer) {
        try { sourceBuffer.removeEventListener('updateend', processChunkQueue); } catch (e) {}
        sourceBuffer = null;
    }
    if (mediaSource) {
        try { mediaSource.endOfStream(); } catch (e) {}
        mediaSource = null;
    }
    chunkQueue = [];
    const videoEl = document.getElementById('main-video');
    if (videoEl.src.startsWith('blob:')) {
        URL.revokeObjectURL(videoEl.src);
    }
}

// ---------- Chat Logic ----------
async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    const payload = { text, timestamp: Date.now() };
    const sig = await signPayload(payload, IDENTITY.privateKey);
    sendChatRaw({ payload, sig });
    input.value = '';

    displayChatMessage({ userId: USER_ID, text, timestamp: Date.now() });
}

receiveChatRaw(async ({ payload, sig }, peerId) => {
    const sender = peerToUserId.get(peerId);
    if (!sender) return;
    const key = peerPublicKeys.get(sender);
    if (!key) return;
    if (!await verifyPayload(payload, sig, key)) return;
    if (sender === USER_ID) return;
    displayChatMessage({ userId: sender, ...payload });
});

function displayChatMessage(msg) {
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-message';
    const profile = getProfile(msg.userId);
    div.innerHTML = `
        <span class="chat-author" style="color: hsl(${hashCode(msg.userId) % 360}, 60%, 35%); font-weight: 600;">
            ${escapeHtml(profile.displayName || msg.userId.slice(0,8))}
        </span>
        <span class="chat-time">${timeAgo(msg.timestamp)}</span>
        <div class="chat-text">${escapeHtml(msg.text)}</div>
    `;
    div.querySelector('.chat-author').addEventListener('click', () => openProfile(msg.userId));
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// ---------- UI Updates ----------
function updateStreamUI() {
    const goLiveBtn = document.getElementById('go-live-btn');
    const stopBtn = document.getElementById('stop-stream-btn');
    const liveIndicator = document.getElementById('live-indicator');
    const streamerName = document.getElementById('streamer-name');

    if (isLive) {
        goLiveBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        liveIndicator.classList.remove('hidden');
        streamerName.textContent = (myProfile.displayName || USER_ID.slice(0,8)) + ' (You)';
    } else if (currentStreamer && currentStreamer !== USER_ID) {
        goLiveBtn.classList.remove('hidden');
        stopBtn.classList.add('hidden');
        liveIndicator.classList.add('hidden');
        const prof = getProfile(currentStreamer);
        streamerName.textContent = prof.displayName || currentStreamer.slice(0,8);
    } else {
        goLiveBtn.classList.remove('hidden');
        stopBtn.classList.add('hidden');
        liveIndicator.classList.add('hidden');
        streamerName.textContent = 'Offline';
    }

    updateViewerCount();
    renderChannelsList();
}

function updateViewerCount() {
    const count = peerMap.size;
    document.getElementById('viewer-count').textContent = `${count} peer${count !== 1 ? 's' : ''} online`;
}

function renderChannelsList() {
    const container = document.getElementById('channels-list');
    if (liveChannels.size === 0) {
        container.innerHTML = '<span class="channel-placeholder">No active streams</span>';
        return;
    }
    container.innerHTML = '';
    liveChannels.forEach((info, userId) => {
        const tag = document.createElement('span');
        tag.className = 'channel-tag' + (currentStreamer === userId ? ' active' : '');
        const prof = getProfile(userId);
        tag.textContent = prof.displayName || userId.slice(0,8);
        tag.addEventListener('click', () => switchToStreamer(userId, info.mimeType));
        container.appendChild(tag);
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
    saveMyProfile(); cacheProfile(USER_ID, myProfile); updateHeaderAvatar(); renderChannelsList();
    const payload = { userId: USER_ID, publicKeyJwk: IDENTITY.publicJwk, profile: myProfile };
    const sig = await signPayload(payload, IDENTITY.privateKey);
    broadcastHelloRaw({ payload, sig });
    alert('Profile saved!');
});

headerAvatar.addEventListener('click', () => openProfile(USER_ID));

document.getElementById('go-live-btn').addEventListener('click', startStream);
document.getElementById('stop-stream-btn').addEventListener('click', stopStream);
document.getElementById('chat-send-btn').addEventListener('click', sendChatMessage);
document.getElementById('chat-input').addEventListener('keypress', e => { if (e.key === 'Enter') sendChatMessage(); });

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
    postsEl.innerHTML = '<p style="color:#666;font-size:0.9rem;">No recent activity.</p>';
}

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

// ---------- Helpers ----------
function timeAgo(timestamp) {
    const s = Math.floor((Date.now() - timestamp) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}
function escapeHtml(text) { if (!text) return ''; const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }
function hashCode(str) { let h = 0; for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; } return Math.abs(h); }

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result; // data:video/webm;codecs=vp8,opus;base64,GkXf...
            // Find the fixed ;base64, marker instead of splitting on commas
            const idx = result.indexOf(';base64,');
            const base64 = idx !== -1 ? result.slice(idx + 8) : '';
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

// ---------- Init ----------
await handleUrlFriendAdd();
updateFriendsListUI();
updateStreamUI();