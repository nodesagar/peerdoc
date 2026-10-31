import React from 'react';
import { ArrowLeft, DoorOpen, UserX } from 'lucide-react';

interface AccessCardProps {
  status: 'pending' | 'removed';
  onReturnToDashboard: () => void;
}

/** Shown instead of the document while an invite awaits the owner, or after removal. */
export const AccessCard: React.FC<AccessCardProps> = ({ status, onReturnToDashboard }) => {
  const pending = status === 'pending';
  const Icon = pending ? DoorOpen : UserX;
  return (
    <div className="max-w-[560px] mx-auto px-4 py-12">
      <div className="bg-white rounded-2xl border border-black/10 shadow-lg p-6 md:p-8 space-y-4 text-center" aria-live="polite">
        <div className="w-14 h-14 rounded-2xl bg-[#005db2]/10 text-[#005db2] flex items-center justify-center mx-auto">
          <Icon className={`w-7 h-7 ${pending ? 'animate-pulse' : ''}`} />
        </div>
        <h2 className="text-xl font-bold text-[#1a1c1c] tracking-tight">
          {pending ? 'Waiting for the owner to let you in' : 'You no longer have access'}
        </h2>
        <p className="text-sm text-[#5f6368] leading-relaxed">
          {pending
            ? 'Your invite is valid. The owner’s browser admits you automatically the next time EditorDoc is open there, with no server involved. Keep this tab open.'
            : 'The owner removed you from this document. You will not receive further changes. Anything already in this browser stays here.'}
        </p>
        <button
          onClick={onReturnToDashboard}
          className="inline-flex items-center gap-1.5 text-xs text-[#5f6368] hover:text-[#1a1c1c] px-3 py-2 rounded-xl transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Dashboard
        </button>
      </div>
    </div>
  );
};
