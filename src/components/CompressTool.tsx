import React, { useState } from 'react';
import { ProcessedDoc } from '../types';
import { compressPDF, downloadUint8ArrayAsFile, formatBytes, buildConvergedPDF } from '../utils/pdfProcessor';
import { Minimize2, Upload, ShieldCheck, Database, X, Check, ArrowRight } from 'lucide-react';
import { useCRDTSync } from '../hooks/useCRDTSync';

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

  const [compressionLevel, setCompressionLevel] = useState<'recommended' | 'extreme' | 'low'>('recommended');
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
    }
  };

  const handleCompress = async () => {
    if (!fileBuffer) return;

    try {
      setIsCompressing(true);

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
  };

  const savedPercent = compressionLevel === 'extreme' ? 60 : compressionLevel === 'recommended' ? 40 : 20;

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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div
            onClick={() => setCompressionLevel('recommended')}
            className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
              compressionLevel === 'recommended'
                ? 'border-amber-500 bg-amber-50/30'
                : 'border-black/10 hover:border-black/20'
            }`}
          >
            <div className="flex justify-between items-center mb-2">
              <span className="font-semibold text-sm">Recommended</span>
              <span className="text-xs font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded-full">
                ~40%
              </span>
            </div>
            <p className="text-xs text-[#5f6368]">Optimal balance between text crispness and small size.</p>
          </div>

          <div
            onClick={() => setCompressionLevel('extreme')}
            className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
              compressionLevel === 'extreme'
                ? 'border-amber-500 bg-amber-50/30'
                : 'border-black/10 hover:border-black/20'
            }`}
          >
            <div className="flex justify-between items-center mb-2">
              <span className="font-semibold text-sm">Extreme</span>
              <span className="text-xs font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded-full">
                ~60%
              </span>
            </div>
            <p className="text-xs text-[#5f6368]">Maximum reduction for strict email attachment limits.</p>
          </div>

          <div
            onClick={() => setCompressionLevel('low')}
            className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
              compressionLevel === 'low'
                ? 'border-amber-500 bg-amber-50/30'
                : 'border-black/10 hover:border-black/20'
            }`}
          >
            <div className="flex justify-between items-center mb-2">
              <span className="font-semibold text-sm">Low</span>
              <span className="text-xs font-bold text-[#5f6368] bg-black/5 px-2 py-0.5 rounded-full">
                ~20%
              </span>
            </div>
            <p className="text-xs text-[#5f6368]">High fidelity preservation for archival printing.</p>
          </div>
        </div>

        <div className="pt-4 flex items-center justify-between border-t border-black/5">
          <div className="text-xs text-[#5f6368]">
            Estimated: <strong className="text-black font-semibold">{formatBytes(Math.round(fileSizeBytes * (1 - savedPercent / 100)))}</strong>
          </div>
          <button
            onClick={handleCompress}
            disabled={isCompressing}
            className="bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold px-6 py-2.5 rounded-xl shadow-2xs transition-colors cursor-pointer disabled:opacity-50"
          >
            {isCompressing ? 'Compressing Streams...' : 'Compress & Download'}
          </button>
        </div>
      </div>
    </div>
  );
};
