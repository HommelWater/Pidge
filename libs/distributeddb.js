import { openDB, deleteDB, wrap, unwrap } from 'https://cdn.jsdelivr.net/npm/idb@8/+esm'
import { NostrP2P } from './p2p.js';

export class DistributedDB { 
    constructor(secretKeyHex, database_id) {
        options = {onMessage:this.onMessageDB}
        this.p2p = NostrP2P(secretKeyHex, options);
        this.db = openDB(database_id);
        this.returns = {};  // contains identifier:async function maps for handling returns from get requests.
    }

    async put(store, data){
        const payload = {type:"put", data:data, store:store};
        await this.onMessageDB(this.p2p.npub, payload);
    }

    async get(store, key, returnFunc){
        const identifier = self.crypto.randomUUID();
        const payload = {type:"get", data:key, store:store, identifier:identifier};
        this.returns[identifier] = returnFunc;
        await this.onMessageDB(this.p2p.npub, payload);
    }

    async onMessageDB(npub, payload){
        const type = payload["type"];
        const data = payload["data"];
        if(!type || !data) return;
        if(type === "return"){
            const identifier = payload["identifier"];
            if(!identifier) return;
            const func = this.returns[identifier];
            if (!func) return;
            await func(data);
            return;
        }

        const store = payload["store"];
        const sender_npub = payload["sender"];
        this.p2p.broadcast(payload, except=[npub, sender_npub]);  // Should only conditionally broadcast, for example filtering out the sender.
        if(!store) return;
        if(type === "put"){
            await this.db.add(store, data);
            return;
        }
        if(type === "get"){
            const identifier = payload["identifier"];
            if(!identifier) return;
            const value = await this.db.get(store, data);
            this.p2p.send(sender_npub, {type:"return", identifier:identifier, data:value});
            return;
        }
        if(type === "delete"){
            this.db.delete(store, data);
            return;
        }
    }
}