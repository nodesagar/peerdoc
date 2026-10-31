# EditorDoc P2P

> **Offline-first, peer-to-peer collaborative PDF & document editor.**  
> Users can work offline for weeks, sync directly in any order without central servers, and always converge to the exact same document.  
> *Built for SDG 9.c: Universal & equitable computing access.*

---

## 1. Architecture Overview

EditorDoc P2P decouples edit operations from raw file storage using Conflict-Free Replicated Data Types (CRDTs):
- **Document Identification**: `documentId = SHA-256(original_pdf_bytes)` names the file and verifies transferred chunks.
- **Invite-only Rooms (`access.ts`, `roomKey.ts`)**: Whoever opens a PDF owns its room. Each browser has its own P-256 key pairs (private keys non-extractable, kept in IndexedDB). The owner signs a roster that lists the members and seals the random 128-bit room key separately to each member (ECDH, then HKDF, then AES-GCM). Every transport derives its channel from that key, so having the PDF is not enough to join. **Inviting** creates a one-time link (`?doc=<id>#i=<token>&o=<owner>`); its holder knocks on a control channel with a request sealed to the token, and the owner's browser admits them automatically. **Removing** someone rotates the room key and seals the new one to everyone else, so the removed browser can no longer find or read the room. Members pass the newest owner-signed roster to each other, so anyone online brings a returning member up to date. There is no server: the public trackers and relay only ever carry signed or encrypted data. Limits: the owner's browser must be online for an invitee's first join; a removed person keeps what they already had; a member who was offline during a removal can still send their own offline edits to the removed person before they hear about it; if the owner's browser storage is lost, the member list can no longer change.
- **CRDT Document (`Y.Doc`)**: Manages non-conflicting operational state across nested `Y.Map` structures (`meta`, `pages`, `textOverlays`, `whiteouts`, `redactions`, `signatures`).
- **Binary Storage (`pdfStore.ts`)**: The raw PDF is stored locally in IndexedDB (`idb-keyval`) and transferred in verified 48KB chunks over WebRTC on-demand.
- **Offline Persistence (`y-indexeddb`)**: Edits survive browser refreshes, tab closures, and weeks offline.
- **Dual Transport P2P Sync (`docSync.ts`, `p2pProvider.ts`)**:
  - **Trystero WebRTC DataChannels**: Peer-to-peer over public BitTorrent trackers with zero custom server requirement.
  - **BroadcastChannel**: Instantaneous tab-to-tab fallback synchronization for local testing and multi-window work.
  - **Encrypted MQTT relay (`relayTransport.ts`)**: When WebRTC cannot connect (Wi-Fi client isolation, blocked mDNS, symmetric/CGNAT, no TURN), peers exchange messages through public MQTT brokers (HiveMQ, EMQX). The relay is always connected and carries CRDT edits alongside WebRTC. Payloads are AES-256-GCM encrypted with a key derived from the document ID plus room key and published to a hashed topic, so brokers see only ciphertext. The PDF is pulled via the relay only if it has not arrived over a direct link within a few seconds.
  - **State-Vector Handshake**: Upon every peer connection, reciprocal state vectors (`Y.encodeStateVector`) and deltas (`Y.encodeStateAsUpdate`) are exchanged, recovering all offline history.
- **Presence (`presence.ts`)**: Yjs awareness over the same transports shows who is in the room, which tool they have open, their live cursors and what they have selected. Never stored in the document; relay links get at most one presence message per 400 ms so cursor streams can't flood public brokers.
- **Per-User Undo/Redo**: A `Y.UndoManager` tracks only this user's edits (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, toolbar buttons). Peer edits, IndexedDB loads, `.cdsync` imports and document seeding are never undone.
- **Installable Offline App (PWA)**: A service worker (`src/sw.js`, generated at build with every asset precached) serves the app shell cache-first, so the editor opens with no network. New versions install in the background and apply when the user clicks **Reload**.
- **Store-and-Forward (`fileSync.ts`)**: Air-gapped file sync via `.cdsync` files containing idempotent delta updates.
- **True Redaction**: Burns redaction boxes directly into canvas pixels, scrubbing underlying text streams and font glyphs permanently.

