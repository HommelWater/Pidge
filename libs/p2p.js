import { generateSecretKey, getPublicKey, finalizeEvent } from 'https://esm.sh/jsr/@nostr/tools@2.23.6/pure';
import { SimplePool } from 'https://esm.sh/jsr/@nostr/tools@2.23.6/pool';
import * as nip44 from 'https://esm.sh/jsr/@nostr/tools@2.23.6/nip44';
import * as nip19 from 'https://esm.sh/jsr/@nostr/tools@2.23.6/nip19';
import { bytesToHex, hexToBytes } from 'https://esm.sh/@noble/hashes@1.7.1/utils';
import { schnorr } from 'https://esm.sh/@noble/curves@1.8.1/secp256k1';
import { sha256 } from 'https://esm.sh/@noble/hashes@1.7.1/sha256';

function canonicalJson(obj) {
    if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
    if (typeof obj === 'object' && obj !== null) {
        const keys = Object.keys(obj).sort();
        return '{' + keys.map(k => `"${k}":${canonicalJson(obj[k])}`).join(',') + '}';
    }
    return JSON.stringify(obj);
}

export function signPayload(payload, skHex) {
    const msgHash = sha256(new TextEncoder().encode(canonicalJson(payload)));
    const sig = schnorr.sign(msgHash, hexToBytes(skHex));
    return bytesToHex(sig);
}

export function verifyPayload(payload, sigHex, npub) {
    if (!npub || !sigHex || !payload) return false;
    const { data: pk } = nip19.decode(npub);
    const msgHash = sha256(new TextEncoder().encode(canonicalJson(payload)));
    return schnorr.verify(hexToBytes(sigHex), msgHash, hexToBytes(pk));
}

const KIND_SIGNAL = 25000;
const RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band'
];

const AUTH_KIND = 25001;

export class NostrP2P {
    constructor(secretKeyHex, options = {}) {
        this.sk = hexToBytes(secretKeyHex);
        this.hex_sk = secretKeyHex;
        this.pk = getPublicKey(this.sk);
        this.npub = nip19.npubEncode(this.pk);
        this.pool = new SimplePool();

        this.onConnect = options.onConnect || null;
        this.onMessage = (npub, message) => {
            if (typeof message === 'string') {
                try { message = JSON.parse(message); } catch { return; }
            }
            const { signature, ...sig_stripped_payload } = message;
            if (!verifyPayload(sig_stripped_payload, signature, message["sender"])) return;
            if (options.onMessage) options.onMessage(npub, message);
        };
        this.onDisconnect = options.onDisconnect || null;
        this.maxConnections = options.maxConnections || 12;

        // --- Connection Management (clean separation) ---
        // npub -> { pc, channel, peerPk, connectedAt }   ONLY AUTHENTICATED
        this.connections = new Map();
        // npub -> { pc, channel, iceBuffer, peerPk, authSent, createdAt }   PENDING/IN-PROGRESS
        this.pendingConnections = new Map();

        // All known peers (npub strings)
        this.peers = options.peers || new Set([this.npub]);
        // Offset for round-robin through shuffled peers
        this.peerConnOffset = 0;

        // --- Passive Rotation Settings ---
        this.rotationInterval = options.rotationInterval || 45 * 1000;
        this.pendingSlots = options.pendingSlots || 3;
        this.minConnectionAge = options.minConnectionAge || 60 * 1000;

        // --- Retransmit Buffers ---
        this.bufferSize = options.bufferSize || 50;
        this.peerLastMessages = {};  // Stores npub:lastMessageId
        this.messageBuffer = [];
        for (const p in this.peers) this.peerMessageBuffers[p] = -1;
    
        this.listen();
        this._startRotationLoop();
    }

    listen() {
        this.pool.subscribeMany(
            RELAYS,
            { kinds: [KIND_SIGNAL], '#p': [this.pk], since: Math.floor(Date.now() / 1000) - 60 },
            { onevent: (event) => this.handleSignal(event) }
        );
    }

