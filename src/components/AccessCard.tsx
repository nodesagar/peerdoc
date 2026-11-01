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
    <div className="max-w-[600px] mx-auto px-4 py-16">
      <div className="bg-white rounded-3xl shadow-xl p-8 md:p-10 space-y-5 text-center" aria-live="polite">
        <div className={`w-16 h-16 rounded-2xl ${pending ? 'bg-periwinkle' : 'bg-marigold'} text-ink flex items-center justify-center mx-auto`}>
          <Icon className={`w-7 h-7 ${pending ? 'animate-pulse' : ''}`} />
        </div>
        <h2 className="font-serif text-subheading md:text-heading-sm text-ink text-balance">
          {pending ? 'Waiting for the owner to let you in' : 'You no longer have access'}
        </h2>
        <p className="text-body text-graphite max-w-md mx-auto">
          {pending
            ? 'Your invite is valid. The owner’s browser admits you automatically the next time EditorDoc is open there, with no server involved. Keep this tab open.'
            : 'The owner removed you from this document. You will not receive further changes. Anything already in this browser stays here.'}
        </p>
        <button onClick={onReturnToDashboard} className="btn btn-ghost">
          <ArrowLeft className="w-4 h-4" />
          Dashboard
        </button>
      </div>
    </div>
  );
};
