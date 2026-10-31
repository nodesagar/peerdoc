import React, { useState } from 'react';
import { ProcessedDoc } from '../types';
import {
  compressPDF,
  downloadUint8ArrayAsFile,
  formatBytes,
  buildConvergedPDF,
  CompressionLevel,
  COMPRESSION_PRESETS,
} from '../utils/pdfProcessor';
import { pressable } from '../lib/pressable';
import { Minimize2, Upload, ShieldCheck, Database, X, Check, ArrowRight } from 'lucide-react';
import { useCRDTSync } from '../hooks/useCRDTSync';

const LEVELS: { id: CompressionLevel; label: string; detail: string }[] = [
  { id: 'low', label: 'Light', detail: 'High image quality. Good for printing.' },
  { id: 'recommended', label: 'Recommended', detail: 'Balanced: images stay clear on screen, file gets much smaller.' },
  { id: 'extreme', label: 'Smallest', detail: 'For strict email limits. Images may look soft.' },
];

interface CompressToolProps {
  onDocumentProcessed: (doc: ProcessedDoc) => void;
  rawPdfBytes?: Uint8Array | null;
  fileName?: string;
  crdt?: ReturnType<typeof useCRDTSync>;
}

export const CompressTool: React.FC<CompressToolProps> = ({
  onDocumentProcessed,
  rawPdfBytes,
  fileName = 'Document.pdf',
  crdt,
}) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileBuffer, setFileBuffer] = useState<Uint8Array | null>(rawPdfBytes || null);
  const [currentFileName, setCurrentFileName] = useState<string>(fileName);
  const [fileSizeBytes, setFileSizeBytes] = useState<number>(rawPdfBytes?.byteLength || 0);

  const [compressionLevel, setCompressionLevel] = useState<CompressionLevel>('recommended');
  const [result, setResult] = useState<{ before: number; after: number } | null>(null);
  const [isCompressing, setIsCompressing] = useState<boolean>(false);

  // Sync if rawPdfBytes changes from parent
  React.useEffect(() => {
    if (rawPdfBytes && !fileBuffer) {
      setFileBuffer(rawPdfBytes);
      setFileSizeBytes(rawPdfBytes.byteLength);
      setCurrentFileName(fileName);
    }
  }, [rawPdfBytes, fileName, fileBuffer]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      setSelectedFile(file);
      setCurrentFileName(file.name);
      setFileSizeBytes(file.size);
      const buffer = await file.arrayBuffer();
      setFileBuffer(new Uint8Array(buffer));
      setResult(null);
    }
  };

  const handleCompress = async () => {
    if (!fileBuffer) return;

    try {
      setIsCompressing(true);
      setResult(null);

      // Apply CRDT edits only when compressing the active collaborative document,
      // never to an unrelated file picked in this tool.
      let inputBuffer = fileBuffer;
      if (crdt && fileBuffer === rawPdfBytes) {
        inputBuffer = await buildConvergedPDF(fileBuffer, crdt.snapshot);
      }

      const { compressedBuffer, originalSizeBytes, compressedSizeBytes } = await compressPDF(
        inputBuffer,
        compressionLevel
      );

      setResult({ before: originalSizeBytes, after: compressedSizeBytes });
      const outputName = currentFileName.replace(/\.pdf$/i, '') + '-compressed.pdf';
      downloadUint8ArrayAsFile(compressedBuffer, outputName);

      onDocumentProcessed({
        id: crypto.randomUUID(),
        name: outputName,
        action: 'Compressed',
        size: formatBytes(compressedSizeBytes),
        originalSize: formatBytes(originalSizeBytes),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob: new Blob([compressedBuffer as any], { type: 'application/pdf' }),
      });
    } catch (err) {
      console.error('Compression error:', err);
      alert('Error compressing PDF: ' + err);
    } finally {
      setIsCompressing(false);
    }
  };

  const resetAll = () => {
    setSelectedFile(null);
    setFileBuffer(null);
    setCurrentFileName('Document.pdf');
    setFileSizeBytes(0);
    setResult(null);
  };

  if (!fileBuffer) {
    return (
      <div className="max-w-[1280px] mx-auto px-4 py-8 space-y-12 animate-in fade-in">
        <div className="text-center space-y-4 max-w-2xl mx-auto">
          <div className="inline-flex items-center space-x-2 bg-amber-50 text-amber-800 text-xs font-semibold px-3 py-1.5 rounded-full border border-amber-200">
            <Minimize2 className="w-4 h-4 text-amber-600" />
            <span>PDF COMPRESSION ENGINE</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-serif-heading font-bold text-[#1a1c1c]">
            Compress PDF Locally
          </h1>
          <p className="text-sm md:text-base text-[#414753]">
            Reduce file sizes securely in your browser. No files are ever sent to external servers.
          </p>
        </div>

        <div className="max-w-2xl mx-auto">
          <label className="flex flex-col items-center justify-center border-2 border-dashed border-black/20 hover:border-amber-500/50 bg-white rounded-3xl p-12 text-center cursor-pointer shadow-2xs hover:shadow-md transition-all">
            <div className="w-16 h-16 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mb-4">
              <Upload className="w-8 h-8" />
            </div>
            <span className="text-base font-semibold text-[#1a1c1c]">Select PDF to Compress</span>
            <span className="text-xs text-[#5f6368] mt-1">or drag and drop your file here</span>
            <input type="file" accept="application/pdf" onChange={handleFileUpload} className="hidden" />
          </label>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center justify-between border-b border-black/10 pb-4">
        <div>
          <h2 className="text-xl font-bold text-[#1a1c1c]">{currentFileName}</h2>
          <p className="text-xs text-[#5f6368]">Original size: {formatBytes(fileSizeBytes)}</p>
        </div>
        <button onClick={resetAll} className="p-2 hover:bg-black/5 rounded-xl text-[#5f6368]">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-black/10 p-6 shadow-2xs space-y-6">
        <h3 className="text-base font-semibold text-[#1a1c1c]">Select Compression Level</h3>

        <div role="radiogroup" aria-label="Compression level" className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {LEVELS.map(({ id, label, detail }) => (
            <div
              key={id}
              {...pressable(() => setCompressionLevel(id))}
              role="radio"
              aria-checked={compressionLevel === id}
              className={`p-4 rounded-xl border-2 cursor-pointer transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 ${
                compressionLevel === id ? 'border-amber-500 bg-amber-50/30' : 'border-black/10 hover:border-black/20'
              }`}
            >
              <div className="flex justify-between items-center mb-2">
                <span className="font-semibold text-sm">{label}</span>
                <span className="text-xs font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded-full">
                  ≤ {COMPRESSION_PRESETS[id].maxPx}px
                </span>
              </div>
              <p className="text-xs text-[#5f6368]">{detail}</p>
            </div>
          ))}
        </div>

        <p className="text-xs text-[#5f6368]">
          Photos and scanned pages are downscaled and re-encoded. Text and vector graphics stay sharp and are not
          changed, so text-only PDFs shrink little.
        </p>

        <div className="pt-4 flex items-center justify-between border-t border-black/5">
          <div className="text-xs text-[#5f6368]" role="status">
            {result &&
              (result.after < result.before ? (
                <>
                  Saved <strong className="text-black font-semibold">{Math.round((1 - result.after / result.before) * 100)}%</strong>:{' '}
                  {formatBytes(result.before)} → {formatBytes(result.after)}
                </>
              ) : (
                <>No smaller version found; downloaded unchanged ({formatBytes(result.before)}).</>
              ))}
          </div>
          <button
            onClick={handleCompress}
            disabled={isCompressing}
            className="bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold px-6 py-2.5 rounded-xl shadow-2xs transition-colors cursor-pointer disabled:opacity-50"
          >
            {isCompressing ? 'Compressing...' : 'Compress & Download'}
          </button>
        </div>
      </div>
    </div>
  );
};