    // Check if a peer is fully authenticated and connected
    isConnected(npub) {
        return this.connections.has(npub);
    }

    // Initiate a connection to a peer (creates a pending connection)
    async connect(npub) {
        if (npub === this.npub) return;
        if (this.connections.has(npub) || this.pendingConnections.has(npub)) return;

        const totalInFlight = this.connections.size + this.pendingConnections.size;
        if (totalInFlight >= this.maxConnections + this.pendingSlots) return;

        const { data: pk } = nip19.decode(npub);
        this._createPendingConnection(npub, true);
    }

    // Send a message over an established connection, 'sender' and 'signature' are reserved for message verification.
    send(npub, message) {
        if(!message.sender){
            message["sender"] = this.npub;
            message["signature"] = signPayload(message, this.hex_sk);
        } else {
            const {signature, ...sig_stripped_payload} = message;
            if(!verifyPayload(sig_stripped_payload, signature, message["sender"])) return;  //verifyPayload returns false if any params are null.
        }
        const conn = this.connections.get(npub);
        if (!conn || conn.channel.readyState !== 'open') {
            throw new Error('Not connected to ' + npub.slice(0, 16));
        }
        conn.channel.send(message);
    }

    // Broadcast to all authenticated peers
    broadcast(message, except=[]) {
        if(!message.sender){
            message["sender"] = this.npub;
            message["signature"] = signPayload(message, this.hex_sk);
        } else {
            const {signature, ...sig_stripped_payload} = message;
            if(!verifyPayload(sig_stripped_payload, signature, message["sender"])) return;  //verifyPayload returns false if any params are null.
        }
        for (const [npub, conn] of this.connections) {
            if(except.includes(npub)) continue;
            if (conn.channel?.readyState === 'open') {
                conn.channel.send(message);
            }
        }
    }

    close() {
        if (this._rotationTimer) {
            clearTimeout(this._rotationTimer);
            this._rotationTimer = null;
        }
        // Close all connections (both pending and active)
        for (const [npub, conn] of this.connections) {
            conn.channel?.close();
            conn.pc.close();
        }
        for (const [npub, pend] of this.pendingConnections) {
            pend.channel?.close();
            pend.pc.close();
        }
        this.connections.clear();
        this.pendingConnections.clear();
        this.pool.close(RELAYS);
    }

    addPeer(npub) {
        if (npub === this.npub || this.peers.has(npub)) return;
        this.peers.add(npub);
        if (!this.peerMessageBuffers[npub]) this.peerMessageBuffers[npub] = [];
        this._rotateConnections();
    }

    removePeer(npub) {
        this.peers.delete(npub);
        this._cleanup(npub);
    }

    // --- Passive Rotation Loop (now with accurate counts) ---

    _startRotationLoop() {
        this._rotationTimer = setTimeout(() => this._rotateConnections(), this.rotationInterval);
    }

    _rotateConnections() {
        try {
            const now = Date.now();

            // 1. Prune stale pending connections (no auth within 30s)
            for (const [npub, pending] of this.pendingConnections) {
                if (now - pending.createdAt > 30000) {
                    pending.pc.close();
                    this.pendingConnections.delete(npub);
                }
            }

            const active = this.connections.size;
            const pending = this.pendingConnections.size;
            const maxTotal = this.maxConnections + this.pendingSlots;
            const deficit = maxTotal - (active + pending);

            // 2. Candidates: peers not already connected or pending
            const candidates = Array.from(this.peers).filter(
                p => p !== this.npub && !this.connections.has(p) && !this.pendingConnections.has(p)
            );
            // Shuffle for randomness
            for (let i = candidates.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
            }

            // 3. Initiate new connections to fill the total in‑flight target
            const toInitiate = Math.min(deficit, candidates.length);
            for (let i = 0; i < toInitiate; i++) {
                this.connect(candidates[i]);
            }

            // 4. Passive rotation: if we're at max active connections, drop the oldest
            //    eligible one and connect to a new candidate to keep the peer set fresh.
            if (active >= this.maxConnections && candidates.length > toInitiate) {
                let oldestNpub = null;
                let oldestTime = Infinity;
                for (const [npub, conn] of this.connections) {
                    if (now - conn.connectedAt >= this.minConnectionAge && conn.connectedAt < oldestTime) {
                        oldestTime = conn.connectedAt;
                        oldestNpub = npub;
                    }
                }
                if (oldestNpub) {
                    this._cleanup(oldestNpub);
                    // The next candidate in the shuffled list (skipping already used ones)
                    this.connect(candidates[toInitiate]);
                }
            }
        } finally {
            this._rotationTimer = setTimeout(() => this._rotateConnections(), this.rotationInterval);
        }
    }

