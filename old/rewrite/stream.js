import { joinRoom,selfId } from 'https://esm.run/trystero';

const BUFFER_SIZE = 600;
const MAX_RELAY_PEERS = 1;
const MIN_PROBE_MS = 500;
const MAX_PROBE_MS = 1000;
const PROBE_W = 128;
const PROBE_H = 72;

const chat_messages_element = document.getElementById('chat-messages');
const stream_name_element = document.getElementById('streamer-name');
const user_info_element = document.getElementById('user-info');
const video_element = document.getElementById('main-video');
const go_live_element = document.getElementById('go-live-btn');

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

async function generateIdentity(){
    const keypair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const priv = JSON.stringify(await crypto.subtle.exportKey('jwk', keypair.privateKey));
    const pub = JSON.stringify(await crypto.subtle.exportKey('jwk', keypair.publicKey));
    const publicKey = await importPublicKey(JSON.parse(pub));
    const id = await deriveIdFromPublicKey(publicKey);
    localStorage.setItem('id', id);
    localStorage.setItem('private_key', priv);
    localStorage.setItem('public_key', pub);
}

async function getIdentity(){
    let privJwk = localStorage.getItem('private_key');
    let pubJwk = localStorage.getItem('public_key');
    let id = localStorage.getItem('id');
    if (!privJwk || !pubJwk || !id) {
        await generateIdentity();
        return getIdentity();
    }
    const privateKey = await crypto.subtle.importKey('jwk', JSON.parse(privJwk), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const publicKey = await importPublicKey(JSON.parse(pubJwk));
    const derived = await deriveIdFromPublicKey(publicKey);
    if (derived !== id) {
      localStorage.clear(); location.reload();
    }
    return { id, privateKey, publicKey, publicJwk: JSON.parse(pubJwk)};
}

const IDENTITY = await getIdentity();
const USER_ID = IDENTITY.id;

// ---------- Frame Buffer ----------
const frameBuffer = new Array(BUFFER_SIZE);
let frameIdx = 0;

function pushFrame(frameData) {
    frameBuffer[frameIdx] = frameData;
    frameIdx = (frameIdx + 1) % BUFFER_SIZE;
}

function meanAbsoluteDifference(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += Math.abs(a[i] - b[i]);
    }
    return sum / a.length;
}

function findLowestMad(probeFrame) {
    let lowest = Infinity;
    for (let i = 0; i < BUFFER_SIZE; i++) {
        const frame = frameBuffer[i];
        if (!frame) continue;
        const mad = meanAbsoluteDifference(probeFrame, frame);
        if (mad < lowest) lowest = mad;
    }
    return lowest;
}

const canvas = document.createElement('canvas');
canvas.width = PROBE_W;
canvas.height = PROBE_H;
const ctx = canvas.getContext('2d', { willReadFrequently: true });

function capture() {
    ctx.drawImage(video_element, 0, 0, PROBE_W, PROBE_H);
    const imageData = ctx.getImageData(0, 0, PROBE_W, PROBE_H);
    pushFrame(new Uint8Array(imageData.data));
}

function scheduleCapture() {
    if ('requestVideoFrameCallback' in video_element) {
        video_element.requestVideoFrameCallback((now, metadata) => {
            capture();
            scheduleCapture();
        });
    } else {
        setInterval(capture, 1000 / 30);
    }
}

// Start it whenever a stream is attached
video_element.addEventListener('loadedmetadata', scheduleCapture);

// Also kick it once if video_element already has a stream
if (video_element.srcObject) scheduleCapture();

async function getLatency(conn) {
    const stats = await conn.getStats(null);
    let rtt = null;
    stats.forEach(report => {
        if (report.type === 'candidate-pair' &&
            report.state === 'succeeded' &&
            report.nominated) {
            rtt = report.currentRoundTripTime * 1000; // ms
        }
    });
    return rtt;
}

let room;
function getIceServers() {
    const iceServers = [{ urls: "stun:stun.relay.metered.ca:80" }];
    const turnInfo = JSON.parse(localStorage.getItem('turn'));
    if(turnInfo){
        iceServers.push(turnInfo);
    }
    return iceServers;
}

