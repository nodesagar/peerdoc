/**
 * Document formats the editor opens. Each format names how its bytes are
 * recognised; the CRDT room, byte transfer and invite flow are format-agnostic.
 * Adding a format = a detector here, a seed in App.openDocument, an editor view.
 */
export type DocFormat = 'pdf' | 'docx' | 'doc';

export const FORMAT_LABEL: Record<DocFormat, string> = {
  pdf: 'PDF',
  docx: 'Word document',
  doc: 'Word 97-2003 document',
};

/** File picker filter for every supported format. */
export const OPEN_ACCEPT =
  '.pdf,.docx,.doc,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword';

export function detectFormat(bytes: Uint8Array): DocFormat | null {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'docx';
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'doc';
  // %PDF may follow a little junk; readers accept it within the first 1 KB
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (head.includes('%PDF-')) return 'pdf';
  return null;
}

export const isWordFormat = (f: DocFormat | null | undefined) => f === 'docx' || f === 'doc';
