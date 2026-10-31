import React, { useState } from 'react';
import { Document, pdfjs } from 'react-pdf';
import { Download, RotateCw, RotateCcw, Trash2, Check, Layers, Scissors, Upload } from 'lucide-react';
import { ProcessedDoc } from '../types';
import { buildConvergedPDF, splitPDF, downloadUint8ArrayAsFile, formatBytes } from '../utils/pdfProcessor';
import { PageThumbnailGrid } from './PageThumbnailGrid';
import { useCRDTSync } from '../hooks/useCRDTSync';
import { SyncWaitingCard } from './SyncWaitingCard';

interface OrganizeToolProps {
  onDocumentProcessed: (doc: ProcessedDoc) => void;
  rawPdfBytes: Uint8Array | null;
  documentId: string | null;
  fileName: string;
  crdt: ReturnType<typeof useCRDTSync>;
  onUploadFile?: (file: File) => void;
}

export const OrganizeTool: React.FC<OrganizeToolProps> = ({
  onDocumentProcessed,
  rawPdfBytes,
  documentId,
  fileName,
  crdt,
  onUploadFile,
}) => {
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const pdfBlobUrl = React.useMemo(() => {
    if (!rawPdfBytes) return null;
    return URL.createObjectURL(new Blob([rawPdfBytes as any], { type: 'application/pdf' }));
  }, [rawPdfBytes]);

  React.useEffect(() => {
    return () => {
      if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
    };
  }, [pdfBlobUrl]);

  // Derive current page order and rotations from CRDT
  // crdt.pages is already sorted by fractional index order
  const pageOrder = crdt.pages.map((p) => p.originalIndex);
  const deletedPages = crdt.pages.filter((p) => p.deleted).map((p) => p.originalIndex);
  const rotations: Record<number, number> = {};
  crdt.pages.forEach((p) => {
    rotations[p.originalIndex] = p.rotation;
  });

  const handleToggleSelect = (originalIndex: number) => {
    setSelectedPages((prev) =>
      prev.includes(originalIndex)
        ? prev.filter((idx) => idx !== originalIndex)
        : [...prev, originalIndex]
    );
  };

  const handleToggleDelete = (originalIndex: number) => {
    const pageMeta = crdt.pages.find((p) => p.originalIndex === originalIndex);
    if (pageMeta) {
      crdt.deletePage(pageMeta.id, !pageMeta.deleted);
    }
  };

  const handleRotate = (originalIndex: number, direction: 'cw' | 'ccw') => {
    const pageMeta = crdt.pages.find((p) => p.originalIndex === originalIndex);
    if (pageMeta) {
      crdt.rotatePage(pageMeta.id, direction === 'cw' ? 90 : -90);
    }
  };

  const handleReorder = (newOriginalIndexOrder: number[], movedOriginalIndex: number) => {
    // Re-key only the dragged page between its new neighbours
    const i = newOriginalIndexOrder.indexOf(movedOriginalIndex);
    const byOrig = (idx: number | undefined) => crdt.pages.find((p) => p.originalIndex === idx);
    const pageMeta = byOrig(movedOriginalIndex);
    if (!pageMeta || i < 0) return;
    const prevMeta = byOrig(newOriginalIndexOrder[i - 1]);
    const nextMeta = byOrig(newOriginalIndexOrder[i + 1]);
    crdt.movePage(pageMeta.id, prevMeta?.order ?? null, nextMeta?.order ?? null);
  };

  const handleRotateAll = (direction: 'cw' | 'ccw') => {
    crdt.pages.forEach((p) => {
      crdt.rotatePage(p.id, direction === 'cw' ? 90 : -90);
    });
  };

  const handleSelectAll = () => {
    if (selectedPages.length === crdt.pages.length) {
      setSelectedPages([]);
    } else {
      setSelectedPages(crdt.pages.map((p) => p.originalIndex));
    }
  };

  const handleExportConverged = async () => {
    if (!rawPdfBytes) return;
    try {
      setIsProcessing(true);
      const convergedBytes = await buildConvergedPDF(rawPdfBytes, crdt.snapshot);
      const outputName = fileName.replace(/\.pdf$/i, '') + '-organized.pdf';
      downloadUint8ArrayAsFile(convergedBytes, outputName);

      onDocumentProcessed({
        id: crypto.randomUUID(),
        name: outputName,
        action: 'Organized',
        size: formatBytes(convergedBytes.byteLength),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob: new Blob([convergedBytes as any], { type: 'application/pdf' }),
        documentId: documentId || undefined,
      });
    } catch (err) {
      console.error('Failed to export organized PDF:', err);
      alert('Error building organized PDF: ' + err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExtractSelected = async () => {
    if (!rawPdfBytes || selectedPages.length === 0) return;
    try {
      setIsProcessing(true);
      // Extract in current (organized) order, not click order
      const ordered = pageOrder.filter((idx) => selectedPages.includes(idx));
      const extractedBytes = await splitPDF(rawPdfBytes, ordered);
      const outputName = fileName.replace(/\.pdf$/i, '') + '-extracted.pdf';
      downloadUint8ArrayAsFile(extractedBytes, outputName);

      onDocumentProcessed({
        id: crypto.randomUUID(),
        name: outputName,
        action: 'Split',
        size: formatBytes(extractedBytes.byteLength),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob: new Blob([extractedBytes as any], { type: 'application/pdf' }),
      });
    } catch (err) {
      alert('Error extracting pages: ' + err);
    } finally {
      setIsProcessing(false);
    }
  };

  if (!rawPdfBytes) {
    if (documentId) {
      return (
        <SyncWaitingCard
          documentId={documentId}
          peerCount={crdt.peerCount}
          pdfProgress={crdt.pdfProgress}
          syncStatus={crdt.syncStatus}
          onRequestPdf={crdt.requestPdfFromPeers}
          onUploadFile={onUploadFile}
        />
      );
    }

    return (
      <div className="max-w-[1000px] mx-auto px-4 py-16 text-center">
        <div className="bg-white rounded-2xl border-2 border-dashed border-black/15 p-12 space-y-4">
          <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
            <Layers className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold">No PDF Active</h2>
          <p className="text-xs text-[#5f6368] max-w-sm mx-auto">
            Upload a PDF or return to the Dashboard to load the demo confidential agreement.
          </p>
          <label className="inline-flex items-center space-x-2 bg-[#005db2] text-white px-5 py-2.5 rounded-xl cursor-pointer hover:bg-[#004a8f] transition-colors text-sm font-medium">
            <Upload className="w-4 h-4" />
            <span>Select PDF</span>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file && onUploadFile) onUploadFile(file);
              }}
              className="hidden"
            />
          </label>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1440px] mx-auto px-4 md:px-8 py-8 space-y-6">
      {/* Top Controls Bar */}
      <div className="bg-white rounded-2xl border border-black/10 p-4 shadow-2xs flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleSelectAll}
            className="flex items-center space-x-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-[#f4f3f2] hover:bg-black/10 text-[#1a1c1c] transition-colors"
          >
            <Check className="w-3.5 h-3.5" />
            <span>
              {selectedPages.length === crdt.pages.length ? 'Deselect All' : 'Select All'}
            </span>
          </button>

          <button
            onClick={() => handleRotateAll('ccw')}
            className="flex items-center space-x-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-[#f4f3f2] hover:bg-black/10 text-[#1a1c1c] transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Rotate All Left</span>
          </button>

          <button
            onClick={() => handleRotateAll('cw')}
            className="flex items-center space-x-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-[#f4f3f2] hover:bg-black/10 text-[#1a1c1c] transition-colors"
          >
            <RotateCw className="w-3.5 h-3.5" />
            <span>Rotate All Right</span>
          </button>

          {selectedPages.length > 0 && (
            <button
              onClick={handleExtractSelected}
              disabled={isProcessing}
              className="flex items-center space-x-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
            >
              <Scissors className="w-3.5 h-3.5" />
              <span>Extract ({selectedPages.length})</span>
            </button>
          )}
        </div>

        <div className="flex items-center space-x-3">
          <div className="text-xs text-[#5f6368]">
            <span className="font-semibold text-black">{crdt.pages.filter((p) => !p.deleted).length}</span> active pages
          </div>

          <button
            onClick={handleExportConverged}
            disabled={isProcessing}
            className="flex items-center space-x-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2 rounded-xl shadow-2xs transition-colors cursor-pointer disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{isProcessing ? 'Processing...' : 'Save & Download'}</span>
          </button>
        </div>
      </div>

      {/* Thumbnails Grid with Dnd */}
      <div className="bg-white/60 backdrop-blur rounded-2xl border border-black/10 p-8 shadow-2xs min-h-[500px]">
        <Document file={pdfBlobUrl}>
          <PageThumbnailGrid
            pageOrder={pageOrder}
            selectedPages={selectedPages}
            deletedPages={deletedPages}
            rotations={rotations}
            onReorder={handleReorder}
            onToggleSelect={handleToggleSelect}
            onToggleDelete={handleToggleDelete}
            onRotate={handleRotate}
          />
        </Document>
      </div>
    </div>
  );
};
