import { useEffect, useRef, useState } from 'react';
import type { StoryPanel, StoryPanelPage } from '../types';
import { panelIsPlacedOnLayout } from './panelPlacement';
import { storyPageNumberById, storyPagePlacementLabel } from './pageNumbers';

function compactText(value: string, maxLength = 180) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

export function PanelChunkList({
  bookLength,
  panels,
  pages,
  selectedPanelId,
  focusedPanelId,
  onSelectPanel,
  onOpenPanelPlacement,
  onDeletePanel,
  isSaving,
  variant = 'card',
}: {
  bookLength: number;
  panels: StoryPanel[];
  pages: StoryPanelPage[];
  selectedPanelId: string | null;
  focusedPanelId: string | null;
  onSelectPanel: (panelId: string) => void;
  onOpenPanelPlacement?: (panelId: string) => void;
  onDeletePanel: (panelId: string) => void;
  isSaving: boolean;
  variant?: 'card' | 'plain';
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const chunkRefs = useRef<Record<string, HTMLElement | null>>({});
  const [flashingPanelId, setFlashingPanelId] = useState<string | null>(null);
  const sortedPanels = panels
    .filter((panel) => panel.startOffset !== null && panel.endOffset !== null)
    .sort((a, b) => a.startOffset! - b.startOffset! || a.order - b.order);
  const pageNumbers = storyPageNumberById(pages);
  const coveredChars = sortedPanels.reduce((total, panel) => total + (panel.endOffset! - panel.startOffset!), 0);
  const coverage = bookLength > 0 ? Math.round((coveredChars / bookLength) * 100) : 0;

  useEffect(() => {
    if (!focusedPanelId) return;
    const chunk = chunkRefs.current[focusedPanelId];
    if (!chunk) return;
    const list = listRef.current;
    if (list) {
      const listRect = list.getBoundingClientRect();
      const chunkRect = chunk.getBoundingClientRect();
      const relativeTop = chunkRect.top - listRect.top + list.scrollTop;
      const relativeBottom = relativeTop + chunkRect.height;
      const padding = 12;
      let targetTop = list.scrollTop;
      if (relativeTop < list.scrollTop + padding) {
        targetTop = relativeTop - padding;
      } else if (relativeBottom > list.scrollTop + list.clientHeight - padding) {
        targetTop = relativeBottom - list.clientHeight + padding;
      }
      list.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    } else {
      chunk.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    setFlashingPanelId(focusedPanelId);
    const timeout = window.setTimeout(() => setFlashingPanelId((current) => (current === focusedPanelId ? null : current)), 1400);
    return () => window.clearTimeout(timeout);
  }, [focusedPanelId]);

  const rootClassName = variant === 'plain' ? 'story-panels-chunks-pane' : 'story-card story-panels-list-card';

  return (
    <div className={rootClassName}>
      {variant === 'card' && (
        <div className="story-panels-section-head">
          <div>
            <h2>Panel Chunks</h2>
            <p className="muted">{sortedPanels.length} panels cover {coverage}% of the book text.</p>
          </div>
        </div>
      )}
      {variant === 'plain' && (
        <p className="story-panels-chunks-meta muted">
          {sortedPanels.length} panel{sortedPanels.length === 1 ? '' : 's'} · {coverage}% covered
        </p>
      )}
      <div ref={listRef} className="story-panels-chunk-list">
        {sortedPanels.length === 0 ? (
          <p className="muted">No panels yet. Select a passage in the book text to begin.</p>
        ) : sortedPanels.map((panel, index) => (
          <article
            key={panel.id}
            ref={(element) => {
              chunkRefs.current[panel.id] = element;
            }}
            className={`story-panels-chunk ${selectedPanelId === panel.id ? 'is-selected' : ''} ${flashingPanelId === panel.id ? 'is-flashing' : ''}`}
            onClick={() => onSelectPanel(panel.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectPanel(panel.id);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div className="story-panels-chunk-main">
              <strong>Panel {index + 1}</strong>
              <span>{panel.startOffset}-{panel.endOffset}</span>
              {panelIsPlacedOnLayout(pages, panel) ? (
                <button
                  type="button"
                  className="story-panels-placement-badge is-placed"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenPanelPlacement?.(panel.id);
                  }}
                >
                  {storyPagePlacementLabel(pages, panel.pageId)}
                </button>
              ) : (
                <span className="story-panels-placement-badge is-unplaced">
                  {storyPagePlacementLabel(pages, panel.pageId)}
                </span>
              )}
              <p>{compactText(panel.selectedText)}</p>
            </div>
            <div className="story-panels-chunk-actions">
              <button type="button" className="secondary" disabled={isSaving} onClick={(event) => {
                event.stopPropagation();
                onDeletePanel(panel.id);
              }}>
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
