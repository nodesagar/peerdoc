import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';
import { compressPDF, recompressImages, JpegCodec, COMPRESSION_PRESETS } from '../utils/pdfProcessor';

/** Codec stand-in: pretends every image shrinks to maxPx and 100 bytes. */
const calls: { maxPx: number; quality: number }[] = [];
const fakeCodec: JpegCodec = async (_jpeg, maxPx, quality) => {
  calls.push({ maxPx, quality });
  return { bytes: new Uint8Array(100), width: maxPx, height: Math.round(maxPx / 2) };
};

function addImage(doc: PDFDocument, extra: Record<string, any> = {}): PDFRef {
  const stream = doc.context.stream(new Uint8Array(50_000), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: 4000,
    Height: 2000,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
    Filter: 'DCTDecode',
    ...extra,
  });
  return doc.context.register(stream);
}

const imageAt = (doc: PDFDocument, ref: PDFRef) => doc.context.lookup(ref) as PDFRawStream;
const num = (s: PDFRawStream, key: string) => (s.dict.get(PDFName.of(key)) as PDFNumber).asNumber();

describe('PDF compression', () => {
  it('re-encodes eligible JPEGs with the level preset and keeps the soft mask', async () => {
    const doc = await PDFDocument.create();
    const smask = doc.context.register(doc.context.stream(new Uint8Array(10), { Subtype: 'Image' }));
    const ref = addImage(doc, { SMask: smask });
    calls.length = 0;

    expect(await recompressImages(doc, 'extreme', fakeCodec)).toBe(1);
    expect(calls).toEqual([COMPRESSION_PRESETS.extreme]);
    const img = imageAt(doc, ref);
    expect(img.contents.byteLength).toBe(100);
    expect(num(img, 'Width')).toBe(1000);
    expect(num(img, 'Height')).toBe(500);
    expect(img.dict.get(PDFName.of('SMask'))).toBe(smask);
  });

  it('leaves CMYK, masked, non-JPEG images and non-shrinking results alone', async () => {
    const doc = await PDFDocument.create();
    const refs = [
      addImage(doc, { ColorSpace: 'DeviceCMYK' }),
      addImage(doc, { Decode: [1, 0, 1, 0, 1, 0] }),
      addImage(doc, { Filter: 'FlateDecode' }),
    ];
    expect(await recompressImages(doc, 'recommended', fakeCodec)).toBe(0);
    refs.forEach((r) => expect(imageAt(doc, r).contents.byteLength).toBe(50_000));

    const bigger: JpegCodec = async () => ({ bytes: new Uint8Array(60_000), width: 1, height: 1 });
    const keep = addImage(doc);
    expect(await recompressImages(doc, 'recommended', bigger)).toBe(0);
    expect(imageAt(doc, keep).contents.byteLength).toBe(50_000);
  });

  it('never returns a larger file and reports the real size', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const input = await doc.save({ useObjectStreams: true });
    const out = await compressPDF(input, 'recommended', fakeCodec);
    expect(out.compressedSizeBytes).toBeLessThanOrEqual(input.byteLength);
    expect(out.compressedSizeBytes).toBe(out.compressedBuffer.byteLength);
  });
});
