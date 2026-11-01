import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as Y from 'yjs';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { Node as PMNode } from 'prosemirror-model';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { loadWordPackage } from '../lib/word/package';
import { importPart } from '../lib/word/import';
import { exportDocx } from '../lib/word/export';
import { wordSchema, WordNodeJSON } from '../lib/word/schema';
import { buildWordSeed, importWordParts, fragmentFor } from '../lib/word/seed';
import { createDocxFiles } from '../lib/word/templates';
import { detectFormat } from '../lib/formats';
import { initializeWordDocument, WORD_BODY, createUndoManager } from '../lib/crdt/schema';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PNG_1PX = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0)
);

/** A document exercising most of what the editor models or must preserve. */
function richDocx(): Uint8Array {
  const xml = (s: string) => strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`);
  const body = `
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Top"/><w:r><w:t>Agreement</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>
<w:p><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="240" w:beforeAutospacing="1"/><w:ind w:left="360" w:hanging="360"/><w:jc w:val="both"/></w:pPr>
  <w:r><w:rPr><w:b/><w:color w:val="FF0000" w:themeColor="accent2"/><w:sz w:val="28"/><w:lang w:val="en-GB"/></w:rPr><w:t xml:space="preserve">Bold red </w:t></w:r>
  <w:hyperlink r:id="rId9"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>link</w:t></w:r></w:hyperlink>
  <w:r><w:tab/><w:t>after tab</w:t><w:br w:type="page"/></w:r>
  <w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
  <w:proofErr w:type="spellStart"/>
</w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Second item</w:t></w:r></w:p>
<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
  <w:tr><w:tc><w:tcPr><w:tcW w:w="6000" w:type="dxa"/><w:gridSpan w:val="2"/><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/></w:tcPr><w:p><w:r><w:t>Wide</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:vMerge w:val="restart"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:r><w:t>Tall</w:t></w:r></w:p></w:tc></w:tr>
  <w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="Picture 1" descr="Logo"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId7"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:sdt><w:sdtPr><w:alias w:val="Clause"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Inside control</w:t></w:r></w:p></w:sdtContent></w:sdt>
<w:sectPr><w:headerReference w:type="default" r:id="rId8"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;

  return zipSync({
    '[Content_Types].xml': xml(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
    ),
    '_rels/.rels': xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    ),
    'word/document.xml': xml(`<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable=""><w:body>${body}</w:body></w:document>`),
    'word/_rels/document.xml.rels': xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
        `<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>` +
        `<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>` +
        `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/>` +
        `</Relationships>`
    ),
    'word/styles.xml': xml(
      `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>` +
        `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
        `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>` +
        `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:u w:val="single"/></w:rPr></w:style>` +
        `</w:styles>`
    ),
    'word/numbering.xml': xml(
      `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1)"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`
    ),
    'word/header1.xml': xml(`<w:hdr xmlns:w="${W}" xmlns:r="${R}"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>Confidential</w:t></w:r></w:p></w:hdr>`),
    'word/media/image1.png': PNG_1PX,
    'word/settings.xml': xml(`<w:settings xmlns:w="${W}"><w:zoom w:percent="100"/></w:settings>`),
  });
}

const fixture = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, 'fixtures', name)));
const toNode = (json: WordNodeJSON) => {
  const node = PMNode.fromJSON(wordSchema, json);
  node.check();
  return node;
};
const textOf = (json: WordNodeJSON) => toNode(json).textBetween(0, toNode(json).content.size, '\n', '￼');
const roundTrip = (bytes: Uint8Array, edit?: (parts: Record<string, WordNodeJSON>) => void) => {
  const pkg = loadWordPackage(bytes);
  const parts = importWordParts(pkg);
  edit?.(parts);
  const out = exportDocx(pkg, { parts });
  return { pkg, parts, out, again: loadWordPackage(out) };
};

