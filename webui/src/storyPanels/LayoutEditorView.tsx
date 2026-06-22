import { useEffect, useState } from 'react';
import type React from 'react';
import { PageLayoutEditor, type StoryPanelLayoutMode } from './PageLayoutEditor';
import { PanelChunkList } from './PanelChunkList';
import { BOOKLET_PAGE_BORDER_OPTIONS, type BookletPageBorder } from './printLayout';
import type { LayoutEditorNavigation } from './layoutEditorNavigation';
import { isEditableShortcutTarget, sortedPanels } from './storyPanelUtils';
import { useStoryPanelDocument } from './useStoryPanelDocument';
import { api } from '../api';

export function LayoutEditorView({
  projectSlug,
  initialNavigation,
  onNavigationComplete,
}: {
  projectSlug: string;
  initialNavigation: LayoutEditorNavigation | null;
  onNavigationComplete: () => void;
}) {
  const {
    bookText,
    document,
    storyPanels,
    isLoading,
    isSaving,
    error,
    saveDocument,
    deletePanel,
    assets,
    projectTags,
    canvas,
  } = useStoryPanelDocument(projectSlug, { withCanvasContext: true });
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [focusedChunkPanelId, setFocusedChunkPanelId] = useState<string | null>(null);
  const [navigateToPanelId, setNavigateToPanelId] = useState<string | null>(null);
  const [layoutMode, setLayoutMode] = useState<StoryPanelLayoutMode>('spread');
  const [isExporting, setIsExporting] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportPageBorder, setExportPageBorder] = useState<BookletPageBorder>('black');
  const [historyControls, setHistoryControls] = useState<React.ReactNode>(null);
  const [pageControls, setPageControls] = useState<React.ReactNode>(null);

  useEffect(() => {
    if (!initialNavigation || !document) return;
    setLayoutMode(initialNavigation.layoutMode);
    setSelectedPanelId(initialNavigation.panelId);
    setFocusedChunkPanelId(null);
    window.setTimeout(() => setFocusedChunkPanelId(initialNavigation.panelId), 0);
    const panel = document.panels.find((candidate) => candidate.id === initialNavigation.panelId);
    if (panel?.pageId && document.pages.some((page) => page.id === panel.pageId && page.pageKind === 'story')) {
      setNavigateToPanelId(initialNavigation.panelId);
    }
    onNavigationComplete();
  }, [document, initialNavigation, onNavigationComplete]);

  const selectPanelChunk = (panelId: string) => {
    setSelectedPanelId(panelId);
    setFocusedChunkPanelId(null);
    window.setTimeout(() => setFocusedChunkPanelId(panelId), 0);
  };

  const selectLayoutPanel = (panelId: string | null) => {
    setSelectedPanelId(panelId);
    if (!panelId) {
      setFocusedChunkPanelId(null);
      return;
    }
    if (!document?.panels.some((panel) => panel.id === panelId && panel.sourceKind === 'story')) return;
    setFocusedChunkPanelId(null);
    window.setTimeout(() => setFocusedChunkPanelId(panelId), 0);
  };

  const openPanelPlacement = (panelId: string) => {
    if (!document) return;
    const panel = document.panels.find((candidate) => candidate.id === panelId);
    if (!panel) return;
    setLayoutMode('single-chunks');
    setSelectedPanelId(panelId);
    setFocusedChunkPanelId(null);
    window.setTimeout(() => setFocusedChunkPanelId(panelId), 0);
    if (panel.pageId && document.pages.some((page) => page.id === panel.pageId && page.pageKind === 'story')) {
      setNavigateToPanelId(panelId);
    }
  };

  const handleDeletePanel = async (panelId: string) => {
    const next = await deletePanel(panelId);
    if (next) {
      setSelectedPanelId(sortedPanels(next.panels).find((panel) => panel.sourceKind === 'story')?.id ?? null);
    }
  };

  const exportBookletPdf = async (pageBorder: BookletPageBorder = exportPageBorder) => {
    setIsExporting(true);
    try {
      const blob = await api.getStoryPanelsBookletPdf(projectSlug, { pageBorder });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = `${projectSlug}-comic-booklet.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
      setShowExportModal(false);
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
      <div className="story-adaptation-screen layout-view-screen layout-view-screen--empty">
        <p className="muted">Loading layout...</p>
      </div>
    );
  }

  if (!bookText) {
    return (
      <div className="story-adaptation-screen layout-view-screen layout-view-screen--empty">
        <p className="muted">Upload book text in Story & Style before laying out pages.</p>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="story-adaptation-screen layout-view-screen layout-view-screen--empty">
        <p className="error">{error ?? 'Unable to load layout.'}</p>
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
      onDeletePanel={handleDeletePanel}
      isSaving={isSaving}
    />
  );

  return (
    <div className="story-adaptation-screen story-panels-screen layout-view-screen">
      <header className="layout-view-toolbar">
        <div className="layout-view-toolbar-primary">
          <label className="story-panels-view-control">
            <select value={layoutMode} aria-label="Layout view" onChange={(event) => setLayoutMode(event.target.value as StoryPanelLayoutMode)}>
              <option value="all-pages">All pages (a)</option>
              <option value="spread">Two-page spread (2)</option>
              <option value="single">Single page + info (i)</option>
              <option value="single-chunks">Single page + panel chunks (p)</option>
            </select>
          </label>
          <div className="story-panels-history-actions">
            {historyControls}
          </div>
          <button
            type="button"
            className="secondary small-button layout-view-export-button"
            disabled={isExporting || isSaving}
            onClick={() => setShowExportModal(true)}
            aria-label={isExporting ? 'Exporting…' : 'Export PDF'}
            title={isExporting ? 'Exporting…' : 'Export PDF'}
          >
            <span aria-hidden="true">🖨️</span>
          </button>
        </div>
        <div className="layout-view-toolbar-page">
          {pageControls}
        </div>
      </header>
      {error && <p className="error error-banner layout-view-error">{error}</p>}
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
      <div className="layout-view-workspace">
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
          onPageControlsChange={setPageControls}
          assets={assets}
          projectTags={projectTags}
          canvas={canvas}
          projectSlug={projectSlug}
          navigateToPanelId={navigateToPanelId}
          onNavigateToPanelComplete={() => setNavigateToPanelId(null)}
        />
      </div>
    </div>
  );
}
