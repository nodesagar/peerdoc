import React, { useState, useEffect, useRef } from 'react';
import { ActiveTool, SyncStatus } from '../types';
import { ShieldCheck, Menu, X } from 'lucide-react';
import { pressable } from '../lib/pressable';
import { CollaborationBar, PresenceProps } from './CollaborationBar';
import type { RoomAccessApi } from '../hooks/useRoomAccess';

interface HeaderProps {
  activeTool: ActiveTool;
  setActiveTool: (tool: ActiveTool) => void;
  onOpenPrivacyModal: () => void;
  documentId: string | null;
  syncStatus: SyncStatus;
  peerCount: number;
  servingCount?: number;
  onExportSync: () => void;
  onImportSync: (file: File) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  presence: PresenceProps;
  access: RoomAccessApi;
  /** Word documents have one editor; the page tools are PDF-only */
  isWordDoc?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  activeTool,
  setActiveTool,
  onOpenPrivacyModal,
  documentId,
  syncStatus,
  peerCount,
  servingCount,
  onExportSync,
  onImportSync,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  presence,
  access,
  isWordDoc,
}) => {
  const navItems: { tool: ActiveTool; label: string }[] = documentId && !isWordDoc
    ? [
        { tool: 'dashboard', label: 'Dashboard' },
        { tool: 'edit', label: 'Edit' },
        { tool: 'organize', label: 'Organize' },
        { tool: 'redact', label: 'Redact' },
        { tool: 'sign', label: 'Sign' },
      ]
    : [
        { tool: 'dashboard', label: 'Dashboard' },
        { tool: 'edit', label: 'Edit' },
      ];
  const syncFileRef = useRef<HTMLInputElement>(null);
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 0);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const menuItem = 'block w-full text-left px-4 py-2.5 rounded-2xl text-body-sm transition-colors';

  return (
    // Floating glass pill over the canvas; the strip around it lets clicks through
    <header className="sticky top-0 z-40 px-4 md:px-6 pt-4 pb-2 pointer-events-none">
      <div
        className={`pointer-events-auto max-w-[1440px] mx-auto h-[52px] flex items-center justify-between gap-3 rounded-full bg-white/75 backdrop-blur-xl ring-1 ring-white/80 pl-1.5 pr-2 transition-shadow duration-200 ${
          isScrolled ? 'shadow-md-2' : 'shadow-subtle'
        }`}
      >
        {/* Left: Brand Logo + Nav Links */}
        <div className="flex items-center gap-4 min-w-0">
          <div
            {...pressable(() => {
              setActiveTool('dashboard');
              setIsMobileMenuOpen(false);
            })}
            aria-label="EditorDoc home"
            className="flex items-center gap-2.5 group shrink-0 rounded-full pr-1"
          >
            <div className="w-9 h-9 rounded-[11px] bg-ink flex items-center justify-center text-white transition-transform duration-300 group-hover:-rotate-6">
              <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
                <path d="M12 18v-6" />
                <path d="M8 15h8" />
              </svg>
            </div>
            <div className="hidden lg:flex items-center gap-2">
              <span className="text-lg font-semibold tracking-[-0.45px] text-ink">EditorDoc</span>
              <span className="chip bg-mint font-semibold uppercase tracking-[0.08em]">P2P</span>
            </div>
          </div>

          {/* Room tools appear once a document is open */}
          <nav className="hidden xl:flex items-center gap-0.5 text-body-sm" aria-label="Tools">
            {navItems.map(({ tool, label }) => (
              <button
                key={tool}
                onClick={() => setActiveTool(tool)}
                aria-current={activeTool === tool ? 'page' : undefined}
                className={`h-9 px-3.5 rounded-full transition-colors ${
                  activeTool === tool
                    ? 'bg-ink/[0.07] text-ink font-medium'
                    : 'text-graphite hover:text-ink hover:bg-ink/5'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>

        </div>

        {/* Right side: Collaboration Bar & Privacy */}
        <div className="flex items-center gap-1.5 shrink-0">
          <CollaborationBar
            documentId={documentId}
            syncStatus={syncStatus}
            peerCount={peerCount}
            servingCount={servingCount}
            onExportSync={onExportSync}
            onImportSync={onImportSync}
            onUndo={onUndo}
            onRedo={onRedo}
            canUndo={canUndo}
            canRedo={canRedo}
            presence={presence}
            access={access}
          />

          <button
            onClick={onOpenPrivacyModal}
            aria-label="P2P Guarantee"
            className="hidden sm:inline-flex btn btn-ghost h-9 px-3 text-caption"
          >
            <ShieldCheck className="w-4 h-4" />
            <span className="hidden xl:inline">P2P Guarantee</span>
          </button>

          {/* Mobile hamburger */}
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="xl:hidden btn btn-ghost h-9 w-9 px-0 text-ink"
            aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={isMobileMenuOpen}
          >
            {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Menu Drawer */}
      {isMobileMenuOpen && (
        <div className="pointer-events-auto xl:hidden max-w-[1440px] mx-auto mt-2 p-2 space-y-0.5 rounded-3xl bg-white shadow-xl">
          {navItems.map(({ tool, label }) => (
            <button
              key={tool}
              onClick={() => {
                setActiveTool(tool);
                setIsMobileMenuOpen(false);
              }}
              aria-current={activeTool === tool ? 'page' : undefined}
              className={`${menuItem} ${
                activeTool === tool ? 'bg-cloud text-ink font-medium' : 'text-graphite hover:bg-linen hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
          {documentId && (
            <div className="sm:hidden border-t border-ash pt-1 mt-1">
              <button
                onClick={() => {
                  onExportSync();
                  setIsMobileMenuOpen(false);
                }}
                className={`${menuItem} text-graphite hover:bg-linen hover:text-ink`}
              >
                Export .cdsync
              </button>
              <button
                onClick={() => syncFileRef.current?.click()}
                className={`${menuItem} text-graphite hover:bg-linen hover:text-ink`}
              >
                Import .cdsync
              </button>
              <input
                ref={syncFileRef}
                type="file"
                accept=".cdsync,application/x-cdsync,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onImportSync(file);
                  e.target.value = '';
                  setIsMobileMenuOpen(false);
                }}
              />
            </div>
          )}
        </div>
      )}
    </header>
  );
};
