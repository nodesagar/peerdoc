import { useState, useEffect, useRef, useCallback } from 'react';
import * as Y from 'yjs';
import {
  DocumentSnapshot,
  readDocumentSnapshot,
  initializeDocument,
  getMetaMap,
  getPagesMap,
  getTextOverlaysMap,
  getWhiteoutsMap,
  getRedactionsMap,
  getSignaturesMap,
  addTextOverlayCRDT,
  updateTextOverlayCRDT,
  removeTextOverlayCRDT,
  addWhiteoutCRDT,
  updateWhiteoutCRDT,
  removeWhiteoutCRDT,
  addRedactionCRDT,
  removeRedactionCRDT,
  addSignatureCRDT,
  updateSignatureCRDT,
  removeSignatureCRDT,
  movePageCRDT,
  rotatePageCRDT,
  setPageDeletedCRDT,
} from '../lib/crdt/schema';
import { createP2PProvider, P2PProviderHandle } from '../lib/crdt/p2pProvider';
import { PdfTransferEvent } from '../lib/crdt/docSync';

export type TransferLogEntry = PdfTransferEvent & { at: number };
import { exportSyncFile, importSyncFile, downloadSyncFile } from '../lib/crdt/fileSync';
import { getOriginalPDF, storeOriginalPDF } from '../lib/crdt/pdfStore';
import { SyncStatus, TextOverlay, WhiteoutBox, RedactionBox, SignatureBox, PageMetadata } from '../types';

export interface UseCRDTSyncOptions {
  documentId: string | null;
  initialPdfBytes?: Uint8Array | null;
  initialTitle?: string;
  pageCount?: number;
}

const EMPTY_SNAPSHOT: DocumentSnapshot = {
  meta: { documentId: '', title: '', createdAt: 0 },
  pages: [],
  textOverlays: [],
  whiteouts: [],
  redactions: [],
  signatures: [],
};