```
+-----------------------------------------------------------------------------------------+
|                                    EditorDoc P2P                                        |
+-----------------------------------------------------------------------------------------+
|                                                                                         |
|   +-----------------------+     +-----------------------+     +---------------------+   |
|   |  Edit / Whiteout Tool |     |  Organize / Reorder   |     | True Redaction Tool |   |
|   +-----------+-----------+     +-----------+-----------+     +----------+----------+   |
|               |                             |                            |              |
|               +----------------------+      |      +---------------------+              |
|                                      |      |      |                                    |
|                                      v      v      v                                    |
|                             +-------------------------------+                           |
|                             |        useCRDTSync Hook       |                           |
|                             +---------------+---------------+                           |
|                                             |                                           |
|                     +-----------------------+-----------------------+                   |
|                     |                                               |                   |
|                     v                                               v                   |
|       +---------------------------+                   +---------------------------+     |
|       |     Yjs Document Engine   |                   |    Original PDF Store     |     |
|       |       (schema.ts)         |                   |       (pdfStore.ts)       |     |
|       +-------------+-------------+                   +-------------+-------------+     |
|                     |                                               |                   |
|         +-----------+-----------+                                   |                   |
|         v                       v                                   v                   |
|  +--------------+       +---------------+                   +---------------+           |
|  | y-indexeddb  |       |  Sync Engine  |                   |  48KB Chunker |           |
|  | (Local IDB)  |       | (docSync.ts)  |                   |   & SHA-256   |           |
|  +--------------+       +-------+-------+                   +-------+-------+           |
|                                 |                                   |                   |
|                +----------------+----------------+                  |                   |
|                |                                 |                  |                   |
|                v                                 v                  v                   |
|      +--------------------+            +-------------------+--------------------+       |
|      |  BroadcastChannel  |            | Trystero (WebRTC) | .cdsync File Sync  |       |
|      |    (Local Tabs)    |            |   (Remote P2P)    | (Store & Forward)  |       |
|      +--------------------+            +-------------------+--------------------+       |
+-----------------------------------------------------------------------------------------+
```

---

## 2. Key Features

1. **Dashboard & Demo Loader**: Load sample confidential agreement with 1 click, open local PDF, or join a room by pasting a personal invite link (`?doc=<id>#i=<token>&o=<owner>`).
2. **Text & Eraser Tool (`EditTool.tsx`)**: Rich typography (Helvetica, Times, Courier, etc.), font sizes, colors, and whiteout boxes with nested field-level merge protection.
3. **Fractional Index Page Organizer (`OrganizeTool.tsx`)**: Reorder pages deterministically using fractional indices, rotate clockwise/counter-clockwise, restore/delete pages, and extract selections.
4. **Permanent True Redactions (`RedactTool.tsx`)**: Renders page canvas, paints solid black boxes directly into pixel data, and replaces the page with a clean rasterized image. Permanently strips all sensitive metadata.
5. **Digital Signature Tool (`SignTool.tsx`)**: Draw signatures, generate cursive typed signatures, or upload PNGs; position and stamp onto any page.
6. **Local Single-shot Utilities**: Merge multiple PDFs, compress PDFs (downscale and re-encode JPEG photos/scans per level, object streams), split pages, apply diagonal text watermarks, and password-encrypt PDFs.
7. **Review & Comments (`Annotations.tsx`)**: Highlight, box, freehand and sticky-note markup; every annotation is a comment thread with replies, resolve/reopen and a Comments panel. Exported PDFs keep the markup and turn open threads into real PDF sticky notes.
8. **Presence & Attribution**: Avatars of everyone in the room (click yours to rename), live cursors and selections in the editor, and "Added by … · 5 minutes ago" on every item.
9. **Store-and-Forward Sync (`CollaborationBar.tsx`)**: Export `.cdsync` files to transfer updates via USB flash drives or email when peers are never online at the same time.

---

## 3. Getting Started

### Prerequisites
- Node.js 18+ (tested with Node v25.9.0)
- npm or pnpm

### Installation
```bash
git clone <repo> editordoc-p2p
cd editordoc-p2p
npm install
```

### Running Locally
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### Running Tests
EditorDoc P2P includes a comprehensive Vitest test suite covering fractional indexing, multi-peer offline convergence, state-vector handshakes, `.cdsync` idempotency, and binary chunk verification.
```bash
npm test
```

### Building for Production
```bash
npm run build
```

---

## 4. Multi-Peer Verification Procedure

To verify real-time and offline peer convergence:

1. Open `http://localhost:3000` in **Browser Profile A** (or Window 1).
2. Click **"Load Demo Agreement"**.
3. In the header `CollaborationBar`, click **Share**, type who the invite is for, and click **Invite**. This copies a one-time link (e.g. `http://localhost:3000/?doc=33842...#i=...&o=...`).
4. Open the copied URL in **Browser Profile B** (a different profile or a private window, so it has its own identity). Profile A admits it automatically. To test removal, click the remove button next to that person in **Share**.
5. Notice both tabs immediately show **"1 Peer"** and green sync indicators!
6. Disconnect Window 2 from network / close tab, make edits in both windows offline.
7. Reconnect or exchange `.cdsync` files: both documents automatically converge to identical state without data loss!
