/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { Toggle } from './Primitives';
import { canAutostart, getAutostart, setAutostart } from '@/src/config/autostart';

// Desktop-only launch-on-login switch. Renders nothing in browsers.
export default function AutostartToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!canAutostart()) return;
    void getAutostart().then((v) => {
      if (v !== null) setEnabled(v);
    });
  }, []);
  if (!canAutostart() || enabled === null) return null;
  return (
    <label className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[12px] text-zinc-400">Launch on login</span>
      <Toggle
        checked={enabled}
        label="Launch on login"
        onChange={(next) => {
          setEnabled(next);
          void setAutostart(next).then((ok) => {
            if (!ok) setEnabled(!next);
          });
        }}
      />
    </label>
  );
}
