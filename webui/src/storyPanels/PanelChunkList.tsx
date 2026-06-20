import { useEffect, useRef, useState } from 'react';
import type { StoryPanel, StoryPanelPage } from '../types';

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
  onDeletePanel,
  onToggleFinalized,
  isSaving,
}: {
  bookLength: number;
  panels: StoryPanel[];
  pages: StoryPanelPage[];
  selectedPanelId: string | null;
  focusedPanelId: string | null;
  onSelectPanel: (panelId: string) => void;
  onDeletePanel: (panelId: string) => void;
  onToggleFinalized: (panel: StoryPanel) => void;
  isSaving: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const chunkRefs = useRef<Record<string, HTMLElement | null>>({});
  const [flashingPanelId, setFlashingPanelId] = useState<string | null>(null);
  const sortedPanels = [...panels].sort((a, b) => a.startOffset - b.startOffset || a.order - b.order);
  const sortedPages = [...pages].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const pageNumberById = new Map(sortedPages.map((page, index) => [page.id, index + 1]));
  const coveredChars = sortedPanels.reduce((total, panel) => total + (panel.endOffset - panel.startOffset), 0);
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

  return (
    <section className="story-card story-panels-list-card">
      <div className="story-panels-section-head">
        <div>
          <h2>Panel Chunks</h2>
          <p className="muted">{sortedPanels.length} panels cover {coverage}% of the book text.</p>
        </div>
      </div>
      <div ref={listRef} className="story-panels-chunk-list">
        {sortedPanels.length === 0 ? (
          <p className="muted">No panels yet. Select a passage in the book text to begin.</p>
        ) : sortedPanels.map((panel, index) => (
          <article
            key={panel.id}
            ref={(element) => {
              chunkRefs.current[panel.id] = element;
            }}
            className={`story-panels-chunk ${selectedPanelId === panel.id ? 'is-selected' : ''} ${panel.finalized ? 'is-finalized' : ''} ${flashingPanelId === panel.id ? 'is-flashing' : ''}`}
          >
            <button type="button" className="story-panels-chunk-main" onClick={() => onSelectPanel(panel.id)}>
              <strong>Panel {index + 1}</strong>
              <span>{panel.startOffset}-{panel.endOffset}</span>
              <span className={`story-panels-placement-badge ${pageNumberById.has(panel.pageId) ? 'is-placed' : 'is-unplaced'}`}>
                {pageNumberById.has(panel.pageId) ? `Page ${pageNumberById.get(panel.pageId)}` : 'Not placed'}
              </span>
              <p>{compactText(panel.selectedText)}</p>
            </button>
            <div className="story-panels-chunk-actions">
              <label>
                <input
                  type="checkbox"
                  checked={panel.finalized}
                  disabled={isSaving}
                  onChange={() => onToggleFinalized(panel)}
                />
                Final
              </label>
              <button type="button" className="secondary" disabled={isSaving} onClick={() => onDeletePanel(panel.id)}>
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
