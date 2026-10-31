import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

/**
 * Creates a sample "CONFIDENTIAL AGREEMENT" PDF for quick testing
 */
export async function createSampleConfidentialAgreement(): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();

  const timesRomanFont = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const timesBoldFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

  // Page 1 - Confidential Agreement
  const page1 = pdfDoc.addPage([612, 792]);
  const { width, height } = page1.getSize();

  // Header Title
  page1.drawText('CONFIDENTIAL NON-DISCLOSURE AGREEMENT', {
    x: 50,
    y: height - 80,
    size: 16,
    font: timesBoldFont,
    color: rgb(0.1, 0.1, 0.1),
  });

  page1.drawText('EXHIBIT A - P2P COLLABORATION', {
    x: width - 220,
    y: height - 80,
    size: 10,
    font: timesRomanFont,
    color: rgb(0.4, 0.4, 0.4),
  });

  page1.drawLine({
    start: { x: 50, y: height - 95 },
    end: { x: width - 50, y: height - 95 },
    thickness: 1.5,
    color: rgb(0.2, 0.2, 0.2),
  });

  page1.drawText('1. PARTIES & RECITALS', {
    x: 50,
    y: height - 130,
    size: 12,
    font: timesBoldFont,
    color: rgb(0.1, 0.1, 0.1),
  });

  page1.drawText(
    'This Agreement is entered into between Party Alpha and Party Beta for confidential research into',
    {
      x: 50,
      y: height - 150,
      size: 10,
      font: timesRomanFont,
      color: rgb(0.2, 0.2, 0.2),
    }
  );

  page1.drawText(
    'peer-to-peer decentralized collaborative document architectures running entirely offline in web browsers.',
    {
      x: 50,
      y: height - 165,
      size: 10,
      font: timesRomanFont,
      color: rgb(0.2, 0.2, 0.2),
    }
  );

  page1.drawText('2. CONFIDENTIAL INFORMATION TO BE REDACTED', {
    x: 50,
    y: height - 200,
    size: 12,
    font: timesBoldFont,
    color: rgb(0.8, 0.1, 0.1),
  });

  page1.drawText('Client Secret Key: 98f4a-7182b-secret-p2p-key-1092', {
    x: 50,
    y: height - 220,
    size: 10,
    font: timesRomanFont,
    color: rgb(0.1, 0.1, 0.1),
  });

  page1.drawText('Internal Budget: $4,500,000 USD allocated for phase 1 development.', {
    x: 50,
    y: height - 235,
    size: 10,
    font: timesRomanFont,
    color: rgb(0.1, 0.1, 0.1),
  });

  page1.drawText('3. SIGNATURES & EXECUTION', {
    x: 50,
    y: height - 275,
    size: 12,
    font: timesBoldFont,
    color: rgb(0.1, 0.1, 0.1),
  });

  page1.drawText('Authorized Signature: _______________________      Date: ___________', {
    x: 50,
    y: height - 310,
    size: 10,
    font: timesRomanFont,
    color: rgb(0.3, 0.3, 0.3),
  });

  // Page 2 - Appendix
  const page2 = pdfDoc.addPage([612, 792]);
  const { width: w2, height: h2 } = page2.getSize();

  page2.drawText('APPENDIX 1: SYSTEM TOPOLOGY', {
    x: 50,
    y: h2 - 80,
    size: 14,
    font: timesBoldFont,
    color: rgb(0.1, 0.1, 0.1),
  });

  page2.drawText(
    'This page can be reordered or rotated in the Organize Tool to test CRDT fractional index ordering.',
    {
      x: 50,
      y: h2 - 110,
      size: 10,
      font: timesRomanFont,
      color: rgb(0.3, 0.3, 0.3),
    }
  );

  // Fixed timestamps: document ID = SHA-256(bytes), so the demo must be byte-identical
  // on every load/machine to land in the same collaboration room.
  const fixedDate = new Date(Date.UTC(2025, 0, 1));
  pdfDoc.setCreationDate(fixedDate);
  pdfDoc.setModificationDate(fixedDate);
  return await pdfDoc.save();
}
