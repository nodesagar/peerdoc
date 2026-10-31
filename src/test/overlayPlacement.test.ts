// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildConvergedPDF, getPageFrame } from '../utils/pdfProcessor';

// Page whose MediaBox does not start at 0,0, displayed with each intrinsic /Rotate.
async function offsetPage(rotation: number) {
  const src = await PDFDocument.create();
  const page = src.addPage([600, 800]);
  page.setMediaBox(100, 200, 600, 800);
  page.setRotation(degrees(rotation));
  return { src, page };
}

describe('Overlay placement in exported PDF', () => {
  for (const rotation of [0, 90, 180, 270]) {
    it(`text lands where the editor showed it (/Rotate ${rotation}, offset MediaBox)`, async () => {
      const { src } = await offsetPage(rotation);
      const out = await buildConvergedPDF(await src.save(), {
        meta: { documentId: '', title: '', createdAt: 0 },
        pages: [],
        textOverlays: [{ id: 't', pageIndex: 0, x: 25, y: 40, text: 'HELLO', fontSize: 20 }],
        whiteouts: [],
        redactions: [],
        signatures: [],
      });

      // Read back with pdf.js, the same engine the editor renders with
      const doc = await pdfjs.getDocument({ data: out, verbosity: 0 }).promise;
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const item: any = (await page.getTextContent()).items.find((i: any) => i.str === 'HELLO');
      const [vx, vy] = vp.convertToViewportPoint(item.transform[4], item.transform[5]);
      const m = pdfjs.Util.transform(vp.transform, item.transform);

      expect((vx / vp.width) * 100).toBeCloseTo(25 + (5 / vp.width) * 100, 1); // + editor padding
      expect((vy / vp.height) * 100).toBeCloseTo(40 + ((3 + 20 * 0.83) / vp.height) * 100, 1);
      expect(m[0]).toBeGreaterThan(0); // upright, left-to-right in the displayed view
      expect(Math.abs(m[1])).toBeLessThan(1e-6);
    });
  }

  it('maps a percentage rect through crop-box offset and rotation', async () => {
    const { page } = await offsetPage(90);
    const frame = getPageFrame(page, 90);
    expect([frame.width, frame.height]).toEqual([800, 600]);
    // Displayed top-left quadrant of a 90°-rotated page = unrotated bottom-left quadrant
    expect(frame.rect({ x: 0, y: 0, width: 50, height: 50 })).toEqual({ x: 100, y: 200, width: 300, height: 400 });
    expect(getPageFrame(page, 0).rect({ x: 0, y: 0, width: 50, height: 25 })).toEqual({ x: 100, y: 800, width: 300, height: 200 });
  });
});
