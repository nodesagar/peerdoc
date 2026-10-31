# EditorDoc P2P

> **Offline-first, peer-to-peer collaborative PDF & document editor.**  
> Users can work offline for weeks, sync directly in any order without central servers, and always converge to the exact same document.  
> *Built for SDG 9.c: Universal & equitable computing access.*

---

## 1. Architecture Overview

EditorDoc P2P decouples edit operations from raw file storage using Conflict-Free Replicated Data Types (CRDTs):
- **Document Identification**: `documentId = SHA-256(original_pdf_bytes)`. All peers opening or receiving the same PDF join the exact same collaboration room.
- **CRDT Document (`Y.Doc`)**: Manages non-conflicting operational state across nested `Y.Map` structures (`meta`, `pages`, `textOverlays`, `whiteouts`, `redactions`, `signatures`).
- **Binary Storage (`pdfStore.ts`)**: The raw PDF is stored locally in IndexedDB (`idb-keyval`) and transferred in verified 48KB chunks over WebRTC on-demand.
- **Offline Persistence (`y-indexeddb`)**: Edits survive browser refreshes, tab closures, and weeks offline.
- **Dual Transport P2P Sync (`docSync.ts`, `p2pProvider.ts`)**:
  - **Trystero WebRTC DataChannels**: Peer-to-peer over public BitTorrent trackers with zero custom server requirement.
  - **BroadcastChannel**: Instantaneous tab-to-tab fallback synchronization for local testing and multi-window work.
  - **Encrypted MQTT relay (`relayTransport.ts`)**: When WebRTC cannot connect (Wi-Fi client isolation, blocked mDNS, symmetric/CGNAT, no TURN), peers exchange messages through public MQTT brokers (HiveMQ, EMQX). Payloads are AES-256-GCM encrypted with a key derived from the room ID and published to a hashed topic, so brokers see only ciphertext. The PDF is pulled via the relay only when no direct link appears within a few seconds.
  - **State-Vector Handshake**: Upon every peer connection, reciprocal state vectors (`Y.encodeStateVector`) and deltas (`Y.encodeStateAsUpdate`) are exchanged, recovering all offline history.
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

1. **Dashboard & Demo Loader**: Load sample confidential agreement with 1 click, open local PDF, or join existing room by SHA-256 hash.
2. **Text & Eraser Tool (`EditTool.tsx`)**: Rich typography (Helvetica, Times, Courier, etc.), font sizes, colors, and whiteout boxes with nested field-level merge protection.
3. **Fractional Index Page Organizer (`OrganizeTool.tsx`)**: Reorder pages deterministically using fractional indices, rotate clockwise/counter-clockwise, restore/delete pages, and extract selections.
4. **Permanent True Redactions (`RedactTool.tsx`)**: Renders page canvas, paints solid black boxes directly into pixel data, and replaces the page with a clean rasterized image. Permanently strips all sensitive metadata.
5. **Digital Signature Tool (`SignTool.tsx`)**: Draw signatures, generate cursive typed signatures, or upload PNGs; position and stamp onto any page.
6. **Local Single-shot Utilities**: Merge multiple PDFs, stream-compress PDFs, split pages, apply diagonal text watermarks, and password-encrypt PDFs.
7. **Store-and-Forward Sync (`CollaborationBar.tsx`)**: Export `.cdsync` files to transfer updates via USB flash drives or email when peers are never online at the same time.

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
3. In the header `CollaborationBar`, click the **Share Room ID** button to copy the room URL (e.g. `http://localhost:3000/?doc=33842...`).
4. Open the copied URL in **Browser Profile B** (or Window 2).
5. Notice both tabs immediately show **"1 Peer"** and green sync indicators!
6. Disconnect Window 2 from network / close tab, make edits in both windows offline.
7. Reconnect or exchange `.cdsync` files: both documents automatically converge to identical state without data loss!
