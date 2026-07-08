import { schnorr } from 'https://esm.sh/@noble/curves@1.8.1/secp256k1';
import { sha256 } from 'https://esm.sh/@noble/hashes@1.7.1/sha256';
import * as nip19 from 'https://esm.sh/jsr/@nostr/tools@2.23.6/nip19'
import { bytesToHex, hexToBytes } from 'https://esm.sh/@noble/hashes@1.7.1/utils';

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