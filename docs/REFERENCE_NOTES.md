# ClearDoc Reference Analysis & Architecture Notes

## 1. Existing Features Overview

ClearDoc is a client-side local PDF utility web application with the following tools:

1. **Dashboard & History (`Dashboard.tsx`, `App.tsx`)**:
   - Feature launch cards for all tools.
   - Recent processed documents list (`cleardoc_recent_docs`) saved via `idb-keyval` containing id, name, action, size, timestamp, and optional blob/dataUrl.
   - Header with quick navigation and privacy modal.

2. **Edit Tool (`EditTool.tsx`)**:
   - Freeform text placement and editing (font family, font size, bold, italic, color).
   - Eraser / whiteout box placement (custom colors, bounding box).
   - Single-page view or continuous vertical scroll view via `react-pdf`.
   - Undo/redo history stack (in-memory state in reference).
   - Download/save modified PDF.

3. **Organize Tool (`OrganizeTool.tsx`, `PageThumbnailGrid.tsx`)**:
   - Page reordering using `@dnd-kit/core` and `@dnd-kit/sortable`.
   - Page rotation (clockwise/counter-clockwise 90° increments).
   - Page deletion (marking pages as deleted).
   - Multi-page selection and extraction.
   - Lazy/intersection-observed thumbnail rendering for high page counts.

4. **Redact Tool (`RedactTool.tsx`)**:
   - Manual black rectangle drawing over sensitive sections.
   - Text search wipe ("Confidential", regex/search wipe overlay generation).
   - Metadata sanitization (clearing author, title, producer, subject).
   - Coordinate bounding box tracking per page.

5. **Sign Tool (`SignTool.tsx`)**:
   - Drawing digital signatures on canvas.
   - Typed signature generator with cursive fonts.
   - Uploading signature image.
   - Positioning, resizing, and stamping signatures onto arbitrary pages.

6. **Single-shot / Destructive Tools**:
   - **Merge (`MergeTool.tsx`)**: Combine multiple uploaded PDFs into a single document using `pdf-lib`'s `copyPages`.
   - **Compress (`CompressTool.tsx`)**: Stream optimization and metadata stripping.
   - **Split (`SplitTool.tsx`)**: Extract page ranges.
   - **Watermark (`WatermarkTool.tsx`)**: Diagonal text watermark stamping with customizable opacity and font size.
   - **Encrypt (`EncryptTool.tsx`)**: Password protection using `pdf-lib-plus-encrypt`.
   - **Conversions (`ConvertTool.tsx`, `GenericConvertTool.tsx`)**: Images to PDF, DOCX to PDF via WASM.

---

## 2. Tool Data Models

### TextOverlay
```typescript
interface TextOverlay {
  id: string; // crypto.randomUUID()
  pageIndex: number;
  x: number; // percentage of page width (0 - 100)
  y: number; // percentage of page height (0 - 100)
  text: string;
  fontSize: number;
  color?: string; // hex color e.g. '#1a1c1c'
  fontFamily?: 'Helvetica' | 'Arial' | 'Verdana' | 'TimesRoman' | 'Times New Roman' | 'Georgia' | 'Courier' | 'Courier New';
  isBold?: boolean;
  isItalic?: boolean;
}
```

### WhiteoutBox
```typescript
interface WhiteoutBox {
  id: string; // crypto.randomUUID()
  pageIndex: number;
  x: number; // percentage of page width
  y: number; // percentage of page height
  width: number; // percentage of page width
  height: number; // percentage of page height
  color?: string; // hex color e.g. '#ffffff'
}
```

### RedactionBox
```typescript
interface RedactionBox {
  id: string; // crypto.randomUUID()
  pageIndex: number;
  x: number; // percentage of page width
  y: number; // percentage of page height
  width: number;
  height: number;
  label?: string;
}
```

### SignatureBox
```typescript
interface SignatureBox {
  id: string; // crypto.randomUUID()
  pageIndex: number;
  x: number; // percentage of page width
  y: number; // percentage of page height
  width: number;
  height: number;
  dataUrl: string; // PNG base64 data URL
}
```

### Page Organization Model
- **`pageOrder`**: Array of original page indices, e.g. `[0, 2, 1]`.
- **`rotations`**: Map of original index -> rotation offset degrees (e.g. `rotations[0] = 90`).
- **`deletedPages`**: Array/Set of deleted page indices.

---

## 3. PDF Lib, PDF.js & Canvas Dependencies

| Tool | Core Engine Calls | Notes |
| :--- | :--- | :--- |
| **Viewer / Canvas** | `pdfjs.getDocument()`, `pdfjs.Page.render()`, `react-pdf` (`<Document>`, `<Page>`) | Renders page canvas and handles zoom scale. Coordinates are converted between screen percentage and PDF point dimensions `(pWidth, pHeight)`. |
| **Edit Tool** | `PDFDocument.load()`, `page.drawRectangle()`, `page.drawText()`, `pdfDoc.embedFont(StandardFonts)` | Draws whiteout rectangles and overlays text at baseline `pHeight - (y/100)*pHeight - fontSize`. |
| **Organize Tool** | `PDFDocument.create()`, `newDoc.copyPages(sourceDoc, pageOrder)`, `page.setRotation(degrees(...))` | Copies pages in target sequence and applies cumulative angle offsets. |
| **Redact Tool** | `page.drawRectangle({ color: rgb(0,0,0) })` | *In reference: purely visual black box. For Peer Docs: must truly scrub underlying stream / rasterize.* |
| **Sign Tool** | `pdfDoc.embedPng(dataUrl)`, `page.drawImage()` | Converts canvas strokes to PNG data URL and embeds into PDF page coordinates. |
| **Compress Tool**| `pdfDoc.save({ useObjectStreams: true })`, metadata removal | Optimizes PDF cross-reference streams. |
| **Merge Tool** | `mergedPdf.copyPages(source, pageIndices)` | Concatenates multiple PDF byte streams. |
| **Split Tool** | `newDoc.copyPages(src, selectedIndices)` | Extracts subset of pages into new document. |

---

## 4. Key Differences in Peer Docs Architecture

1. **State Ownership**:
   - Reference: Ephemeral React `useState` inside each individual component; loses edits on navigation or reload; zero collaboration.
   - Peer Docs: Centralized `Y.Doc` managed by `useCRDTSync` backed by `y-indexeddb` and synced via P2P WebRTC (`trystero`) and local `BroadcastChannel`.

2. **Page Ordering**:
   - Reference: `number[]` array of indices (cannot merge concurrently without conflicts).
   - Peer Docs: Fractional index string order on a `Y.Map<pageId, Y.Map>`, allowing deterministic non-conflicting page insertions and movements between peers.

3. **Field-level Granular Merges**:
   - Overlays, boxes, and metadata are nested `Y.Map` objects with Y.Text / primitive fields. Edits to x/y coordinates and text content merge concurrently without overwriting.

4. **Security / Redaction**:
   - True content removal via canvas rasterization / stripping to prevent underlying text recovery.
