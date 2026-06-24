import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function HubCardMenu({
  disabled,
  ariaLabel = 'Card actions',
  onDelete,
}: {
  disabled?: boolean;
  ariaLabel?: string;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 });
  const [isPositioned, setIsPositioned] = useState(false);

  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const popoverWidth = 140;
    const padding = 8;
    let left = rect.right - popoverWidth;
    left = Math.max(padding, Math.min(left, window.innerWidth - popoverWidth - padding));
    setPopoverPosition({ top: rect.bottom + 4, left });
    setIsPositioned(true);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setIsPositioned(false);
      return;
    }
    updatePopoverPosition();
  }, [open, updatePopoverPosition]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePopoverPosition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, updatePopoverPosition]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [open]);

  const popover = open ? createPortal(
    <div
      ref={popoverRef}
      className="story-panels-chunk-menu-popover is-portaled"
      role="menu"
      style={{
        top: popoverPosition.top,
        left: popoverPosition.left,
        visibility: isPositioned ? 'visible' : 'hidden',
      }}
    >
      <button
        type="button"
        role="menuitem"
        className="story-panels-chunk-menu-item story-panels-chunk-menu-item--danger"
        disabled={disabled}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          window.setTimeout(() => onDelete(), 0);
        }}
      >
        Delete
      </button>
    </div>,
    document.body,
  ) : null;

  return (
    <div className="story-panels-chunk-menu character-hub-card-menu" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        className="story-panels-chunk-menu-trigger"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        ···
      </button>
      {popover}
    </div>
  );
}
