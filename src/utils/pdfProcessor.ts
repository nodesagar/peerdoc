import { applyTextEdits } from '../lib/pdf/textEdit';
import { PDFDocument, PDFPage, PDFDict, PDFArray, PDFName, PDFNumber, PDFRawStream, PDFHexString, BlendMode, LineCapStyle, rgb, StandardFonts, degrees } from 'pdf-lib';
import { PDFDocument as PDFDocumentPlus } from 'pdf-lib-plus-encrypt';
import { PDFMetadataInfo, RedactionBox, WhiteoutBox, TextOverlay, SignatureBox, PageMetadata } from '../types';
import { DocumentSnapshot } from '../lib/crdt/schema';

/**
 * Merges multiple PDF Uint8Arrays into a single PDF
 */
export async function mergePDFs(pdfBuffers: Uint8Array[]): Promise<Uint8Array> {
  const mergedPdf = await PDFDocument.create();

  for (const buffer of pdfBuffers) {
    const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }

  return await mergedPdf.save();
}

export type CompressionLevel = 'low' | 'recommended' | 'extreme';

/** Photos/scans are downscaled to maxPx on their longest side and re-encoded as JPEG. */
export const COMPRESSION_PRESETS: Record<CompressionLevel, { maxPx: number; quality: number }> = {
  low: { maxPx: 2400, quality: 0.85 },
  recommended: { maxPx: 1600, quality: 0.72 },
  extreme: { maxPx: 1000, quality: 0.5 },
};

/** Re-encodes one JPEG image; null keeps the original. */
export type JpegCodec = (
  jpeg: Uint8Array,
  maxPx: number,
  quality: number
) => Promise<{ bytes: Uint8Array; width: number; height: number } | null>;

export const browserJpegCodec: JpegCodec = async (jpeg, maxPx, quality) => {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }));
  try {
    const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
  } finally {
    bitmap.close();
  }
};

/**
 * 8-bit RGB/Gray JPEG images only. CMYK JPEGs decode with inverted colours in
 * some browsers, and Decode arrays, colour-key masks and stencil masks change
 * how pixel values are interpreted, so those are left untouched.
 */
function isRecompressibleJpeg(doc: PDFDocument, dict: PDFDict): boolean {
  const filter = doc.context.lookup(dict.get(PDFName.of('Filter')));
  const filters = filter instanceof PDFArray ? filter.asArray() : [filter];
  if (filters.length !== 1 || filters[0] !== PDFName.of('DCTDecode')) return false;
  if (dict.has(PDFName.of('Decode')) || dict.has(PDFName.of('Mask')) || dict.has(PDFName.of('ImageMask'))) return false;
  const bpc = doc.context.lookup(dict.get(PDFName.of('BitsPerComponent')));
  if (bpc instanceof PDFNumber && bpc.asNumber() !== 8) return false;

  const cs = doc.context.lookup(dict.get(PDFName.of('ColorSpace')));
  if (cs === PDFName.of('DeviceRGB') || cs === PDFName.of('DeviceGray')) return true;
  if (cs instanceof PDFArray && cs.get(0) === PDFName.of('ICCBased')) {
    const profile = doc.context.lookup(cs.get(1));
    const n = profile instanceof PDFRawStream ? doc.context.lookup(profile.dict.get(PDFName.of('N'))) : undefined;
    return n instanceof PDFNumber && (n.asNumber() === 3 || n.asNumber() === 1);
  }
  return false;
}

/** Replaces each eligible JPEG image with a smaller re-encoding. Returns how many were replaced. */
export async function recompressImages(
  doc: PDFDocument,
  level: CompressionLevel,
  codec: JpegCodec = browserJpegCodec
): Promise<number> {
  const { maxPx, quality } = COMPRESSION_PRESETS[level];
  let replaced = 0;
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    if (!isRecompressibleJpeg(doc, obj.dict)) continue;

    let out: Awaited<ReturnType<JpegCodec>> = null;
    try {
      out = await codec(obj.contents, maxPx, quality);
    } catch {
      continue; // undecodable image: keep it
    }
    if (!out || out.bytes.byteLength >= obj.contents.byteLength) continue;

    // Canvas output is always 8-bit RGB JPEG. A soft mask may keep its own size.
    const image = doc.context.stream(out.bytes, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: out.width,
      Height: out.height,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      Filter: 'DCTDecode',
    });
    for (const key of ['SMask', 'Interpolate', 'Intent']) {
      const value = obj.dict.get(PDFName.of(key));
      if (value) image.dict.set(PDFName.of(key), value);
    }
    doc.context.assign(ref, image);
    replaced++;
  }
  return replaced;
}

