import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip19,
  SimplePool
} from 'https://esm.sh/nostr-tools@2.10.4';

import { sha256 } from 'https://esm.sh/@noble/hashes@1.4.0/sha256.js';
import { schnorr } from 'https://esm.sh/@noble/curves@1.4.0/secp256k1.js';

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://relay.primal.net'
];

const DEFAULT_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

const MAX_DIRECT = 1;
const MAX_RELAY  = 1;
const OFFER_TIMEOUT_MS = 30000; // how long to hold a reserved slot

/* ---------- helpers ---------- */
function parse(input, prefix) {
  input = (input || '').trim();
  if (input.startsWith(prefix + '1')) return nip19.decode(input).data;
  if (/^[0-9a-fA-F]{64}$/.test(input)) return input;
  throw new Error('Invalid ' + prefix);
}

function hexToBytes(hex) {
  hex = hex.replace(/^0x/, '');
  if (hex.length % 2 !== 0) throw new Error('Invalid hex');
  return Uint8Array.from(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
}

function ensureBytes(key) {
  if (key instanceof Uint8Array) return key;
  if (typeof key === 'string') return hexToBytes(key);
  throw new Error('Key must be hex string or Uint8Array');
}

function iceComplete(pc, maxMs = 8000) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(() => resolve(), maxMs);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/* ---------- exports ---------- */
export function generateKeys() {
  const priv = generateSecretKey();
  const pub = getPublicKey(priv);
  return {
    nsec: nip19.nsecEncode(priv),
    npub: nip19.npubEncode(pub),
    priv,
    pub
  };
}

export function signData(privKey, data) {
  const priv = ensureBytes(privKey);
  const hash = sha256(data);
  return schnorr.sign(hash, priv);
}

export function verifyData(pubKey, sig, data) {
  const pub = ensureBytes(pubKey);
  const hash = sha256(data);
  return schnorr.verify(sig, hash, pub);
}

/* ---------- wire protocol ---------- */
export const PROTO = {
  packConfig(cfg, privKey) {
    const meta = new TextEncoder().encode(JSON.stringify(cfg));
    const sig = signData(privKey, meta);
    const buf = new ArrayBuffer(1 + 4 + meta.length + 64);
    const u8 = new Uint8Array(buf);
    u8[0] = 0x01;
    new DataView(buf).setUint32(1, meta.length, true);
    u8.set(meta, 5);
    u8.set(sig, 5 + meta.length);
    return buf;
  },

  packChunk(meta, data, privKey) {
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
    const dataBytes = (data instanceof ArrayBuffer) ? new Uint8Array(data) : data;
    const toSign = new Uint8Array(metaBytes.length + dataBytes.length);
    toSign.set(metaBytes, 0);
    toSign.set(dataBytes, metaBytes.length);
    const sig = signData(privKey, toSign);
    const buf = new ArrayBuffer(1 + 4 + metaBytes.length + 64 + dataBytes.length);
    const u8 = new Uint8Array(buf);
    u8[0] = 0x02;
    new DataView(buf).setUint32(1, metaBytes.length, true);
    u8.set(metaBytes, 5);
    u8.set(sig, 5 + metaBytes.length);
    u8.set(dataBytes, 5 + metaBytes.length + 64);
    return buf;
  },

  unpack(buf) {
    const u8 = new Uint8Array(buf);
    const type = u8[0];
    const metaLen = new DataView(buf).getUint32(1, true);
    const meta = JSON.parse(new TextDecoder().decode(u8.slice(5, 5 + metaLen)));
    const sig = u8.slice(5 + metaLen, 5 + metaLen + 64);
    const data = u8.slice(5 + metaLen + 64);
    return { type, meta, sig, data };
  },

  packControl(cmd, payload) {
    const json = new TextEncoder().encode(JSON.stringify({ cmd, payload }));
    const buf = new ArrayBuffer(1 + 4 + json.length);
    const u8 = new Uint8Array(buf);
    u8[0] = 0x10;
    new DataView(buf).setUint32(1, json.length, true);
    u8.set(json, 5);
    return buf;
  },

  unpackControl(buf) {
    const u8 = new Uint8Array(buf);
    const len = new DataView(buf).getUint32(1, true);
    return JSON.parse(new TextDecoder().decode(u8.slice(5, 5 + len)));
  }
};

/* ================================================================
   STREAMER NODE  —  with offer-in-flight backpressure
   ================================================================ */
export class StreamerNode {
  constructor(opts = {}) {
    this.keys = opts.keys || generateKeys();
    this.priv = this.keys.priv;
    this.pub  = this.keys.pub;
    this.npub = this.keys.npub;
    this.relays = (opts.relays || DEFAULT_RELAYS).filter(Boolean);
    this.iceServers = opts.iceServers || DEFAULT_ICE;
    this.maxDirect = opts.maxDirectPeers || MAX_DIRECT;

    this.pool = null;
    this.subAdmission = null;
    this.subSignal = null;

    this.directPeers = new Map();   // npub -> { pc, channel, relayCapacity, relayCurrent, ready }
    this.pendingApprovals = new Map(); // sid -> { remotePub, npub, timer }
    this.allRelays = new Map();       // npub -> { capacity, current, via }
    this.offersInFlight = 0;            // reserved but not yet connected

    this.onConnection = opts.onConnection || (() => {});
    this.onPeerDisconnect = opts.onPeerDisconnect || (() => {});
    this.onPeerRelayUpdate = opts.onPeerRelayUpdate || (() => {});
    this.onKeyframeRequest = opts.onKeyframeRequest || (() => {});
    this.onConfigRequest = opts.onConfigRequest || (() => {});
    this.onPeerOfferTimeout = opts.onPeerOfferTimeout || (() => {}); // NEW
    this.onLog = opts.onLog || ((...a) => console.log('[Streamer]', ...a));
  }

  _effectiveLoad() {
    return this.directPeers.size + this.offersInFlight;
  }

  async start() {
    this.pool = new SimplePool({ enablePing: true, enableReconnect: true });
    let connected = 0;
    for (const url of this.relays) {
      try { await this.pool.ensureRelay(url); connected++; }
      catch (e) { this.onLog('relay failed', url, e?.message); }
    }
    if (!connected) throw new Error('No Nostr relays connected');

    const since = Math.floor(Date.now() / 1000) - 5;

    this.subAdmission = this.pool.subscribeMany(this.relays, [
      { kinds: [25001], '#p': [this.pub], since }
    ], { onevent: (ev) => this._handleJoinRequest(ev) });

    this.subSignal = this.pool.subscribeMany(this.relays, [
      { kinds: [25000], '#p': [this.pub], since }
    ], { onevent: (ev) => this._handleSignal(ev) });

    this.onLog('started on', connected, 'relays');
    return { npub: this.npub, stop: () => this.stop() };
  }

  _handleJoinRequest(ev) {
    const now = Math.floor(Date.now() / 1000);
    if (ev.created_at < now - 60) return;
    let payload;
    try { payload = JSON.parse(ev.content); } catch { return; }
    if (payload.type !== 'join-request' || !payload.sid) return;

    const remotePub = ev.pubkey;
    const remoteNpub = nip19.npubEncode(remotePub);

    if (this._effectiveLoad() < this.maxDirect) {
      // Reserve a slot immediately so concurrent joiners see backpressure
      this.offersInFlight++;
      this.onLog('reserved slot for', remoteNpub.slice(0, 16), 'load:', this._effectiveLoad(), '/', this.maxDirect);

      const timer = setTimeout(() => {
        if (this.pendingApprovals.has(payload.sid)) {
          this.offersInFlight = Math.max(0, this.offersInFlight - 1);
          this.pendingApprovals.delete(payload.sid);
          this.onLog('offer timeout, freed slot for', remoteNpub.slice(0, 16));
          this.onPeerOfferTimeout(remoteNpub);
        }
      }, OFFER_TIMEOUT_MS);

      this.pendingApprovals.set(payload.sid, { remotePub, npub: remoteNpub, timer });

      const out = finalizeEvent({
        kind: 25001, created_at: now, tags: [['p', remotePub]],
        content: JSON.stringify({ type: 'join-approve', sid: payload.sid })
      }, this.priv);
      for (const p of this.pool.publish(this.relays, out)) {
        if (p && typeof p.then === 'function') p.catch(() => {});
      }
      this.onLog('approved join', remoteNpub.slice(0, 16));
    } else {
      let relay = null;
      for (const [npub, info] of this.allRelays) {
        if (info.current < info.capacity) { relay = npub; break; }
      }

      if (relay) {
        const out = finalizeEvent({
          kind: 25001, created_at: now, tags: [['p', remotePub]],
          content: JSON.stringify({ type: 'join-redirect', sid: payload.sid, relayNpub: relay })
        }, this.priv);
        for (const p of this.pool.publish(this.relays, out)) {
          if (p && typeof p.then === 'function') p.catch(() => {});
        }
        this.onLog('redirected', remoteNpub.slice(0, 16), '→', relay.slice(0, 16));
      } else {
        const out = finalizeEvent({
          kind: 25001, created_at: now, tags: [['p', remotePub]],
          content: JSON.stringify({ type: 'join-reject', sid: payload.sid, reason: 'capacity' })
        }, this.priv);
        for (const p of this.pool.publish(this.relays, out)) {
          if (p && typeof p.then === 'function') p.catch(() => {});
        }
        this.onLog('rejected', remoteNpub.slice(0, 16), '(full)');
      }
    }
  }

  async _handleSignal(ev) {
    let payload;
    try { payload = JSON.parse(ev.content); } catch { return; }
    if (payload.type !== 'offer' || !payload.sid) return;

    const approved = this.pendingApprovals.get(payload.sid);
    if (!approved || approved.remotePub !== ev.pubkey) {
      this.onLog('ignoring unapproved offer', ev.pubkey.slice(0, 16));
      return;
    }

    // Commit the reservation: decrement in-flight, remove pending
    clearTimeout(approved.timer);
    this.pendingApprovals.delete(payload.sid);
    this.offersInFlight = Math.max(0, this.offersInFlight - 1);

    const remotePub = ev.pubkey;
    const sid = payload.sid;
    const remoteNpub = nip19.npubEncode(remotePub);

    // Final capacity guard (edge case: peer disconnected while offer was in flight)
    if (this.directPeers.size >= this.maxDirect) {
      this.onLog('slot vanished before offer processed, rejecting', remoteNpub.slice(0, 16));
      // Send a polite reject so the viewer can re-join and get redirected
      const out = finalizeEvent({
        kind: 25001, created_at: Math.floor(Date.now() / 1000), tags: [['p', remotePub]],
        content: JSON.stringify({ type: 'join-reject', sid, reason: 'slot-lost' })
      }, this.priv);
      for (const p of this.pool.publish(this.relays, out)) {
        if (p && typeof p.then === 'function') p.catch(() => {});
      }
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const nativeClose = pc.close.bind(pc);
    let cleaned = false, finished = false, timer = null;

    const cleanup = (reason) => {
      if (cleaned) return;
      cleaned = true;
      this.onLog('cleanup', remoteNpub.slice(0, 16), reason);
      clearTimeout(timer);
      try { if (pc.signalingState !== 'closed') nativeClose(); } catch (_) {}
      const hadPeer = this.directPeers.has(remoteNpub);
      this.directPeers.delete(remoteNpub);
      if (hadPeer) this.onPeerDisconnect(remoteNpub, reason);
      for (const [npub, info] of this.allRelays) {
        if (info.via === remoteNpub) this.allRelays.delete(npub);
      }
      this.onPeerRelayUpdate(remoteNpub, 0, 0, 'disconnected');
    };
    pc.close = () => cleanup('pc.close()');

    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') cleanup('PC ' + s);
    });

    pc.ondatachannel = (e) => {
      const ch = e.channel;
      ch.binaryType = 'arraybuffer';
      ch.onopen = () => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        const peer = { pc, channel: ch, relayCapacity: 0, relayCurrent: 0, ready: false };
        this.directPeers.set(remoteNpub, peer);
        this.onConnection(pc, remoteNpub, 'in');
        peer.ready = true;
        this.onLog('direct peer ready', remoteNpub.slice(0, 16));
      };
      ch.onclose = () => cleanup('channel closed');
      ch.onerror = err => this.onLog('channel error', sid, err);
      ch.onmessage = (e) => {
        if (typeof e.data === 'string') return;
        const u8 = new Uint8Array(e.data);
        if (u8[0] !== 0x10) return;
        const ctl = PROTO.unpackControl(e.data);
        if (ctl.cmd === 'relay-capacity') {
          const npub = ctl.payload.npub || remoteNpub;
          const cap = ctl.payload.capacity || 0;
          this.allRelays.set(npub, { capacity: cap, current: 0, via: remoteNpub });
          const peer = this.directPeers.get(remoteNpub);
          if (peer) { peer.relayCapacity = cap; peer.relayCurrent = 0; }
          this.onPeerRelayUpdate(npub, cap, 0, 'advertised');
        } else if (ctl.cmd === 'relay-update') {
          const npub = ctl.payload.npub || remoteNpub;
          const cur = ctl.payload.current || 0;
          const info = this.allRelays.get(npub);
          if (info) { info.current = cur; this.onPeerRelayUpdate(npub, info.capacity, cur, 'update'); }
        } else if (ctl.cmd === 'relay-gone') {
          const npub = ctl.payload.npub;
          if (this.allRelays.has(npub)) {
            this.allRelays.delete(npub);
            this.onPeerRelayUpdate(npub, 0, 0, 'gone');
          }
        } else if (ctl.cmd === 'request-keyframe') {
          this.onLog('keyframe requested by', (ctl.payload?.npub || remoteNpub).slice(0, 16));
          this.onKeyframeRequest();
        } else if (ctl.cmd === 'request-config') {
          this.onLog('config requested by', (ctl.payload?.npub || remoteNpub).slice(0, 16));
          this.onConfigRequest(ctl.payload?.npub || remoteNpub);
        }
      };
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await iceComplete(pc, 8000);

      const out = finalizeEvent({
        kind: 25000, created_at: Math.floor(Date.now() / 1000),
        tags: [['p', remotePub]],
        content: JSON.stringify({ type: 'answer', sdp: pc.localDescription, sid })
      }, this.priv);
      for (const p of this.pool.publish(this.relays, out)) {
        if (p && typeof p.then === 'function') p.catch(() => {});
      }
    } catch (err) {
      this.onLog('offer failed', sid, err);
      cleanup('offer error');
    }

    timer = setTimeout(() => {
      if (!this.directPeers.has(remoteNpub)) cleanup('timeout');
    }, 60000);
  }

  broadcast(data) {
    for (const [, peer] of this.directPeers) {
      if (peer.ready && peer.channel?.readyState === 'open') {
        try { peer.channel.send(data); } catch (_) {}
      }
    }
  }

  stop() {
    this.onLog('stopping');
    try { this.subAdmission.close(); } catch (_) {}
    try { this.subSignal.close(); } catch (_) {}
    for (const [, peer] of this.directPeers) try { peer.pc.close(); } catch (_) {}
    this.directPeers.clear();
    for (const [, p] of this.pendingApprovals) clearTimeout(p.timer);
    this.pendingApprovals.clear();
    this.allRelays.clear();
    this.offersInFlight = 0;
    try { this.pool.close(this.relays); } catch (_) {}
  }
}

