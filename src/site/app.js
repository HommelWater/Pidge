import { NostrP2P } from '/lib/p2p.js';
import { openDB, deleteDB, wrap, unwrap } from 'https://cdn.jsdelivr.net/npm/idb@8/+esm'

function escapeHtml(text) { 
    if (!text) return ''; 
    const d = document.createElement('div'); 
    d.textContent = text; 
    return d.innerHTML; 
}

function timeAgo(timestamp) {
    const s = Math.floor((Date.now() - timestamp) / 1000);
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

function displayPost(post) {
    const feed = document.getElementById('feed-content');
    let el = document.getElementById(`post-${post.id}`);
    if (!el) {
        el = document.createElement('article');
        el.id = `post-${post.id}`; el.className = 'post';
        const profile = getProfile(post.npub);
        if (!profile) return;
        const avatarHtml = profile.avatarUrl ? `<img src="${escapeHtml(profile.avatarUrl)}" alt="">` : '';
        const avatarBg = profile.avatarUrl ? '' : `background-color: hsl(${hashCode(post.npub) % 360}, 60%, 70%);`;
        el.innerHTML = `
            <div class="post-avatar" style="${avatarBg}" data-author="${post.npub}">${avatarHtml}</div>
            <div class="post-content">
                <div class="post-header">
                <span class="post-author" data-author="${post.npub}">${escapeHtml(profile.username || post.npub.slice(0,8))}</span>
                <span class="post-handle">@${post.npub.slice(0,8)}</span>
                <span class="post-time"> · ${timeAgo(post.timestamp)}</span>
                </div>
                <div class="post-text">${escapeHtml(post.content)}</div>
                ${post.imageUrl ? `<img class="post-image" src="${escapeHtml(post.imageUrl)}" alt="Post image" onerror="this.style.display='none'">` : ''}
                <div class="post-actions">
                <button class="action-button like-btn"><span>${post.hops}</span>Λ</button>
                </div>
            </div>`;
        feed.prepend(el);
        el.querySelector('.like-btn').addEventListener('click', e => { e.stopPropagation(); likePost(post.id); });
        el.querySelector('.post-author').addEventListener('click', e => { e.stopPropagation(); openProfile(post.author_npub); });
        el.querySelector('.post-avatar').addEventListener('click', e => { e.stopPropagation(); openProfile(post.author_npub); });
    }
}

const db = await openDB('pidge-store', 1, {
    upgrade(db) {
        db.createObjectStore('profiles');
        const posts = db.createObjectStore('posts', {autoincrement:true, keyPath:"uuid"});
        posts.createIndex('by-author-id', ['author', 'id']);
    },
});

function getLastPostId(npub){
    const tx = db.transaction('posts');
    const index = tx.store.index('by-author-id');
    const range = IDBKeyRange.bound([npub], [npub, []], false, true);
    const cursor = await index.openCursor(range, 'prev');
    const maxId = cursor?.value?.id;
    return maxId;
}

const my_npub = localStorage.getItem("npub");
if (!my_npub) location.href = "/settings";

let profile = await db.get('profiles', my_npub);
if (!profile) location.href = "/settings";

const p2p = new NostrP2P(profile.nsec);
p2p.onConnect = (npub) => {
    p2p.log(`Connected to ${npub.slice(0, 16)}...`);
};

p2p.onMessage = async (npub, data) => {
    p2p.log(`[${npub.slice(0, 16)}...] ${data}`);
    const type = data["type"];
    if(!type) return;
    if(type === "profile"){
        const profile = {username:data.username, avatarUrl:data.avatarUrl, bio:data.bio, timestamp:data.timestamp, npub:data.sender}
        const old_profile = await db.get("profiles", profile.npub);
        if (old_profile.timestamp >= profile.timestamp) return;
        await db.put("profiles", profile, profile.npub);
        p2p.broadcast(data);
    }
    if(type === "profile_request"){
        const requested_profile = await db.get("profiles", data.request_npub);
        if (requested_profile){
            p2p.broadcast({"type":"profile", ...requested_profile});
        } else {
            //p2p.broadcast(data) //Maybe wait a random amount of time, try and see if the profile is received, else broadcast the packet again.
        }
    }
    if(type === "post"){
        const post = {npub:data.sender, id:data.id, content:data.content, imageUrl:data.imageUrl, timestamp:data.timestamp};
        displayPost(post);
        await db.put("posts", post);
    }
    if (type === "sync"){
        const last_post_id = getLastPostId(my_npub);
        const profile_timestamp = await db.get("profiles", my_npub, )
    }
};

function post(){
    const post_text = document.getElementById('post-text').value;
    const post_image_url = document.getElementById('post-image-url').value;
    const post = {id:posts.length, npub:profile.npub, timestamp:String(Date.now()), content:post_text, imageUrl:post_image_url}
    putPost(post);
    displayPost(post);
    document.getElementById('post-text').value = "";
    document.getElementById('post-image-url').value = "";
}

document.getElementById('post-button').addEventListener("click", post);

//displayPost({id:"25", author_npub:profile.npub, timestamp:String(Date.now()), content:"This is a sample post.", imageUrl:"https://nationalzoo.si.edu/sites/default/files/styles/wide/public/animals/sandcat-001.jpg?h=4a7d1ed4&itok=xEHW2Ogp", hops:"0"})