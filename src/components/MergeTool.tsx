import React, { useState } from 'react';
import { ProcessedDoc, PDFFileItem } from '../types';
import { mergePDFs, downloadUint8ArrayAsFile, formatBytes } from '../utils/pdfProcessor';
import { Layers, Upload, FileText, Trash2, ArrowUp, ArrowDown, X, Download, ShieldCheck } from 'lucide-react';

interface MergeToolProps {
  onDocumentProcessed: (doc: ProcessedDoc) => void;
}

export const MergeTool: React.FC<MergeToolProps> = ({ onDocumentProcessed }) => {
  const [queue, setQueue] = useState<PDFFileItem[]>([]);
  const [isMerging, setIsMerging] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const pdfFiles = files.filter((f) => f.type === 'application/pdf');

    const newItems: PDFFileItem[] = pdfFiles.map((file) => ({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      size: formatBytes(file.size),
      sizeBytes: file.size,
    }));

    setQueue((prev) => [...prev, ...newItems]);
    e.target.value = '';
  };

  const removeItem = (id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
  };

  const moveUp = (idx: number) => {
    if (idx === 0) return;
    setQueue((prev) => {
      const copy = [...prev];
      const temp = copy[idx - 1];
      copy[idx - 1] = copy[idx];
      copy[idx] = temp;
      return copy;
    });
  };

  const moveDown = (idx: number) => {
    if (idx === queue.length - 1) return;
    setQueue((prev) => {
      const copy = [...prev];
      const temp = copy[idx + 1];
      copy[idx + 1] = copy[idx];
      copy[idx] = temp;
      return copy;
    });
  };

  const handleMergeNow = async () => {
    if (queue.length === 0) return;

    try {
      setIsMerging(true);
      const buffers: Uint8Array[] = [];
      for (const item of queue) {
        const buf = await item.file.arrayBuffer();
        buffers.push(new Uint8Array(buf));
      }

      const mergedBytes = await mergePDFs(buffers);
      const outputName = `merged-${Date.now()}.pdf`;
      downloadUint8ArrayAsFile(mergedBytes, outputName);

      onDocumentProcessed({
        id: crypto.randomUUID(),
        name: outputName,
        action: 'Merged',
        size: formatBytes(mergedBytes.byteLength),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob: new Blob([mergedBytes as any], { type: 'application/pdf' }),
        format: 'pdf',
        tool: 'merge',
        details: `Merged ${queue.length} ${queue.length === 1 ? 'file' : 'files'}`,
      });
    } catch (err) {
      alert('Could not merge the files: ' + (err instanceof Error ? err.message : err));
    } finally {
      setIsMerging(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <div className="text-center space-y-3">
        <div className="inline-flex items-center space-x-2 bg-blue-50 text-blue-800 text-xs font-semibold px-3 py-1.5 rounded-full border border-blue-200">
          <Layers className="w-4 h-4 text-blue-600" />
          <span>Merge</span>
        </div>
        <h1 className="text-3xl font-serif-heading font-bold text-[#1a1c1c]">Merge PDFs</h1>
        <p className="text-xs text-[#5f6368]">
          Combine several PDFs into one file, in the order you set. Everything happens in your browser.
        </p>
      </div>

      <div className="border-2 border-dashed border-blue-300 hover:border-blue-500 bg-blue-50/40 rounded-2xl p-8 text-center cursor-pointer transition-colors relative">
        <input
          type="file"
          accept=".pdf"
          multiple
          onChange={handleFileChange}
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
        <div className="w-12 h-12 rounded-xl bg-blue-600 text-white flex items-center justify-center mx-auto mb-2 shadow-sm">
          <Upload className="w-6 h-6" />
        </div>
        <span className="text-sm font-semibold text-[#1a1c1c]">Choose or drop the PDFs to combine</span>
        <span className="text-xs text-[#5f6368] block mt-1">You can select several at once</span>
      </div>

      {queue.length > 0 && (
        <div className="bg-white rounded-2xl border border-black/10 p-6 shadow-2xs space-y-4">
          <div className="flex items-center justify-between border-b border-black/5 pb-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-black/60">
              Files to merge ({queue.length})
            </span>
            <button
              onClick={() => setQueue([])}
              className="text-xs text-red-600 hover:underline"
            >
              Clear all
            </button>
          </div>

          <div className="space-y-2">
            {queue.map((item, idx) => (
              <div
                key={item.id}
                className="bg-[#faf9f8] border border-black/5 rounded-xl p-3 flex items-center justify-between"
              >
                <div className="flex items-center space-x-3">
                  <span className="w-6 h-6 rounded-full bg-black/5 text-xs font-mono font-bold flex items-center justify-center">
                    {idx + 1}
                  </span>
                  <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold text-[#1a1c1c]">{item.name}</h4>
                    <span className="text-[11px] text-[#5f6368]">{item.size}</span>
                  </div>
                </div>

                <div className="flex items-center space-x-1">
                  <button
                    onClick={() => moveUp(idx)}
                    disabled={idx === 0}
                    className="p-1 hover:bg-black/5 rounded text-black/60 disabled:opacity-20"
                    title="Move up" aria-label={`Move ${item.name} up`}
                  >
                    <ArrowUp className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => moveDown(idx)}
                    disabled={idx === queue.length - 1}
                    className="p-1 hover:bg-black/5 rounded text-black/60 disabled:opacity-20"
                    title="Move down" aria-label={`Move ${item.name} down`}
                  >
                    <ArrowDown className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => removeItem(item.id)}
                    className="p-1 hover:bg-red-50 text-red-500 rounded"
                    title="Remove from list" aria-label={`Remove ${item.name} from list`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="pt-4 flex items-center justify-between border-t border-black/5">
            <div className="text-xs text-[#5f6368]">
              Total size: {formatBytes(queue.reduce((acc, curr) => acc + curr.sizeBytes, 0))}
            </div>
            <button
              onClick={handleMergeNow}
              disabled={isMerging}
              className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-6 py-2.5 rounded-xl shadow-2xs transition-colors cursor-pointer disabled:opacity-50 flex items-center space-x-2"
            >
              <Layers className="w-4 h-4" />
              <span>{isMerging ? 'Merging…' : 'Merge & download'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