/* ================================================================
   VIEWER / RELAY NODE
   ================================================================ */
export class ViewerNode {
  constructor(streamerNpub, opts = {}) {
    this.streamerNpub = streamerNpub;
    this.streamerPub = parse(streamerNpub, 'npub');
    this.keys = opts.keys || generateKeys();
    this.priv = this.keys.priv;
    this.pub  = this.keys.pub;
    this.npub = this.keys.npub;
    this.relays = (opts.relays || DEFAULT_RELAYS).filter(Boolean);
    this.iceServers = opts.iceServers || DEFAULT_ICE;
    this.maxDownstream = opts.maxRelayPeers || MAX_RELAY;
    this.enableRelay = opts.enableRelay !== false;
    this.maxReconnectAttempts = opts.maxReconnectAttempts || 10;
    this.reconnectBaseDelay = opts.reconnectBaseDelay || 2000;

    this.pool = null;
    this.subAdmission = null;
    this.subSignal = null;

    this.upstream = null;      // { pc, channel, npub, role }
    this.downstreams = new Map(); // npub -> { pc, channel }

    this._cachedConfigPacket = null;
    this._receivedConfig = false;

    this._joinSid = null;
    this._joinTimer = null;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;

    this.onUpstreamData = opts.onUpstreamData || (() => {});
    this.onDownstreamConnection = opts.onDownstreamConnection || (() => {});
    this.onConnectionStateChange = opts.onConnectionStateChange || (() => {});
    this.onLog = opts.onLog || ((...a) => console.log('[Viewer]', ...a));
  }