/**
 * Compresses by re-encoding photos/scans per level, packing objects into
 * object streams and stripping metadata. Never returns a larger file.
 */
export async function compressPDF(
  pdfBuffer: Uint8Array,
  level: CompressionLevel = 'recommended',
  codec: JpegCodec = browserJpegCodec
): Promise<{ compressedBuffer: Uint8Array; originalSizeBytes: number; compressedSizeBytes: number; imagesRecompressed: number }> {
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });

  // Strip non-essential metadata
  pdfDoc.setTitle('');
  pdfDoc.setAuthor('');
  pdfDoc.setProducer('EditorDoc P2P Optimizer');
  pdfDoc.setKeywords([]);

  const imagesRecompressed = await recompressImages(pdfDoc, level, codec);
  const saved = await pdfDoc.save({ useObjectStreams: true });
  const compressedBuffer = saved.byteLength < pdfBuffer.byteLength ? saved : pdfBuffer;

  return {
    compressedBuffer,
    originalSizeBytes: pdfBuffer.byteLength,
    compressedSizeBytes: compressedBuffer.byteLength,
    imagesRecompressed,
  };
}

export interface PageRedactionJob {
  sourceIndex: number; // page index in rawPdfBuffer
  rotation: number; // extra CRDT rotation to re-apply
  viewRotation: number; // page's intrinsic /Rotate, as the editor displayed it
  boxes: RedactionBox[];
}

type PctRect = { x: number; y: number; width: number; height: number };

/**
 * Coordinate frame of a page as the editor shows it: pdf.js renders the CropBox
 * (whose origin need not be 0,0) turned by the page's intrinsic /Rotate. Overlays
 * are stored as percentages of that view; this maps them back to PDF user space.
 */
export function getPageFrame(page: PDFPage, viewRotation: number) {
  const { x: x0, y: y0, width: W, height: H } = page.getCropBox();
  const rotation = ((Math.round(viewRotation / 90) * 90) % 360 + 360) % 360;
  const swap = rotation === 90 || rotation === 270;
  const width = swap ? H : W; // displayed size
  const height = swap ? W : H;

  /** (dx, dy) in points from the displayed top-left corner -> PDF user space. */
  const toPdf = (dx: number, dy: number): [number, number] => {
    switch (rotation) {
      case 90:
        return [x0 + dy, y0 + dx];
      case 180:
        return [x0 + W - dx, y0 + dy];
      case 270:
        return [x0 + W - dy, y0 + H - dx];
      default:
        return [x0 + dx, y0 + H - dy];
    }
  };

  const rect = (r: PctRect) => {
    const [ax, ay] = toPdf((r.x / 100) * width, (r.y / 100) * height);
    const [bx, by] = toPdf(((r.x + r.width) / 100) * width, ((r.y + r.height) / 100) * height);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
  };

  return { width, height, rotation, toPdf, rect };
}

/**
 * True Redaction engine:
 * In a browser, renders the source page with pdf.js, paints black boxes into the pixels,
 * and REPLACES the output page with an image-only page, so no text/vector content survives.
 * Without a DOM (node tests) it falls back to drawing vector boxes (content NOT scrubbed).
 */