export function useCRDTSync(options: UseCRDTSyncOptions) {
  const { documentId, initialPdfBytes, initialTitle, pageCount } = options;

  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [snapshot, setSnapshot] = useState<DocumentSnapshot>(EMPTY_SNAPSHOT);

  const [syncStatus, setSyncStatus] = useState<SyncStatus>('offline');
  const [peerCount, setPeerCount] = useState<number>(0);
  const [rawPdfBytes, setRawPdfBytes] = useState<Uint8Array | null>(initialPdfBytes || null);
  const [pdfProgress, setPdfProgress] = useState<number | null>(null);
  const [isLoaded, setIsLoaded] = useState<boolean>(false);
  // Receiving side: what happened to our PDF request. Sending side: active uploads.
  const [transferLog, setTransferLog] = useState<TransferLogEntry[]>([]);
  const [servingCount, setServingCount] = useState<number>(0);

  const providerHandleRef = useRef<P2PProviderHandle | null>(null);
  const docRef = useRef<Y.Doc | null>(null);
  const rawPdfBytesRef = useRef<Uint8Array | null>(rawPdfBytes);

  // Sync refs with state
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  useEffect(() => {
    rawPdfBytesRef.current = rawPdfBytes;
  }, [rawPdfBytes]);

  // Sync initialPdfBytes if passed later
  useEffect(() => {
    if (initialPdfBytes && !rawPdfBytes) {
      setRawPdfBytes(initialPdfBytes);
      rawPdfBytesRef.current = initialPdfBytes;
    }
  }, [initialPdfBytes, rawPdfBytes]);

  // Main lifecycle for joining a document room
  useEffect(() => {
    if (!documentId) {
      setDoc(null);
      docRef.current = null;
      setSnapshot(EMPTY_SNAPSHOT);
      setIsLoaded(false);
      setSyncStatus('offline');
      setPeerCount(0);
      setRawPdfBytes(null);
      setPdfProgress(null);
      rawPdfBytesRef.current = null;
      return;
    }

    const cleanDocId = documentId.trim().toLowerCase();
    let isCancelled = false;
    const ydoc = new Y.Doc();
    // Reset everything belonging to the previous document immediately, so tools
    // never render (or mutate) the old doc's state/bytes under the new room ID.
    setDoc(ydoc);
    docRef.current = ydoc;
    setSnapshot(EMPTY_SNAPSHOT);
    setIsLoaded(false);
    setSyncStatus('connecting');
    setPeerCount(0);
    setPdfProgress(null);
    setTransferLog([]);
    setServingCount(0);
    setRawPdfBytes(initialPdfBytes || null);
    rawPdfBytesRef.current = initialPdfBytes || null;

    // Deep observer callback to re-render UI whenever nested maps change
    const handleDeepChange = () => {
      if (isCancelled) return;
      setSnapshot(readDocumentSnapshot(ydoc));
    };

    const metaMap = getMetaMap(ydoc);
    const pagesMap = getPagesMap(ydoc);
    const textOverlaysMap = getTextOverlaysMap(ydoc);
    const whiteoutsMap = getWhiteoutsMap(ydoc);
    const redactionsMap = getRedactionsMap(ydoc);
    const signaturesMap = getSignaturesMap(ydoc);

    metaMap.observeDeep(handleDeepChange);
    pagesMap.observeDeep(handleDeepChange);
    textOverlaysMap.observeDeep(handleDeepChange);
    whiteoutsMap.observeDeep(handleDeepChange);
    redactionsMap.observeDeep(handleDeepChange);
    signaturesMap.observeDeep(handleDeepChange);

    // Load or initialize
    (async () => {
      try {
        // 1. Check local PDF bytes in IndexedDB
        const existingPdf = await getOriginalPDF(cleanDocId);
        if (existingPdf && existingPdf.bytes) {
          if (!isCancelled) {
            setRawPdfBytes(existingPdf.bytes);
            rawPdfBytesRef.current = existingPdf.bytes;
          }
        } else if (initialPdfBytes) {
          await storeOriginalPDF(cleanDocId, initialPdfBytes, initialTitle);
          if (!isCancelled) {
            setRawPdfBytes(initialPdfBytes);
            rawPdfBytesRef.current = initialPdfBytes;
          }
        } else {
          if (!isCancelled) {
            setRawPdfBytes(null);
            rawPdfBytesRef.current = null;
          }
        }

        // 2. Connect P2P and IndexedDB persistence
        const handle = await createP2PProvider(cleanDocId, ydoc, {
          getLocalPdfBytes: () => rawPdfBytesRef.current,
          onStatusChange: (status) => {
            if (!isCancelled) setSyncStatus(status);
          },
          onPeersChange: (count) => {
            if (!isCancelled) setPeerCount(count);
          },
          onPdfAvailable: (bytes: Uint8Array, _filename?: string) => {
            if (!isCancelled) {
              setRawPdfBytes(bytes);
              rawPdfBytesRef.current = bytes;
              setPdfProgress(null);
            }
          },
          onPdfProgress: (progress) => {
            if (!isCancelled) setPdfProgress(progress);
          },
          onPdfTransferEvent: (event) => {
            if (isCancelled) return;
            console.info('[EditorDoc PDF]', event.kind, event);
            if (event.kind === 'serving') setServingCount((n) => n + 1);
            else if (event.kind === 'served') setServingCount((n) => Math.max(0, n - 1));
            else setTransferLog((log) => [...log, { ...event, at: Date.now() }].slice(-12));
          },
        });

        if (isCancelled) {
          handle.destroy();
          return;
        }

        providerHandleRef.current = handle;

        // 3. If doc has no pages yet and pageCount is provided, initialize
        if (pageCount && pageCount > 0) {
          initializeDocument(ydoc, cleanDocId, initialTitle || 'Document.pdf', pageCount);
        }

        // 4. Request PDF bytes from peers if missing locally
        if (!existingPdf && !initialPdfBytes) {
          handle.engine.requestPDFFromPeers(false); // direct links only; poll falls back to relay
        }

        if (!isCancelled) {
          setSnapshot(readDocumentSnapshot(ydoc));
          setIsLoaded(true);
        }
      } catch (err) {
        console.error('Error initializing CRDT sync:', err);
      }
    })();

    return () => {
      isCancelled = true;
      metaMap.unobserveDeep(handleDeepChange);
      pagesMap.unobserveDeep(handleDeepChange);
      textOverlaysMap.unobserveDeep(handleDeepChange);
      whiteoutsMap.unobserveDeep(handleDeepChange);
      redactionsMap.unobserveDeep(handleDeepChange);
      signaturesMap.unobserveDeep(handleDeepChange);

      if (providerHandleRef.current) {
        providerHandleRef.current.destroy();
        providerHandleRef.current = null;
      }
      if (docRef.current === ydoc) docRef.current = null;
      ydoc.destroy();
    };
  }, [documentId, pageCount]);

  // ================= Mutation Helpers =================

  const addTextOverlay = useCallback(
    (overlay: Omit<TextOverlay, 'id'> & { id?: string }) => {
      if (!docRef.current) return '';
      return addTextOverlayCRDT(docRef.current, overlay);
    },
    []
  );

  const updateTextOverlay = useCallback(
    (id: string, patch: Partial<TextOverlay>) => {
      if (!docRef.current) return;
      updateTextOverlayCRDT(docRef.current, id, patch);
    },
    []
  );

  const removeTextOverlay = useCallback((id: string) => {
    if (!docRef.current) return;
    removeTextOverlayCRDT(docRef.current, id);
  }, []);

  const addWhiteout = useCallback(
    (box: Omit<WhiteoutBox, 'id'> & { id?: string }) => {
      if (!docRef.current) return '';
      return addWhiteoutCRDT(docRef.current, box);
    },
    []
  );

  const updateWhiteout = useCallback(
    (id: string, patch: Partial<WhiteoutBox>) => {
      if (!docRef.current) return;
      updateWhiteoutCRDT(docRef.current, id, patch);
    },
    []
  );

  const removeWhiteout = useCallback((id: string) => {
    if (!docRef.current) return;
    removeWhiteoutCRDT(docRef.current, id);
  }, []);

  const addRedaction = useCallback(
    (redaction: Omit<RedactionBox, 'id'> & { id?: string }) => {
      if (!docRef.current) return '';
      return addRedactionCRDT(docRef.current, redaction);
    },
    []
  );

  const removeRedaction = useCallback((id: string) => {
    if (!docRef.current) return;
    removeRedactionCRDT(docRef.current, id);
  }, []);

  const addSignature = useCallback(
    (sig: Omit<SignatureBox, 'id'> & { id?: string }) => {
      if (!docRef.current) return '';
      return addSignatureCRDT(docRef.current, sig);
    },
    []
  );

  const updateSignature = useCallback(
    (id: string, patch: Partial<SignatureBox>) => {
      if (!docRef.current) return;
      updateSignatureCRDT(docRef.current, id, patch);
    },
    []
  );

  const removeSignature = useCallback((id: string) => {
    if (!docRef.current) return;
    removeSignatureCRDT(docRef.current, id);
  }, []);

  const movePage = useCallback(
    (pageId: string, prevOrder: string | null, nextOrder: string | null) => {
      if (!docRef.current) return;
      movePageCRDT(docRef.current, pageId, prevOrder, nextOrder);
    },
    []
  );

  const rotatePage = useCallback((pageId: string, degreesDelta: number) => {
    if (!docRef.current) return;
    rotatePageCRDT(docRef.current, pageId, degreesDelta);
  }, []);

  const deletePage = useCallback((pageId: string, deleted: boolean) => {
    if (!docRef.current) return;
    setPageDeletedCRDT(docRef.current, pageId, deleted);
  }, []);

  const exportSync = useCallback(() => {
    if (!docRef.current || !documentId) return;
    const { blob, filename } = exportSyncFile(docRef.current, documentId);
    downloadSyncFile(blob, filename);
  }, [documentId]);

  const importSync = useCallback(
    async (file: File) => {
      if (!docRef.current || !documentId) return;
      try {
        await importSyncFile(file, docRef.current, documentId);
      } catch (err) {
        console.error('Failed to import .cdsync file:', err);
        alert('Could not import sync file: ' + (err instanceof Error ? err.message : err));
      }
    },
    [documentId]
  );

  const requestPdfFromPeers = useCallback(() => {
    // Explicit user action: ask on every route, relay included
    providerHandleRef.current?.engine.requestPDFFromPeers(true, true);
  }, []);

  return {
    doc,
    documentId,
    snapshot,
    pages: snapshot.pages,
    textOverlays: snapshot.textOverlays,
    whiteouts: snapshot.whiteouts,
    redactions: snapshot.redactions,
    signatures: snapshot.signatures,
    meta: snapshot.meta,
    syncStatus,
    peerCount,
    rawPdfBytes,
    pdfProgress,
    transferLog,
    servingCount,
    isLoaded,
    requestPdfFromPeers,
    // Mutations
    addTextOverlay,
    updateTextOverlay,
    removeTextOverlay,
    addWhiteout,
    updateWhiteout,
    removeWhiteout,
    addRedaction,
    removeRedaction,
    addSignature,
    updateSignature,
    removeSignature,
    movePage,
    rotatePage,
    deletePage,
    exportSync,
    importSync,
  };
}
