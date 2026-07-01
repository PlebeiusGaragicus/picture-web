import { useEffect, useState, type ReactNode } from 'react';
import type React from 'react';
import { PageLayoutEditor, type StoryPanelLayoutMode } from './PageLayoutEditor';
import { LayoutViewModeSelect } from './LayoutViewModeSelect';
import { PanelChunkList } from './PanelChunkList';
import type { InsertDraftPayload } from './storyPanelSidebar';
import { autoPlaceDraftPanel, readAutoPlaceEnabled } from './autoPlace';
import type { LayoutEditorNavigation } from './layoutEditorNavigation';
import { readSingleSidePanel, writeSingleSidePanel, type SingleSidePanel } from './singleSidePanel';
import { readSinglePagePreviewMode, writeSinglePagePreviewMode, type SinglePagePreviewMode } from './singlePagePreview';
import { isEditableShortcutTarget, sortedPanels } from './storyPanelUtils';
import { useStoryPanelDocument } from './useStoryPanelDocument';
import { formatRequestError } from '../formatError';
import { HoverTooltip } from '../ui';
import { api } from '../api';
import type { StoryPanelRect } from '../types';
import { isPanel, isUnplaced } from './panelModel';

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
    setError,
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
  const [historyControls, setHistoryControls] = useState<React.ReactNode>(null);
  const [pageControls, setPageControls] = useState<React.ReactNode>(null);
  const [spreadPanelInfoEnabled, setSpreadPanelInfoEnabled] = useState(readSpreadPanelInfoEnabled);
  const [singleSidePanel, setSingleSidePanel] = useState<SingleSidePanel>(readSingleSidePanel);
  const [singlePagePreviewMode, setSinglePagePreviewMode] = useState<SinglePagePreviewMode>(readSinglePagePreviewMode);
  const [isPlacingPanel, setIsPlacingPanel] = useState(false);

  const selectSingleSidePanel = (panel: SingleSidePanel) => {
    writeSingleSidePanel(panel);
    setSingleSidePanel(panel);
  };

  const togglePrintPreview = () => {
    setSinglePagePreviewMode((current) => {
      const next = current === 'print' ? 'readable' : 'print';
      writeSinglePagePreviewMode(next);
      return next;
    });
  };

  const toggleSpreadPanelInfo = () => {
    setSpreadPanelInfoEnabled((current) => {
      const next = !current;
      writeSpreadPanelInfoEnabled(next);
      return next;
    });
  };

  useEffect(() => {
    if (!initialNavigation || !document) return;
    setLayoutMode('single');
    selectSingleSidePanel(initialNavigation.singleSidePanel);
    setSelectedPanelId(initialNavigation.panelId);
    setFocusedChunkPanelId(null);
    window.setTimeout(() => setFocusedChunkPanelId(initialNavigation.panelId), 0);
    const panel = document.panels.find((candidate) => candidate.id === initialNavigation.panelId);
    if (panel?.pageId && document.pages.some((page) => page.id === panel.pageId)) {
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
    if (!document?.panels.some((panel) => panel.id === panelId && isPanel(panel))) return;
    setFocusedChunkPanelId(null);
    window.setTimeout(() => setFocusedChunkPanelId(panelId), 0);
  };

  const openPanelPlacement = (panelId: string) => {
    if (!document) return;
    const panel = document.panels.find((candidate) => candidate.id === panelId);
    if (!panel) return;
    setLayoutMode('single');
    selectSingleSidePanel('chunks');
    setSelectedPanelId(panelId);
    setFocusedChunkPanelId(null);
    window.setTimeout(() => setFocusedChunkPanelId(panelId), 0);
    if (panel.pageId && document.pages.some((page) => page.id === panel.pageId)) {
      setNavigateToPanelId(panelId);
    }
  };

  const placePanelOnLayout = async (panelId: string) => {
    setIsPlacingPanel(true);
    setError(null);
    try {
      const next = await api.autoPlaceStoryPanel(projectSlug, panelId);
      setDocument(next);
      setSelectedPanelId(panelId);
      openPanelPlacement(panelId);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsPlacingPanel(false);
    }
  };

  const handleDeletePanel = async (panelId: string) => {
    const next = await deletePanel(panelId);
    if (next) {
      setSelectedPanelId(sortedPanels(next.panels).find((panel) => isPanel(panel) && panel.parentPanelId == null)?.id ?? null);
    }
  };

  const insertDraft = async ({ customText, insertAfterPanelId }: InsertDraftPayload) => {
    const beforeIds = new Set(document?.panels.map((panel) => panel.id) ?? []);
    const next = await api.createStoryPanel(projectSlug, {
      customText,
      insertAfterPanelId,
      autoPlace: autoPlaceDraftPanel(sidebarPanels.length, readAutoPlaceEnabled()),
    });
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

  const createPanelAt = async ({ pageId, rect, panelKind }: { pageId: string; rect: StoryPanelRect; panelKind: 'image' | 'text' }) => {
    const beforeIds = new Set(document?.panels.map((panel) => panel.id) ?? []);
    const next = await api.createStoryPanel(projectSlug, {
      title: panelKind === 'text' ? 'Text panel' : 'Image panel',
      customText: panelKind === 'text' ? 'Text block' : '',
      panelKind,
      pageId,
      rect,
      autoPlace: false,
    });
    setDocument(next);
    const created = next.panels.find((panel) => !beforeIds.has(panel.id));
    if (created) {
      setSelectedPanelId(created.id);
      setFocusedChunkPanelId(null);
      return created.id;
    }
    return null;
  };

  const placePanelAt = async ({ panelId, pageId, rect }: { panelId: string; pageId: string; rect: StoryPanelRect }) => {
    const next = await api.patchStoryPanel(projectSlug, panelId, { pageId, rect });
    setDocument(next);
    setSelectedPanelId(panelId);
    setFocusedChunkPanelId(null);
  };

  useEffect(() => {
    if (!onTopBarEndContentChange) return;
    onTopBarEndContentChange(
      <LayoutViewModeSelect value={layoutMode} onChange={setLayoutMode} disabled={isSaving} />,
    );
    return () => onTopBarEndContentChange(null);
  }, [layoutMode, isSaving, onTopBarEndContentChange]);

  useEffect(() => {
    const layoutShortcuts: Record<string, StoryPanelLayoutMode> = {
      a: 'all-pages',
      '2': 'spread',
      s: 'single',
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableShortcutTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const nextMode = layoutShortcuts[key];
      if (nextMode) {
        event.preventDefault();
        setLayoutMode(nextMode);
        if (key === 's') {
          selectSingleSidePanel('info');
        }
        return;
      }
      if (key === 'p') {
        event.preventDefault();
        setLayoutMode('single');
        selectSingleSidePanel('chunks');
      }
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

  const unplacedPanels = sidebarPanels.filter(isUnplaced);

  const panelChunks = (
    <PanelChunkList
      bookLength={bookText.length}
      panels={sidebarPanels}
      pages={document.pages}
      selectedPanelId={selectedPanelId}
      focusedPanelId={focusedChunkPanelId}
      onSelectPanel={selectPanelChunk}
      onOpenPanelPlacement={openPanelPlacement}
      onPlacePanelOnLayout={placePanelOnLayout}
      onDeletePanel={handleDeletePanel}
      onInsertDraft={insertDraft}
      onEditPanelNote={bookText.length > 0 ? editPanelNote : undefined}
      isSaving={isSaving || isPlacingPanel}
    />
  );

  return (
    <div className="story-adaptation-screen story-panels-screen layout-view-screen">
      <header className="layout-view-toolbar">
        <div className="layout-view-toolbar-primary">
          <div className="story-panels-history-actions">
            {historyControls}
          </div>
          <HoverTooltip
            text={singlePagePreviewMode === 'print' ? 'Hide print preview' : 'Show print preview'}
            placement="bottom"
          >
            <button
              type="button"
              className={`secondary small-button layout-view-export-button ${singlePagePreviewMode === 'print' ? 'active' : ''}`}
              disabled={isSaving}
              aria-pressed={singlePagePreviewMode === 'print'}
              aria-label={singlePagePreviewMode === 'print' ? 'Hide print preview' : 'Show print preview'}
              onClick={togglePrintPreview}
            >
              <span aria-hidden="true">🖨️</span>
            </button>
          </HoverTooltip>
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
        <div className="layout-view-toolbar-center">
          {layoutMode === 'single' && (
            <div className="story-panels-preview-toggle" role="group" aria-label="Side panel">
              <button
                type="button"
                className={singleSidePanel === 'info' ? 'active' : ''}
                disabled={isSaving}
                aria-pressed={singleSidePanel === 'info'}
                onClick={() => selectSingleSidePanel('info')}
              >
                Info
              </button>
              <button
                type="button"
                className={singleSidePanel === 'chunks' ? 'active' : ''}
                disabled={isSaving}
                aria-pressed={singleSidePanel === 'chunks'}
                onClick={() => selectSingleSidePanel('chunks')}
              >
                Chunks
              </button>
            </div>
          )}
        </div>
        <div className="layout-view-toolbar-page">
          {pageControls}
        </div>
      </header>
      {error && <p className="error error-banner layout-view-error">{error}</p>}
      <div className="layout-view-workspace">
        <PageLayoutEditor
          document={document}
          selectedPanelId={selectedPanelId}
          layoutMode={layoutMode}
          singleSidePanel={singleSidePanel}
          singlePagePreviewMode={singlePagePreviewMode}
          onSelectPanel={selectLayoutPanel}
          onSaveDocument={saveDocument}
          isSaving={isSaving}
          sidePanel={panelChunks}
          onLayoutModeChange={setLayoutMode}
          onHistoryControlsChange={setHistoryControls}
          onPageControlsChange={setPageControls}
          spreadPanelInfoEnabled={spreadPanelInfoEnabled}
          unplacedPanels={unplacedPanels}
          onCreatePanelAt={createPanelAt}
          onPlacePanelAt={placePanelAt}
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
