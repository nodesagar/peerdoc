import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

let reloadOnControllerChange = false;

/** Registers the service worker (production only) and offers new versions. */
export const UpdateBanner: React.FC = () => {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    const sw = navigator.serviceWorker;

    // Fires on the first install too (clients.claim); only reload when the user asked.
    const onControllerChange = () => {
      if (reloadOnControllerChange) {
        reloadOnControllerChange = false;
        window.location.reload();
      }
    };
    sw.addEventListener('controllerchange', onControllerChange);

    sw.register(`${import.meta.env.BASE_URL}sw.js`)
      .then((reg) => {
        // A waiting worker with an active controller means an update, not a first install.
        if (reg.waiting && sw.controller) setWaiting(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const next = reg.installing;
          next?.addEventListener('statechange', () => {
            if (next.state === 'installed' && sw.controller) setWaiting(next);
          });
        });
      })
      .catch((err) => console.warn('Service worker registration failed:', err));

    return () => sw.removeEventListener('controllerchange', onControllerChange);
  }, []);

  if (!waiting) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-[#1a1c1c] text-white text-sm px-4 py-2.5 rounded-xl shadow-lg max-w-[calc(100vw-32px)]"
    >
      <span>A new version is ready. Your edits are saved.</span>
      <button
        onClick={() => {
          reloadOnControllerChange = true;
          waiting.postMessage('skipWaiting');
        }}
        className="flex items-center gap-1.5 bg-white text-[#1a1c1c] font-medium px-3 py-1 rounded-lg hover:bg-white/90"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        Reload
      </button>
    </div>
  );
};
