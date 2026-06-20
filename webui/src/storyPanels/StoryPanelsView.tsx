import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { formatRequestError } from '../formatError';
import { api } from '../api';
import type { StoryPanel, StoryPanelDocument } from '../types';
import { BookTextSelector, type TextSelectionRange } from './BookTextSelector';
import { PageLayoutEditor, type StoryPanelLayoutMode } from './PageLayoutEditor';
import { PanelChunkList } from './PanelChunkList';
import { BOOKLET_PAGE_BORDER_OPTIONS, type BookletPageBorder } from './printLayout';

function sortedPanels(panels: StoryPanel[]) {
  return [...panels].sort((a, b) => (a.startOffset ?? Number.MAX_SAFE_INTEGER) - (b.startOffset ?? Number.MAX_SAFE_INTEGER) || a.order - b.order);
}

function withSelectedText(bookText: string, panel: StoryPanel): StoryPanel {
  if (panel.startOffset === null || panel.endOffset === null) return panel;
  return { ...panel, selectedText: bookText.slice(panel.startOffset, panel.endOffset) };
}

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable;
}

export function StoryPanelsView({ projectSlug }: { projectSlug: string }) {
  const [bookText, setBookText] = useState('');
  const [document, setDocument] = useState<StoryPanelDocument | null>(null);
  const [selection, setSelection] = useState<TextSelectionRange | null>(null);
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [focusedBookPanelId, setFocusedBookPanelId] = useState<string | null>(null);
  const [focusedChunkPanelId, setFocusedChunkPanelId] = useState<string | null>(null);
  const [layoutMode, setLayoutMode] = useState<StoryPanelLayoutMode>('spread');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportPageBorder, setExportPageBorder] = useState<BookletPageBorder>('black');
  const [historyControls, setHistoryControls] = useState<React.ReactNode>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [book, panels] = await Promise.all([
        api.getStoryPanelBook(projectSlug),
        api.getStoryPanels(projectSlug),
      ]);
      setBookText(book.text);
      setDocument(panels);
      setSelectedPanelId((current) => current ?? sortedPanels(panels.panels).find((panel) => panel.sourceKind === 'story')?.id ?? null);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsLoading(false);
    }
  }, [projectSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const panels = useMemo(() => sortedPanels(document?.panels ?? []), [document]);
  const storyPanels = useMemo(() => panels.filter((panel) => panel.sourceKind === 'story'), [panels]);

  const selectPanelChunk = (panelId: string) => {
    setSelectedPanelId(panelId);
    setFocusedBookPanelId(null);
    window.setTimeout(() => setFocusedBookPanelId(panelId), 0);
  };

  const focusPanelChunk = (panelId: string) => {
    setSelectedPanelId(panelId);
    setFocusedChunkPanelId(null);
    window.setTimeout(() => setFocusedChunkPanelId(panelId), 0);
  };

  const selectLayoutPanel = (panelId: string | null) => {
    setSelectedPanelId(panelId);
    if (!panelId || !document?.panels.some((panel) => panel.id === panelId && panel.sourceKind === 'story')) return;
    setFocusedChunkPanelId(null);
    window.setTimeout(() => setFocusedChunkPanelId(panelId), 0);
  };

  const openPanelPlacement = (panelId: string) => {
    setLayoutMode('single-chunks');
    setSelectedPanelId(panelId);
    setFocusedChunkPanelId(null);
    window.setTimeout(() => setFocusedChunkPanelId(panelId), 0);
  };

  const createPanel = async () => {
    if (!selection) return;
    setIsCreating(true);
    setError(null);
    try {
      const next = await api.createStoryPanel(projectSlug, selection);
      setDocument(next);
      setSelection(null);
      setSelectedPanelId(sortedPanels(next.panels).find((panel) => panel.sourceKind === 'story' && panel.startOffset === selection.startOffset && panel.endOffset === selection.endOffset)?.id ?? null);
      window.getSelection()?.removeAllRanges();
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsCreating(false);
    }
  };

  const saveDocument = async (nextDocument: StoryPanelDocument) => {
    setIsSaving(true);
    setError(null);
    try {
      const saved = await api.saveStoryPanels(projectSlug, nextDocument);
      setDocument(saved);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsSaving(false);
    }
  };

  const deletePanel = async (panelId: string) => {
    setIsSaving(true);
    setError(null);
    try {
      const next = await api.deleteStoryPanel(projectSlug, panelId);
      setDocument(next);
      setSelectedPanelId(sortedPanels(next.panels).find((panel) => panel.sourceKind === 'story')?.id ?? null);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsSaving(false);
    }
  };

  const adjustPanelRange = async (panelId: string, startOffset: number, endOffset: number) => {
    if (!document) return;
    const ordered = sortedPanels(document.panels).filter((panel) => panel.sourceKind === 'story');
    const targetIndex = ordered.findIndex((panel) => panel.id === panelId);
    if (targetIndex < 0) return;
    const target = ordered[targetIndex];
    if (target.startOffset === null || target.endOffset === null) return;
    const nextStart = Math.max(0, Math.min(startOffset, endOffset - 1));
    const nextEnd = Math.min(bookText.length, Math.max(endOffset, nextStart + 1));
    const updates = new Map<string, StoryPanel>();
    updates.set(target.id, withSelectedText(bookText, { ...target, startOffset: nextStart, endOffset: nextEnd }));
    const previous = ordered[targetIndex - 1];
    if (previous && previous.startOffset !== null && previous.endOffset !== null && previous.endOffset > nextStart) {
      const adjustedPrevious = { ...previous, endOffset: Math.max(previous.startOffset + 1, nextStart) };
      updates.set(previous.id, withSelectedText(bookText, adjustedPrevious));
    }
    const next = ordered[targetIndex + 1];
    if (next && next.startOffset !== null && next.endOffset !== null && next.startOffset < nextEnd) {
      const adjustedNext = { ...next, startOffset: Math.min(next.endOffset - 1, nextEnd) };
      updates.set(next.id, withSelectedText(bookText, adjustedNext));
    }
    await saveDocument({
      ...document,
      panels: document.panels.map((panel) => updates.get(panel.id) ?? panel),
    });
  };

  const exportBookletPdf = async (pageBorder: BookletPageBorder = exportPageBorder) => {
    setIsExporting(true);
    setError(null);
    try {
      const blob = await api.getStoryPanelsBookletPdf(projectSlug, { pageBorder });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = `${projectSlug}-comic-booklet.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
      setShowExportModal(false);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsExporting(false);
    }
  };

  useEffect(() => {
    const shortcuts: Record<string, StoryPanelLayoutMode> = {
      a: 'all-pages',
      '2': 'spread',
      i: 'single',
      p: 'single-chunks',
      b: 'book',
      c: 'book-chunks',
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableShortcutTarget(event.target)) return;
      const nextMode = shortcuts[event.key.toLowerCase()];
      if (!nextMode) return;
      event.preventDefault();
      setLayoutMode(nextMode);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (isLoading) {
    return (
      <div className="story-adaptation-screen">
        <p className="muted">Loading story panels...</p>
      </div>
    );
  }

  if (!bookText) {
    return (
      <div className="story-adaptation-screen">
        <section className="story-card">
          <h2>Story Panels</h2>
          <p className="muted">Upload book text in Story & Style before creating panel chunks.</p>
        </section>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="story-adaptation-screen">
        <section className="story-card">
          <h2>Story Panels</h2>
          <p className="error">{error ?? 'Unable to load story panels.'}</p>
        </section>
      </div>
    );
  }

  const panelChunks = (
    <PanelChunkList
      bookLength={bookText.length}
      panels={storyPanels}
      pages={document.pages}
      selectedPanelId={selectedPanelId}
      focusedPanelId={focusedChunkPanelId}
      onSelectPanel={selectPanelChunk}
      onOpenPanelPlacement={openPanelPlacement}
      onDeletePanel={deletePanel}
      isSaving={isSaving}
    />
  );
  const showBookText = layoutMode === 'book' || layoutMode === 'book-chunks';

  return (
    <div className="story-adaptation-screen story-panels-screen">
      <h1 className="story-panels-title">Story Panels</h1>
      <header className="story-panels-header story-card">
        <div className="story-panels-header-actions">
          <label className="story-panels-view-control">
            View
            <select value={layoutMode} onChange={(event) => setLayoutMode(event.target.value as StoryPanelLayoutMode)}>
              <option value="all-pages">All pages (a)</option>
              <option value="spread">Two-page spread (2)</option>
              <option value="single">Single page + info (i)</option>
              <option value="single-chunks">Single page + panel chunks (p)</option>
              <option value="book-chunks">Book text + panel chunks (c)</option>
              <option value="book">Book text (b)</option>
            </select>
          </label>
          <div className="story-panels-history-actions">
            {historyControls}
          </div>
          <button type="button" className="secondary" disabled={isExporting || isSaving} onClick={() => setShowExportModal(true)}>
            {isExporting ? 'Exporting...' : 'Export PDF'}
          </button>
        </div>
      </header>
      {error && <p className="error error-banner">{error}</p>}
      {showExportModal && (
        <div className="confirm-backdrop" onClick={() => !isExporting && setShowExportModal(false)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="export-booklet-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="export-booklet-title">Export comic booklet PDF</h2>
            <p className="muted">Landscape letter sheets with saddle-stitch imposition. Print duplex on the long edge, fold, and staple on the center crease.</p>
            <fieldset className="story-panels-export-options">
              <legend>Page outline border</legend>
              {BOOKLET_PAGE_BORDER_OPTIONS.map((option) => (
                <label key={option.value} className="story-panels-export-option">
                  <input
                    type="radio"
                    name="booklet-page-border"
                    value={option.value}
                    checked={exportPageBorder === option.value}
                    disabled={isExporting}
                    onChange={() => setExportPageBorder(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            <div className="modal-actions">
              <button type="button" className="secondary" disabled={isExporting} onClick={() => setShowExportModal(false)}>Cancel</button>
              <button type="button" disabled={isExporting} onClick={() => void exportBookletPdf(exportPageBorder)}>
                {isExporting ? 'Exporting...' : 'Export PDF'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="story-panels-grid">
        <PageLayoutEditor
          document={document}
          selectedPanelId={selectedPanelId}
          layoutMode={layoutMode}
          onSelectPanel={selectLayoutPanel}
          onSaveDocument={saveDocument}
          isSaving={isSaving}
          sidePanel={panelChunks}
          onLayoutModeChange={setLayoutMode}
          onHistoryControlsChange={setHistoryControls}
        />
        {showBookText && (
          <div className={`story-panels-text-row is-book-mode ${layoutMode === 'book' ? 'is-book-only' : ''}`}>
            <BookTextSelector
              bookText={bookText}
              panels={storyPanels}
              selection={selection}
              focusedPanelId={focusedBookPanelId}
              onSelectionChange={setSelection}
              onCreatePanel={createPanel}
              onDeletePanel={deletePanel}
              onAdjustPanelRange={adjustPanelRange}
              onFocusPanelChunk={focusPanelChunk}
              isCreating={isCreating}
            />
            {layoutMode === 'book-chunks' && panelChunks}
          </div>
        )}
      </div>
    </div>
  );
}
