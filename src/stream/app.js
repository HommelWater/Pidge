import { generateSecretKey, getPublicKey } from 'https://esm.sh/jsr/@nostr/tools@2.23.6/pure';
import { NostrP2P } from '/lib/p2p.js';
import { bytesToHex, hexToBytes } from 'https://esm.sh/@noble/hashes@1.7.1/utils';

let profile = JSON.parse(localStorage.getItem("userinfo"));
console.log(profile);
if (!profile){
    const skraw = generateSecretKey()
    const sk = bytesToHex(skraw);
    const pk = getPublicKey(skraw);
    profile = {username:"", avatarUrl:"", bio:"", nsec:sk, npub:pk}
    localStorage.setItem("userinfo", JSON.stringify(profile));
    location.href = "/settings"
}
const sk = profile["nsec"]
const p2p = new NostrP2P(sk);