describe('Word import', () => {
  it('detects formats by signature', () => {
    expect(detectFormat(richDocx())).toBe('docx');
    expect(detectFormat(fixture('sample.doc'))).toBe('doc');
    expect(detectFormat(strToU8('%PDF-1.7\n'))).toBe('pdf');
    expect(detectFormat(strToU8('hello'))).toBeNull();
  });

  it('maps Word structure onto the schema', () => {
    const pkg = loadWordPackage(richDocx());
    expect(pkg.headerPart).toBe('word/header1.xml');
    expect(Math.round(pkg.section.width)).toBe(794); // A4
    const doc = importPart(pkg, pkg.main);
    toNode(doc);
    const [h1, para, li1, , table, imgPara, sdtPara] = doc.content!;

    expect(h1.attrs).toMatchObject({ style: 'Heading1' });
    expect(h1.content!.map((n) => n.type)).toEqual(['raw_inline', 'text', 'raw_inline']); // bookmarks kept

    expect(para.attrs).toMatchObject({ spBefore: 120, spAfter: 240, indL: 360, indFirst: -360, align: 'justify' });
    expect(JSON.parse(para.attrs!.pPrX)).toEqual(expect.arrayContaining(['<w:keepNext/>']));
    const bold = para.content![0];
    expect(bold.marks!.map((m) => m.type)).toEqual(['bold', 'color', 'size', 'rprx']);
    const link = para.content!.find((n) => n.text === 'link')!;
    expect(link.marks!.find((m) => m.type === 'link')!.attrs).toMatchObject({ href: 'https://example.com/', rId: 'rId9' });
    expect(para.content!.some((n) => n.type === 'tab')).toBe(true);
    expect(para.content!.some((n) => n.type === 'hard_break' && n.attrs!.type === 'page')).toBe(true);
    // field codes survive as invisible atoms; the result stays editable text
    expect(para.content!.filter((n) => n.type === 'raw_inline').length).toBe(4);

    expect(li1.attrs).toMatchObject({ numId: '1', ilvl: 0 });

    expect(table.type).toBe('table');
    const [row1, row2] = table.content!;
    expect(row1.content![0].attrs).toMatchObject({ colspan: 2, colwidth: [200, 200], shade: 'D9E2F3' });
    expect(row1.content![1].attrs).toMatchObject({ rowspan: 2, vAlign: 'center' });
    expect(row2.content!.length).toBe(2); // vMerge continuation folded into rowspan

    const img = imgPara.content![0];
    expect(img.attrs).toMatchObject({ rId: 'rId7', width: 100, height: 50, alt: 'Logo' });
    expect(pkg.mediaUrl(pkg.main, 'rId7')).toMatch(/^blob:/);

    expect(textOf(sdtPara)).toBe('Inside control');
  });

  it('resolves document styles and list definitions', () => {
    const pkg = loadWordPackage(richDocx());
    expect(pkg.styles.css).toContain('.wd-p[data-style="Heading1"]');
    expect(pkg.styles.css).toContain('font-size:16pt');
    expect(pkg.styles.byId.get('Heading1')).toMatchObject({ outline: 0, name: 'Heading 1', next: 'Normal' });
    expect(pkg.numbering.level('1', 0)).toMatchObject({ fmt: 'decimal', text: '%1)', indL: 720, hanging: 360 });
  });
});

describe('Word export', () => {
  it('round-trips without drift and keeps untouched parts byte-identical', () => {
    const { pkg, parts, out, again } = roundTrip(richDocx());
    expect(importWordParts(again)).toEqual(parts);
    const files = unzipSync(out);
    for (const p of ['word/styles.xml', 'word/numbering.xml', 'word/media/image1.png', 'word/settings.xml', 'word/_rels/document.xml.rels']) {
      expect(files[p]).toEqual(pkg.files[p]);
    }
    const docXml = strFromU8(files['word/document.xml']);
    expect(docXml).toContain('mc:Ignorable=""'); // root element untouched
    expect(docXml).toContain('<w:headerReference w:type="default" r:id="rId8"/>'); // final sectPr kept
    expect(docXml).toMatch(/<w:spacing w:before="120" w:after="240" w:beforeAutospacing="1"\/>/);
    expect(docXml).toContain('<w:vMerge/>');
    expect(docXml).toContain('<w:instrText xml:space="preserve"> PAGE </w:instrText>');
    expect(docXml.indexOf('<w:keepNext/>')).toBeLessThan(docXml.indexOf('<w:spacing w:before="120"'));
  });

  it('writes edits, new lists, links and pictures as valid parts', () => {
    const { out, again } = roundTrip(richDocx(), (parts) => {
      const body = parts['word/document.xml'].content!;
      body.push({
        type: 'paragraph',
        attrs: { numId: 'app-bullet', ilvl: 0 },
        content: [
          { type: 'text', text: 'New ', marks: [{ type: 'italic', attrs: { on: true } }] },
          { type: 'text', text: 'site', marks: [{ type: 'link', attrs: { href: 'https://new.example/' } }] },
          { type: 'image', attrs: { src: `data:image/png;base64,${btoa(String.fromCharCode(...PNG_1PX))}`, width: 40, height: 20 } },
        ],
      });
      body.push({ type: 'paragraph', attrs: { style: 'Title' }, content: [{ type: 'text', text: 'Injected style' }] });
      parts['word/header1.xml'].content![0].content![0].text = 'Secret';
    });
    const files = unzipSync(out);
    const numbering = strFromU8(files['word/numbering.xml']);
    expect(numbering).toMatch(/<w:abstractNum w:abstractNumId="1">[\s\S]*<\/w:abstractNum><w:num w:numId="1">/);
    expect(numbering).toContain('<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>');
    const rels = strFromU8(files['word/_rels/document.xml.rels']);
    expect(rels).toContain('Target="https://new.example/" TargetMode="External"');
    expect(rels).toMatch(/Target="media\/editordoc1\.png"/);
    expect(files['word/media/editordoc1.png']).toEqual(PNG_1PX);
    expect(strFromU8(files['word/styles.xml'])).toContain('w:styleId="Title"');
    expect(strFromU8(files['word/header1.xml'])).toContain('Secret');

    const last = importPart(again, again.main).content!.slice(-2);
    expect(last[0].attrs).toMatchObject({ numId: '2' });
    expect(last[0].content!.find((n) => n.type === 'image')!.attrs).toMatchObject({ width: 40, height: 20 });
    expect(last[1].attrs).toMatchObject({ style: 'Title' });
  });

  it('round-trips a third-party DOCX (macOS textutil)', () => {
    const { parts, again } = roundTrip(fixture('sample.docx'));
    const text = textOf(parts['word/document.xml']);
    expect(text).toContain('Title Heading');
    expect(text).toContain('Centered');
    // textutil writes run properties out of schema order; export normalises once, then is stable
    const once = importWordParts(again);
    expect(textOf(once['word/document.xml'])).toBe(text);
    expect(importWordParts(loadWordPackage(exportDocx(again, { parts: once })))).toEqual(once);
  });

  it('creates a blank document that opens', () => {
    const pkg = loadWordPackage(zipSync(createDocxFiles('<w:p/>')));
    expect(importPart(pkg, pkg.main).content).toEqual([{ type: 'paragraph' }]);
    expect(pkg.styles.byId.has('Heading1')).toBe(true);
  });
});

