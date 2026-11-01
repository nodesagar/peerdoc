import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { interpretPage, tokenize, fillToCss } from '../lib/pdf/contentStream';
import { segmentsOf, applyTextEdits, editForSegment, insertionLike, nearestSegment, TextEdit, styleOf } from '../lib/pdf/textEdit';

const fixture = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, 'fixtures', name)));

async function segmentsIn(bytes: Uint8Array, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  return segmentsOf(interpretPage(doc, doc.getPage(pageIndex)), pageIndex);
}

async function standardFontPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.TimesRoman);
  page.drawText('Invoice total: 1,200 USD', { x: 40, y: 250, size: 16, font, color: rgb(0.8, 0.1, 0.1) });
  page.drawText('Payable within 30 days.', { x: 40, y: 220, size: 12, font: body });
  return doc.save();
}

const edit = (e: Omit<TextEdit, 'id'>, id = 'e1'): TextEdit => ({ id, ...e });

describe('content stream tokenizer', () => {
  it('keeps operator spans and parses strings, arrays and inline images', () => {
    const src = 'BT /F1 12 Tf (a\\(b\\)c) Tj [<0041> -120 (B)] TJ ET BI /W 1 /H 1 ID \x00\xff EI Q';
    const ops = tokenize(src);
    expect(ops.map((o) => o.op)).toEqual(['BT', 'Tf', 'Tj', 'TJ', 'ET', 'BI', 'Q']);
    const tj = ops[2];
    expect(src.slice(tj.start, tj.end)).toBe('(a\\(b\\)c) Tj');
    expect((tj.operands[0] as { bytes: number[] }).bytes).toEqual([...'a(b)c'].map((c) => c.charCodeAt(0)));
    expect((ops[3].operands[0] as unknown[]).length).toBe(3);
  });

  it('reads fill colours', () => {
    expect(fillToCss(['0.8 0.1 0.1 rg'])).toBe('#cc1a1a');
    expect(fillToCss(['0.5 g'])).toBe('#808080');
    expect(fillToCss([])).toBe('#000000');
  });
});

