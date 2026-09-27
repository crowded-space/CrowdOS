/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { socket } from '@/src/config/socket';

// Distinguishes API-down (socket disconnected + fetch failing) from
// DB-degraded (connected, workspace.database.configured === false).
// Minimal prestige bar: single hairline strip, no blocking modal.
export default function OfflineBanner({ dbDegraded }: { dbDegraded: boolean }) {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [socketDown, setSocketDown] = useState(false);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    const onDisconnect = () => setSocketDown(true);
    const onConnect = () => setSocketDown(false);
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
    };
  }, []);

  if (online && !socketDown && !dbDegraded) return null;
  const copy = !online
    ? 'Offline. Messages will queue until the connection returns.'
    : socketDown
      ? 'Connection to the local workspace lost. Retrying.'
      : 'Database unavailable. Running on local files; memory search is degraded.';
  return (
    <div
      role="status"
      className="shrink-0 border-b border-amber-500/25 bg-amber-500/[0.07] px-4 py-1.5 text-[12px] text-amber-200"
    >
      {copy}
    </div>
  );
}
