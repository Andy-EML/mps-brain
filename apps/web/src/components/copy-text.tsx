'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from 'cn';

export interface CopyTextProps {
  /** What goes on the clipboard (and, unless `iconOnly`, what is shown). */
  text: string;
  /** What `text` is, for the button's accessible name: "Copy serial A1B2C3D4E". */
  label?: string;
  /**
   * Just the copy icon, for a place where the text is already on screen as something else — a
   * serial that is the link to the device page keeps being that link.
   */
  iconOnly?: boolean;
  className?: string;
}

/**
 * Copies to the clipboard, with a short "Copied" confirmation. A real `<button>`, so it takes focus
 * and works from the keyboard; the confirmation is also announced through a polite live region.
 *
 * `navigator.clipboard` only exists on a secure origin, and the dashboard may be opened over plain
 * http on the office network, so a hidden-textarea `execCommand('copy')` covers that case.
 */
export function CopyText({ text, label = 'serial', iconOnly, className }: CopyTextProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    const ok = await writeClipboard(text);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  const Icon = copied ? Check : Copy;
  return (
    <span className={cn('inline-flex items-center gap-1 align-baseline', className)}>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label} ${text}`}
        title="Copy to clipboard"
        className={cn(
          'inline-flex items-center gap-1 rounded-sm font-mono text-inherit transition-colors hover:text-foreground',
          'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        )}
      >
        {iconOnly ? null : <span>{text}</span>}
        <Icon aria-hidden className={cn('size-3 shrink-0', copied ? 'text-ok' : 'opacity-60')} />
      </button>
      <span aria-live="polite" className="text-[11px] font-sans text-ok">
        {copied ? 'Copied' : ''}
      </span>
    </span>
  );
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea route.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
