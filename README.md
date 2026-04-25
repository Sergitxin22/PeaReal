# BeRealPeer

BeRealPeer is a local-first P2P desktop app built with Electron + Autopass (Holepunch stack).
There is no central backend server for feed storage or synchronization.

## Why this app is P2P

- Privacy: data is stored locally and synced peer-to-peer.
- Resilience: no single point of failure.
- Autonomy: users control their own node and data.
- Efficiency: no central infra required for core sync flow.

## Security Model (Important)

This project separates two layers:

1. Network/replication layer
- Provided by Pear/Hypercore/Autopass.
- Handles peer discovery, replication transport, and data integrity.

2. Message confidentiality layer
- Implemented at application level in `p2p/feed.js`.
- Notes are encrypted with **XChaCha20-Poly1305** using a per-message random content key (CK).
- Ciphertext is replicated to all peers.
- Plaintext is only available to peers that receive a valid key grant.
- No legacy fallback is enabled: notes are revealed only through request/grant.

Detailed deep dive available in `EXPLICATION.md`.

## Unlock Protocol (Request/Grant)

The app implements a no-backend unlock flow:

1. Author (N1) posts a message.
- N1 generates random CK (32 bytes).
- N1 encrypts message with XChaCha20-Poly1305.
- N1 stores only encrypted payload in shared feed.

2. Receiver (N2/N3) sees encrypted item.
- If receiver has not completed the local submission condition, message stays hidden.

3. Receiver requests unlock from author.
- Receiver writes `unlockReq` for target author, including receiver public key.

4. Author validates request.
- Author checks requester has submitted in current round.

5. Author grants key for that requester.
- Author wraps CK with requester's public key (RSA-OAEP-SHA256).
- Author writes `unlockGrant` for that requester.

6. Receiver decrypts locally.
- Receiver unwraps CK using its private key.
- Receiver decrypts message ciphertext locally.

Result: each peer can be granted access individually by author, without central server.

## N1 / N2 / N3 Example

- N1 publishes photo/message -> N2 and N3 receive encrypted blob.
- N2 submits its own post -> N2 creates unlock request to N1.
- N1 issues unlock grant only for N2.
- N2 decrypts N1 content locally.
- N3 remains locked until N3 submits and receives its own grant.

## Data Keys (Autopass)

- `config:currentRound`
- `round:<id>:meta`
- `round:<id>:note:<authorHex>`
- `round:<id>:unlockReq:<authorHex>:<requesterHex>`
- `round:<id>:unlockGrant:<authorHex>:<requesterHex>`

## Writer Authorization & Discovery (for challenge deliverable)

- Peer discovery and replication are handled by Pear/Autopass.
- Writer authorization in UX is invite-based (`createGroup` / `joinGroup`).
- Unlock authorization is explicit per author and per requester via request/grant records.

## Run

```bash
npm install
npm start
```

If PowerShell policy is restrictive:

```bash
npm.cmd install
npm.cmd start
```

## Local UI Cluster (Interactive)

Launch multiple Electron windows (one per local peer):

```bash
npm.cmd run cluster:local
```

The script asks how many peers to open and launches isolated users (`user1`, `user2`, ...).