export async function applyTrueRedactions(
  pdfDoc: PDFDocument,
  jobsByOutputIndex: Map<number, PageRedactionJob>,
  rawPdfBuffer: Uint8Array
): Promise<Set<number>> {
  const rasterized = new Set<number>();
  const canRasterize = typeof window !== 'undefined' && typeof document !== 'undefined';
  const sourcePdf = canRasterize
    ? await (await import('pdfjs-dist')).getDocument({ data: rawPdfBuffer.slice() }).promise
    : null;

  for (const [outIdx, job] of jobsByOutputIndex.entries()) {
    if (outIdx < 0 || outIdx >= pdfDoc.getPageCount()) continue;

    if (!sourcePdf) {
      const page = pdfDoc.getPage(outIdx);
      const frame = getPageFrame(page, job.viewRotation);
      for (const red of job.boxes) {
        page.drawRectangle({ ...frame.rect(red), color: rgb(0, 0, 0) });
      }
      continue;
    }

    // Errors propagate: silently exporting un-scrubbed text would be a data leak.
    const pdfPage = await sourcePdf.getPage(job.sourceIndex + 1);
    const scale = 2.0; // High DPI render
    const viewport = pdfPage.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable; cannot burn redactions');

    await (pdfPage.render as any)({ canvasContext: ctx, viewport, canvas }).promise;
    ctx.fillStyle = '#000000';
    for (const red of job.boxes) {
      ctx.fillRect(
        (red.x / 100) * canvas.width,
        (red.y / 100) * canvas.height,
        (red.width / 100) * canvas.width,
        (red.height / 100) * canvas.height
      );
    }

    const embeddedImage = await pdfDoc.embedPng(canvas.toDataURL('image/png'));
    const w = viewport.width / scale;
    const h = viewport.height / scale;
    pdfDoc.removePage(outIdx);
    const cleanPage = pdfDoc.insertPage(outIdx, [w, h]);
    cleanPage.drawImage(embeddedImage, { x: 0, y: 0, width: w, height: h });
    // Intrinsic /Rotate is baked into the raster; only re-apply the user's rotation.
    if (job.rotation) cleanPage.setRotation(degrees(job.rotation % 360));
    rasterized.add(outIdx);
  }

  // Always scrub sensitive metadata
  pdfDoc.setTitle('');
  pdfDoc.setAuthor('');
  pdfDoc.setSubject('');
  pdfDoc.setCreator('');
  pdfDoc.setProducer('EditorDoc P2P Sanitizer');
  pdfDoc.setKeywords([]);
  return rasterized;
}

/**
 * Builds the final output PDF from a snapshot of converged CRDT state.
 */