describe('Legacy .doc', () => {
  it('converts text, formatting and tables', () => {
    const pkg = loadWordPackage(fixture('sample.doc'));
    expect(pkg.source).toBe('doc');
    const doc = importPart(pkg, pkg.main);
    const text = textOf(doc);
    expect(text).toContain('Title Heading');
    expect(text).toContain('Hello bold and italic under text.');
    const table = doc.content!.find((n) => n.type === 'table');
    expect(table).toBeTruthy();
    expect(textOf({ type: 'doc', content: [table!] })).toMatch(/A1[\s\S]*B1[\s\S]*A2/);
    const runs = doc.content!.flatMap((n) => n.content ?? []);
    const boldRun = runs.find((n) => n.text === 'bold');
    expect(boldRun?.marks?.some((m) => m.type === 'bold')).toBe(true);
    const centered = doc.content!.find((n) => n.content?.some((c) => c.text?.includes('Centered')));
    expect(centered?.attrs?.align).toBe('center');
  });
});

describe('Word CRDT seed', () => {
  it('is deterministic, so independent seeds merge without duplicating text', () => {
    const bytes = richDocx();
    const a = buildWordSeed('doc-1', loadWordPackage(bytes));
    const b = buildWordSeed('doc-1', loadWordPackage(bytes));
    expect(a).toEqual(b);

    const peer1 = new Y.Doc();
    const peer2 = new Y.Doc();
    initializeWordDocument(peer1, 'A.docx', a);
    initializeWordDocument(peer2, 'A.docx', b);
    Y.applyUpdate(peer1, Y.encodeStateAsUpdate(peer2));
    const pkg = loadWordPackage(bytes);
    const body = yXmlFragmentToProsemirrorJSON(peer1.getXmlFragment(WORD_BODY));
    expect(textOf(body as WordNodeJSON)).toBe(textOf(importPart(pkg, pkg.main)));
    expect(peer1.getXmlFragment(fragmentFor(pkg, 'word/header1.xml')).length).toBe(1);
    expect(peer1.getMap('meta').get('format')).toBe('word');
  });

  it('does not let undo remove the seeded content', () => {
    const doc = new Y.Doc();
    const um = createUndoManager(doc);
    initializeWordDocument(doc, 'A.docx', buildWordSeed('doc-2', loadWordPackage(richDocx())));
    um.undo();
    expect(doc.getXmlFragment(WORD_BODY).length).toBeGreaterThan(0);
  });
});

describe('Word table placement', () => {
  it('follows floating offset, then indent, then centring', async () => {
    const { tablePlacement } = await import('../lib/word/editor');
    expect(tablePlacement('<w:tblPr><w:tblpPr w:horzAnchor="text" w:tblpX="-642.0000000000002"/><w:tblInd w:w="-108.0" w:type="dxa"/></w:tblPr>').offset).toBeCloseTo(-42.8, 1);
    expect(tablePlacement('<w:tblPr><w:tblInd w:w="-108" w:type="dxa"/></w:tblPr>').offset).toBeCloseTo(-7.2, 1);
    expect(tablePlacement('<w:tblPr><w:jc w:val="center"/></w:tblPr>')).toEqual({ offset: 0, center: true });
    expect(tablePlacement('')).toEqual({ offset: 0, center: false });
  });
});
