import { useEffect, useState } from 'react';
import { formatRequestError } from '../formatError';
import { api } from '../api';
import { BookTextSelector, type TextSelectionRange } from './BookTextSelector';
import { PanelChunkList } from './PanelChunkList';
import type { LayoutEditorNavigation } from './layoutEditorNavigation';
import type { InsertDraftPayload } from './storyPanelSidebar';
import { sortedPanels, withSelectedText } from './storyPanelUtils';
import { useStoryPanelDocument } from './useStoryPanelDocument';

export function BookTextView({
  projectSlug,
  onNavigateToLayoutEditor,
  panelChunksOpen,
  onPanelChunksOpenChange,
  onHasBookTextChange,
  autoPlaceEnabled,
}: {
  projectSlug: string;
  onNavigateToLayoutEditor: (navigation: LayoutEditorNavigation) => void;
  panelChunksOpen: boolean;
  onPanelChunksOpenChange: (open: boolean) => void;
  onHasBookTextChange: (hasBookText: boolean) => void;
  autoPlaceEnabled: boolean;
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
  } = useStoryPanelDocument(projectSlug);
  const [selection, setSelection] = useState<TextSelectionRange | null>(null);
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [focusedBookPanelId, setFocusedBookPanelId] = useState<string | null>(null);
  const [focusedChunkPanelId, setFocusedChunkPanelId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const hasBookText = bookText.length > 0;

  useEffect(() => {
    if (!hasBookText) {
      onPanelChunksOpenChange(true);
    }
  }, [hasBookText, onPanelChunksOpenChange]);

  useEffect(() => {
    onHasBookTextChange(hasBookText);
  }, [hasBookText, onHasBookTextChange]);

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

  const openPanelPlacement = (panelId: string) => {
    if (!document) return;
    const panel = document.panels.find((candidate) => candidate.id === panelId);
    if (!panel) return;
    setSelectedPanelId(panelId);
    onNavigateToLayoutEditor({ panelId, singleSidePanel: 'chunks' });
  };

  const createPanel = async (panelNote?: string) => {
    if (!selection) return;
    setIsCreating(true);
    setError(null);
    try {
      const next = await api.createStoryPanel(projectSlug, {
        ...selection,
        customText: panelNote ?? '',
        autoPlace: autoPlaceEnabled,
      });
      setDocument(next);
      setSelection(null);
      setSelectedPanelId(
        sortedPanels(next.panels).find(
          (panel) => panel.sourceKind === 'story' && panel.startOffset === selection.startOffset && panel.endOffset === selection.endOffset,
        )?.id ?? null,
      );
      window.getSelection()?.removeAllRanges();
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeletePanel = async (panelId: string) => {
    const next = await deletePanel(panelId);
    if (next) {
      setSelectedPanelId(sortedPanels(next.panels).find((panel) => (
        panel.sourceKind === 'story' || panel.sourceKind === 'draft' || panel.sourceKind === 'bookmark'
      ))?.id ?? null);
    }
  };

  const createBookmark = async () => {
    if (!selection) return;
    setIsCreating(true);
    setError(null);
    try {
      const beforeIds = new Set(document?.panels.map((panel) => panel.id) ?? []);
      const next = await api.createStoryBookmark(projectSlug, selection);
      setDocument(next);
      setSelection(null);
      const created = next.panels.find((panel) => !beforeIds.has(panel.id));
      if (created) {
        setSelectedPanelId(created.id);
        setFocusedBookPanelId(null);
        window.setTimeout(() => setFocusedBookPanelId(created.id), 0);
      }
      window.getSelection()?.removeAllRanges();
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsCreating(false);
    }
  };

  const insertDraft = async ({ customText, insertAfterPanelId }: InsertDraftPayload) => {
    if (!document) return;
    const beforeIds = new Set(document.panels.map((panel) => panel.id));
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
    setError(null);
    try {
      const next = await api.patchStoryPanel(projectSlug, panelId, { customText: noteText });
      setDocument(next);
    } catch (err) {
      setError(formatRequestError(err));
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
    const updates = new Map<string, ReturnType<typeof withSelectedText>>();
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

  if (isLoading) {
    return (
      <div className="story-adaptation-screen">
        <p className="muted">Loading story...</p>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="story-adaptation-screen story-view-screen story-view-screen--empty">
        <h1 className="story-view-title">Story</h1>
        <p className="error">{error ?? 'Unable to load panel chunks.'}</p>
      </div>
    );
  }

  const panelChunks = (
    <PanelChunkList
      variant="plain"
      bookLength={bookText.length}
      panels={sidebarPanels}
      pages={document.pages}
      selectedPanelId={selectedPanelId}
      focusedPanelId={focusedChunkPanelId}
      onSelectPanel={selectPanelChunk}
      onOpenPanelPlacement={openPanelPlacement}
      onDeletePanel={handleDeletePanel}
      onInsertDraft={hasBookText ? undefined : insertDraft}
      onEditPanelNote={hasBookText ? editPanelNote : undefined}
      isSaving={isSaving}
    />
  );

  return (
    <div className="story-adaptation-screen story-panels-screen story-view-screen">
      {error && <p className="error error-banner story-view-error">{error}</p>}
      <div
        className={[
          'story-view-workspace',
          panelChunksOpen && hasBookText ? 'is-chunks-open' : '',
          !hasBookText ? 'is-create-mode' : '',
        ].filter(Boolean).join(' ')}
      >
        {hasBookText ? (
          <div className="story-view-text-pane">
            <BookTextSelector
              bookText={bookText}
              panels={sidebarPanels.filter((panel) => panel.sourceKind === 'story' || panel.sourceKind === 'bookmark')}
              selection={selection}
              focusedPanelId={focusedBookPanelId}
              onSelectionChange={setSelection}
              onCreatePanel={createPanel}
              onCreateBookmark={createBookmark}
              onDeletePanel={handleDeletePanel}
              onAdjustPanelRange={adjustPanelRange}
              onFocusPanelChunk={focusPanelChunk}
              isCreating={isCreating}
            />
          </div>
        ) : (
          <div className="story-view-create-pane">
            <div className="story-view-create-head">
              <h2 className="story-view-chunks-title">Your story</h2>
              <p className="muted">Add chunks with Insert after in the Reading list, then open Layout to place them on pages.</p>
            </div>
            {panelChunks}
          </div>
        )}

        {hasBookText && panelChunksOpen && (
          <aside className="story-view-chunks-pane">
            <div className="story-view-chunks-pane-head">
              <h2 className="story-view-chunks-title">Reading</h2>
            </div>
            {panelChunks}
          </aside>
        )}
      </div>
    </div>
  );
}