  async _ensurePool() {
    if (this.pool) return;
    this.pool = new SimplePool({ enablePing: true, enableReconnect: true });
    let connected = 0;
    for (const url of this.relays) {
      try { await this.pool.ensureRelay(url); connected++; }
      catch (e) { this.onLog('relay failed', url); }
    }
    if (!connected) throw new Error('No Nostr relays connected');
  }

  async join() {
    await this._ensurePool();
    return this._requestAdmission();
  }

  async _requestAdmission() {
    const sid = Math.random().toString(36).slice(2, 10);
    this._joinSid = sid;

    const out = finalizeEvent({
      kind: 25001, created_at: Math.floor(Date.now() / 1000),
      tags: [['p', this.streamerPub]],
      content: JSON.stringify({ type: 'join-request', sid, npub: this.npub })
    }, this.priv);
    for (const p of this.pool.publish(this.relays, out)) {
      if (p && typeof p.then === 'function') p.catch(() => {});
    }

    const since = Math.floor(Date.now() / 1000) - 5;
    return new Promise((resolve, reject) => {
      this._joinResolve = resolve;
      this._joinReject = reject;

      this.subAdmission = this.pool.subscribeMany(this.relays, [
        { kinds: [25001], authors: [this.streamerPub], '#p': [this.pub], since }
      ], { onevent: (ev) => this._handleJoinResponse(ev, resolve, reject) });

      this._joinTimer = setTimeout(() => {
        if (!this.upstream) {
          this._cleanupUpstream();
          reject(new Error('Join timeout'));
        }
      }, 30000);
    });
  }

