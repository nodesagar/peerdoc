import React, { useState } from 'react';
import { ProcessedDoc } from '../types';
import { splitPDF, downloadUint8ArrayAsFile, formatBytes } from '../utils/pdfProcessor';
import { Scissors, Upload, FileText, Check, Download, X } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';

interface SplitToolProps {
  onDocumentProcessed: (doc: ProcessedDoc) => void;
}

export const SplitTool: React.FC<SplitToolProps> = ({ onDocumentProcessed }) => {
  const [fileBuffer, setFileBuffer] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState('Document.pdf');
  const [numPages, setNumPages] = useState<number>(0);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [isSplitting, setIsSplitting] = useState(false);
  const sessionDocIdRef = React.useRef<string>(crypto.randomUUID());

  const pdfBlobUrl = React.useMemo(() => {
    if (!fileBuffer) return null;
    return URL.createObjectURL(new Blob([fileBuffer as any], { type: 'application/pdf' }));
  }, [fileBuffer]);

  React.useEffect(() => {
    return () => {
      if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
    };
  }, [pdfBlobUrl]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      const nextId = crypto.randomUUID();
      sessionDocIdRef.current = nextId;
      setFileName(file.name);
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      setFileBuffer(bytes);
      setSelectedPages([]);
      onDocumentProcessed({
        id: nextId,
        name: file.name,
        action: 'Opened',
        size: formatBytes(file.size),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob: new Blob([bytes as any], { type: 'application/pdf' }),
        format: 'pdf',
        tool: 'split',
        details: 'Opened in Split tool',
      });
    }
  };

  const togglePage = (index: number) => {
    setSelectedPages((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
    );
  };

  const handleExtract = async () => {
    if (!fileBuffer || selectedPages.length === 0) return;

    try {
      setIsSplitting(true);
      const extractedBytes = await splitPDF(fileBuffer, selectedPages);
      const outputName = fileName.replace(/\.pdf$/i, '') + '-extracted.pdf';
      downloadUint8ArrayAsFile(extractedBytes, outputName);

      onDocumentProcessed({
        id: sessionDocIdRef.current,
        name: outputName,
        action: 'Split',
        size: formatBytes(extractedBytes.byteLength),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob: new Blob([extractedBytes as any], { type: 'application/pdf' }),
        format: 'pdf',
        pageCount: selectedPages.length,
        tool: 'split',
        details: `Extracted ${selectedPages.length} ${selectedPages.length === 1 ? 'page' : 'pages'}`,
      });
    } catch (err) {
      alert('Error splitting PDF: ' + err);
    } finally {
      setIsSplitting(false);
    }
  };

  if (!fileBuffer) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center space-y-4">
        <div className="w-12 h-12 rounded-xl bg-orange-50 text-orange-600 flex items-center justify-center mx-auto">
          <Scissors className="w-6 h-6" />
        </div>
        <h1 className="text-3xl font-serif-heading font-bold text-[#1a1c1c]">Split PDF Pages</h1>
        <p className="text-xs text-[#5f6368]">
          Select specific pages to extract into a clean, standalone PDF.
        </p>
        <label className="inline-flex items-center space-x-2 bg-[#005db2] text-white px-5 py-2.5 rounded-xl cursor-pointer hover:bg-[#004a8f] transition-colors text-sm font-medium">
          <Upload className="w-4 h-4" />
          <span>Select PDF</span>
          <input type="file" accept="application/pdf" onChange={handleFileUpload} className="hidden" />
        </label>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <div className="bg-white rounded-2xl border border-black/10 p-4 shadow-2xs flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-[#1a1c1c]">{fileName}</h2>
          <span className="text-xs text-[#5f6368]">{selectedPages.length} pages selected for extraction</span>
        </div>
        <button
          onClick={handleExtract}
          disabled={selectedPages.length === 0 || isSplitting}
          className="bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold px-5 py-2 rounded-xl shadow-2xs transition-colors cursor-pointer disabled:opacity-40 flex items-center space-x-2"
        >
          <Scissors className="w-3.5 h-3.5" />
          <span>{isSplitting ? 'Extracting...' : 'Extract Selected'}</span>
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-black/10 p-6 shadow-2xs">
        <Document
          file={pdfBlobUrl}
          onLoadSuccess={({ numPages: count }) => setNumPages(count)}
          className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-4"
        >
          {Array.from({ length: numPages }, (_, i) => {
            const isSelected = selectedPages.includes(i);
            return (
              <div
                key={i}
                onClick={() => togglePage(i)}
                className={`relative border-2 rounded-xl p-2 cursor-pointer transition-all flex flex-col items-center ${
                  isSelected ? 'border-orange-500 bg-orange-50/20 shadow-md' : 'border-black/10 hover:border-black/30'
                }`}
              >
                <Page pageNumber={i + 1} width={120} renderTextLayer={false} renderAnnotationLayer={false} />
                <div className="mt-2 flex items-center justify-between w-full text-xs font-mono px-1">
                  <span>Page {i + 1}</span>
                  {isSelected && <Check className="w-3.5 h-3.5 text-orange-600" />}
                </div>
              </div>
            );
          })}
        </Document>
      </div>
    </div>
  );
};
