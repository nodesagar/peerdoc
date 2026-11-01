import React, { useState } from 'react';
import { ProcessedDoc } from '../types';
import { encryptPDF, downloadUint8ArrayAsFile, formatBytes } from '../utils/pdfProcessor';
import { Lock, Upload, Download, Eye, EyeOff } from 'lucide-react';

interface EncryptToolProps {
  onDocumentProcessed: (doc: ProcessedDoc) => void;
}

export const EncryptTool: React.FC<EncryptToolProps> = ({ onDocumentProcessed }) => {
  const [fileBuffer, setFileBuffer] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState('Document.pdf');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
        tool: 'encrypt',
        details: 'Opened in Encrypt tool',
      });
    }
  };

  const handleEncrypt = async () => {
    if (!fileBuffer || !password) return;

    try {
      setIsProcessing(true);
      const encryptedBytes = await encryptPDF(fileBuffer, password);
      const outputName = fileName.replace(/\.pdf$/i, '') + '-encrypted.pdf';
      downloadUint8ArrayAsFile(encryptedBytes, outputName);

      onDocumentProcessed({
        id: sessionDocIdRef.current,
        name: outputName,
        action: 'Encrypted',
        size: formatBytes(encryptedBytes.byteLength),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob: new Blob([encryptedBytes as any], { type: 'application/pdf' }),
        format: 'pdf',
        tool: 'encrypt',
        details: 'Password protected PDF',
      });
    } catch (err) {
      alert('Error encrypting PDF: ' + err);
    } finally {
      setIsProcessing(false);
    }
  };

  if (!fileBuffer) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center space-y-4">
        <div className="w-12 h-12 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center mx-auto">
          <Lock className="w-6 h-6" />
        </div>
        <h1 className="text-3xl font-serif-heading font-bold text-[#1a1c1c]">Protect & Encrypt PDF</h1>
        <p className="text-xs text-[#5f6368]">
          Add password protection to prevent unauthorized opening or viewing.
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
    <div className="max-w-xl mx-auto px-4 py-8 space-y-6">
      <div className="bg-white rounded-2xl border border-black/10 p-6 shadow-2xs space-y-4">
        <h2 className="text-base font-bold text-[#1a1c1c]">Set Document Password</h2>

        <div className="relative">
          <input
            type={showPassword ? 'text' : 'password'}
            placeholder="Enter a strong password..."
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-[#f4f3f2] p-3 rounded-xl border border-black/10 outline-none text-sm pr-10"
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-3 text-black/50 hover:text-black"
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>

        <div className="pt-4 flex items-center justify-between border-t border-black/5">
          <button
            onClick={() => setFileBuffer(null)}
            className="text-xs text-[#5f6368] hover:text-black"
          >
            Cancel
          </button>
          <button
            onClick={handleEncrypt}
            disabled={!password || isProcessing}
            className="bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold px-6 py-2.5 rounded-xl shadow-2xs transition-colors cursor-pointer disabled:opacity-40 flex items-center space-x-2"
          >
            <Lock className="w-4 h-4" />
            <span>{isProcessing ? 'Encrypting...' : 'Encrypt & Download'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