  _handleJoinResponse(ev, resolve, reject) {
    let payload;
    try { payload = JSON.parse(ev.content); } catch { return; }
    if (payload.sid !== this._joinSid) return;

    if (payload.type === 'join-approve') {
      this.subAdmission?.close();
      this._connectTo(this.streamerNpub, 'streamer').then(resolve).catch(reject);
    } else if (payload.type === 'join-redirect') {
      this.subAdmission?.close();
      this.onLog('redirected to relay', payload.relayNpub.slice(0, 16));
      this._connectTo(payload.relayNpub, 'relay').then(resolve).catch(reject);
    } else if (payload.type === 'join-reject') {
      this.subAdmission?.close();
      reject(new Error('Join rejected: ' + (payload.reason || 'capacity')));
    }
  }

  _cleanupUpstream() {
    clearTimeout(this._joinTimer);
    try { this.subAdmission.close(); } catch (_) {}
    if (this.upstream) {
      try { this.upstream.pc.close(); } catch (_) {}
      this.upstream = null;
    }
  }

  _scheduleReconnect(reason) {
    if (this._reconnectTimer) return;

    this._cleanupUpstream();
    this.onConnectionStateChange('reconnecting', null, null);

    this._reconnectAttempts++;
    if (this._reconnectAttempts > this.maxReconnectAttempts) {
      this.onLog('max reconnect attempts reached, giving up');
      this.onConnectionStateChange('failed', null, null);
      this.cleanup();
      return;
    }

    const delay = Math.min(this.reconnectBaseDelay * Math.pow(2, this._reconnectAttempts - 1), 30000);
    this.onLog(`reconnect in ${delay}ms (attempt ${this._reconnectAttempts}/${this.maxReconnectAttempts}) reason: ${reason}`);
    this._reconnectTimer = setTimeout(() => this._doReconnect(), delay);
  }

