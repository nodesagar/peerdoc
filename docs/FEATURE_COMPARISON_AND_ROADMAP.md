# EditorDoc P2P — Competitive Feature Comparison & Upgrade Roadmap

_Prepared 2026-10-31 · baseline commit `42f31bc`_

---

## 1. Where the project stands today

**Stage:** working v1.0 MVP. About 8.9k lines of TypeScript/React. 10 test files, 37 tests, all passing. Linked to a Vercel project (`editordoc-p2p`).

**What makes it different:** it is a serverless, offline-first, peer-to-peer **collaborative** PDF editor. Edits are stored in a Yjs CRDT and merge deterministically. None of the competitors below collaborate without a central server.

### 1.1 Current feature inventory

| Area | Feature | Collaborative (CRDT)? | Notes |
|---|---|---|---|
| Docs | Open local PDF; demo agreement; join by room ID or share link | — | Room ID = SHA-256 of the PDF bytes |
| Docs | Recent documents (IndexedDB, last 20) | — | |
| Edit | Free text overlays (8 fonts, size, colour, bold, italic) | ✅ | Text merges per character (`Y.Text`) |
| Edit | Whiteout / eraser boxes with custom colour | ✅ | |
| Organize | Drag-reorder (fractional index), rotate one/all, delete/restore, extract selection | ✅ | Deterministic concurrent moves |
| Redact | Draw boxes, search-and-wipe text, strip metadata | ✅ (boxes) | True redaction rasterises the **whole page** on export |
| Sign | Draw, typed cursive, or upload PNG; place and resize | ✅ | Image stamp only; no cryptographic signature |
| One-shot | Merge, split, watermark (diagonal text), encrypt (password), images to PDF | ❌ | Not tied to the room |
| One-shot | Compress | ❌ | Downscales and re-encodes RGB/gray JPEG images per level, plus object streams (fixed 2026-11-01). PNG/Flate images not yet recompressed |
| Sync | WebRTC via Trystero (BitTorrent trackers), BroadcastChannel between tabs | ✅ | |
| Sync | Encrypted MQTT relay fallback (AES-256-GCM, hashed topic) | ✅ | |
| Sync | State-vector handshake; `.cdsync` store-and-forward files | ✅ | Works air-gapped (USB, email) |
| Sync | Chunked PDF transfer (48 KB, SHA-256 verified) | ✅ | |
| Storage | `y-indexeddb` persistence of edits; original PDF kept in IndexedDB | ✅ | |
| UI | Peer count, sync status, PDF-transfer status, connection troubleshooting card, privacy modal | — | |

### 1.2 Gaps found in the code

1. **No undo/redo.** The ClearDoc reference had it; the CRDT port lost it.
2. **No service worker or PWA manifest.** Edits survive offline, but the **app shell does not load offline** after the tab is closed. This contradicts the "offline for weeks" claim.
3. **No presence.** No user names, colours, cursors, or "who changed this". `y-protocols` (awareness) is installed but not used.
4. **Room access = owning the PDF.** The relay key and topic come only from `roomId = SHA-256(pdf)` (`relayTransport.ts:21`). Trystero has no room password. Anyone with the same file (a public government form, say) or the share link can read and write the room.
5. **No annotations or comments** (highlight, sticky note, shapes, freehand, threads). Every collaborative competitor has these.
6. **No form support** (AcroForm fill or create).
7. **Redaction rasterises whole pages,** so the rest of the page loses selectable text and gets bigger.
8. **Dead code paths:** `ActiveTool` has `'ai' | 'request' | 'more' | 'convert-word'`, but no tool uses them.
9. **One-shot tools are isolated.** You can't merge, watermark, or encrypt the shared document you're editing.

---

## 2. Competitors analysed