let main_room;
let main_room_id;
let relay_room;
let relay_probe_action;
let local_id_to_user_id = {};
function new_room(room_id){
    room = joinRoom({
        appId: 'pidge-live',
        relays: [    'wss://relay.damus.io',
            'wss://nos.lol',
            'wss://relay.primal.net',
            'wss://relay.snort.social',
            'wss://nostr.wine'],
        rtcConfig: { iceServers: getIceServers() }
    }, room_id);
    const helloAction = room.makeAction('hello');
    const probeAction = room.makeAction('probe');
    if (room_id === USER_ID){
        relay_probe_action = probeAction;
    }

    helloAction.onMessage = async ({payload, sig}, {peerId, metadata}) =>{
        const { userId, publicKeyJwk, activeStream } = payload;
        let pubKey;
        try { 
            pubKey = await importPublicKey(publicKeyJwk); 
        } catch (e) { return; }
        const derivedId = await deriveIdFromPublicKey(pubKey);
        if (derivedId !== userId) return;
        const valid = await verifyPayload(payload, sig, pubKey);
        if (!valid) return;
        local_id_to_user_id[peerId] = userId;
        if ((room_id === USER_ID) && video_element.srcObject){
            console.log("added stream...");
            room.addStream(video_element.srcObject, {target:peerId});
            
            const peersEntries = Object.entries(main_room.getPeers());
            if (room_id !== USER_ID && peersEntries.length > MAX_RELAY_PEERS) {
                const results = await Promise.all(
                    peersEntries.map(async ([peerId, conn]) => ({
                        peerId:local_id_to_user_id[peerId],
                        latency: await getLatency(conn)
                    }))
                );
                const best = results
                    .filter(r => !(r.peerId === USER_ID || r.peerId === room_id))
                    .filter(r => r.latency !== null)
                    .reduce((best, cur) => cur.latency < best.latency ? cur : best, { latency: Infinity });
                if (best.peerId !== undefined) {
                    console.log(`"switching peer to : ${best.peerId}"`)
                    watch(best.peerId);
                }
            }

            return;
        }
    };

    probeAction.onMessage = async ({payload, sig}, {peerId, metadata}) => {
        const sender_user_id = local_id_to_user_id[peerId];
        if (sender_user_id === main_room_id && main_room_id !== USER_ID){
            handleProbe(payload, sig);
        }
    };

    room.onPeerJoin = async local_id => {
        const payload = { userId: USER_ID, publicKeyJwk: IDENTITY.publicJwk };
        const sig = await signPayload(payload, IDENTITY.privateKey);
        helloAction.send({ payload, sig });
    };

    room.onPeerLeave = (local_id) => {
        const leftUserId = local_id_to_user_id[local_id];
        if (leftUserId === room_id) {
            console.warn(`Relay peer ${leftUserId} disconnected, reconnecting to source`);
            watch(url_room_id);
        }
    };

    room.onPeerStream = async (stream, local_id) => {
        const user_id = local_id_to_user_id[local_id];
        console.log(user_id)
        if(!user_id || (user_id !== room_id)) return;
        stream_name_element.innerText = user_id;
        video_element.srcObject = stream;
        video_element.play().catch(e => console.warn('Autoplay blocked', e));
    };
    return room;
}

async function watch(room_id) {
    main_room_id = room_id;
    main_room = new_room(room_id);
    if (!relay_room) relay_room = new_room(USER_ID);
}

async function stream(){
    video_element.srcObject = await navigator.mediaDevices.getUserMedia({audio: true,video: true});
    video_element.play().catch(e => console.warn('Autoplay blocked', e));
    await watch(USER_ID);
}

user_info_element.innerText = USER_ID;
go_live_element.addEventListener('click', await stream);
const url_room_id = window.location.pathname.split('/')[1];
if(url_room_id) await watch(url_room_id);


//Broadcast at random intervals based on secret key, unpredictable for viewers.
async function sendFrameProbe(){
    const frame = frameBuffer[(frameIdx - 1 + BUFFER_SIZE) % BUFFER_SIZE];
    if (!frame) return;
    // get last frame
    const payload = { publicKeyJwk: IDENTITY.publicJwk, frame: Array.from(frame) };
    const sig = await signPayload(payload, IDENTITY.privateKey);
    if (relay_probe_action) relay_probe_action.send({ payload, sig });
}

function scheduleNextProbe() {
    const delay = MIN_PROBE_MS + Math.random() * (MAX_PROBE_MS - MIN_PROBE_MS);
    setTimeout(async () => {
        if (main_room_id === USER_ID) {
            console.log("sent probe...");
            await sendFrameProbe();
        }
        scheduleNextProbe();
    }, delay);
}
scheduleNextProbe();

async function handleProbe(payload, sig){
    const { publicKeyJwk, frame } = payload;
    let pubKey;
    try { 
        pubKey = await importPublicKey(publicKeyJwk); 
    } catch (e) { return; }
    const derivedId = await deriveIdFromPublicKey(pubKey);
    if (derivedId !== url_room_id) return;
    const valid_pub = await verifyPayload(payload, sig, pubKey);
    const lowestMad = findLowestMad(frame);
    console.log(`mad: ${lowestMad}`);
    if (lowestMad > 15) {
        watch(url_room_id);
        console.log("failed probe, reconnecting....");
        return;
    }
    console.log("forwarding probe...");
    if (relay_probe_action) relay_probe_action.send({payload, sig});
}