  async _doReconnect() {
    this._reconnectTimer = null;
    try {
      await this._requestAdmission();
      this._reconnectAttempts = 0;
      this.onLog('reconnected successfully');
    } catch (e) {
      this.onLog('reconnect failed:', e.message);
      this._scheduleReconnect('admission failed');
    }
  }

  _connectTo(targetNpub, role) {
    return new Promise((resolve, reject) => {
      const targetPub = parse(targetNpub, 'npub');
      const sid = this._joinSid || Math.random().toString(36).slice(2, 10);
      const startTime = Math.floor(Date.now() / 1000);

      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const nativeClose = pc.close.bind(pc);
      let cleaned = false, finished = false, timer = null, offerInterval = null;

      const cleanup = (reason) => {
        if (cleaned) return;
        cleaned = true;
        if (offerInterval) clearInterval(offerInterval);
        clearTimeout(timer);
        try { if (pc.signalingState !== 'closed') nativeClose(); } catch (_) {}
        if (this.upstream?.pc === pc) this.upstream = null;
      };
      pc.close = () => cleanup('pc.close()');

      const sendSig = (type, sdp, extra = {}) => {
        const ev = finalizeEvent({
          kind: 25000, created_at: Math.floor(Date.now() / 1000),
          tags: [['p', targetPub]],
          content: JSON.stringify({ type, sdp, sid, ...extra })
        }, this.priv);
        for (const p of this.pool.publish(this.relays, ev)) {
          if (p && typeof p.then === 'function') p.catch(() => {});
        }
      };

      const since = startTime - 5;
      const sub = this.pool.subscribeMany(this.relays, [
        { kinds: [25000], authors: [targetPub], '#p': [this.pub], since }
      ], {
        onevent: async (ev) => {
          if (cleaned || ev.created_at < startTime - 5) return;
          try {
            const p = JSON.parse(ev.content);
            if (!p.sid || p.sid !== sid) return;
            if (p.type === 'answer' && pc.signalingState === 'have-local-offer') {
              await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
              if (offerInterval) { clearInterval(offerInterval); offerInterval = null; }
            }
          } catch (err) { this.onLog('signal error', err); }
        }
      });

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (offerInterval) clearInterval(offerInterval);
        this.upstream = { pc, channel, npub: targetNpub, role };
        this.onConnectionStateChange('connected', targetNpub, role);
        resolve(pc);
      };

      pc.addEventListener('connectionstatechange', () => {
        const s = pc.connectionState;
        if (s === 'connected' && channel?.readyState === 'open') finish();
        else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
          cleanup('PC ' + s);
          if (!finished) { finished = true; reject(new Error('Connection ' + s)); }
          else if (this._reconnectAttempts < this.maxReconnectAttempts) {
            this._scheduleReconnect('PC ' + s);
          }
        }
      });

      const channel = pc.createDataChannel('data', { ordered: true });
      channel.binaryType = 'arraybuffer';
      channel.onopen = () => {
        finish();
        if (this.enableRelay) {
          const msg = PROTO.packControl('relay-capacity', { capacity: this.maxDownstream, npub: this.npub });
          try { channel.send(msg); } catch (_) {}
          this.startRelay().catch(e => this.onLog('startRelay failed', e));
        }
        const cfgMsg = PROTO.packControl('request-config', { npub: this.npub });
        try { channel.send(cfgMsg); } catch (_) {}
      };
      channel.onclose = () => {
        cleanup('channel closed');
        if (finished) this._scheduleReconnect('channel closed');
        else this.onConnectionStateChange('closed', targetNpub, role);
      };
      channel.onerror = e => this.onLog('channel error', e);
      channel.onmessage = (e) => {
        if (typeof e.data === 'string') return;
        const u8 = new Uint8Array(e.data);
        if (u8[0] === 0x01) {
          this._cachedConfigPacket = e.data;
          this._receivedConfig = true;
        }
        this.onUpstreamData(e.data, targetNpub);
      };

      (async () => {
        await new Promise(r => setTimeout(r, 1500));
        await pc.setLocalDescription(await pc.createOffer());
        await iceComplete(pc, 8000);

        const sendOffer = () => {
          if (finished || pc.signalingState !== 'have-local-offer') {
            if (offerInterval) { clearInterval(offerInterval); offerInterval = null; }
            return;
          }
          sendSig('offer', pc.localDescription);
        };
        sendOffer();
        offerInterval = setInterval(sendOffer, 5000);

        timer = setTimeout(() => {
          cleanup('timeout');
          if (!finished) { finished = true; reject(new Error('Connection timeout')); }
        }, 60000);

        if (channel.readyState === 'open') finish();
      })();
    });
  }

  async startRelay() {
    if (!this.enableRelay) return;
    if (this.subSignal) {
      try { this.subSignal.close(); } catch (_) {}
    }
    const since = Math.floor(Date.now() / 1000) - 5;
    this.subSignal = this.pool.subscribeMany(this.relays, [
      { kinds: [25000], '#p': [this.pub], since }
    ], {
      onevent: async (ev) => {
        if (ev.created_at < since) return;
        let payload;
        try { payload = JSON.parse(ev.content); } catch { return; }
        if (payload.type !== 'offer' || !payload.sid) return;
        if (this.downstreams.size >= this.maxDownstream) {
          this.onLog('at capacity, ignoring offer');
          return;
        }

        const remotePub = ev.pubkey;
        const sid = payload.sid;
        const remoteNpub = nip19.npubEncode(remotePub);

        const pc = new RTCPeerConnection({ iceServers: this.iceServers });
        let cleaned = false, finished = false, timer = null;

        const cleanup = (reason) => {
          if (cleaned) return;
          cleaned = true;
          clearTimeout(timer);
          try { if (pc.signalingState !== 'closed') pc.close(); } catch (_) {}
          this.downstreams.delete(remoteNpub);
          this._notifyUpstreamCapacity();
          if (this.upstream?.channel?.readyState === 'open') {
            const msg = PROTO.packControl('relay-gone', { npub: remoteNpub });
            try { this.upstream.channel.send(msg); } catch (_) {}
          }
        };
        pc.close = () => cleanup('pc.close()');

        pc.addEventListener('connectionstatechange', () => {
          const s = pc.connectionState;
          if (s === 'failed' || s === 'disconnected' || s === 'closed') cleanup('PC ' + s);
        });

        pc.ondatachannel = (e) => {
          const ch = e.channel;
          ch.binaryType = 'arraybuffer';
          ch.onopen = () => {
            if (finished) return;
            finished = true; clearTimeout(timer);
            this.downstreams.set(remoteNpub, { pc, channel: ch });
            this.onDownstreamConnection(pc, remoteNpub);
            this.onLog('downstream connected', remoteNpub.slice(0, 16));
            this._notifyUpstreamCapacity();

            if (this._cachedConfigPacket && ch.readyState === 'open') {
              try { ch.send(this._cachedConfigPacket); } catch (_) {}
            }
          };
          ch.onclose = () => cleanup('channel closed');
          ch.onerror = err => this.onLog('downstream error', sid, err);
          ch.onmessage = (e) => {
            if (typeof e.data === 'string') return;
            const u8 = new Uint8Array(e.data);
            if (u8[0] === 0x10) {
              const ctl = PROTO.unpackControl(e.data);
              if (ctl.cmd === 'request-config') {
                if (this._cachedConfigPacket && ch.readyState === 'open') {
                  try { ch.send(this._cachedConfigPacket); } catch (_) {}
                }
              } else if (this.upstream?.channel?.readyState === 'open') {
                try { this.upstream.channel.send(e.data); } catch (_) {}
              }
            }
          };
        };

        try {
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await iceComplete(pc, 8000);

          const out = finalizeEvent({
            kind: 25000, created_at: Math.floor(Date.now() / 1000),
            tags: [['p', remotePub]],
            content: JSON.stringify({ type: 'answer', sdp: pc.localDescription, sid })
          }, this.priv);
          for (const p of this.pool.publish(this.relays, out)) {
            if (p && typeof p.then === 'function') p.catch(() => {});
          }
        } catch (err) {
          this.onLog('relay offer failed', sid, err);
          cleanup('offer error');
        }

        timer = setTimeout(() => { if (!finished) cleanup('timeout'); }, 60000);
      }
    });
    this.onLog('relay listening for downstreams');
  }

  _notifyUpstreamCapacity() {
    if (!this.upstream?.channel || this.upstream.channel.readyState !== 'open') return;
    const msg = PROTO.packControl('relay-update', { current: this.downstreams.size, npub: this.npub });
    try { this.upstream.channel.send(msg); } catch (_) {}
  }

  sendToDownstreams(data, excludeNpub = null) {
    for (const [npub, peer] of this.downstreams) {
      if (excludeNpub === npub) continue;
      if (peer.channel?.readyState === 'open') {
        try { peer.channel.send(data); } catch (_) {}
      }
    }
  }

  cleanup() {
    clearTimeout(this._joinTimer);
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try { this.subAdmission.close(); } catch (_) {}
    try { this.subSignal.close(); } catch (_) {}
    if (this.upstream) try { this.upstream.pc.close(); } catch (_) {}
    for (const [, peer] of this.downstreams) try { peer.pc.close(); } catch (_) {}
    this.downstreams.clear();
    try { this.pool.close(this.relays); } catch (_) {}
    this.pool = null;
  }

  stop() { this.cleanup(); }
}

/* re-export nip19 so the UI can decode npubs easily */
export { nip19 };