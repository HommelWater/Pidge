import { generateSecretKey, getPublicKey } from 'https://esm.sh/jsr/@nostr/tools@2.23.6/pure';
import { bytesToHex } from 'https://esm.sh/@noble/hashes@1.7.1/utils';
import { openDB, deleteDB, wrap, unwrap } from 'https://cdn.jsdelivr.net/npm/idb@8/+esm'

const db = await openDB('pidge-store', 1, {
    upgrade(db) {
        db.createObjectStore('profiles');
        const posts = db.createObjectStore('posts', {autoincrement:true, keyPath:"uuid"});
        posts.createIndex('by-author', 'author');
    },
});

let mynpub = localStorage.getItem("npub");
let profile = null;
if (mynpub) {
    profile = await db.get("profiles", mynpub);
    console.log(profile);
} 
if(!mynpub || !profile) {
    const skraw = generateSecretKey()
    const sk = bytesToHex(skraw);
    const pk = getPublicKey(skraw);
    mynpub = pk;
    profile = {username:"", avatarUrl:"", bio:"", nsec:sk, npub:pk}
    await db.put("profiles", profile, mynpub);
    localStorage.setItem("npub", mynpub);
}

function displayPeer(p) {
    const userList = document.querySelector('.user-list');
    if (!userList) return;

    const [usernameCol, npubCol, deleteCol] = userList.querySelectorAll('.column');

    // Username
    const nameDiv = document.createElement('div');
    nameDiv.style.cssText = 'height:1.5rem';
    nameDiv.textContent = p.username || p.npub.slice(0, 12) + '…';

    // NPUB
    const npubDiv = document.createElement('div');
    npubDiv.style.cssText = 'height:1.5rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    npubDiv.textContent = p.npub;

    // Delete button
    const btn = document.createElement('button');
    btn.style.cssText = 'height:1.5rem;width:100%';
    btn.textContent = 'Delete';
    btn.onclick = async () => {
        if (p.npub === mynpub) return;
        nameDiv.remove();
        npubDiv.remove();
        btn.remove();
        await db.delete("profiles", p.npub);
    };

    usernameCol.appendChild(nameDiv);
    npubCol.appendChild(npubDiv);
    deleteCol.appendChild(btn);
}

//SETTINGS:
//'turn': json of {urls, username, credential}
//'userinfo': json of {username, avatar_url, bio}

function updateTurnInfo(){
    const urls = document.getElementById("turn-url").value;
    const username = document.getElementById("turn-username").value;
    const credential = document.getElementById("turn-password").value;
    const data = {urls, username, credential};
    localStorage.setItem("turn", JSON.stringify(data));
}
document.getElementById("save-ice-btn").addEventListener("click", updateTurnInfo);

function resetTurnInfo(){
    const data = {urls:"", username:"", credential:""};
    localStorage.setItem("turn", JSON.stringify(data));
}
document.getElementById("reset-ice-btn").addEventListener("click", resetTurnInfo);

async function updateUserInfo(){
    const nsec = document.getElementById("profile-nsec").value
    const npub = document.getElementById("profile-npub").value
    const username = document.getElementById("profile-name").value;
    const avatarUrl = document.getElementById("profile-avatar").value;
    const bio = document.getElementById("profile-bio").value;
    profile = {username, avatarUrl, bio, nsec, npub};
    await db.put("profiles", profile, npub);
    location.href="/settings/"
}
document.getElementById("save-profile").addEventListener("click", updateUserInfo);

async function addPeer(){
    const peer_npub = document.getElementById("peer-npub").value;
    const peer_profile = {username:"unknown", avatarUrl:"", bio:"", npub:peer_npub};
    await db.put("profiles", peer_profile, peer_npub);
    await displayAllPeers();
}
document.getElementById("add-peer").addEventListener("click", addPeer);

const turnInfo = JSON.parse(localStorage.getItem("turn"));
if(turnInfo){
    document.getElementById("turn-url").value = turnInfo.urls;
    document.getElementById("turn-username").value = turnInfo.username;
    document.getElementById("turn-password").value = turnInfo.credential;
}

if (profile){
    document.getElementById("profile-nsec").value = profile.nsec;
    document.getElementById("profile-npub").value = profile.npub;
    document.getElementById("profile-name").value = profile.username;
    document.getElementById("profile-avatar").value = profile.avatarUrl;
    document.getElementById("profile-bio").value = profile.bio;
}

async function displayAllPeers(){
    const all_profiles = await db.getAll("profiles");
    console.log(all_profiles)
    for (let i = 0; i < all_profiles.length; i++) {
        const p = all_profiles[i];
        displayPeer(p);
    }
}
await displayAllPeers();