    // --- Internal: create a new pending connection ---

    _createPendingConnection(npub, isInitiator) {
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        const state = {
            pc,
            channel: null,
            iceBuffer: [],
            peerPk: null,          // will be set for incoming, or later during auth
            authSent: false,
            createdAt: Date.now()
        };

        this.pendingConnections.set(npub, state);

        pc.onicecandidate = async (e) => {
            if (!e.candidate) return;
            const { data: pk } = nip19.decode(npub);
            await this._sendSignal(pk, { type: 'ice-candidate', candidate: e.candidate });
        };

        pc.onconnectionstatechange = () => {
            if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
                this._cleanup(npub);
            }
        };

        pc.ondatachannel = (e) => {
            this._setupPendingChannel(npub, state, e.channel);
        };

        if (isInitiator) {
            const channel = pc.createDataChannel('nostr-p2p');
            this._setupPendingChannel(npub, state, channel);
            // Now start the offer
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => {
                    const { data: pk } = nip19.decode(npub);
                    return this._sendSignal(pk, { type: 'offer', sdp: pc.localDescription });
                })
                .catch(err => {
                    console.error('Offer failed', err);
                    this._cleanup(npub);
                });
        }

        return state;
    }

    _setupPendingChannel(npub, state, channel) {
        if (state.channel) return; // already set
        state.channel = channel;

        channel.onopen = () => {
            if (!state.authSent) {
                state.authSent = true;
                this._sendAuth(npub);
            }
        };
        channel.onclose = () => this._cleanup(npub);
        channel.onmessage = (e) => this._handleChannelMessage(npub, e.data);
    }

    async _sendAuth(npub) {
        const state = this.pendingConnections.get(npub) || this.connections.get(npub);
        if (!state || !state.channel || state.channel.readyState !== 'open') return;

        const authEvent = finalizeEvent({
            kind: AUTH_KIND,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', state.peerPk || '']],
            content: 'webrtc-auth',
            lastMessageId:this.peerMessageBuffers[npub] || -1
        }, this.sk);

        state.channel.send(JSON.stringify({ type: 'auth', event: authEvent }));
    }

    async _handleChannelMessage(npub, data) {
        const state = this.pendingConnections.get(npub) || this.connections.get(npub);
        if (!state) return;

        let msg;
        try {
            msg = JSON.parse(data);
        } catch {
            // If we are already authenticated, pass raw data to onMessage
            if (this.connections.has(npub)) {
                this.onMessage(npub, data);
            }
            return;
        }

        if (msg.type === 'auth' && msg.event) {
            // Already authenticated? ignore duplicate auth
            if (this.connections.has(npub)) return;

            const valid = this._verifyAuth(msg.event, npub);
            if (!valid) {
                this._cleanup(npub);
                return;
            }

            // Promote from pending to active connection
            const pending = this.pendingConnections.get(npub);
            if (pending) {
                // Move to connections
                this.connections.set(npub, {
                    pc: pending.pc,
                    channel: pending.channel,
                    peerPk: msg.event.pubkey,
                    connectedAt: Date.now()
                });
                this.pendingConnections.delete(npub);

                // Send our own auth back if we haven't yet
                if (!pending.authSent) {
                    // auth will be sent in channel.onopen, but if already open, send now
                    if (pending.channel && pending.channel.readyState === 'open') {
                        await this._sendAuth(npub);
                    }
                }

                this.send(npub, JSON.stringify({}));//TODO: SEND messages newer than lastMessageId to sync the data.

                this.onConnect?.(npub);
                return;
            }
            // (Should not happen – if state existed in connections it would have been caught above)
        }

        // For non-auth messages, only deliver if already authenticated
        if (this.connections.has(npub)) {
            this.onMessage(npub, data);
        }
    }

    _verifyAuth(event, expectedNpub) {
        if (event.kind !== AUTH_KIND) return false;
        if (Math.abs(event.created_at - Math.floor(Date.now() / 1000)) > 60) return false;

        const claimedNpub = nip19.npubEncode(event.pubkey);
        if (claimedNpub !== expectedNpub) return false;



        return true;
    }

    _cleanup(npub) {
        const conn = this.connections.get(npub);
        if (conn) {
            conn.channel?.close();
            conn.pc.close();
            this.connections.delete(npub);
            this.onDisconnect?.(npub);
        }

        const pending = this.pendingConnections.get(npub);
        if (pending) {
            pending.channel?.close();
            pending.pc.close();
            this.pendingConnections.delete(npub);
        }
    }

    // Handle incoming signaling messages
    async handleSignal(event) {
        const senderPk = event.pubkey;
        const npub = nip19.npubEncode(senderPk);
        if (!this.peers.has(npub)) return;

        // Decrypt payload
        let payload;
        try {
            const ck = nip44.getConversationKey(this.sk, senderPk);
            payload = JSON.parse(nip44.decrypt(event.content, ck));
        } catch {
            return;
        }

        // Get or create pending connection (or use existing active one for late ICE candidates)
        let state = this.pendingConnections.get(npub) || this.connections.get(npub);
        let pc;

        if (!state) {
            // Incoming new connection – check room
            const totalInFlight = this.connections.size + this.pendingConnections.size;
            if (totalInFlight >= this.maxConnections + this.pendingSlots) return;

            state = this._createPendingConnection(npub, false);
            state.peerPk = senderPk; // we know who we're talking to
        }

        pc = state.pc;

        // Process signaling payload
        if (payload.type === 'offer') {
            await pc.setRemoteDescription(payload.sdp);
            await this._flushIce(npub, pc);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await this._sendSignal(senderPk, { type: 'answer', sdp: pc.localDescription });
        } else if (payload.type === 'answer') {
            await pc.setRemoteDescription(payload.sdp);
            await this._flushIce(npub, pc);
        } else if (payload.type === 'ice-candidate' && payload.candidate) {
            if (pc.remoteDescription && pc.remoteDescription.type) {
                await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
            } else {
                // Still waiting for remote description – buffer it
                const st = this.pendingConnections.get(npub);
                if (st) st.iceBuffer.push(payload.candidate);
            }
        }
    }

    async _flushIce(npub, pc) {
        const state = this.pendingConnections.get(npub) || this.connections.get(npub);
        if (!state || !state.iceBuffer || !state.iceBuffer.length) return;

        const buffered = state.iceBuffer.splice(0, state.iceBuffer.length);
        for (const candidate of buffered) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                // ignore stale candidates
            }
        }
    }

    async _sendSignal(recipientPk, payload) {
        const ck = nip44.getConversationKey(this.sk, recipientPk);
        const ciphertext = nip44.encrypt(JSON.stringify(payload), ck);
        const event = finalizeEvent({
            kind: KIND_SIGNAL,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', recipientPk]],
            content: ciphertext
        }, this.sk);
        await Promise.allSettled(this.pool.publish(RELAYS, event));
    }
}