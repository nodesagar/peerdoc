import React, { useState } from 'react';
import { ProcessedDoc } from '../types';
import { watermarkPDF, downloadUint8ArrayAsFile, formatBytes } from '../utils/pdfProcessor';
import { Stamp, Upload, Download, X } from 'lucide-react';

interface WatermarkToolProps {
  onDocumentProcessed: (doc: ProcessedDoc) => void;
}

export const WatermarkTool: React.FC<WatermarkToolProps> = ({ onDocumentProcessed }) => {
  const [fileBuffer, setFileBuffer] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState('Document.pdf');
  const [text, setText] = useState('CONFIDENTIAL');
  const [colorHex, setColorHex] = useState('#808080');
  const [opacity, setOpacity] = useState(0.25);
  const [rotation, setRotation] = useState(-45);
  const [fontSize, setFontSize] = useState(48);
  const [isProcessing, setIsProcessing] = useState(false);
  const sessionDocIdRef = React.useRef<string>(crypto.randomUUID());

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      const nextId = crypto.randomUUID();
      sessionDocIdRef.current = nextId;
      setFileName(file.name);
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      setFileBuffer(bytes);
      onDocumentProcessed({
        id: nextId,
        name: file.name,
        action: 'Opened',
        size: formatBytes(file.size),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob: new Blob([bytes as any], { type: 'application/pdf' }),
        format: 'pdf',
        tool: 'watermark',
        details: 'Opened in Watermark tool',
      });
    }
  };

  const handleApplyWatermark = async () => {
    if (!fileBuffer) return;

    try {
      setIsProcessing(true);
      const result = await watermarkPDF(fileBuffer, {
        text,
        colorHex,
        opacity,
        rotation,
        fontSize,
      });

      const outputName = fileName.replace(/\.pdf$/i, '') + '-watermarked.pdf';
      downloadUint8ArrayAsFile(result, outputName);

      onDocumentProcessed({
        id: sessionDocIdRef.current,
        name: outputName,
        action: 'Watermarked',
        size: formatBytes(result.byteLength),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob: new Blob([result as any], { type: 'application/pdf' }),
        format: 'pdf',
        tool: 'watermark',
        details: `Watermark: "${text}"`,
      });
    } catch (err) {
      alert('Could not add the watermark: ' + (err instanceof Error ? err.message : err));
    } finally {
      setIsProcessing(false);
    }
  };

  if (!fileBuffer) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center space-y-4">
        <div className="w-12 h-12 rounded-xl bg-cyan-50 text-cyan-600 flex items-center justify-center mx-auto">
          <Stamp className="w-6 h-6" />
        </div>
        <h1 className="text-3xl font-serif-heading font-bold text-[#1a1c1c]">Add a watermark</h1>
        <p className="text-xs text-[#5f6368]">
          Stamp your own text across every page of a PDF, at the opacity and angle you choose.
        </p>
        <label className="inline-flex items-center space-x-2 bg-[#005db2] text-white px-5 py-2.5 rounded-xl cursor-pointer hover:bg-[#004a8f] transition-colors text-sm font-medium">
          <Upload className="w-4 h-4" />
          <span>Choose PDF</span>
          <input type="file" accept="application/pdf" onChange={handleFileUpload} className="hidden" />
        </label>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <div className="bg-white rounded-2xl border border-black/10 p-6 shadow-2xs space-y-4">
        <h2 className="text-base font-bold text-[#1a1c1c]">Watermark settings</h2>

        <div className="space-y-3 text-xs">
          <div>
            <label className="block text-black/60 font-semibold mb-1">Watermark text</label>
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full bg-[#f4f3f2] p-2.5 rounded-xl border border-black/10 outline-none text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-black/60 font-semibold mb-1">Opacity ({Math.round(opacity * 100)}%)</label>
              <input
                type="range"
                min="0.05"
                max="0.9"
                step="0.05"
                value={opacity}
                onChange={(e) => setOpacity(parseFloat(e.target.value))}
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-black/60 font-semibold mb-1">Rotation ({rotation}&deg;)</label>
              <input
                type="range"
                min="-90"
                max="90"
                step="5"
                value={rotation}
                onChange={(e) => setRotation(parseInt(e.target.value))}
                className="w-full"
              />
            </div>
          </div>
        </div>

        <div className="pt-4 flex items-center justify-between border-t border-black/5">
          <button
            onClick={() => setFileBuffer(null)}
            className="text-xs text-[#5f6368] hover:text-black"
          >
            Choose another file
          </button>
          <button
            onClick={handleApplyWatermark}
            disabled={isProcessing}
            className="bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-semibold px-6 py-2.5 rounded-xl shadow-2xs transition-colors cursor-pointer disabled:opacity-50 flex items-center space-x-2"
          >
            <Download className="w-4 h-4" />
            <span>{isProcessing ? 'Adding watermark…' : 'Add watermark & download'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
