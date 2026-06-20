import type { StoryPanel } from '../types';

function compactText(value: string, maxLength = 180) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

export function PanelChunkList({
  bookLength,
  panels,
  selectedPanelId,
  onSelectPanel,
  onDeletePanel,
  onToggleFinalized,
  isSaving,
}: {
  bookLength: number;
  panels: StoryPanel[];
  selectedPanelId: string | null;
  onSelectPanel: (panelId: string) => void;
  onDeletePanel: (panelId: string) => void;
  onToggleFinalized: (panel: StoryPanel) => void;
  isSaving: boolean;
}) {
  const sortedPanels = [...panels].sort((a, b) => a.startOffset - b.startOffset || a.order - b.order);
  const coveredChars = sortedPanels.reduce((total, panel) => total + (panel.endOffset - panel.startOffset), 0);
  const coverage = bookLength > 0 ? Math.round((coveredChars / bookLength) * 100) : 0;
  const gaps = sortedPanels.reduce<Array<{ start: number; end: number }>>((items, panel, index) => {
    const previousEnd = index === 0 ? 0 : sortedPanels[index - 1].endOffset;
    if (panel.startOffset > previousEnd) items.push({ start: previousEnd, end: panel.startOffset });
    if (index === sortedPanels.length - 1 && panel.endOffset < bookLength) items.push({ start: panel.endOffset, end: bookLength });
    return items;
  }, sortedPanels.length ? [] : [{ start: 0, end: bookLength }]);

  return (
    <section className="story-card story-panels-list-card">
      <div className="story-panels-section-head">
        <div>
          <h2>Panel Chunks</h2>
          <p className="muted">{sortedPanels.length} panels cover {coverage}% of the book text.</p>
        </div>
      </div>
      {gaps.length > 0 && (
        <p className="story-panels-gap-note">
          {gaps.length} uncovered passage{gaps.length === 1 ? '' : 's'} remain.
        </p>
      )}
      <div className="story-panels-chunk-list">
        {sortedPanels.length === 0 ? (
          <p className="muted">No panels yet. Select a passage in the book text to begin.</p>
        ) : sortedPanels.map((panel, index) => (
          <article
            key={panel.id}
            className={`story-panels-chunk ${selectedPanelId === panel.id ? 'is-selected' : ''} ${panel.finalized ? 'is-finalized' : ''}`}
          >
            <button type="button" className="story-panels-chunk-main" onClick={() => onSelectPanel(panel.id)}>
              <strong>Panel {index + 1}</strong>
              <span>{panel.startOffset}-{panel.endOffset}</span>
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