| # | Project | Type | Why chosen |
|---|---|---|---|
| 1 | [Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF) | OSS, server and desktop, ~95k ★ | #1 PDF project on GitHub; widest toolset (60+ operations) |
| 2 | [BentoPDF](https://github.com/alam00000/bentopdf) | OSS, **client-side** browser, ~16k ★ | Closest architecture to ours: privacy-first, in-browser, WASM |
| 3 | [ONLYOFFICE Docs PDF Editor](https://www.onlyoffice.com/en/pdf-editor.aspx) | OSS server suite, ~7k ★ | Real-time **PDF co-editing**, comments, collaborative forms |
| 4 | [Documenso](https://github.com/documenso/documenso) | OSS e-signature, ~15.6k ★ | Benchmark for signing workflows (open-source DocuSign) |
| 5 | [Xodo](https://xodo.com) | Commercial web/mobile | Benchmark for collaborative annotation, sharing, and chat |

### 2.1 Stirling-PDF
Desktop app, browser UI, and self-hosted REST API. Tools: PDF text editor, page editor/multi-tool, merge, compare, compress, convert, OCR/scan cleanup, redact. Signing: sign, certificate signing, timestamp. Security: password, watermark, stamp, sanitize, flatten, unlock forms, permissions, validate signature, full info. Page formatting: crop, rotate, auto-rotate, split, reorganise, scale/page size, page numbers, multi-page layout (N-up), booklet, single large page, attachments, portfolio. Extraction: pages, images. Removal: pages, blank pages, annotations, images, password, certificate signature. Automation: auto form detection, pipelines, auto-rename, folder scanning. General: add text/image, annotate, form editor. Advanced: colour/contrast, repair, detect and split scanned photos, overlay PDFs, replace/invert colour, show JavaScript. Also: AI assistant, MCP server, SSO/SAML, audit logging, 40+ UI languages, review workflow, Google Drive storage, mobile scanner.

### 2.2 BentoPDF
All processing in the browser (WASM: PyMuPDF, Ghostscript, CPDF); air-gapped deployment possible. **Organize:** merge (keeps bookmarks), split, organise/duplicate, extract, delete, rotate (custom degrees), N-up, alternate/mix, posterize, multi-tool, booklet, attachments (add/extract/edit), divide pages, combine to single page, blank page, reverse, view metadata, PDFs to ZIP, compare. **Edit:** annotate/highlight/comment/shapes/images/search, **edit existing text** (reuses embedded fonts), create fillable forms, form filler (incl. XFA), page numbers, Bates numbering, text/image watermark, header/footer, crop, deskew, font to outline, invert, background colour, text colour, flatten, remove annotations, remove blank pages, bookmarks editor, stamps, table of contents, redact, scanner effect, adjust colours. **Automate:** visual workflow builder. **Convert to PDF:** ~17 image formats, Office (DOCX/XLSX/PPTX/ODF/RTF), CSV, Markdown, text, JSON, XML, EPUB. **Convert from PDF:** images (JPG/PNG/WebP/BMP/TIFF/SVG), CBZ, greyscale, text, JSON, CSV/Excel tables, OCR. **Secure:** compress, repair, encrypt/decrypt, permissions, X.509 digital signature, validate signature, edit/remove metadata, linearize, sanitize, fix page size, page dimensions, remove restrictions. 20+ translations, custom branding, disabling individual tools.

### 2.3 ONLYOFFICE Docs (PDF Editor)
Edits existing text and images, fonts, alignment, hyperlinks. Annotations: comments and sticky notes, callouts, highlight/underline/strikethrough, shapes, freehand, reply and resolve threads. **Co-editing modes** (Strict with locking, or Fast real-time). Forms: build from DOCX, templates, or scratch; text, dropdown, combo, radio, checkbox, and signature fields; required fields, date masks; **collaborative form filling**; roles per section. Page reorder, delete, rotate, insert from another PDF. Share with view or comment permission; activity attribution (who did what, when). OCR via AI plugin. True redaction (manual, search, page range). Password. Desktop, web, and mobile.

### 2.4 Documenso
Field types: signature, text, date, and others. Recipient roles: signer, approver, viewer, CC. Signing order. Recipient authentication (2FA, passkeys, access auth). Templates, direct signing links, multi-recipient sending, visual workflow builder, completion email with signed copy, audit trail and signing certificate, compliance (ESIGN, UETA, 21 CFR Part 11). Teams, API, webhooks, embedding (React/Vue), Zapier, white-label, self-hosting.

### 2.5 Xodo
Real-time shared viewing and annotation by public link or invite, in-document chat, annotations synced across devices, highlight/underline/strikeout/comments/arrows/shapes/drawing, form fill, sign, cloud storage (Drive, Dropbox, OneDrive), web, desktop, and mobile apps.

---

## 3. Master feature list vs. EditorDoc P2P

Legend: ✅ has · ◐ partial · ❌ missing. Columns: **SP** Stirling-PDF, **BP** BentoPDF, **OO** ONLYOFFICE, **DM** Documenso, **XO** Xodo, **Us** EditorDoc P2P.

### 3.1 Collaboration & sync
| Feature | SP | BP | OO | DM | XO | Us |
|---|---|---|---|---|---|---|
| Real-time multi-user editing | ❌ | ❌ | ✅ | ❌ | ◐ | ✅ |
| Serverless P2P sync | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Works offline for days, then merges | ❌ | ◐ | ❌ | ❌ | ❌ | ✅ |
| Air-gapped sync file (`.cdsync`) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| E2E-encrypted relay | ❌ | n/a | ❌ | ❌ | ❌ | ✅ |
| Presence (names, colours, cursors) | ❌ | ❌ | ✅ | ❌ | ◐ | ✅ (M2) |
| Activity attribution (who changed what) | ◐ audit | ❌ | ✅ | ✅ audit | ◐ | ◐ (M2: who added, when) |
| Comment threads (reply/resolve) | ◐ | ◐ | ✅ | ❌ | ✅ | ✅ (M2) |
| Chat | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ |
| Permissions (view / comment / edit) | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| Room secret / access control | ✅ SSO | n/a | ✅ | ✅ | ✅ | ✅ (M1, link key) |
| Version history / snapshots | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Undo / redo | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ (M1) |
| Review / approval workflow | ✅ | ❌ | ◐ | ✅ | ❌ | ❌ |

### 3.2 Viewing & annotation
| Feature | SP | BP | OO | DM | XO | Us |
|---|---|---|---|---|---|---|
| Viewer with zoom, search, thumbnails | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ |
| Highlight / underline / strikethrough | ✅ | ✅ | ✅ | ❌ | ✅ | ◐ (M2: area highlight) |
| Sticky notes / callouts | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ (M2) |
| Shapes / arrows / lines | ✅ | ✅ | ✅ | ❌ | ✅ | ◐ (M2: boxes) |
| Freehand ink | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ (M2) |
| Image insert | ✅ | ✅ | ✅ | ❌ | ✅ | ◐ (signature only) |
| Stamps (Approved, Draft, …) | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Remove / flatten annotations | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Keyboard shortcuts | ✅ | ◐ | ✅ | ❌ | ✅ | ❌ |
| Dark mode / accessibility | ◐ | ✅ | ✅ | ✅ | ✅ | ❌ |
| UI translations | ✅ 40+ | ✅ 20+ | ✅ | ✅ | ✅ | ❌ |

### 3.3 Editing content
| Feature | SP | BP | OO | DM | XO | Us |
|---|---|---|---|---|---|---|
| Add free text | ✅ | ✅ | ✅ | ◐ | ✅ | ✅ |
| Whiteout | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Edit existing PDF text in place | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Hyperlinks | ◐ | ◐ | ✅ | ❌ | ◐ | ❌ |
| Page numbers | ✅ | ✅ | ❌ | ❌ | ◐ | ❌ |
| Bates numbering | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Header / footer | ◐ | ✅ | ◐ | ❌ | ❌ | ❌ |
| Text watermark | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ (one-shot) |
| Image watermark | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Crop | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Bookmarks / TOC editor | ✅ | ✅ | ◐ | ❌ | ◐ | ❌ |
| Colour adjust / invert / greyscale | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

### 3.4 Forms & signing
| Feature | SP | BP | OO | DM | XO | Us |
|---|---|---|---|---|---|---|
| Fill AcroForm fields | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Collaborative form filling | ❌ | ❌ | ✅ | ◐ | ❌ | ❌ |
| Create fillable forms | ✅ | ✅ | ✅ | ◐ | ✅ | ❌ |
| Auto form-field detection | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Visual signature (draw/type/upload) | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ |
| Cryptographic signature (X.509/PAdES) | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| Validate signatures | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| Timestamp (TSA) | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |
| Signer roles and signing order | ❌ | ❌ | ◐ | ✅ | ❌ | ❌ |
| Signature fields assigned per person | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ |
| Audit trail / completion certificate | ◐ | ❌ | ❌ | ✅ | ❌ | ❌ |
| Templates / direct signing links | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ |

### 3.5 Pages & documents
| Feature | SP | BP | OO | DM | XO | Us |
|---|---|---|---|---|---|---|
| Reorder / rotate / delete / extract | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Insert blank page | ✅ | ✅ | ◐ | ❌ | ✅ | ❌ |
| Insert pages from another PDF into the doc | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ (merge is one-shot) |
| Duplicate page | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Merge / split | ✅ | ✅ | ◐ | ❌ | ✅ | ✅ (one-shot) |
| N-up / booklet / posterize | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Remove blank pages | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Compare two PDFs | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Attachments (add/extract) | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| Batch / multi-file processing | ✅ | ✅ | ❌ | ✅ | ❌ | ◐ (merge) |
| Workflow / pipeline automation | ✅ | ✅ | ✅ macros | ✅ | ❌ | ❌ |

### 3.6 Conversion & OCR
| Feature | SP | BP | OO | DM | XO | Us |
|---|---|---|---|---|---|---|
| Images to PDF | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Office (DOCX/XLSX/PPTX) to PDF | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| PDF to images | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| PDF to text / Markdown / DOCX | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Table extraction (CSV/XLSX) | ◐ | ✅ | ❌ | ❌ | ❌ | ❌ |
| OCR (scanned to searchable) | ✅ | ✅ | ◐ | ❌ | ✅ | ❌ |
| Deskew / scan cleanup / mobile scanner | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| PDF/A (archival) | ✅ | ✅ (Kura) | ✅ | ✅ | ❌ | ❌ |

### 3.7 Security & optimisation
| Feature | SP | BP | OO | DM | XO | Us |
|---|---|---|---|---|---|---|
| True redaction | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ (whole-page raster) |
| Search-based redaction | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Pattern redaction (emails, phone numbers, IDs, regex) | ✅ | ◐ | ❌ | ❌ | ❌ | ❌ |
| Metadata view / edit / strip | ✅ | ✅ | ◐ | ❌ | ❌ | ◐ (strip only) |
| Sanitize (JS, embedded files, links) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Password encrypt | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Decrypt / unlock (password known) | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ (encrypted PDFs can't be opened) |
| Permissions (print/copy) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Real compression (image downsampling) | ✅ | ✅ | ❌ | ❌ | ✅ | ◐ (JPEG images) |
| Repair corrupt PDF | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Linearize (fast web view) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

### 3.8 Platform
| Feature | SP | BP | OO | DM | XO | Us |
|---|---|---|---|---|---|---|
| Installable / offline app shell | ✅ desktop | ✅ air-gap | ✅ desktop | ❌ | ✅ apps | ✅ (M1) |
| Mobile-friendly UI | ◐ | ✅ | ✅ | ✅ | ✅ | ◐ |
| Self-hosting | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ (static) |
| REST API / embedding SDK | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |
| Cloud storage connectors | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ |
| AI assistant (summarise, Q&A) | ✅ | ❌ | ✅ plugin | ❌ | ✅ | ❌ |
| SSO / audit logging | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |

---

## 4. What we do **not** adopt (and why)

Not every feature fits a serverless, offline-first, collaborative editor.

| Feature | Decision | Reason |
|---|---|---|
| SSO, enterprise audit logging, clustering, REST API, folder scanning, Telegram bot | **Won't do** | Needs a server; contradicts the no-server design |
| Cloud storage connectors (Drive, Dropbox) | **Won't do (now)** | Adds OAuth plus third-party data flow; `.cdsync` and the P2P link cover sharing |
| Office/EPUB/PSD to PDF, PDF to DOCX/XLSX | **Defer** | Needs heavy WASM (LibreOffice ~50 MB+) and isn't core to collaboration. Revisit if users ask |
| N-up, booklet, posterize, CBZ, scanner effect, font to outline, colour tools | **Defer** | Niche print tools; the one-shot toolbox is not our differentiator |
| Email-based signing (DocuSign style), Stripe, Zapier, webhooks | **Won't do** | Needs a server and accounts. A P2P signing flow (below) covers the core need |
| Cloud AI assistant | **Defer** | Sends document text to a third party, which conflicts with the privacy promise. An on-device model may be possible later |
| Visual workflow builder | **Defer** | Premature until there are enough tools to chain |
| Chat panel | **Defer** | Comment threads cover discussion tied to the document |

**Strategy:** don't race Stirling and BentoPDF on tool count (60+). Win on **collaboration that works without servers or internet**, and close the table-stakes gaps users expect from any PDF editor.

---

## 5. Roadmap

Scoring: **Impact** (1–5) × **Fit** with the P2P/CRDT core (1–5) ÷ **Effort** (S = 1, M = 2, L = 3).

### 5.0 P0 prerequisite — security fix (do first, small)
**Room secret / access control.** Today, anyone who has the same PDF can compute the room ID and the relay key.
- Add an optional room passphrase. Derive `roomKey = HKDF(roomId ‖ passphrase)`. Use it for the relay key and topic, and as the Trystero `password` (Trystero encrypts SDP signalling with it).
- Share link carries the secret in the URL fragment (`#k=…`). Fragments are never sent to a server or tracker.
- Effort S. Touches `relayTransport.ts`, `p2pProvider.ts`, `App.tsx` (`parseRoomId`), and the share button.

### 5.1 The Top 5 — definitely worth building

| # | Feature | Impact | Fit | Effort | Score | Why |
|---|---|---|---|---|---|---|
| 1 | **Installable PWA / true offline app shell** | 5 | 5 | S | 25 | The headline promise ("offline for weeks") is false today if the tab is closed with no network. A service worker plus manifest fixes it. Key for SDG 9.c low-connectivity users |
| 2 | **Collaborative annotations + comment threads** | 5 | 5 | M | 12.5 | Every collaborative competitor (ONLYOFFICE, Xodo, BentoPDF, Stirling) has highlight, sticky note, shapes, freehand, reply/resolve. It's the main reason people open a shared PDF. Fits as new `Y.Map`s |
| 3 | **Presence & attribution** | 4 | 5 | S | 20 | Names, colours, live cursors, the selection each peer is editing, and "added by X · 2 h ago" on every object. Yjs awareness is already installed (`y-protocols`). Without it, collaboration feels anonymous and confusing |
| 4 | **Per-user undo / redo** | 5 | 5 | S | 25 | Basic expectation; the reference app had it. `Y.UndoManager` scoped to the local origin undoes only *your* changes, never a peer's |
| 5 | **Form filling (AcroForm), collaborative** | 5 | 4 | M | 10 | Government, school, and job forms are the most common real-world PDF task for SDG target users. pdf-lib already reads and writes AcroForm fields. Field values in a `Y.Map` let a family or team fill one form together offline |

Build order: **4, 1, P0, 3, 2, 5.** Small, high-score items go first, and comments (2) need presence (3) for attribution.

#### Implementation notes for the Top 5
1. **PWA:** hand-written `public/sw.js`. Precache the Vite build output (manifest list generated at build), cache-first for hashed assets, network-first for `index.html`. Add `manifest.webmanifest` and icons. Show an "Install app" prompt and an "Update available" toast. Test: load once, go offline, reload, and the app opens with the last room.
2. **Annotations:** new CRDT maps `annotations` (type: `highlight | underline | strike | note | rect | ellipse | arrow | line | ink`, pageIndex, geometry in %, colour, author, createdAt) and `comments` (threadId, parentId, `Y.Text` body, author, resolved). Use the pdf.js text layer to snap highlights to text quads. Export option: write real PDF annotation objects (`/Highlight`, `/Text`, `/Ink`) so comments show up in Acrobat, or flatten them.
3. **Presence:** `awareness.setLocalStateField('user', { name, color })` plus `{ tool, pageIndex, cursor, selectionId }`. Send awareness over the same transports (`docSync.ts`). Avatar stack in `CollaborationBar`; coloured outline on objects another peer is editing. Store an `author` field on every CRDT object (needed by 2 and 5).
4. **Undo:** one `Y.UndoManager` over all mutable maps, with `trackedOrigins` set to the local origin. `Ctrl/Cmd+Z` and `Shift+Ctrl/Cmd+Z`, plus toolbar buttons. Tag every `doc.transact` in `schema.ts` with the local origin.
5. **Forms:** on open, read fields with `pdfDoc.getForm().getFields()` and seed a `formFields` map (deterministic like the page seed). Render HTML inputs over the pdf.js annotation layer. On export, `field.setText / check / select`, then optionally `form.flatten()`. Handle signature fields by linking to the Sign tool.

### 5.2 P1 — high value, next wave

| Feature | Impact | Fit | Effort | Notes |
|---|---|---|---|---|
| Version history & named checkpoints | 4 | 5 | M | Yjs snapshots (`Y.snapshot`, needs `gc: false` or periodic full snapshots in IndexedDB). "Restore" and "show changes since checkpoint". Competitors: ONLYOFFICE only |
| P2P signing workflow | 4 | 4 | L | Assign signature fields per participant, signing order, visible status ("2 of 3 signed"), and a signed **audit page** appended to the PDF (hashes plus timestamps from CRDT history). Documenso's core flow, without a server or email |
| Room permissions (view / comment / edit) | 4 | 3 | M | Owner keypair signs a role list; peers ignore updates from unauthorised keys. Hard in a pure CRDT, so design carefully |
| Selective (vector) redaction | 4 | 4 | M | Rasterise only redacted regions, or remove text-show operators inside boxes, so the rest of the page keeps selectable text and stays small |
| Pattern redaction | 4 | 4 | S | Presets for emails, phone numbers, IBANs/cards, national IDs, plus custom regex, built on the existing Search Wipe |
| Open password-protected PDFs | 3 | 4 | S | Ask for the password and decrypt locally. Today encrypted PDFs fail to open |
| Insert pages / blank page / duplicate into the shared doc | 4 | 5 | M | Multi-source page model: `pages` entries gain `sourceDocId`, and extra PDFs are stored and transferred like the original. Turns one-shot merge into a collaborative feature |
| Page numbers, header/footer, Bates | 3 | 4 | S | CRDT-stored settings, applied at export |
| Real compression, part 2 | 2 | 3 | M | JPEG recompression shipped. Remaining: Flate/PNG images (decode via `DecompressionStream`, handle predictors and colour spaces) |
| Viewer upgrades: zoom, text search, thumbnails sidebar, keyboard shortcuts | 4 | 4 | M | Table stakes in every competitor |
| Images and stamps (Approved, Draft, custom) | 3 | 5 | S | Generalise `signatures` into `images` with a stamp library |

### 5.3 P2 — nice to have

| Feature | Notes |
|---|---|
| On-device OCR (tesseract.js, lazy-loaded) | Makes scanned PDFs searchable, highlightable, and redactable |
| Create fillable forms (form designer) | After form filling ships |
| Compare two versions / two PDFs | Visual diff using version history |
| Metadata editor (view and edit, not just strip) | Small |
| Sanitize (remove JS, embedded files, links) | Small; fits the privacy story |
| Cryptographic signatures (PAdES via WebCrypto, user-supplied PFX) | Key never leaves the browser |
| PDF to images / text export | Small with pdf.js already loaded |
| Dark mode, i18n, accessibility pass, mobile layout | Important for reach; ongoing |
| Bookmarks / outline editor | |
| Crop pages | Store a CropBox per page in the CRDT |
| Edit existing PDF text in place | Very hard; whiteout plus text covers most needs. Revisit last |

### 5.4 Cleanup (with the first PR)
- Remove the unused `ActiveTool` values `'ai' | 'request' | 'more' | 'convert-word'`.
- Remove duplicate `.js` siblings next to `.tsx`/`.ts` (`src/lib/utils.js`, `src/components/ui/highlighter.js`, `src/workers/pdf.worker.js`) if unused.
- README: state the access model honestly until P0 ships ("anyone with the share link or the same PDF can join").

---

## 6. Milestones

| Milestone | Contents | Exit check |
|---|---|---|
| **M1 Foundations** ✅ done 2026-10-31 | Undo/redo, PWA, room secret, cleanup | Reload offline opens the app; Ctrl+Z undoes only local edits (test); a wrong passphrase can't decrypt relay traffic (test) |
| **M2 Real collaboration** ✅ done 2026-11-01 | Presence plus attribution, annotations plus comment threads | Two peers see each other's cursors; a comment thread converges after offline edits (convergence test) |
| **M3 Forms** | Collaborative AcroForm filling plus export/flatten | Sample government form filled by 2 peers exports with correct values |
| **M4 Trust** | Version history, selective plus pattern redaction, P2P signing workflow with audit page | Restore checkpoint; redacted text not extractable while other text still selectable |
| **M5 Breadth** | P1 remainder, then P2 by user demand | — |

---

_Sources: [Stirling-PDF repo](https://github.com/Stirling-Tools/Stirling-PDF) · [Stirling-PDF tools docs](https://docs.stirlingpdf.com/Tools/) · [BentoPDF repo](https://github.com/alam00000/bentopdf) · [ONLYOFFICE PDF workflows (2026)](https://www.onlyoffice.com/blog/2026/08/pdf-workflows-without-adobe-in-onlyoffice) · [ONLYOFFICE Docs 8.2 co-editing](https://www.linuxlinks.com/onlyoffice-docs-8-2-boosts-collaboration/) · [ONLYOFFICE Document Server](https://github.com/onlyoffice/documentserver) · [Documenso repo](https://github.com/documenso/documenso) · [Documenso site](https://documenso.com) · [Documenso user docs](https://docs.documenso.com/docs/users) · [Xodo Chrome listing](https://chrome.google.com/webstore/detail/xodo-pdf-viewer-editor/okimpmfnmbjbaciaeaikdiecpobfomfh) · [Xodo review (FitGap)](https://us.fitgap.com/products/xodo)_