describe('in-place PDF text editing', () => {
  it('finds editable line runs with their typography (standard fonts)', async () => {
    const segs = await segmentsIn(await standardFontPdf());
    expect(segs.map((s) => s.text)).toEqual(['Invoice total: 1,200 USD', 'Payable within 30 days.']);
    expect(segs.every((s) => s.editable)).toBe(true);
    const style = styleOf(segs[0].glyphs[0]);
    expect(style).toMatchObject({ bold: true, color: '#cc1a1a' });
    expect(style.size).toBeCloseTo(16);
  });

  it('replaces text in place with the same font, size, colour and origin', async () => {
    const bytes = await standardFontPdf();
    const [total, terms] = await segmentsIn(bytes);
    const out = await applyTextEdits(bytes, [edit(editForSegment(total, 'Invoice total: 1,450 USD'))]);
    const after = await segmentsIn(out);
    expect(after.map((s) => s.text)).toEqual(['Payable within 30 days.', 'Invoice total: 1,450 USD']);
    const edited = after.find((s) => s.text.startsWith('Invoice'))!;
    expect(edited.x0).toBeCloseTo(total.x0, 3);
    expect(edited.baseline).toBeCloseTo(total.baseline, 3);
    expect(edited.glyphs[0].state.font!.resName).toBe(total.glyphs[0].state.font!.resName); // original font reused
    expect(styleOf(edited.glyphs[0])).toMatchObject({ bold: true, color: '#cc1a1a' });
    // untouched line is byte-for-byte where it was
    const untouched = after.find((s) => s.text.startsWith('Payable'))!;
    expect(untouched.x0).toBeCloseTo(terms.x0, 6);
  });

  it('edits embedded subset fonts (Chrome PDF, Type0 Identity-H)', async () => {
    const bytes = fixture('chrome-text.pdf');
    const segs = await segmentsIn(bytes);
    const name = segs.find((s) => s.text.includes('Jane Doe'))!;
    expect(name.editable).toBe(true);
    expect(name.glyphs[0].state.font!.twoByte).toBe(true);
    // Letters that exist in the subset: drawn with the original embedded font
    const out = await applyTextEdits(bytes, [edit(editForSegment(name, 'Client name: Jean Dane'))]);
    const after = await segmentsIn(out);
    const edited = after.find((s) => s.text.includes('Jean Dane'))!;
    expect(edited).toBeTruthy();
    expect(after.some((s) => s.text.includes('Jane Doe'))).toBe(false);
    expect(edited.glyphs[0].state.font!.resName).toBe(name.glyphs[0].state.font!.resName);
    expect(edited.x0).toBeCloseTo(name.x0, 2);
    expect(after.find((s) => s.text.includes('Service Agreement'))).toBeTruthy();
  });

  it('falls back to a matching standard font for glyphs the subset lacks', async () => {
    const bytes = fixture('chrome-text.pdf');
    const name = (await segmentsIn(bytes)).find((s) => s.text.includes('Jane Doe'))!;
    const out = await applyTextEdits(bytes, [edit(editForSegment(name, 'Client name: Quixotic Vex'))]);
    const edited = (await segmentsIn(out)).find((s) => s.text.includes('Quixotic'))!;
    expect(edited.glyphs[0].state.font!.resName).toMatch(/^EdF/);
    expect(edited.size).toBeCloseTo(name.size, 2);
  });

  it('inserts new text styled like the nearest run', async () => {
    const bytes = await standardFontPdf();
    const segs = await segmentsIn(bytes);
    const like = nearestSegment(segs, 50, 200)!;
    expect(like.text).toBe('Payable within 30 days.');
    const out = await applyTextEdits(bytes, [edit(insertionLike(like, 0, 40, 200, 'Late fee applies.'))]);
    const inserted = (await segmentsIn(out)).find((s) => s.text === 'Late fee applies.')!;
    expect(inserted.baseline).toBeCloseTo(200, 3);
    expect(inserted.glyphs[0].state.font!.resName).toBe(like.glyphs[0].state.font!.resName);
  });

  it('keeps the rest of a line in place when one run inside a show operator changes', async () => {
    // One TJ with a wide gap: two runs ("Name:" and "Bob"); edit only the second
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 100]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('x', { x: 0, y: 0, size: 1, font }); // registers the font resource
    const base = await PDFDocument.load(await doc.save());
    const p = base.getPage(0);
    const fontName = interpretPage(base, p).glyphs[0].state.font!.resName;
    const raw = `BT /${fontName} 10 Tf 20 50 Td [(Name:) -3000 (Bob) -3000 (end)] TJ ET`;
    p.node.set(PDFName.of('Contents'), base.context.register(base.context.flateStream(raw)));
    const bytes = await base.save();
    const segs = await segmentsIn(bytes);
    expect(segs.map((s) => s.text)).toEqual(['Name:', 'Bob', 'end']);
    const out = await applyTextEdits(bytes, [edit(editForSegment(segs[1], 'Alexander'))]);
    const after = await segmentsIn(out);
    expect(after.find((s) => s.text === 'end')!.x0).toBeCloseTo(segs[2].x0, 4);
    expect(after.find((s) => s.text === 'Name:')!.x0).toBeCloseTo(segs[0].x0, 4);
    expect(after.some((s) => s.text === 'Alexander')).toBe(true);
    expect(after.some((s) => s.text === 'Bob')).toBe(false);
  });

  it('deleting text (empty replacement) removes the glyphs only', async () => {
    const bytes = await standardFontPdf();
    const [total] = await segmentsIn(bytes);
    const after = await segmentsIn(await applyTextEdits(bytes, [edit(editForSegment(total, ''))]));
    expect(after.map((s) => s.text)).toEqual(['Payable within 30 days.']);
  });
});
