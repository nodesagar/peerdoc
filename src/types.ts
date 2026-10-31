export type ActiveTool =
  | 'dashboard'
  | 'merge'
  | 'compress'
  | 'redact'
  | 'split'
  | 'sign'
  | 'organize'
  | 'edit'
  | 'watermark'
  | 'convert'
  | 'encrypt';

export interface ProcessedDoc {
  id: string;
  name: string;
  action: 'Compressed' | 'Merged' | 'Redacted' | 'Split' | 'Signed' | 'Organized' | 'AI Edited' | 'Edited' | 'Watermarked' | 'Converted' | 'Encrypted';
  size: string;
  originalSize?: string;
  timeAgo: string;
  timestamp: number;
  dataUrl?: string;
  blob?: Blob;
  documentId?: string; // SHA-256 room ID for P2P sync
}

export interface RedactionBox {
  id: string;
  pageIndex: number;
  x: number; // percentage
  y: number;
  width: number;
  height: number;
  label?: string;
}

export interface WhiteoutBox {
  id: string;
  pageIndex: number;
  x: number; // percentage
  y: number;
  width: number;
  height: number;
  color?: string; // hex
}

export interface TextOverlay {
  id: string;
  pageIndex: number;
  x: number; // percentage
  y: number;
  text: string;
  fontSize: number;
  color?: string; // hex
  fontFamily?: 'Helvetica' | 'Arial' | 'Verdana' | 'TimesRoman' | 'Times New Roman' | 'Georgia' | 'Courier' | 'Courier New';
  isBold?: boolean;
  isItalic?: boolean;
}

export interface SignatureBox {
  id: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  dataUrl: string;
}

export interface PageMetadata {
  id: string; // unique page identifier e.g. "page-0", "page-1"
  originalIndex: number; // 0-based index in the original raw PDF
  order: string; // Fractional index string for deterministic ordering
  rotation: number; // 0, 90, 180, 270 degrees
  deleted: boolean;
}

export interface PDFFileItem {
  id: string;
  file: File;
  name: string;
  size: string;
  sizeBytes: number;
  pageCount?: number;
  previewUrl?: string;
}

export interface PDFMetadataInfo {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
}

export type SyncStatus = 'offline' | 'connecting' | 'synced' | 'syncing';

export interface PeerInfo {
  peerId: string;
  joinedAt: number;
}