export async function buildConvergedPDF(
  originalPdfBuffer: Uint8Array,
  snapshot: DocumentSnapshot
): Promise<Uint8Array> {
  // In-place text edits rewrite the original pages first, so every later step
  // (reorder, rasterising redactions, overlays) works on the edited text.
  if (snapshot.textEdits?.length) originalPdfBuffer = await applyTextEdits(originalPdfBuffer, snapshot.textEdits);
  const sourceDoc = await PDFDocument.load(originalPdfBuffer, { ignoreEncryption: true });
  const newDoc = await PDFDocument.create();

  // 1. Process active pages (non-deleted, sorted by fractional index).
  // No page metadata (CRDT not initialised yet) means "original order", not "all deleted".
  const pages: PageMetadata[] =
    snapshot.pages.length > 0
      ? snapshot.pages
      : sourceDoc.getPageIndices().map((i) => ({ id: `page-${i}`, originalIndex: i, order: '', rotation: 0, deleted: false }));
  const activePages = pages.filter((p) => !p.deleted);
  const pageIndicesToCopy = activePages.map((p) => p.originalIndex);

  if (pageIndicesToCopy.length === 0) {
    // If all deleted, retain at least a blank page
    newDoc.addPage([612, 792]);
    return await newDoc.save();
  }

  const copiedPages = await newDoc.copyPages(sourceDoc, pageIndicesToCopy);

  // Redaction jobs keyed by output page index
  const redactionsByNewIndex = new Map<number, PageRedactionJob>();
  // Intrinsic rotation per output page = orientation overlays were drawn in
  const viewRotations: number[] = [];

  for (let i = 0; i < copiedPages.length; i++) {
    const page = copiedPages[i];
    const pageMeta = activePages[i];
    const intrinsic = page.getRotation().angle;
    viewRotations.push(intrinsic);

    // Apply rotation
    if (pageMeta.rotation && pageMeta.rotation !== 0) {
      page.setRotation(degrees((intrinsic + pageMeta.rotation) % 360));
    }

    newDoc.addPage(page);

    // Group redactions for this page
    const pageRedactions = snapshot.redactions.filter(
      (r) => r.pageIndex === pageMeta.originalIndex
    );
    if (pageRedactions.length > 0) {
      redactionsByNewIndex.set(i, {
        sourceIndex: pageMeta.originalIndex,
        rotation: pageMeta.rotation || 0,
        viewRotation: intrinsic,
        boxes: pageRedactions,
      });
    }
  }

  // 2. Apply True Redactions
  if (redactionsByNewIndex.size > 0) {
    // Rasterized pages have the intrinsic rotation baked into their pixels
    const replaced = await applyTrueRedactions(newDoc, redactionsByNewIndex, originalPdfBuffer);
    replaced.forEach((idx) => (viewRotations[idx] = 0));
  }

  const finalPages = newDoc.getPages();
  const frameOf = (idx: number) => getPageFrame(finalPages[idx], viewRotations[idx]);

  // 3. Apply Whiteouts
  for (const w of snapshot.whiteouts) {
    // Find matching active page
    const targetIdx = activePages.findIndex((p) => p.originalIndex === w.pageIndex);
    if (targetIdx >= 0 && targetIdx < finalPages.length) {
      const page = finalPages[targetIdx];

      let wr = 1, wg = 1, wb = 1;
      if (w.color && w.color.startsWith('#')) {
        const hex = w.color.replace('#', '');
        if (hex.length === 6) {
          wr = parseInt(hex.substring(0, 2), 16) / 255;
          wg = parseInt(hex.substring(2, 4), 16) / 255;
          wb = parseInt(hex.substring(4, 6), 16) / 255;
        }
      }

      page.drawRectangle({ ...frameOf(targetIdx).rect(w), color: rgb(wr, wg, wb) });
    }
  }

  // 4. Apply Text Overlays
  for (const t of snapshot.textOverlays) {
    const targetIdx = activePages.findIndex((p) => p.originalIndex === t.pageIndex);
    if (targetIdx >= 0 && targetIdx < finalPages.length) {
      const page = finalPages[targetIdx];
      const frame = frameOf(targetIdx);
      // Editor box has 1px border + px-1/py-0.5 padding; baseline sits ~0.83em below
      // the text line top for normal line-height. 1 CSS px = 1pt at scale 1.
      const [x, y] = frame.toPdf(
        (t.x / 100) * frame.width + 5,
        (t.y / 100) * frame.height + 3 + t.fontSize * 0.83
      );

      let r = 0, g = 0, b = 0;
      if (t.color && t.color.startsWith('#')) {
        const hex = t.color.replace('#', '');
        if (hex.length === 6) {
          r = parseInt(hex.substring(0, 2), 16) / 255;
          g = parseInt(hex.substring(2, 4), 16) / 255;
          b = parseInt(hex.substring(4, 6), 16) / 255;
        }
      }

      let fontType = StandardFonts.Helvetica;
      if (t.fontFamily === 'TimesRoman' || t.fontFamily === 'Georgia' || t.fontFamily === 'Times New Roman') {
        if (t.isBold && t.isItalic) fontType = StandardFonts.TimesRomanBoldItalic;
        else if (t.isBold) fontType = StandardFonts.TimesRomanBold;
        else if (t.isItalic) fontType = StandardFonts.TimesRomanItalic;
        else fontType = StandardFonts.TimesRoman;
      } else if (t.fontFamily === 'Courier' || t.fontFamily === 'Courier New') {
        if (t.isBold && t.isItalic) fontType = StandardFonts.CourierBoldOblique;
        else if (t.isBold) fontType = StandardFonts.CourierBold;
        else if (t.isItalic) fontType = StandardFonts.CourierOblique;
        else fontType = StandardFonts.Courier;
      } else {
        if (t.isBold && t.isItalic) fontType = StandardFonts.HelveticaBoldOblique;
        else if (t.isBold) fontType = StandardFonts.HelveticaBold;
        else if (t.isItalic) fontType = StandardFonts.HelveticaOblique;
        else fontType = StandardFonts.Helvetica;
      }

      const font = await newDoc.embedFont(fontType);
      // Standard fonts are WinAnsi-only; one emoji/CJK char would abort the whole export.
      const supported = new Set(font.getCharacterSet());
      const safeText = Array.from(t.text)
        .map((ch) => (supported.has(ch.codePointAt(0)!) ? ch : '?'))
        .join('');
      page.drawText(safeText, {
        x,
        y,
        size: t.fontSize,
        font,
        color: rgb(r, g, b),
        rotate: degrees(frame.rotation), // stays upright in the rotated view
      });
    }
  }

  // 5. Apply Signatures
  for (const sig of snapshot.signatures) {
    const targetIdx = activePages.findIndex((p) => p.originalIndex === sig.pageIndex);
    if (targetIdx >= 0 && targetIdx < finalPages.length && sig.dataUrl) {
      const page = finalPages[targetIdx];
      const frame = frameOf(targetIdx);

      try {
        const pngImage = /^data:image\/jpe?g/i.test(sig.dataUrl)
          ? await newDoc.embedJpg(sig.dataUrl)
          : await newDoc.embedPng(sig.dataUrl);
        // Anchor at the image's displayed bottom-left, rotated with the view
        const w = (sig.width / 100) * frame.width;
        const h = (sig.height / 100) * frame.height;
        const [x, y] = frame.toPdf((sig.x / 100) * frame.width, ((sig.y + sig.height) / 100) * frame.height);
        page.drawImage(pngImage, { x, y, width: w, height: h, rotate: degrees(frame.rotation) });
      } catch (err) {
        console.warn('Failed to embed signature PNG:', err);
      }
    }
  }

  // 6. Review annotations: markup is drawn into the page (visible in every viewer);
  // each open comment thread also becomes a real PDF sticky note.
  for (const a of snapshot.annotations) {
    const targetIdx = activePages.findIndex((p) => p.originalIndex === a.pageIndex);
    if (targetIdx < 0 || targetIdx >= finalPages.length) continue;
    const page = finalPages[targetIdx];
    const frame = frameOf(targetIdx);
    const color = hexToRgb(a.color);

    if (a.type === 'highlight') {
      page.drawRectangle({ ...frame.rect(a), color, opacity: 0.35, blendMode: BlendMode.Multiply });
    } else if (a.type === 'box') {
      page.drawRectangle({ ...frame.rect(a), borderColor: color, borderWidth: 2 });
    } else if (a.type === 'ink' && a.points && a.points.length >= 4) {
      const pts = a.points;
      const at = (i: number) => {
        const [x, y] = frame.toPdf((pts[i] / 100) * frame.width, (pts[i + 1] / 100) * frame.height);
        return { x, y };
      };
      for (let i = 0; i + 3 < pts.length; i += 2) {
        page.drawLine({ start: at(i), end: at(i + 2), thickness: 2, color, lineCap: LineCapStyle.Round });
      }
    }

    const thread = snapshot.comments.filter((c) => c.annotationId === a.id);
    if (!a.resolved && thread.length > 0) {
      const [x, y] = frame.toPdf((a.x / 100) * frame.width, (a.y / 100) * frame.height);
      const note = newDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [x, y - 20, x + 20, y],
        Contents: PDFHexString.fromText(thread.map((c) => `${c.createdBy ?? 'Someone'}: ${c.text}`).join('\n\n')),
        T: PDFHexString.fromText(thread[0].createdBy ?? 'EditorDoc'),
        Name: 'Comment',
        C: [color.red, color.green, color.blue],
        F: 4, // print
        Open: false,
      });
      page.node.addAnnot(newDoc.context.register(note));
    }
  }

  return await newDoc.save();
}

