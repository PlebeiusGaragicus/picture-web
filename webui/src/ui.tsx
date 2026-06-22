import React, { useEffect } from 'react';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div className="editor-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="editor-dialog-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function HelpTip({ text, placement = 'top' }: { text: string; placement?: 'top' | 'bottom' }) {
  return (
    <span className={`help-tip-wrap ${placement === 'bottom' ? 'is-below' : ''}`.trim()}>
      <button type="button" className="help-tip" aria-label={text} onClick={(event) => event.preventDefault()}>?</button>
      <span className="help-tip-bubble" role="tooltip">{text}</span>
    </span>
  );
}

export function HoverTooltip({
  text,
  placement = 'bottom',
  children,
}: {
  text: string;
  placement?: 'top' | 'bottom';
  children: React.ReactElement;
}) {
  return (
    <span className={`hover-tooltip-wrap ${placement === 'bottom' ? 'is-below' : ''}`.trim()}>
      {children}
      <span className="help-tip-bubble hover-tooltip-bubble" role="tooltip">{text}</span>
    </span>
  );
}
