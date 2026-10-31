import React, { useState, useEffect } from 'react';
import { get, set, del } from 'idb-keyval';
import { ActiveTool, ProcessedDoc } from './types';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { Dashboard } from './components/Dashboard';
import { EditTool } from './components/EditTool';
import { OrganizeTool } from './components/OrganizeTool';
import { RedactTool } from './components/RedactTool';
import { SignTool } from './components/SignTool';
import { CompressTool } from './components/CompressTool';
import { MergeTool } from './components/MergeTool';
import { SplitTool } from './components/SplitTool';
import { WatermarkTool } from './components/WatermarkTool';
import { EncryptTool } from './components/EncryptTool';
import { ConvertTool } from './components/ConvertTool';
import { PrivacyModal } from './components/PrivacyModal';
import { useCRDTSync } from './hooks/useCRDTSync';
import { computeSHA256, getOriginalPDF, storeOriginalPDF } from './lib/crdt/pdfStore';
import { createSampleConfidentialAgreement } from './utils/samplePdfs';
import { PDFDocument } from 'pdf-lib';

async function countPages(bytes: Uint8Array): Promise<number> {
  try {
    return (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
  } catch {
    return 0;
  }
}

/** Accepts a bare SHA-256 room ID or a pasted share link containing ?doc=<id>. */
function parseRoomId(input: string): string | null {
  let id = input.trim();
  try {
    id = new URL(id).searchParams.get('doc') ?? id;
  } catch {
    /* not a URL */
  }
  id = id.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(id) ? id : null;
}

export default function App() {
  const [activeTool, setActiveTool] = useState<ActiveTool>('dashboard');
  const [isPrivacyModalOpen, setIsPrivacyModalOpen] = useState<boolean>(false);

  // Active Document and Room State
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [rawPdfBytes, setRawPdfBytes] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState<string>('Document.pdf');
  const [pageCount, setPageCount] = useState<number>(0);

  const [recentDocs, setRecentDocs] = useState<ProcessedDoc[]>([]);

  // Initialize unified CRDT Sync hook for the active document room
  const crdt = useCRDTSync({
    documentId,
    initialPdfBytes: rawPdfBytes,
    initialTitle: fileName,
    pageCount,
  });

  // Load recent docs history from IndexedDB on startup
  useEffect(() => {
    get<ProcessedDoc[]>('editordoc_recent_docs').then((val) => {
      if (val) setRecentDocs(val);
    });

    // Check URL parameters for collaborative room invitation: ?doc=<sha256>
    const urlParams = new URLSearchParams(window.location.search);
    const docFromUrl = urlParams.get('doc');
    if (docFromUrl) {
      handleJoinRoomId(docFromUrl);
    }
  }, []);

  const handleDocumentProcessed = (newDoc: ProcessedDoc) => {
    setRecentDocs((prev) => {
      const updated = [newDoc, ...prev.filter((d) => d.id !== newDoc.id)];
      const trimmed = updated.slice(0, 20);
      set('editordoc_recent_docs', trimmed).catch(console.error);
      return trimmed;
    });
  };

  const handleClearHistory = () => {
    setRecentDocs([]);
    del('editordoc_recent_docs').catch(console.error);
  };

  const updateUrlDocParam = (docId: string | null) => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (docId) {
      url.searchParams.set('doc', docId);
    } else {
      url.searchParams.delete('doc');
    }
    window.history.replaceState(null, '', url.toString());
  };

  const handleSelectRecentDoc = (doc: ProcessedDoc) => {
    if (doc.blob) {
      const url = URL.createObjectURL(doc.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (doc.documentId) {
      handleJoinRoomId(doc.documentId);
    }
  };

  const handleLoadSample = async () => {
    try {
      const sampleBytes = await createSampleConfidentialAgreement();
      await openDocument(sampleBytes, 'Confidential_Agreement.pdf');
    } catch (err) {
      console.error('Failed to load demo document:', err);
    }
  };

  // All document state is set together after every await, so the CRDT hook never
  // sees a new room ID paired with the previous document's bytes or page count.
  const openDocument = async (bytes: Uint8Array, name: string) => {
    const docId = (await computeSHA256(bytes.slice())).toLowerCase();
    await storeOriginalPDF(docId, bytes.slice(), name);
    const count = await countPages(bytes);

    setFileName(name);
    setRawPdfBytes(bytes.slice());
    setPageCount(count);
    setDocumentId(docId);
    updateUrlDocParam(docId);
    setActiveTool('edit');
  };

  const handleUploadNewDoc = async (file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      await openDocument(new Uint8Array(buffer), file.name);
    } catch (err) {
      console.error('Failed to upload PDF:', err);
    }
  };

  const handleJoinRoomId = async (roomId: string) => {
    const cleanId = parseRoomId(roomId);
    if (!cleanId) {
      alert('Invalid room ID. Paste the 64-character document ID or a share link containing ?doc=...');
      return;
    }
    const existing = await getOriginalPDF(cleanId);
    // Joiners never seed pages unless they hold the PDF; otherwise pages arrive from peers.
    const count = existing?.bytes ? await countPages(existing.bytes) : 0;

    setRawPdfBytes(existing?.bytes ?? null);
    setFileName(existing?.filename || 'Document.pdf');
    setPageCount(count);
    setDocumentId(cleanId);
    updateUrlDocParam(cleanId);
    setActiveTool('edit');
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#faf9f8] text-[#1a1c1c] selection:bg-[#005db2]/15 selection:text-[#005db2]">
      {/* Navigation Header with CollaborationBar */}
      <Header
        activeTool={activeTool}
        setActiveTool={setActiveTool}
        onOpenPrivacyModal={() => setIsPrivacyModalOpen(true)}
        documentId={documentId}
        syncStatus={crdt.syncStatus}
        peerCount={crdt.peerCount}
        onExportSync={crdt.exportSync}
        onImportSync={crdt.importSync}
      />

      {/* Main Tool Area */}
      <main className="flex-1">
        {activeTool === 'dashboard' && (
          <Dashboard
            setActiveTool={setActiveTool}
            recentDocs={recentDocs}
            onClearHistory={handleClearHistory}
            onSelectRecentDoc={handleSelectRecentDoc}
            onLoadSample={handleLoadSample}
            onUploadNewDoc={handleUploadNewDoc}
            onJoinRoomId={handleJoinRoomId}
            activeDocId={documentId}
          />
        )}

        {activeTool === 'edit' && (
          <EditTool
            onDocumentProcessed={handleDocumentProcessed}
            rawPdfBytes={crdt.rawPdfBytes}
            documentId={documentId}
            fileName={fileName}
            crdt={crdt}
            onUploadFile={handleUploadNewDoc}
          />
        )}

        {activeTool === 'organize' && (
          <OrganizeTool
            onDocumentProcessed={handleDocumentProcessed}
            rawPdfBytes={crdt.rawPdfBytes}
            documentId={documentId}
            fileName={fileName}
            crdt={crdt}
            onUploadFile={handleUploadNewDoc}
          />
        )}

        {activeTool === 'redact' && (
          <RedactTool
            onDocumentProcessed={handleDocumentProcessed}
            rawPdfBytes={crdt.rawPdfBytes}
            documentId={documentId}
            fileName={fileName}
            crdt={crdt}
            onUploadFile={handleUploadNewDoc}
          />
        )}

        {activeTool === 'sign' && (
          <SignTool
            onDocumentProcessed={handleDocumentProcessed}
            rawPdfBytes={crdt.rawPdfBytes}
            documentId={documentId}
            fileName={fileName}
            crdt={crdt}
            onUploadFile={handleUploadNewDoc}
          />
        )}

        {activeTool === 'compress' && (
          <CompressTool
            onDocumentProcessed={handleDocumentProcessed}
            rawPdfBytes={crdt.rawPdfBytes}
            fileName={fileName}
            crdt={crdt}
          />
        )}

        {activeTool === 'merge' && (
          <MergeTool onDocumentProcessed={handleDocumentProcessed} />
        )}

        {activeTool === 'split' && (
          <SplitTool onDocumentProcessed={handleDocumentProcessed} />
        )}

        {activeTool === 'watermark' && (
          <WatermarkTool onDocumentProcessed={handleDocumentProcessed} />
        )}

        {activeTool === 'encrypt' && (
          <EncryptTool onDocumentProcessed={handleDocumentProcessed} />
        )}

        {activeTool === 'convert' && (
          <ConvertTool onDocumentProcessed={handleDocumentProcessed} />
        )}
      </main>

      {/* Footer */}
      <Footer onOpenPrivacyModal={() => setIsPrivacyModalOpen(true)} />

      {/* Privacy Guarantee Modal */}
      <PrivacyModal
        isOpen={isPrivacyModalOpen}
        onClose={() => setIsPrivacyModalOpen(false)}
      />
    </div>
  );
}
