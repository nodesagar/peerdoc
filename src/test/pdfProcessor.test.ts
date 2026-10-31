import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createSampleConfidentialAgreement } from '../utils/samplePdfs';
import { computeSHA256 } from '../lib/crdt/pdfStore';
import { buildConvergedPDF } from '../utils/pdfProcessor';

describe('PDF processing', () => {
  it('demo PDF is byte-identical across loads (stable room ID)', async () => {
    const a = await computeSHA256(await createSampleConfidentialAgreement());
    await new Promise((r) => setTimeout(r, 1100)); // cross a PDF-date second boundary
    const b = await computeSHA256(await createSampleConfidentialAgreement());
    expect(a).toBe(b);
  });

  it('exports all original pages when CRDT page metadata is not initialised', async () => {
    const src = await createSampleConfidentialAgreement();
    const out = await buildConvergedPDF(src, {
      meta: { documentId: '', title: '', createdAt: 0 },
      pages: [],
      textOverlays: [{ id: 't', pageIndex: 0, x: 10, y: 10, text: 'Emoji 🚀 ok', fontSize: 12 }],
      whiteouts: [],
      redactions: [],
      signatures: [],
      annotations: [],
      comments: [],
    });
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2);
  });
});
