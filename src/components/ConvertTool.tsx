import React, { useState } from 'react';
import { ProcessedDoc } from '../types';
import { imagesToPDF, downloadUint8ArrayAsFile, formatBytes } from '../utils/pdfProcessor';
import { Image, Upload, Download, Trash2 } from 'lucide-react';

interface ConvertToolProps {
  onDocumentProcessed: (doc: ProcessedDoc) => void;
}

/** pdf-lib embeds only PNG/JPEG; anything else the browser can decode is re-encoded to PNG. */
function toEmbeddableDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = reader.result as string;
      if (file.type === 'image/png' || file.type === 'image/jpeg') return resolve(url);
      const img = new window.Image(); // `Image` is the lucide icon here
      img.onerror = () => reject(new Error('unsupported image format'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || 1024; // SVGs without intrinsic size
        canvas.height = img.naturalHeight || 1024;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('canvas unavailable'));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = url;
    };
    reader.readAsDataURL(file);
  });
}

export const ConvertTool: React.FC<ConvertToolProps> = ({ onDocumentProcessed }) => {
  const [imageUrls, setImageUrls] = useState<{ id: string; url: string; name: string }[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const valid = files.filter((f) => f.type.startsWith('image/'));

    valid.forEach((file) => {
      toEmbeddableDataUrl(file)
        .then((url) => setImageUrls((prev) => [...prev, { id: crypto.randomUUID(), url, name: file.name }]))
        .catch((err) => alert(`Skipped ${file.name}: ${err.message || err}`));
    });
    e.target.value = '';
  };

  const handleConvert = async () => {
    if (imageUrls.length === 0) return;

    try {
      setIsProcessing(true);
      const urls = imageUrls.map((i) => i.url);
      const pdfBytes = await imagesToPDF(urls);
      const outputName = `images-converted-${Date.now()}.pdf`;
      downloadUint8ArrayAsFile(pdfBytes, outputName);

      onDocumentProcessed({
        id: crypto.randomUUID(),
        name: outputName,
        action: 'Converted',
        size: formatBytes(pdfBytes.byteLength),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob: new Blob([pdfBytes as any], { type: 'application/pdf' }),
      });
    } catch (err) {
      alert('Error converting images: ' + err);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <div className="text-center space-y-3">
        <div className="inline-flex items-center space-x-2 bg-emerald-50 text-emerald-800 text-xs font-semibold px-3 py-1.5 rounded-full border border-emerald-200">
          <Image className="w-4 h-4 text-emerald-600" />
          <span>IMAGE TO PDF CONVERTER</span>
        </div>
        <h1 className="text-3xl font-serif-heading font-bold text-[#1a1c1c]">Convert Images to PDF</h1>
        <p className="text-xs text-[#5f6368]">
          Combine multiple PNGs or JPEGs into a high-quality PDF document.
        </p>
      </div>

      <div className="border-2 border-dashed border-emerald-300 hover:border-emerald-500 bg-emerald-50/40 rounded-2xl p-8 text-center cursor-pointer transition-colors relative">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={handleFiles}
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
        <div className="w-12 h-12 rounded-xl bg-emerald-600 text-white flex items-center justify-center mx-auto mb-2 shadow-sm">
          <Upload className="w-6 h-6" />
        </div>
        <span className="text-sm font-semibold text-[#1a1c1c]">Select or drop images</span>
        <span className="text-xs text-[#5f6368] block mt-1">PNG and JPG files supported</span>
      </div>

      {imageUrls.length > 0 && (
        <div className="bg-white rounded-2xl border border-black/10 p-6 shadow-2xs space-y-4">
          <div className="flex items-center justify-between border-b border-black/5 pb-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-black/60">
              Selected Images ({imageUrls.length})
            </span>
            <button onClick={() => setImageUrls([])} className="text-xs text-red-600 hover:underline">
              Clear all
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {imageUrls.map((item) => (
              <div key={item.id} className="relative border rounded-xl overflow-hidden group">
                <img src={item.url} alt={item.name} className="w-full h-28 object-cover" />
                <button
                  onClick={() => setImageUrls((prev) => prev.filter((i) => i.id !== item.id))}
                  className="opacity-0 group-hover:opacity-100 absolute top-2 right-2 p-1 bg-red-600 text-white rounded-md shadow-md transition-opacity"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <div className="pt-4 flex justify-end">
            <button
              onClick={handleConvert}
              disabled={isProcessing}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-6 py-2.5 rounded-xl shadow-2xs transition-colors cursor-pointer disabled:opacity-50 flex items-center space-x-2"
            >
              <Download className="w-4 h-4" />
              <span>{isProcessing ? 'Converting...' : 'Convert & Download PDF'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
