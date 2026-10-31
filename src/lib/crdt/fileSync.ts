import * as Y from 'yjs';
import { uint8ArrayToBase64, base64ToUint8Array } from './pdfStore';

export interface CDSFileContent {
  format: 'CDSYNC_V1';
  documentId: string;
  timestamp: number;
  updateBase64: string;
}

/**
 * Export current document state or delta as a .cdsync file for offline store-and-forward.
 */
export function exportSyncFile(
  doc: Y.Doc,
  documentId: string,
  targetStateVector?: Uint8Array
): { blob: Blob; filename: string } {
  const update = targetStateVector
    ? Y.encodeStateAsUpdate(doc, targetStateVector)
    : Y.encodeStateAsUpdate(doc);

  const payload: CDSFileContent = {
    format: 'CDSYNC_V1',
    documentId,
    timestamp: Date.now(),
    updateBase64: uint8ArrayToBase64(update),
  };

  const jsonStr = JSON.stringify(payload, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/x-cdsync' });
  const filename = `${documentId.slice(0, 8)}-${Date.now()}.cdsync`;

  return { blob, filename };
}

/**
 * Import a .cdsync file and apply CRDT updates to the document.
 * Idempotent and order-independent.
 */
export async function importSyncFile(
  fileOrBlob: File | Blob | ArrayBuffer | string,
  doc: Y.Doc,
  expectedDocId?: string
): Promise<{ documentId: string; applied: boolean }> {
  let text = '';
  if (typeof fileOrBlob === 'string') {
    text = fileOrBlob;
  } else if (fileOrBlob instanceof ArrayBuffer) {
    text = new TextDecoder().decode(fileOrBlob);
  } else {
    text = await fileOrBlob.text();
  }

  const parsed = JSON.parse(text) as CDSFileContent;
  if (!parsed || parsed.format !== 'CDSYNC_V1' || !parsed.updateBase64) {
    throw new Error('Invalid .cdsync file format');
  }

  if (expectedDocId && parsed.documentId !== expectedDocId) {
    throw new Error(
      `Document mismatch: file is for ${parsed.documentId}, but active doc is ${expectedDocId}`
    );
  }

  const update = base64ToUint8Array(parsed.updateBase64);
  Y.applyUpdate(doc, update, 'file-sync');

  return {
    documentId: parsed.documentId,
    applied: true,
  };
}

/**
 * Triggers a browser file download of a .cdsync file.
 */
export function downloadSyncFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