function hexToRgb(hex: string | undefined) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  return m ? rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : rgb(0.98, 0.67, 0);
}

/**
 * Legacy/Standalone helper: Edits a PDF by applying whiteouts and text overlays
 */
export async function editPDF(
  pdfBuffer: Uint8Array,
  whiteouts: WhiteoutBox[],
  textOverlays: TextOverlay[]
): Promise<Uint8Array> {
  const dummySnapshot: DocumentSnapshot = {
    meta: { documentId: '', title: '', createdAt: 0 },
    pages: [],
    textOverlays,
    whiteouts,
    redactions: [],
    signatures: [],
    annotations: [],
    comments: [],
  };
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  dummySnapshot.pages = pdfDoc.getPageIndices().map((idx) => ({
    id: `page-${idx}`,
    originalIndex: idx,
    order: String(idx),
    rotation: 0,
    deleted: false,
  }));
  return await buildConvergedPDF(pdfBuffer, dummySnapshot);
}

/**
 * Legacy/Standalone helper: Redact PDF
 */
export async function redactPDF(
  pdfBuffer: Uint8Array,
  redactions: RedactionBox[],
  stripMetadataFlag: boolean = true
): Promise<Uint8Array> {
  const dummySnapshot: DocumentSnapshot = {
    meta: { documentId: '', title: '', createdAt: 0 },
    pages: [],
    textOverlays: [],
    whiteouts: [],
    redactions,
    signatures: [],
    annotations: [],
    comments: [],
  };
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  dummySnapshot.pages = pdfDoc.getPageIndices().map((idx) => ({
    id: `page-${idx}`,
    originalIndex: idx,
    order: String(idx),
    rotation: 0,
    deleted: false,
  }));
  return await buildConvergedPDF(pdfBuffer, dummySnapshot);
}

/**
 * Legacy/Standalone helper: Organize PDF
 */
