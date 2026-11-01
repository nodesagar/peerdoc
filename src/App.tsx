import React, { useState, useEffect } from 'react';
import { get, set, del } from 'idb-keyval';
import { ActiveTool, ProcessedDoc } from './types';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { Dashboard } from './components/Dashboard';
import { EditTool } from './components/EditTool';
import { WordEditor } from './components/WordEditor';
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
import { UpdateBanner } from './components/UpdateBanner';
import { useCRDTSync, DocumentSeed } from './hooks/useCRDTSync';
import { detectFormat, isWordFormat, DocFormat, FORMAT_LABEL } from './lib/formats';
import { loadWordPackage } from './lib/word/package';
import { buildWordSeed } from './lib/word/seed';
import { createDocxFiles } from './lib/word/templates';
import { zipSync } from 'fflate';
import { computeSHA256, getOriginalPDF, storeOriginalPDF } from './lib/crdt/pdfStore';
import { createSampleConfidentialAgreement } from './utils/samplePdfs';
import { parseShareInput } from './lib/crdt/roomKey';
import { createOwnedRoom, getIdentity, loadRoom, saveRoom } from './lib/crdt/access';
import { useRoomAccess } from './hooks/useRoomAccess';
import { AccessCard } from './components/AccessCard';
import { PDFDocument } from 'pdf-lib';

