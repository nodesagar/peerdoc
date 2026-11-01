import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { WORD_BODY, getMetaMap, seedClientId } from '../crdt/schema';
import { WordPackage } from './package';
import { importPart } from './import';
import { wordSchema, WordNodeJSON } from './schema';

/** Y.Doc fragment holding one editable part. */
export const fragmentFor = (pkg: WordPackage, part: string) => (part === pkg.main ? WORD_BODY : `word:${part}`);

/** The parts the editor owns: body plus the final section's default header and footer. */
export const editableParts = (pkg: WordPackage) =>
  [pkg.main, pkg.headerPart, pkg.footerPart].filter((p): p is string => Boolean(p));

export function importWordParts(pkg: WordPackage): Record<string, WordNodeJSON> {
  return Object.fromEntries(editableParts(pkg).map((part) => [part, importPart(pkg, part)]));
}

/**
 * Initial CRDT state for a Word document, byte-identical for every peer that
 * imports the same file (fixed client id, deterministic import).
 */
export function buildWordSeed(documentId: string, pkg: WordPackage): Uint8Array {
  const seed = new Y.Doc();
  seed.clientID = seedClientId(documentId);
  seed.transact(() => {
    const meta = getMetaMap(seed);
    meta.set('documentId', documentId);
    meta.set('format', 'word');
    for (const [part, json] of Object.entries(importWordParts(pkg))) {
      prosemirrorJSONToYXmlFragment(wordSchema, json, seed.getXmlFragment(fragmentFor(pkg, part)));
    }
  });
  const update = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  return update;
}
