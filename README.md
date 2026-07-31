# Pidge - Peer to Peer, Private Posting :)

Example social media platform without central servers running entirely in the browser. Users can post text data, include images or files (max 1MB for now), repost other users' posts or reply to them. 

Try it via github pages: https://hommelwater.github.io/Pidge/

This project sets up direct peer to peer WebRTC connections using the nostr network as signalling server to setup connections. Peers cache eachother's data, and cryptographic signatures are used to verify that messages are original and unedited from the author, even when received from another peer. Optional TURN server is configurable to avoid NAT issues. 