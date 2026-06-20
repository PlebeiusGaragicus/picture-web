import { useEffect, useMemo, useRef, useState } from 'react';
import type { StoryPanel } from '../types';

export type TextSelectionRange = {
  startOffset: number;
  endOffset: number;
  selectedText: string;
};

type MenuState =
  | { kind: 'selection'; x: number; y: number }
  | { kind: 'panel'; panelId: string; x: number; y: number };

type BoundaryDrag = {
  panelId: string;
  side: 'start' | 'end';
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
  focusedPanelId,
  onSelectionChange,
  onCreatePanel,
  onDeletePanel,
  onAdjustPanelRange,
  onFocusPanelChunk,
  isCreating,
}: {
  bookText: string;
  panels: StoryPanel[];
  selection: TextSelectionRange | null;
  focusedPanelId: string | null;
  onSelectionChange: (selection: TextSelectionRange | null) => void;
  onCreatePanel: () => void;
  onDeletePanel: (panelId: string) => void;
  onAdjustPanelRange: (panelId: string, startOffset: number, endOffset: number) => void;
  onFocusPanelChunk: (panelId: string) => void;
  isCreating: boolean;
}) {
  const textRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const panelSpanRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const [flashingPanelId, setFlashingPanelId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [boundaryDrag, setBoundaryDrag] = useState<BoundaryDrag | null>(null);
  const pieces = useMemo(() => textWithHighlights(bookText, panels, selection), [bookText, panels, selection]);

  useEffect(() => {
    if (!focusedPanelId) return;
    const panelElement = panelSpanRefs.current[focusedPanelId];
    if (!panelElement) return;
    const scrollRoot = textRef.current;
    if (scrollRoot) {
      const panelTop = panelElement.offsetTop;
      const targetTop = panelTop - (scrollRoot.clientHeight / 2) + (panelElement.offsetHeight / 2);
      scrollRoot.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    }
    setFlashingPanelId(focusedPanelId);
    const timeout = window.setTimeout(() => setFlashingPanelId((current) => (current === focusedPanelId ? null : current)), 1400);
    return () => window.clearTimeout(timeout);
  }, [focusedPanelId]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!cardRef.current?.contains(event.target as Node)) {
        onSelectionChange(null);
        setMenu(null);
        window.getSelection()?.removeAllRanges();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onSelectionChange]);

  const offsetFromPoint = (clientX: number, clientY: number): number | null => {
    const root = textRef.current;
    if (!root) return null;
    let range: Range | null = null;
    const docWithCaret = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = docWithCaret.caretPositionFromPoint?.(clientX, clientY);
    if (position) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
    } else {
      range = docWithCaret.caretRangeFromPoint?.(clientX, clientY) ?? null;
    }
    if (!range || !root.contains(range.startContainer)) return null;
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString().length;
  };

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
    const rect = range.getBoundingClientRect();
    setMenu({ kind: 'selection', x: rect.left + rect.width / 2, y: rect.top });
  };

  const beginBoundaryDrag = (event: React.PointerEvent, panelId: string, side: 'start' | 'end') => {
    event.preventDefault();
    event.stopPropagation();
    setBoundaryDrag({ panelId, side });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateBoundaryDrag = (event: React.PointerEvent) => {
    if (!boundaryDrag) return;
    const offset = offsetFromPoint(event.clientX, event.clientY);
    const panel = panels.find((item) => item.id === boundaryDrag.panelId);
    if (offset === null || !panel) return;
    if (boundaryDrag.side === 'start') {
      onAdjustPanelRange(panel.id, Math.max(0, Math.min(offset, panel.endOffset - 1)), panel.endOffset);
      return;
    }
    onAdjustPanelRange(panel.id, panel.startOffset, Math.min(bookText.length, Math.max(offset, panel.startOffset + 1)));
  };

  const endBoundaryDrag = () => {
    setBoundaryDrag(null);
  };

  const clearMenuForTextOffClick = (event: React.PointerEvent) => {
    const target = event.target as HTMLElement | null;
    if (
      target?.closest('.story-panels-text-panel') ||
      target?.closest('.story-panels-boundary-handle') ||
      target?.closest('.story-panels-text-menu')
    ) {
      return;
    }
    setMenu(null);
    onSelectionChange(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <section ref={cardRef} className="story-card story-panels-book-card">
      <div className="story-panels-section-head">
        <div>
          <h2>Book Text</h2>
          <p className="muted">Select a passage to open actions, or drag panel edges to refine chunks.</p>
        </div>
      </div>
      {selectionError && <p className="error">{selectionError}</p>}
      <div
        ref={textRef}
        className="story-panels-book-text"
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        onPointerDown={clearMenuForTextOffClick}
        onPointerMove={updateBoundaryDrag}
        onPointerUp={endBoundaryDrag}
        onPointerCancel={endBoundaryDrag}
      >
        {pieces.map((piece, index) => (
          <span
            key={`${piece.id ?? 'plain'}-${index}`}
            ref={piece.kind === 'panel' && piece.id ? (element) => {
              panelSpanRefs.current[piece.id!] = element;
            } : undefined}
            className={[
              piece.kind ? `story-panels-text-${piece.kind}` : '',
              piece.kind === 'panel' && piece.id === focusedPanelId ? 'is-focused' : '',
              piece.kind === 'panel' && piece.id === flashingPanelId ? 'is-flashing' : '',
            ].filter(Boolean).join(' ') || undefined}
            onClick={piece.kind === 'panel' && piece.id ? (event) => {
              const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
              onFocusPanelChunk(piece.id!);
              setMenu({ kind: 'panel', panelId: piece.id!, x: rect.left + rect.width / 2, y: rect.top });
            } : undefined}
          >
            {piece.kind === 'panel' && piece.id && (
              <span
                className="story-panels-boundary-handle is-start"
                aria-hidden="true"
                onPointerDown={(event) => beginBoundaryDrag(event, piece.id!, 'start')}
              />
            )}
            {piece.text}
            {piece.kind === 'panel' && piece.id && (
              <span
                className="story-panels-boundary-handle is-end"
                aria-hidden="true"
                onPointerDown={(event) => beginBoundaryDrag(event, piece.id!, 'end')}
              />
            )}
          </span>
        ))}
      </div>
      {menu && (
        <div className="story-panels-text-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
          {menu.kind === 'selection' ? (
            <button
              type="button"
              disabled={!selection || isCreating}
              onClick={() => {
                setMenu(null);
                onCreatePanel();
              }}
            >
              {isCreating ? 'Creating...' : 'Create panel'}
            </button>
          ) : (
            <button
              type="button"
              className="danger"
              onClick={() => {
                setMenu(null);
                onDeletePanel(menu.panelId);
              }}
            >
              Delete panel
            </button>
          )}
        </div>
      )}
    </section>
  );
}
