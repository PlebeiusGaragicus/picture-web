import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function Modal({
  title,
  onClose,
  children,
  dialogClassName,
  hideHeader = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  dialogClassName?: string;
  hideHeader?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div
        className={`editor-dialog${dialogClassName ? ` ${dialogClassName}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={hideHeader ? title : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        {!hideHeader && (
          <div className="editor-dialog-head">
            <h2>{title}</h2>
            <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function HelpTip({ text, placement = 'bottom' }: { text: string; placement?: 'top' | 'bottom' }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [isPositioned, setIsPositioned] = useState(false);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;
    const rect = trigger.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const padding = 8;
    let left = rect.left;
    left = Math.max(padding, Math.min(left, window.innerWidth - bubbleRect.width - padding));
    const top = placement === 'bottom'
      ? rect.bottom + 8
      : rect.top - bubbleRect.height - 8;
    setPosition({ top: Math.max(padding, top), left });
    setIsPositioned(true);
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) {
      setIsPositioned(false);
      return;
    }
    updatePosition();
  }, [open, text, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePosition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, updatePosition]);

  return (
    <>
      <span className={`help-tip-wrap ${placement === 'bottom' ? 'is-below' : ''}`.trim()}>
        <button
          ref={triggerRef}
          type="button"
          className="help-tip"
          aria-label={text}
          onClick={(event) => event.preventDefault()}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        >?</button>
      </span>
      {open && createPortal(
        <span
          ref={bubbleRef}
          className="help-tip-bubble is-portaled"
          role="tooltip"
          style={{
            top: position.top,
            left: position.left,
            visibility: isPositioned ? 'visible' : 'hidden',
          }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >{text}</span>,
        document.body,
      )}
    </>
  );
}

export function HoverTooltip({
  text,
  placement = 'bottom',
  children,
}: {
  text: string;
  placement?: 'top' | 'bottom' | 'right';
  children: React.ReactElement;
}) {
  const placementClass = placement === 'bottom' ? 'is-below' : placement === 'right' ? 'is-right' : '';
  return (
    <span className={`hover-tooltip-wrap ${placementClass}`.trim()}>
      {children}
      <span className="help-tip-bubble hover-tooltip-bubble" role="tooltip">{text}</span>
    </span>
  );
}