export async function organizePDF(
  pdfBuffer: Uint8Array,
  pageOrder: number[],
  rotations: Record<number, number>
): Promise<Uint8Array> {
  const sourceDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const newDoc = await PDFDocument.create();

  const copiedPages = await newDoc.copyPages(sourceDoc, pageOrder);

  copiedPages.forEach((page, i) => {
    const originalIndex = pageOrder[i];
    const angleOffset = rotations[originalIndex];
    if (angleOffset && angleOffset !== 0) {
      const currentRotation = page.getRotation().angle;
      page.setRotation(degrees(currentRotation + angleOffset));
    }
    newDoc.addPage(page);
  });

  return await newDoc.save();
}

/**
 * Watermark PDF
 */
export interface WatermarkOptions {
  text: string;
  colorHex: string;
  opacity: number;
  rotation: number;
  fontSize: number;
}

export async function watermarkPDF(pdfBuffer: Uint8Array, options: WatermarkOptions): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const hex = options.colorHex.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;

  pages.forEach((page) => {
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(options.text, options.fontSize);
    const textHeight = font.heightAtSize(options.fontSize);

    page.drawText(options.text, {
      x: width / 2 - textWidth / 2,
      y: height / 2 - textHeight / 2,
      size: options.fontSize,
      font: font,
      color: rgb(r, g, b),
      opacity: options.opacity,
      rotate: degrees(options.rotation),
    });
  });

  return await pdfDoc.save();
}

/**
 * Stamp signature on PDF
 */
export async function stampSignatureOnPDF(
  pdfBuffer: Uint8Array,
  pageIndex: number,
  signaturePngDataUrl: string,
  rectPct: { x: number; y: number; width: number; height: number }
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();

  if (pageIndex >= 0 && pageIndex < pages.length) {
    const page = pages[pageIndex];
    const { width: pWidth, height: pHeight } = page.getSize();

    const pngImage = await pdfDoc.embedPng(signaturePngDataUrl);
    const x = (rectPct.x / 100) * pWidth;
    const y = pHeight - ((rectPct.y + rectPct.height) / 100) * pHeight;
    const w = (rectPct.width / 100) * pWidth;
    const h = (rectPct.height / 100) * pHeight;

    page.drawImage(pngImage, {
      x,
      y,
      width: w,
      height: h,
    });
  }

  return await pdfDoc.save();
}

/**
 * Split PDF by page indices
 */
export async function splitPDF(
  pdfBuffer: Uint8Array,
  selectedPagesZeroBased: number[]
): Promise<Uint8Array> {
  const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const newDoc = await PDFDocument.create();

  const copiedPages = await newDoc.copyPages(srcDoc, selectedPagesZeroBased);
  copiedPages.forEach((page) => newDoc.addPage(page));

  return await newDoc.save();
}

/**
 * Extracts metadata from PDF
 */
export async function extractPDFMetadata(pdfBuffer: Uint8Array): Promise<PDFMetadataInfo> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    return {
      title: pdfDoc.getTitle() || 'Untitled Document',
      author: pdfDoc.getAuthor() || 'Unknown Author',
      subject: pdfDoc.getSubject() || 'None',
      creator: pdfDoc.getCreator() || 'Unknown',
      producer: pdfDoc.getProducer() || 'EditorDoc P2P Client',
      creationDate: pdfDoc.getCreationDate()?.toLocaleDateString() || 'N/A',
      modificationDate: pdfDoc.getModificationDate()?.toLocaleDateString() || 'N/A',
    };
  } catch (err) {
    return {
      title: 'Uploaded Document',
      author: 'Unknown',
      producer: 'EditorDoc P2P Browser Engine',
    };
  }
}

/**
 * Download helper
 */
export function downloadUint8ArrayAsFile(data: Uint8Array, filename: string) {
  const blob = new Blob([data as any], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Format bytes to readable string
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Encrypt PDF with password
 */
export async function encryptPDF(
  pdfBuffer: Uint8Array,
  password: string,
  encryptionLevel: '128' | '256' = '128'
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocumentPlus.load(pdfBuffer, { ignoreEncryption: true });
  await pdfDoc.encrypt({
    userPassword: password,
    ownerPassword: password,
  });
  return await pdfDoc.save();
}

/**
 * Images to PDF
 */
export async function imagesToPDF(imageUrls: string[]): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();

  for (const url of imageUrls) {
    const image = /^data:image\/jpe?g/i.test(url) ? await pdfDoc.embedJpg(url) : await pdfDoc.embedPng(url);

    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    });
  }

  return await pdfDoc.save();
}
