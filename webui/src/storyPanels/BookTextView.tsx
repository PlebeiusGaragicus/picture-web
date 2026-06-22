import { useEffect, useState } from 'react';
import { formatRequestError } from '../formatError';
import { api } from '../api';
import { BookTextSelector, type TextSelectionRange } from './BookTextSelector';
import { ManualStoryReader } from './ManualStoryReader';
import { PanelChunkList } from './PanelChunkList';
import { StorySetupView } from './StorySetupView';
import type { LayoutEditorNavigation } from './layoutEditorNavigation';
import type { InsertDraftPayload } from './storyPanelSidebar';
import { sortedPanels, withSelectedText } from './storyPanelUtils';
import { autoPlaceDraftPanel } from './autoPlace';
import { useStoryPanelDocument } from './useStoryPanelDocument';

export function BookTextView({
  projectSlug,
  onNavigateToLayoutEditor,
  panelChunksOpen,
  onPanelChunksOpenChange,
  onHasBookTextChange,
  autoPlaceEnabled,
  onImportBook,
}: {
  projectSlug: string;
  onNavigateToLayoutEditor: (navigation: LayoutEditorNavigation) => void;
  panelChunksOpen: boolean;
  onPanelChunksOpenChange: (open: boolean) => void;
  onHasBookTextChange: (hasBookText: boolean) => void;
  autoPlaceEnabled: boolean;
  onImportBook: (file: File) => Promise<void>;
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
    reload,
  } = useStoryPanelDocument(projectSlug);
  const [selection, setSelection] = useState<TextSelectionRange | null>(null);
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [focusedBookPanelId, setFocusedBookPanelId] = useState<string | null>(null);
  const [focusedChunkPanelId, setFocusedChunkPanelId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const hasBookText = bookText.length > 0;
  const showStorySetup = !hasBookText && sidebarPanels.length === 0;

  const handleImportBook = async (file: File) => {
    setError(null);
    try {
      await onImportBook(file);
      await reload();
    } catch (err) {
      setError(formatRequestError(err));
      throw err;
    }
  };

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
    const next = await api.createDraftStoryPanel(projectSlug, {
      customText,
      insertAfterPanelId,
      autoPlace: autoPlaceDraftPanel(sidebarPanels.length, autoPlaceEnabled),
    });
    setDocument(next);
    const created = next.panels.find((panel) => !beforeIds.has(panel.id));
    if (created) {
      setSelectedPanelId(created.id);
      setFocusedBookPanelId(null);
      window.setTimeout(() => setFocusedBookPanelId(created.id), 0);
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

  const editPanelText = editPanelNote;

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
      onEditPanelText={hasBookText ? undefined : editPanelText}
      isSaving={isSaving}
    />
  );

  if (showStorySetup) {
    return (
      <div className="story-adaptation-screen story-panels-screen story-view-screen">
        {error && <p className="error error-banner story-view-error">{error}</p>}
        <StorySetupView
          onImportBook={handleImportBook}
          onAddPanel={insertDraft}
          isSaving={isSaving}
        />
      </div>
    );
  }

  return (
    <div className="story-adaptation-screen story-panels-screen story-view-screen">
      {error && <p className="error error-banner story-view-error">{error}</p>}
      <div
        className={[
          'story-view-workspace',
          panelChunksOpen ? 'is-chunks-open' : '',
        ].filter(Boolean).join(' ')}
      >
        <div className="story-view-text-pane">
          {hasBookText ? (
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
          ) : (
            <ManualStoryReader
              panels={sidebarPanels}
              selectedPanelId={selectedPanelId}
              focusedPanelId={focusedBookPanelId}
              onSelectPanel={selectPanelChunk}
              onFocusPanelChunk={focusPanelChunk}
              onInsertDraft={insertDraft}
              onEditPanelText={editPanelText}
              isSaving={isSaving || isCreating}
            />
          )}
        </div>

        {panelChunksOpen && (
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
