import { useEffect, useState, type ReactNode } from 'react';
import type React from 'react';
import { PageLayoutEditor, type StoryPanelLayoutMode } from './PageLayoutEditor';
import { LayoutViewModeSelect } from './LayoutViewModeSelect';
import { PanelChunkList } from './PanelChunkList';
import type { InsertDraftPayload } from './storyPanelSidebar';
import { BOOKLET_PAGE_BORDER_OPTIONS, type BookletPageBorder } from './printLayout';
import type { LayoutEditorNavigation } from './layoutEditorNavigation';
import { isEditableShortcutTarget, sortedPanels } from './storyPanelUtils';
import { useStoryPanelDocument } from './useStoryPanelDocument';
import { api } from '../api';

const SPREAD_PANEL_INFO_KEY = 'story-panels-spread-panel-info';

function readSpreadPanelInfoEnabled(): boolean {
  try {
    const stored = localStorage.getItem(SPREAD_PANEL_INFO_KEY);
    if (stored === 'false') return false;
    if (stored === 'true') return true;
  } catch {
    // Ignore storage read failures in private browsing or restricted contexts.
  }
  return true;
}

function writeSpreadPanelInfoEnabled(enabled: boolean) {
  try {
    localStorage.setItem(SPREAD_PANEL_INFO_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore storage write failures.
  }
}

export function LayoutEditorView({
  projectSlug,
  initialNavigation,
  onNavigationComplete,
  onTopBarEndContentChange,
}: {
  projectSlug: string;
  initialNavigation: LayoutEditorNavigation | null;
  onNavigationComplete: () => void;
  onTopBarEndContentChange?: (content: ReactNode | null) => void;
}) {
  const {
    bookText,
    document,
    sidebarPanels,
    isLoading,
    isSaving,
    error,
    setDocument,
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
  const [spreadPanelInfoEnabled, setSpreadPanelInfoEnabled] = useState(readSpreadPanelInfoEnabled);

  const toggleSpreadPanelInfo = () => {
    setSpreadPanelInfoEnabled((current) => {
      const next = !current;
      writeSpreadPanelInfoEnabled(next);
      return next;
    });
  };

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
    if (!document?.panels.some((panel) => panel.id === panelId && (panel.sourceKind === 'story' || panel.sourceKind === 'draft'))) return;
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
      setSelectedPanelId(sortedPanels(next.panels).find((panel) => panel.sourceKind === 'story' || panel.sourceKind === 'draft')?.id ?? null);
    }
  };

  const insertDraft = async ({ customText, insertAfterPanelId }: InsertDraftPayload) => {
    const beforeIds = new Set(document?.panels.map((panel) => panel.id) ?? []);
    const next = await api.createDraftStoryPanel(projectSlug, { customText, insertAfterPanelId });
    setDocument(next);
    const created = next.panels.find((panel) => !beforeIds.has(panel.id));
    if (created) {
      setSelectedPanelId(created.id);
      setFocusedChunkPanelId(null);
      window.setTimeout(() => setFocusedChunkPanelId(created.id), 0);
    }
  };

  const editPanelNote = async (panelId: string, noteText: string) => {
    const next = await api.patchStoryPanel(projectSlug, panelId, { customText: noteText });
    setDocument(next);
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
    if (!onTopBarEndContentChange) return;
    onTopBarEndContentChange(
      <LayoutViewModeSelect value={layoutMode} onChange={setLayoutMode} disabled={isSaving} />,
    );
    return () => onTopBarEndContentChange(null);
  }, [layoutMode, isSaving, onTopBarEndContentChange]);

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
      panels={sidebarPanels}
      pages={document.pages}
      selectedPanelId={selectedPanelId}
      focusedPanelId={focusedChunkPanelId}
      onSelectPanel={selectPanelChunk}
      onOpenPanelPlacement={openPanelPlacement}
      onDeletePanel={handleDeletePanel}
      onInsertDraft={bookText.length === 0 ? insertDraft : undefined}
      onEditPanelNote={bookText.length > 0 ? editPanelNote : undefined}
      isSaving={isSaving}
    />
  );

  return (
    <div className="story-adaptation-screen story-panels-screen layout-view-screen">
      <header className="layout-view-toolbar">
        <div className="layout-view-toolbar-primary">
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
          {layoutMode === 'spread' && (
            <button
              type="button"
              className={`secondary small-button layout-view-spread-info-toggle ${spreadPanelInfoEnabled ? 'active' : ''}`}
              disabled={isSaving}
              aria-pressed={spreadPanelInfoEnabled}
              aria-label={spreadPanelInfoEnabled ? 'Hide panel info in spread view' : 'Show panel info in spread view'}
              title={spreadPanelInfoEnabled ? 'Hide panel info when a panel is selected' : 'Show panel info when a panel is selected'}
              onClick={toggleSpreadPanelInfo}
            >
              i
            </button>
          )}
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
          spreadPanelInfoEnabled={spreadPanelInfoEnabled}
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
