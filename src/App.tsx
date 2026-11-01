import React, { useState, useEffect, useCallback } from 'react';
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
import { detectFormat, isWordFormat, DocFormat, FORMAT_LABEL, SUPPORTED_EXTENSIONS } from './lib/formats';
import { loadWordPackage } from './lib/word/package';
import { buildWordSeed } from './lib/word/seed';
import { createDocxFiles } from './lib/word/templates';
import { zipSync } from 'fflate';
import { computeSHA256, getOriginalPDF, storeOriginalPDF } from './lib/crdt/pdfStore';
import { createSampleConfidentialAgreement } from './utils/samplePdfs';
import { buildConvergedPDF, downloadUint8ArrayAsFile, formatBytes } from './utils/pdfProcessor';
import { parseShareInput } from './lib/crdt/roomKey';
import { createOwnedRoom, getIdentity, loadRoom, saveRoom } from './lib/crdt/access';
import { useRoomAccess } from './hooks/useRoomAccess';
import { AccessCard } from './components/AccessCard';
import { PDFDocument } from 'pdf-lib';
import {
  loadRecentDocs,
  saveRecentDocs,
  upsertRecentDocList,
  summarizeSnapshotWork,
  saveActiveDocSession,
  loadActiveDocSession,
} from './lib/recentDocs';

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
  const [pendingDocRequest, setPendingDocRequest] = useState<{
    label: string;
    run: () => Promise<void>;
  } | null>(null);
  const [isSavingPrevious, setIsSavingPrevious] = useState(false);

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

  const handleDocumentProcessed = useCallback((newDoc: ProcessedDoc) => {
    setRecentDocs((prev) => {
      const updated = upsertRecentDocList(prev, newDoc);
      saveRecentDocs(updated).catch(console.error);
      return updated;
    });
  }, []);

  // Load recent docs history and any active workspace session from browser storage on startup
  useEffect(() => {
    const hasInviteHash = new URLSearchParams(window.location.hash.slice(1)).has('i');
    const inviteHref = hasInviteHash && new URLSearchParams(window.location.search).get('doc') ? window.location.href : null;
    if (!inviteHref && (window.location.search || window.location.hash)) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    (async () => {
      const loaded = await loadRecentDocs();
      setRecentDocs((prev) => {
        if (prev.length === 0) return loaded;
        let merged = [...loaded];
        for (const doc of prev) {
          merged = upsertRecentDocList(merged, doc);
        }
        saveRecentDocs(merged).catch(console.error);
        return merged;
      });

      if (inviteHref) {
        await joinRoomByIdInternal(inviteHref);
        return;
      }

      const activeSession = await loadActiveDocSession();
      if (activeSession?.documentId) {
        const cleanId = activeSession.documentId.trim().toLowerCase();
        const existing = await getOriginalPDF(cleanId);
        const room = await loadRoom(cleanId);
        if (!room && existing?.bytes) {
          await createOwnedRoom(cleanId, await getIdentity());
        }
        const format = existing?.bytes ? detectFormat(existing.bytes) : (activeSession.format ?? null);
        let nextSeed: DocumentSeed | null = null;
        if (existing?.bytes && format) {
          try {
            nextSeed = await buildSeed(cleanId, existing.bytes, format);
          } catch (err) {
            console.error('Stored active file could not be read:', err);
          }
        }
        setRawPdfBytes(existing?.bytes ?? null);
        setFileName(existing?.filename || activeSession.fileName || 'Document.pdf');
        setSeed(nextSeed);
        setDocFormat(format);
        setDocumentId(cleanId);
        setAccessRevision((n) => n + 1);
      }
    })().catch(console.error);

    // An invite for the page already open only changes the #fragment: no reload
    const onHashChange = () => {
      if (new URLSearchParams(window.location.hash.slice(1)).has('i')) handleJoinRoomId(window.location.href);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Keep fileName and format in sync when a joined room receives metadata or bytes from peers
  useEffect(() => {
    if (crdt.meta.title && crdt.meta.title !== 'Untitled Document' && fileName === 'Document.pdf') {
      setFileName(crdt.meta.title);
    }
  }, [crdt.meta.title, fileName]);

  useEffect(() => {
    if (crdt.rawPdfBytes && !docFormat) {
      const detected = detectFormat(crdt.rawPdfBytes);
      if (detected) setDocFormat(detected);
    }
  }, [crdt.rawPdfBytes, docFormat]);

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

  // Keep the address bar clean so refreshing always opens the Dashboard
  const clearUrlParams = useCallback(() => {
    if (window.location.search || window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const endActiveSession = useCallback(() => {
    setDocumentId(null);
    setRawPdfBytes(null);
    setSeed(null);
    setDocFormat(null);
    setFileName('Document.pdf');
    saveActiveDocSession(null).catch(console.error);
    clearUrlParams();
  }, [clearUrlParams]);

  // Navigating to Dashboard keeps the active document in the navbar so clicking Edit reopens it.
  const handleNavigateTool = useCallback(
    (tool: ActiveTool) => {
      clearUrlParams();
      setActiveTool(tool);
    },
    [clearUrlParams]
  );

  // Clicking Save inside the workspace saves the document in cache and ends the active session.
  const handleSaveDocument = useCallback(
    (savedDoc: ProcessedDoc) => {
      const summary = summarizeSnapshotWork(crdt.snapshot, {
        isWordDoc,
        activeTool,
        wordModified: crdt.lastModifiedAt !== null || isWordDoc,
        pageCount: savedDoc.pageCount ?? (seed?.format === 'pdf' ? seed.pageCount : undefined),
      });
      handleDocumentProcessed({
        ...savedDoc,
        id: savedDoc.documentId || savedDoc.id,
        documentId: savedDoc.documentId ?? documentId ?? undefined,
        name: savedDoc.name || fileName,
        details: savedDoc.details ?? summary.details,
        pageCount: savedDoc.pageCount ?? summary.pageCount,
      });
      endActiveSession();
      setActiveTool('dashboard');
    },
    [crdt.snapshot, crdt.lastModifiedAt, isWordDoc, activeTool, seed, handleDocumentProcessed, documentId, fileName, endActiveSession]
  );

  const saveActiveDocBeforeSwitching = async () => {
    if (!documentId) return;
    const effectiveName =
      crdt.meta.title && crdt.meta.title !== 'Untitled Document' && fileName === 'Document.pdf'
        ? crdt.meta.title
        : fileName;
    const format: DocFormat = docFormat ?? (isWordDoc ? 'docx' : 'pdf');
    const summary = summarizeSnapshotWork(crdt.snapshot, {
      isWordDoc,
      activeTool,
      wordModified: crdt.lastModifiedAt !== null,
      pageCount: seed?.format === 'pdf' ? seed.pageCount : undefined,
    });
    let blob: Blob | undefined;
    let size = crdt.rawPdfBytes ? formatBytes(crdt.rawPdfBytes.byteLength) : '—';
    if (!isWordDoc && crdt.rawPdfBytes) {
      try {
        const converged = await buildConvergedPDF(crdt.rawPdfBytes, crdt.snapshot);
        blob = new Blob([converged as BlobPart], { type: 'application/pdf' });
        size = formatBytes(converged.byteLength);
      } catch {
        // fallback to raw bytes
      }
    } else if (crdt.rawPdfBytes) {
      blob = new Blob([crdt.rawPdfBytes as BlobPart], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    }

    handleDocumentProcessed({
      id: documentId,
      documentId,
      name: effectiveName,
      action: summary.action === 'Opened' ? 'Edited' : summary.action,
      size,
      timestamp: Date.now(),
      timeAgo: 'Just now',
      blob,
      format,
      pageCount: summary.pageCount,
      tool: DOC_TOOLS.includes(activeTool) ? activeTool : 'edit',
      details: summary.details,
    });
    endActiveSession();
  };

  const handleSelectRecentDoc = async (doc: ProcessedDoc) => {
    if (doc.blob) {
      const url = URL.createObjectURL(doc.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }

    if (doc.documentId) {
      try {
        if (doc.documentId === documentId && crdt.rawPdfBytes && !isWordDoc) {
          const converged = await buildConvergedPDF(crdt.rawPdfBytes, crdt.snapshot);
          downloadUint8ArrayAsFile(converged, doc.name);
          return;
        }
        const stored = await getOriginalPDF(doc.documentId);
        if (stored?.bytes) {
          const mime = isWordFormat(doc.format ?? detectFormat(stored.bytes))
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/pdf';
          const blob = new Blob([stored.bytes as BlobPart], { type: mime });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = doc.name || stored.filename;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          return;
        }
      } catch (err) {
        console.error('Failed to download recent document:', err);
      }
      handleJoinRoomId(doc.documentId, doc.tool);
    }
  };

  // All document state is set together after every await, so the CRDT hook never
  // sees a new room ID paired with the previous document's bytes or page count.
  const openDocument = async (bytes: Uint8Array, name: string, targetTool: ActiveTool = 'edit') => {
    const format = detectFormat(bytes);
    if (!format) {
      alert(`"${name}" can't be opened. Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}.`);
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

    await saveActiveDocSession({ documentId: docId, fileName: name, format });
    setFileName(name);
    setRawPdfBytes(bytes.slice());
    setSeed(nextSeed);
    setDocFormat(format);
    setDocumentId(docId);
    setAccessRevision((n) => n + 1);
    clearUrlParams();
    setActiveTool(targetTool);
  };

  const joinRoomByIdInternal = async (input: string, preferredTool?: ActiveTool) => {
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

    const nextTool: ActiveTool =
      preferredTool && DOC_TOOLS.includes(preferredTool) ? preferredTool : 'edit';

    await saveActiveDocSession({
      documentId: cleanId,
      fileName: existing?.filename || 'Document.pdf',
      format: format ?? undefined,
    });
    setRawPdfBytes(existing?.bytes ?? null);
    setFileName(existing?.filename || 'Document.pdf');
    setSeed(nextSeed);
    setDocFormat(format);
    setDocumentId(cleanId);
    setAccessRevision((n) => n + 1);
    clearUrlParams();
    setActiveTool(nextTool);
  };

  const guardActiveDocument = (label: string, action: () => Promise<void>) => {
    if (documentId) {
      setPendingDocRequest({ label, run: action });
      return;
    }
    action();
  };

  const handleOpenRecentDoc = async (doc: ProcessedDoc) => {
    if (doc.documentId && doc.documentId === documentId) {
      const targetTool = doc.tool && DOC_TOOLS.includes(doc.tool) ? doc.tool : 'edit';
      setActiveTool(targetTool);
      return;
    }
    guardActiveDocument(doc.name, async () => {
      if (doc.documentId) {
        await joinRoomByIdInternal(doc.documentId, doc.tool);
      } else if (doc.blob) {
        const buf = await doc.blob.arrayBuffer();
        const targetTool = doc.tool && DOC_TOOLS.includes(doc.tool) ? doc.tool : 'edit';
        await openDocument(new Uint8Array(buf), doc.name, targetTool);
      } else if (doc.tool) {
        setActiveTool(doc.tool);
      }
    });
  };

  const handleLoadSample = async () => {
    guardActiveDocument('Confidential_Agreement.pdf', async () => {
      try {
        const sampleBytes = await createSampleConfidentialAgreement();
        await openDocument(sampleBytes, 'Confidential_Agreement.pdf');
      } catch (err) {
        console.error('Failed to load demo document:', err);
      }
    });
  };

  const handleUploadNewDoc = async (file: File) => {
    guardActiveDocument(file.name, async () => {
      try {
        const buffer = await file.arrayBuffer();
        await openDocument(new Uint8Array(buffer), file.name);
      } catch (err) {
        console.error('Failed to open file:', err);
      }
    });
  };

  const handleNewWordDoc = async () => {
    guardActiveDocument('Untitled document.docx', async () => {
      const bytes = zipSync(createDocxFiles('<w:p/>', { title: 'Untitled document' }));
      await openDocument(bytes, 'Untitled document.docx');
    });
  };

  const handleJoinRoomId = async (input: string, preferredTool?: ActiveTool) => {
    const parsed = parseShareInput(input);
    if (parsed && parsed.documentId === documentId) {
      const nextTool: ActiveTool =
        preferredTool && DOC_TOOLS.includes(preferredTool) ? preferredTool : 'edit';
      setActiveTool(nextTool);
      return;
    }
    guardActiveDocument(parsed ? `document ${parsed.documentId.slice(0, 8)}…` : 'a new document', async () => {
      await joinRoomByIdInternal(input, preferredTool);
    });
  };

  return (
    <div className="min-h-screen flex flex-col bg-canvas text-ink">
      {/* Navigation Header with CollaborationBar */}
      <Header
        activeTool={activeTool}
        setActiveTool={handleNavigateTool}
        onOpenPrivacyModal={() => setIsPrivacyModalOpen(true)}
        documentId={documentId}
        doc={crdt.doc}
        fileName={fileName}
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
          <AccessCard status={access.status} onReturnToDashboard={() => handleNavigateTool('dashboard')} />
        ) : (
        <>
        {activeTool === 'dashboard' && (
          <Dashboard
            setActiveTool={handleNavigateTool}
            recentDocs={recentDocs}
            onSelectRecentDoc={handleSelectRecentDoc}
            onOpenRecentDoc={handleOpenRecentDoc}
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
            onSaveDocument={handleSaveDocument}
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
            onSaveDocument={handleSaveDocument}
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
            onSaveDocument={handleSaveDocument}
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
            onSaveDocument={handleSaveDocument}
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
            onSaveDocument={handleSaveDocument}
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

      {/* Prompt when user tries to add/open another document while a previous document is still active */}
      {pendingDocRequest && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="save-prev-doc-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-xs p-4"
        >
          <div className="bg-white rounded-3xl shadow-xl max-w-md w-full p-6 md:p-7 space-y-5 ring-1 ring-ink/10">
            <div className="space-y-2">
              <span className="chip bg-marigold text-ink font-medium">Document open</span>
              <h2 id="save-prev-doc-title" className="font-serif text-subheading text-ink">
                Save and close the current document?
              </h2>
              <p className="text-body-sm text-graphite leading-relaxed">
                <strong className="font-semibold text-ink">{fileName}</strong> is still open. Save and close it to open{' '}
                <strong className="font-semibold text-ink">{pendingDocRequest.label}</strong>. It stays in Recent documents with your edits.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                disabled={isSavingPrevious}
                onClick={() => setPendingDocRequest(null)}
                className="btn btn-ghost h-10 px-4 text-caption"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSavingPrevious}
                onClick={() => {
                  setPendingDocRequest(null);
                  setActiveTool('edit');
                }}
                className="btn btn-secondary h-10 px-4 text-caption"
              >
                Keep editing
              </button>
              <button
                type="button"
                disabled={isSavingPrevious}
                onClick={async () => {
                  const nextAction = pendingDocRequest.run;
                  try {
                    setIsSavingPrevious(true);
                    await saveActiveDocBeforeSwitching();
                    setPendingDocRequest(null);
                    await nextAction();
                  } finally {
                    setIsSavingPrevious(false);
                  }
                }}
                className="btn btn-primary h-10 px-5 text-caption"
              >
                {isSavingPrevious ? 'Saving…' : 'Save & open'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Privacy Guarantee Modal */}
      <PrivacyModal
        isOpen={isPrivacyModalOpen}
        onClose={() => setIsPrivacyModalOpen(false)}
      />
    </div>
  );
}
