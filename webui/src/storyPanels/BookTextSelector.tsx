import { useMemo, useRef, useState } from 'react';
import type { StoryPanel } from '../types';

export type TextSelectionRange = {
  startOffset: number;
  endOffset: number;
  selectedText: string;
};

function textWithHighlights(bookText: string, panels: StoryPanel[], selection: TextSelectionRange | null) {
  const markers: Array<{ start: number; end: number; kind: 'panel' | 'selection'; id: string }> = panels.map((panel) => ({
    start: panel.startOffset,
    end: panel.endOffset,
    kind: 'panel',
    id: panel.id,
  }));
  if (selection) {
    markers.push({ start: selection.startOffset, end: selection.endOffset, kind: 'selection', id: 'selection' });
  }
  markers.sort((a, b) => a.start - b.start || a.end - b.end);
  const pieces: Array<{ text: string; kind?: 'panel' | 'selection'; id?: string }> = [];
  let cursor = 0;
  for (const marker of markers) {
    if (marker.start < cursor || marker.start >= marker.end) continue;
    if (marker.start > cursor) pieces.push({ text: bookText.slice(cursor, marker.start) });
    pieces.push({ text: bookText.slice(marker.start, marker.end), kind: marker.kind, id: marker.id });
    cursor = marker.end;
  }
  if (cursor < bookText.length) pieces.push({ text: bookText.slice(cursor) });
  return pieces;
}

export function BookTextSelector({
  bookText,
  panels,
  selection,
  onSelectionChange,
  onCreatePanel,
  isCreating,
}: {
  bookText: string;
  panels: StoryPanel[];
  selection: TextSelectionRange | null;
  onSelectionChange: (selection: TextSelectionRange | null) => void;
  onCreatePanel: () => void;
  isCreating: boolean;
}) {
  const textRef = useRef<HTMLDivElement | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const pieces = useMemo(() => textWithHighlights(bookText, panels, selection), [bookText, panels, selection]);

  const captureSelection = () => {
    const root = textRef.current;
    const range = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null;
    if (!root || !range || range.collapsed) return;
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    const startOffset = before.toString().length;
    const selectedText = range.toString();
    const endOffset = startOffset + selectedText.length;
    if (!selectedText.trim()) return;
    const overlaps = panels.some((panel) => startOffset < panel.endOffset && endOffset > panel.startOffset);
    if (overlaps) {
      setSelectionError('That passage overlaps an existing panel.');
      onSelectionChange(null);
      return;
    }
    setSelectionError(null);
    onSelectionChange({ startOffset, endOffset, selectedText });
  };

  return (
    <section className="story-card story-panels-book-card">
      <div className="story-panels-section-head">
        <div>
          <h2>Book Text</h2>
          <p className="muted">Select a passage, then create a comic panel from that text chunk.</p>
        </div>
        <button type="button" disabled={!selection || isCreating} onClick={onCreatePanel}>
          {isCreating ? 'Creating...' : 'Create panel'}
        </button>
      </div>
      {selectionError && <p className="error">{selectionError}</p>}
      {selection && (
        <p className="story-panels-selection-note">
          Selected {selection.endOffset - selection.startOffset} characters.
        </p>
      )}
      <div ref={textRef} className="story-panels-book-text" onMouseUp={captureSelection} onKeyUp={captureSelection}>
        {pieces.map((piece, index) => (
          <span key={`${piece.id ?? 'plain'}-${index}`} className={piece.kind ? `story-panels-text-${piece.kind}` : undefined}>
            {piece.text}
          </span>
        ))}
      </div>
    </section>
  );
}
