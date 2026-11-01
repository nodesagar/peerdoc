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
      className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-ink text-white text-body-sm pl-5 pr-1.5 py-1.5 rounded-full shadow-xl max-w-[calc(100vw-32px)]"
    >
      <span>A new version is ready. Your edits are saved.</span>
      <button
        onClick={() => {
          reloadOnControllerChange = true;
          waiting.postMessage('skipWaiting');
        }}
        className="btn h-8 px-3.5 bg-white text-ink hover:bg-white/90"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        Reload
      </button>
    </div>
  );
};