async function countPages(bytes: Uint8Array): Promise<number> {
  try {
    return (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
  } catch {
    return 0;
  }
}

/** Initial CRDT state for a file we hold locally, per format. Throws on a damaged file. */
async function buildSeed(docId: string, bytes: Uint8Array, format: DocFormat): Promise<DocumentSeed> {
  if (isWordFormat(format)) return { format: 'word', update: buildWordSeed(docId, loadWordPackage(bytes)) };
  return { format: 'pdf', pageCount: await countPages(bytes) };
}

/** PDF-only tools; Word documents are edited in WordEditor. */
const PDF_ONLY_TOOLS: ActiveTool[] = ['organize', 'redact', 'sign', 'compress'];

/** Tools that work on the shared document (the others take their own files). */
const DOC_TOOLS: ActiveTool[] = ['edit', 'organize', 'redact', 'sign', 'compress'];

/** Typing in a field keeps the browser's own text undo. */
function isTextInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

export default function App() {
  const [activeTool, setActiveTool] = useState<ActiveTool>('dashboard');
  const [isPrivacyModalOpen, setIsPrivacyModalOpen] = useState<boolean>(false);

  // Active Document and Room State
  const [documentId, setDocumentId] = useState<string | null>(null);
  // Bumped whenever this document's stored access record is replaced
  const [accessRevision, setAccessRevision] = useState(0);
  const [rawPdfBytes, setRawPdfBytes] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState<string>('Document.pdf');
  const [seed, setSeed] = useState<DocumentSeed | null>(null);
  // Known from local bytes; joiners still waiting for the file learn it from the room
  const [docFormat, setDocFormat] = useState<DocFormat | null>(null);

  const [recentDocs, setRecentDocs] = useState<ProcessedDoc[]>([]);

  // Who may be in the room; its current key is what the document channel uses
  const access = useRoomAccess(documentId, accessRevision);
  const crdt = useCRDTSync({
    documentId,
    roomKey: access.roomKey,
    initialPdfBytes: rawPdfBytes,
    initialTitle: fileName,
    seed,
  });
  const isWordDoc = isWordFormat(docFormat) || crdt.meta.format === 'word';

  // Load recent docs history from IndexedDB on startup
  useEffect(() => {
    get<ProcessedDoc[]>('editordoc_recent_docs').then((val) => {
      if (val) setRecentDocs(val);
    });

    // Invite (?doc=<sha256>#i=<token>&o=<owner>) or reopening a document (?doc=<sha256>)
    if (new URLSearchParams(window.location.search).get('doc')) {
      handleJoinRoomId(window.location.href);
    }
    // An invite for the page already open only changes the #fragment: no reload
    const onHashChange = () => {
      if (new URLSearchParams(window.location.hash.slice(1)).has('i')) handleJoinRoomId(window.location.href);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Let collaborators see which tool we have open
  const { setPresence, awareness } = crdt;
  useEffect(() => {
    setPresence({ tool: activeTool });
  }, [setPresence, awareness, activeTool]);
  const presence = React.useMemo(
    () => ({ awareness: crdt.awareness, user: crdt.user, onRename: crdt.setUser }),
    [crdt.awareness, crdt.user, crdt.setUser]
  );

  // Undo/redo shortcuts: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y
  const { undo, redo } = crdt;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || isTextInput(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) undo();
      else if ((key === 'z' && e.shiftKey) || (key === 'y' && !e.metaKey)) redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

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

  // Only the document ID: an invite token is used up, never left in the address bar
  const updateUrlDocParam = (docId: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('doc', docId);
    url.hash = '';
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
    const format = detectFormat(bytes);
    if (!format) {
      alert(`"${name}" is not a PDF or Word document.`);
      return;
    }
    const docId = (await computeSHA256(bytes.slice())).toLowerCase();
    let nextSeed: DocumentSeed;
    try {
      nextSeed = await buildSeed(docId, bytes, format);
    } catch (err) {
      alert(`Could not open this ${FORMAT_LABEL[format]}: ${err instanceof Error ? err.message : err}`);
      return;
    }
    await storeOriginalPDF(docId, bytes.slice(), name);
    // Reopening a PDF rejoins its room; a new PDF (or one we were removed from)
    // gets a fresh invite-only room that we own.
    const room = await loadRoom(docId);
    if (!room || room.removed) await createOwnedRoom(docId, await getIdentity());

    setFileName(name);
    setRawPdfBytes(bytes.slice());
    setSeed(nextSeed);
    setDocFormat(format);
    setDocumentId(docId);
    setAccessRevision((n) => n + 1);
    updateUrlDocParam(docId);
    setActiveTool('edit');
  };

  const handleUploadNewDoc = async (file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      await openDocument(new Uint8Array(buffer), file.name);
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  };

  const handleNewWordDoc = async () => {
    const bytes = zipSync(createDocxFiles('<w:p/>', { title: 'Untitled document' }));
    await openDocument(bytes, 'Untitled document.docx');
  };

  const handleJoinRoomId = async (input: string) => {
    const parsed = parseShareInput(input);
    if (!parsed) {
      alert('Invalid link. Paste an invite link, or the 64-character document ID of a document you have opened before.');
      return;
    }
    const cleanId = parsed.documentId;
    const existing = await getOriginalPDF(cleanId);
    const room = await loadRoom(cleanId);
    if (parsed.invite) {
      // Already a member of this owner's room? Then the invite is not needed.
      if (!(room?.ownerId === parsed.invite.ownerId && room.roomKey)) {
        await saveRoom(cleanId, { ownerId: parsed.invite.ownerId, token: parsed.invite.token });
      }
    } else if (!room) {
      if (existing?.bytes) {
        await createOwnedRoom(cleanId, await getIdentity()); // our own PDF from before invites
      } else {
        alert(
          parsed.legacyKey
            ? 'This is an old share link. Links no longer grant access by themselves: ask the owner for a personal invite link.'
            : 'You have not been invited to this document. Ask its owner for an invite link.'
        );
        window.history.replaceState(null, '', window.location.pathname);
        return;
      }
    }
    // Joiners never seed unless they hold the file; otherwise content arrives from peers.
    const format = existing?.bytes ? detectFormat(existing.bytes) : null;
    let nextSeed: DocumentSeed | null = null;
    if (existing?.bytes && format) {
      try {
        nextSeed = await buildSeed(cleanId, existing.bytes, format);
      } catch (err) {
        console.error('Stored file could not be read:', err);
      }
    }

    setRawPdfBytes(existing?.bytes ?? null);
    setFileName(existing?.filename || 'Document.pdf');
    setSeed(nextSeed);
    setDocFormat(format);
    setDocumentId(cleanId);
    setAccessRevision((n) => n + 1);
    updateUrlDocParam(cleanId);
    setActiveTool('edit');
  };

  return (
    <div className="min-h-screen flex flex-col bg-canvas text-ink">
      {/* Navigation Header with CollaborationBar */}
      <Header
        activeTool={activeTool}
        setActiveTool={setActiveTool}
        onOpenPrivacyModal={() => setIsPrivacyModalOpen(true)}
        documentId={documentId}
        syncStatus={crdt.syncStatus}
        peerCount={crdt.peerCount}
        servingCount={crdt.servingCount}
        onExportSync={crdt.exportSync}
        onImportSync={crdt.importSync}
        onUndo={crdt.undo}
        onRedo={crdt.redo}
        canUndo={crdt.canUndo}
        canRedo={crdt.canRedo}
        presence={presence}
        access={access}
        isWordDoc={isWordDoc}
      />

      {/* Main Tool Area */}
      <main className="flex-1">
        {DOC_TOOLS.includes(activeTool) && documentId && (access.status === 'pending' || access.status === 'removed') ? (
          <AccessCard status={access.status} onReturnToDashboard={() => setActiveTool('dashboard')} />
        ) : (
        <>
        {activeTool === 'dashboard' && (
          <Dashboard
            setActiveTool={setActiveTool}
            recentDocs={recentDocs}
            onClearHistory={handleClearHistory}
            onSelectRecentDoc={handleSelectRecentDoc}
            onLoadSample={handleLoadSample}
            onUploadNewDoc={handleUploadNewDoc}
            onJoinRoomId={handleJoinRoomId}
            onNewWordDoc={handleNewWordDoc}
            activeDocId={documentId}
          />
        )}

        {(activeTool === 'edit' || PDF_ONLY_TOOLS.includes(activeTool)) && isWordDoc && (
          <WordEditor
            onDocumentProcessed={handleDocumentProcessed}
            bytes={crdt.rawPdfBytes}
            documentId={documentId}
            fileName={fileName}
            crdt={crdt}
            onUploadFile={handleUploadNewDoc}
          />
        )}

        {activeTool === 'edit' && !isWordDoc && (
          <EditTool
            onDocumentProcessed={handleDocumentProcessed}
            rawPdfBytes={crdt.rawPdfBytes}
            documentId={documentId}
            fileName={fileName}
            crdt={crdt}
            onUploadFile={handleUploadNewDoc}
          />
        )}

        {activeTool === 'organize' && !isWordDoc && (
          <OrganizeTool
            onDocumentProcessed={handleDocumentProcessed}
            rawPdfBytes={crdt.rawPdfBytes}
            documentId={documentId}
            fileName={fileName}
            crdt={crdt}
            onUploadFile={handleUploadNewDoc}
          />
        )}

        {activeTool === 'redact' && !isWordDoc && (
          <RedactTool
            onDocumentProcessed={handleDocumentProcessed}
            rawPdfBytes={crdt.rawPdfBytes}
            documentId={documentId}
            fileName={fileName}
            crdt={crdt}
            onUploadFile={handleUploadNewDoc}
          />
        )}

        {activeTool === 'sign' && !isWordDoc && (
          <SignTool
            onDocumentProcessed={handleDocumentProcessed}
            rawPdfBytes={crdt.rawPdfBytes}
            documentId={documentId}
            fileName={fileName}
            crdt={crdt}
            onUploadFile={handleUploadNewDoc}
          />
        )}

        {activeTool === 'compress' && !isWordDoc && (
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
        </>
        )}
      </main>

      {/* Footer */}
      <Footer onOpenPrivacyModal={() => setIsPrivacyModalOpen(true)} />

      <UpdateBanner />

      {/* Privacy Guarantee Modal */}
      <PrivacyModal
        isOpen={isPrivacyModalOpen}
        onClose={() => setIsPrivacyModalOpen(false)}
      />
    </div>
  );
}
