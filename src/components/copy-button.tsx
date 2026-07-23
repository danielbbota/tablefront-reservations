'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** Copies `text` to the clipboard with a brief success state. */
export default function CopyButton({
  text,
  label,
  copiedLabel,
}: {
  text: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — leave button as-is.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={`flex min-h-9 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition active:scale-95 ${
        copied
          ? 'bg-leaf/15 text-leaf'
          : 'bg-sand text-espresso/70 hover:bg-linen hover:text-espresso'
      }`}
    >
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      {copied ? copiedLabel : label}
    </button>
  );
}
