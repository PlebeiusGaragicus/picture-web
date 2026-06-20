import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { StoryPanel, StoryPanelDocument, StoryPanelRect } from '../types';

export type StoryPanelLayoutMode = 'spread' | 'single' | 'single-chunks' | 'all-pages' | 'book' | 'book-chunks';

const gridColumns = 12;
const minPanelHeight = 2;
const minPanelWidth = 2;
const minTextPanelHeight = 0.5;
const minTextPanelWidth = 0.75;
const panelSnapScale = 4;
const comicPageAspectRatio = '5.5 / 8.5';

type DragMode = 'move' | 'resize';
type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';
type DragState = {
  panelId: string;
  pageId: string;
  mode: DragMode;
  corner?: ResizeCorner;
  startClientX: number;
  startClientY: number;
  startRect: StoryPanelRect;
};

type PageContextMenu = {
  kind: 'page';
  x: number;
  y: number;
  pageId: string;
  rect: StoryPanelRect;
};

function storyOffset(panel: StoryPanel) {
  return panel.startOffset ?? Number.MAX_SAFE_INTEGER;
}

function sortedPages(document: StoryPanelDocument) {
  return [...document.pages].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function sortedPanelsForPage(document: StoryPanelDocument, pageId: string) {
  return document.panels
    .filter((panel) => panel.pageId === pageId)
    .sort((a, b) => a.layer - b.layer || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

function pageKindLabel(pageKind: StoryPanelDocument['pages'][number]['pageKind']) {
  if (pageKind === 'cover') return 'Cover page';
  if (pageKind === 'inside-cover') return 'Inside cover / copyright';
  if (pageKind === 'back-cover') return 'Back cover';
  return 'Story page';
}

function panelStyle(panel: StoryPanel, rows: number): CSSProperties {
  return {
    left: `${(panel.rect.x / gridColumns) * 100}%`,
    top: `${(panel.rect.y / rows) * 100}%`,
    width: `${(panel.rect.w / gridColumns) * 100}%`,
    height: `${(panel.rect.h / rows) * 100}%`,
    zIndex: panel.layer + 1,
  };
}

function roundStep(value: number, scale: number) {
  return Math.round(value * scale) / scale;
}

function clampRect(rect: StoryPanelRect, panelKind: StoryPanel['panelKind'] = 'image'): StoryPanelRect {
  const minWidth = panelKind === 'text' ? minTextPanelWidth : minPanelWidth;
  const minHeight = panelKind === 'text' ? minTextPanelHeight : minPanelHeight;
  const w = Math.min(gridColumns, Math.max(minWidth, roundStep(rect.w, panelSnapScale)));
  const h = Math.max(minHeight, roundStep(rect.h, panelSnapScale));
  const x = Math.min(gridColumns - w, Math.max(0, roundStep(rect.x, panelSnapScale)));
  return { x, y: Math.max(0, roundStep(rect.y, panelSnapScale)), w, h };
}

function resizeRectFromCorner(rect: StoryPanelRect, corner: ResizeCorner, deltaColumns: number, deltaRows: number, panelKind: StoryPanel['panelKind']): StoryPanelRect {
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  const minWidth = panelKind === 'text' ? minTextPanelWidth : minPanelWidth;
  const minHeight = panelKind === 'text' ? minTextPanelHeight : minPanelHeight;
  let x = rect.x;
  let y = rect.y;
  let w = rect.w;
  let h = rect.h;
  if (corner.includes('w')) {
    x = Math.min(right - minWidth, Math.max(0, rect.x + deltaColumns));
    w = right - x;
  } else {
    w = rect.w + deltaColumns;
  }
  if (corner.includes('n')) {
    y = Math.min(bottom - minHeight, Math.max(0, rect.y + deltaRows));
    h = bottom - y;
  } else {
    h = rect.h + deltaRows;
  }
  return clampRect({ x, y, w, h }, panelKind);
}

function nextPageId(document: StoryPanelDocument) {
  const ids = new Set(document.pages.map((page) => page.id));
  let index = document.pages.length + 1;
  while (ids.has(`page-${String(index).padStart(3, '0')}`)) index += 1;
  return `page-${String(index).padStart(3, '0')}`;
}

function nextPanelId(document: StoryPanelDocument) {
  const ids = new Set(document.panels.map((panel) => panel.id));
  let index = document.panels.length + 1;
  while (ids.has(`panel-${String(index).padStart(3, '0')}`)) index += 1;
  return `panel-${String(index).padStart(3, '0')}`;
}

function normalizePageOrder(pages: StoryPanelDocument['pages']) {
  return pages
    .map((page, index) => ({ ...page, order: index }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function PageLayoutEditor({
  document,
  selectedPanelId,
  layoutMode,
  onSelectPanel,
  onSaveDocument,
  isSaving,
  sidePanel,
  onLayoutModeChange,
  onHistoryControlsChange,
}: {
  document: StoryPanelDocument;
  selectedPanelId: string | null;
  layoutMode: StoryPanelLayoutMode;
  onSelectPanel: (panelId: string) => void;
  onSaveDocument: (document: StoryPanelDocument) => void;
  isSaving: boolean;
  sidePanel?: React.ReactNode;
  onLayoutModeChange?: (layoutMode: StoryPanelLayoutMode) => void;
  onHistoryControlsChange?: (controls: React.ReactNode) => void;
}) {
  const pageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const sideHeightSourceRef = useRef<HTMLElement | null>(null);
  const [draftDocument, setDraftDocument] = useState<StoryPanelDocument | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [pageMenu, setPageMenu] = useState<PageContextMenu | null>(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [pendingPageDeleteId, setPendingPageDeleteId] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<StoryPanelDocument[]>([]);
  const [redoStack, setRedoStack] = useState<StoryPanelDocument[]>([]);
  const [customTextDraft, setCustomTextDraft] = useState<string | null>(null);
  const [sidePanelHeight, setSidePanelHeight] = useState<number | null>(null);
  const [flashingPanelId, setFlashingPanelId] = useState<string | null>(null);
  const displayDocument = draftDocument ?? document;
  const pages = sortedPages(displayDocument);
  const clampedPageIndex = Math.min(Math.max(currentPageIndex, 0), Math.max(0, pages.length - 1));
  const lastSpreadStartIndex = pages.length <= 1 ? 0 : pages.length % 2 === 0 ? pages.length - 1 : pages.length - 2;
  const isPageLayoutMode = layoutMode !== 'book' && layoutMode !== 'book-chunks';
  const isSinglePageMode = isPageLayoutMode && layoutMode !== 'spread';
  const visiblePages = pages.length === 0 ? [] : layoutMode === 'all-pages'
    ? pages
    : isSinglePageMode
    ? pages.slice(clampedPageIndex, clampedPageIndex + 1)
    : clampedPageIndex === 0
      ? [null, pages[0]].filter((page, index) => index === 0 || Boolean(page))
      : pages.slice(clampedPageIndex, clampedPageIndex + 2);
  const selectedPanel = displayDocument.panels.find((panel) => panel.id === selectedPanelId) ?? null;
  const pendingPageDelete = pendingPageDeleteId ? pages.find((page) => page.id === pendingPageDeleteId) ?? null : null;
  const pendingPageDeletePanelCount = pendingPageDeleteId
    ? displayDocument.panels.filter((panel) => panel.pageId === pendingPageDeleteId).length
    : 0;
  const storyPanelNumberById = new Map(
    displayDocument.panels
      .filter((panel) => panel.sourceKind === 'story')
      .sort((a, b) => storyOffset(a) - storyOffset(b) || a.order - b.order)
      .map((panel, index) => [panel.id, index + 1]),
  );
  useEffect(() => {
    if (!pageMenu) return;
    const close = () => setPageMenu(null);
    window.document.addEventListener('pointerdown', close);
    return () => window.document.removeEventListener('pointerdown', close);
  }, [pageMenu]);
  useEffect(() => {
    setCustomTextDraft(selectedPanel?.customText ?? null);
  }, [selectedPanel?.id, selectedPanel?.customText]);
  useEffect(() => {
    if (selectedPageId && pages.some((page) => page.id === selectedPageId)) return;
    setSelectedPageId(pages[clampedPageIndex]?.id ?? pages[0]?.id ?? null);
  }, [clampedPageIndex, pages, selectedPageId]);
  useEffect(() => {
    if (!selectedPanel || !isPageLayoutMode || layoutMode === 'all-pages') return;
    const pageIndex = pages.findIndex((page) => page.id === selectedPanel.pageId);
    if (pageIndex >= 0) {
      setCurrentPageIndex(layoutMode === 'spread' ? pageIndex === 0 ? 0 : pageIndex % 2 === 0 ? pageIndex - 1 : pageIndex : pageIndex);
    }
    setFlashingPanelId(null);
    const start = window.setTimeout(() => setFlashingPanelId(selectedPanel.id), 0);
    const stop = window.setTimeout(() => setFlashingPanelId((current) => (current === selectedPanel.id ? null : current)), 1400);
    return () => {
      window.clearTimeout(start);
      window.clearTimeout(stop);
    };
  }, [isPageLayoutMode, layoutMode, selectedPanel?.id, selectedPanel?.pageId]);
  useEffect(() => {
    onHistoryControlsChange?.(
      <>
        <button type="button" className="secondary" disabled={isSaving || undoStack.length === 0} onClick={undo}>
          Undo
        </button>
        <button type="button" className="secondary" disabled={isSaving || redoStack.length === 0} onClick={redo}>
          Redo
        </button>
      </>,
    );
    return () => onHistoryControlsChange?.(null);
  }, [isSaving, onHistoryControlsChange, redoStack.length, undoStack.length]);
  useLayoutEffect(() => {
    if (layoutMode !== 'single-chunks' || !sideHeightSourceRef.current) {
      setSidePanelHeight(null);
      return;
    }
    const source = sideHeightSourceRef.current;
    const updateHeight = () => setSidePanelHeight(source.getBoundingClientRect().height);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(source);
    return () => observer.disconnect();
  }, [layoutMode, clampedPageIndex, visiblePages.length]);
  const createPageDocument = (afterPageId?: string) => {
    const id = nextPageId(displayDocument);
    const insertionIndex = afterPageId ? pages.findIndex((page) => page.id === afterPageId) + 1 : displayDocument.pages.length;
    const page: StoryPanelDocument['pages'][number] = {
      id,
      order: insertionIndex,
      title: `Page ${pages.filter((candidate) => candidate.pageKind === 'story').length + 1}`,
      pageKind: 'story',
    };
    const nextPages = [...pages];
    nextPages.splice(insertionIndex < 0 ? pages.length : insertionIndex, 0, page);
    return {
      ...displayDocument,
      pages: nextPages.map((candidate, index) => ({ ...candidate, order: index })),
    };
  };
  const commitDocument = (nextDocument: StoryPanelDocument) => {
    setUndoStack((current) => [...current, document]);
    setRedoStack([]);
    onSaveDocument(nextDocument);
  };
  const undo = () => {
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    setUndoStack((current) => current.slice(0, -1));
    setRedoStack((current) => [...current, document]);
    onSaveDocument(previous);
  };
  const redo = () => {
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    setRedoStack((current) => current.slice(0, -1));
    setUndoStack((current) => [...current, document]);
    onSaveDocument(next);
  };
  const goNext = () => {
    const nextPageIndex = layoutMode === 'spread'
      ? clampedPageIndex === 0 ? 1 : clampedPageIndex + 2
      : clampedPageIndex + 1;
    const lastPageIndex = layoutMode === 'spread' ? lastSpreadStartIndex : pages.length - 1;
    if (nextPageIndex <= lastPageIndex) {
      setCurrentPageIndex(nextPageIndex);
      return;
    }
    const newPageIndex = pages.length;
    commitDocument(createPageDocument());
    setCurrentPageIndex(layoutMode === 'spread' && newPageIndex > 0 && newPageIndex % 2 === 0 ? newPageIndex - 1 : newPageIndex);
  };
  const selectedPageIndex = selectedPageId ? pages.findIndex((page) => page.id === selectedPageId) : -1;
  const addPageAfterSelected = () => {
    const anchorId = selectedPageId ?? pages[pages.length - 1]?.id;
    const nextDocument = createPageDocument(anchorId);
    const insertedPage = sortedPages(nextDocument)[Math.max(0, (anchorId ? selectedPageIndex + 1 : pages.length))];
    commitDocument(nextDocument);
    setSelectedPageId(insertedPage?.id ?? null);
  };
  const requestDeleteSelectedPage = () => {
    if (!selectedPageId || pages.length <= 1) return;
    setPendingPageDeleteId(selectedPageId);
  };
  const confirmDeleteSelectedPage = () => {
    const pageId = pendingPageDeleteId;
    if (!pageId || pages.length <= 1) return;
    const pageIndex = pages.findIndex((page) => page.id === pageId);
    const nextPages = normalizePageOrder(pages.filter((page) => page.id !== pageId));
    const nextIndex = Math.min(Math.max(0, pageIndex), nextPages.length - 1);
    commitDocument({
      ...displayDocument,
      pages: nextPages,
      panels: displayDocument.panels.filter((panel) => panel.pageId !== pageId),
    });
    setPendingPageDeleteId(null);
    setSelectedPageId(nextPages[nextIndex]?.id ?? null);
    setCurrentPageIndex(nextIndex);
  };
  const moveSelectedPage = (direction: -1 | 1) => {
    if (!selectedPageId || selectedPageIndex < 0) return;
    const targetIndex = selectedPageIndex + direction;
    if (targetIndex < 0 || targetIndex >= pages.length) return;
    const nextPages = [...pages];
    const [page] = nextPages.splice(selectedPageIndex, 1);
    nextPages.splice(targetIndex, 0, page);
    commitDocument({ ...displayDocument, pages: nextPages.map((candidate, index) => ({ ...candidate, order: index })) });
    setCurrentPageIndex(targetIndex);
  };
  const goPrevious = () => {
    if (isSinglePageMode) {
      setCurrentPageIndex((index) => Math.max(0, index - 1));
      return;
    }
    setCurrentPageIndex((index) => index <= 1 ? 0 : Math.max(1, index - 2));
  };
  const placeSelectedPanelAt = (pageId: string, rect: StoryPanelRect) => {
    if (!selectedPanel) return;
    const page = displayDocument.pages.find((candidate) => candidate.id === pageId);
    if (selectedPanel.sourceKind === 'story' && page?.pageKind !== 'story') return;
    commitDocument({
      ...displayDocument,
      panels: displayDocument.panels.map((panel) => (
        panel.id === selectedPanel.id ? { ...panel, pageId, rect: clampRect({ ...panel.rect, x: rect.x, y: rect.y }, panel.panelKind) } : panel
      )),
    });
    setPageMenu(null);
  };
  const addFreePanelAt = (pageId: string, rect: StoryPanelRect, sourceKind: 'free-text' | 'free-image') => {
    const page = displayDocument.pages.find((candidate) => candidate.id === pageId);
    if (!page || page.pageKind === 'story') return;
    const nextPanel: StoryPanel = {
      id: nextPanelId(displayDocument),
      order: Math.max(...displayDocument.panels.map((panel) => panel.order), -1) + 1,
      sourceKind,
      startOffset: null,
      endOffset: null,
      selectedText: '',
      customText: sourceKind === 'free-text' ? page.pageKind === 'inside-cover' ? 'Copyright information' : 'Text block' : '',
      pageId,
      panelKind: sourceKind === 'free-text' ? 'text' : 'image',
      rect: clampRect({ ...rect, w: sourceKind === 'free-text' ? 5 : 8, h: sourceKind === 'free-text' ? 1.5 : 4 }, sourceKind === 'free-text' ? 'text' : 'image'),
      layer: 0,
      assetIds: [],
      activeAssetId: null,
      finalized: false,
    };
    commitDocument({ ...displayDocument, panels: [...displayDocument.panels, nextPanel] });
    onSelectPanel(nextPanel.id);
    setPageMenu(null);
  };
  const updateSelectedPanel = (patch: Partial<StoryPanel>) => {
    if (!selectedPanel) return;
    commitDocument({
      ...displayDocument,
      panels: displayDocument.panels.map((panel) => panel.id === selectedPanel.id ? { ...panel, ...patch } : panel),
    });
  };
  const commitCustomTextDraft = () => {
    if (!selectedPanel || customTextDraft === null || customTextDraft === (selectedPanel.customText ?? '')) return;
    updateSelectedPanel({ customText: customTextDraft });
  };
  const jumpToPage = (value: number) => {
    if (!Number.isFinite(value)) return;
    setCurrentPageIndex(Math.min(Math.max(value - 1, 0), Math.max(0, pages.length - 1)));
  };
  const pageIdFromPointer = (clientX: number, clientY: number) => {
    for (const [pageId, element] of Object.entries(pageRefs.current)) {
      if (!element) continue;
      const bounds = element.getBoundingClientRect();
      if (clientX >= bounds.left && clientX <= bounds.right && clientY >= bounds.top && clientY <= bounds.bottom) {
        return pageId;
      }
    }
    return null;
  };
  const updatePanelDuringDrag = (event: React.PointerEvent, state: DragState) => {
    const targetPageId = pageIdFromPointer(event.clientX, event.clientY) ?? state.pageId;
    const pageElement = pageRefs.current[targetPageId] ?? pageRefs.current[state.pageId];
    if (!pageElement) return;
    const bounds = pageElement.getBoundingClientRect();
    const columnWidth = bounds.width / gridColumns;
    const rowHeight = Math.max(22, bounds.height / Math.max(10, ...displayDocument.panels.map((panel) => panel.rect.y + panel.rect.h)));
    const deltaColumns = targetPageId === state.pageId ? roundStep((event.clientX - state.startClientX) / columnWidth, panelSnapScale) : roundStep((event.clientX - bounds.left) / columnWidth, panelSnapScale) - state.startRect.x;
    const deltaRows = targetPageId === state.pageId ? roundStep((event.clientY - state.startClientY) / rowHeight, panelSnapScale) : roundStep((event.clientY - bounds.top) / rowHeight, panelSnapScale) - state.startRect.y;
    const nextPanels = displayDocument.panels.map((panel) => {
      if (panel.id !== state.panelId) return panel;
      if (state.mode === 'resize') {
        return {
          ...panel,
          rect: resizeRectFromCorner(state.startRect, state.corner ?? 'se', deltaColumns, deltaRows, panel.panelKind),
        };
      }
      return {
        ...panel,
        pageId: targetPageId,
        rect: clampRect({
          ...state.startRect,
          x: state.startRect.x + deltaColumns,
          y: state.startRect.y + deltaRows,
        }, panel.panelKind),
      };
    });
    setDraftDocument({ ...displayDocument, panels: nextPanels });
  };
  const beginDrag = (event: React.PointerEvent, panel: StoryPanel, mode: DragMode, corner?: ResizeCorner) => {
    if (isSaving) return;
    event.preventDefault();
    event.stopPropagation();
    onSelectPanel(panel.id);
    const state = {
      panelId: panel.id,
      pageId: panel.pageId,
      mode,
      corner,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRect: panel.rect,
    };
    setDragState(state);
    setDraftDocument(displayDocument);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const continueDrag = (event: React.PointerEvent) => {
    if (!dragState) return;
    updatePanelDuringDrag(event, dragState);
  };
  const endDrag = () => {
    if (!dragState || !draftDocument) return;
    const nextDocument = draftDocument;
    setDragState(null);
    setDraftDocument(null);
    commitDocument(nextDocument);
  };
  const openPageMenu = (event: React.MouseEvent<HTMLDivElement>, pageId: string) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const columnWidth = bounds.width / gridColumns;
    const rows = Math.max(10, ...displayDocument.panels.filter((panel) => panel.pageId === pageId).map((panel) => panel.rect.y + panel.rect.h));
    const rowHeight = Math.max(22, bounds.height / rows);
    const minWidth = selectedPanel?.panelKind === 'text' ? minTextPanelWidth : minPanelWidth;
    const x = Math.min(gridColumns - minWidth, Math.max(0, roundStep((event.clientX - bounds.left) / columnWidth, panelSnapScale)));
    const y = Math.max(0, roundStep((event.clientY - bounds.top) / rowHeight, panelSnapScale));
    setPageMenu({ kind: 'page', x: event.clientX, y: event.clientY, pageId, rect: { x, y, w: selectedPanel?.rect.w ?? 6, h: selectedPanel?.rect.h ?? 3 } });
  };
  const openPageDetail = (pageId: string) => {
    const pageIndex = pages.findIndex((page) => page.id === pageId);
    if (pageIndex < 0) return;
    setCurrentPageIndex(pageIndex);
    setSelectedPageId(pageId);
    onLayoutModeChange?.('single');
  };
  const openPanelDetail = (event: React.MouseEvent, panel: StoryPanel) => {
    event.preventDefault();
    event.stopPropagation();
    const pageIndex = pages.findIndex((page) => page.id === panel.pageId);
    if (pageIndex >= 0) {
      setCurrentPageIndex(pageIndex);
      setSelectedPageId(panel.pageId);
    }
    onSelectPanel(panel.id);
    onLayoutModeChange?.('single');
  };

  return (
    <>
      {isPageLayoutMode && (
        <div className="story-panels-overlap-controls">
          <div className="story-panels-action-row">
            <div className="story-panels-page-nav" aria-label="Page navigation">
              {layoutMode === 'all-pages' ? (
                <>
                  <button type="button" className="secondary" disabled={isSaving || selectedPageIndex <= 0} onClick={() => moveSelectedPage(-1)}>Move left</button>
                  <button type="button" className="secondary" disabled={isSaving || selectedPageIndex < 0 || selectedPageIndex >= pages.length - 1} onClick={() => moveSelectedPage(1)}>Move right</button>
                  <button type="button" className="secondary" disabled={isSaving || !selectedPageId} onClick={addPageAfterSelected}>Add page after</button>
                  <button type="button" className="secondary" disabled={isSaving || !selectedPageId || pages.length <= 1} onClick={requestDeleteSelectedPage}>Delete page</button>
                </>
              ) : (
                <>
                  <button type="button" className="secondary" disabled={isSaving || clampedPageIndex <= 0} onClick={goPrevious}>
                    Prev
                  </button>
                  <label className="story-panels-page-jump">
                    <span>Page</span>
                    <input
                      type="number"
                      min={1}
                      max={Math.max(1, pages.length)}
                      value={pages.length ? clampedPageIndex + 1 : 0}
                      disabled={isSaving || pages.length === 0}
                      onChange={(event) => jumpToPage(Number(event.target.value))}
                    />
                    <span aria-hidden="true">/</span>
                    <input type="text" value={Math.max(1, pages.length)} readOnly aria-label="Total pages" />
                  </label>
                  <button type="button" className="secondary" disabled={isSaving} onClick={goNext}>
                    {clampedPageIndex >= (layoutMode === 'spread' ? lastSpreadStartIndex : pages.length - 1) ? 'New page' : 'Next'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {isPageLayoutMode && (
        <div className={`story-panels-layout-workspace is-${layoutMode}`}>
        <div className="story-panels-pages">
        {visiblePages.length ? visiblePages.map((page, pageIndex) => {
          if (!page) {
            return (
            <article
              key="intentional-blank-start"
              ref={(element) => {
                if (layoutMode === 'single-chunks' && pageIndex === 0) sideHeightSourceRef.current = element;
              }}
              className={`story-panels-page is-blank ${layoutMode === 'all-pages' && selectedPageId === null ? 'is-page-selected' : ''}`}
            >
                <h3>Intentionally Blank</h3>
                <div className="story-panels-page-grid story-panels-blank-page" style={{ aspectRatio: comicPageAspectRatio }}>
                  <p>This page intentionally left blank.</p>
                </div>
              </article>
            );
          }
          const pagePanels = sortedPanelsForPage(displayDocument, page.id);
          const pageRows = Math.max(10, ...pagePanels.map((panel) => panel.rect.y + panel.rect.h));
          return (
            <article
              key={`${page.id}-${pageIndex}`}
              ref={(element) => {
                if (layoutMode === 'single-chunks' && pageIndex === 0) sideHeightSourceRef.current = element;
              }}
              className={`story-panels-page ${layoutMode === 'all-pages' && selectedPageId === page.id ? 'is-page-selected' : ''}`}
              onClick={() => setSelectedPageId(page.id)}
              onDoubleClick={layoutMode === 'all-pages' ? () => openPageDetail(page.id) : undefined}
            >
              <h3>{page.title || page.id} <span>{pageKindLabel(page.pageKind)}</span></h3>
              <div
                ref={(element) => {
                  pageRefs.current[page.id] = element;
                }}
                className="story-panels-page-grid"
                style={{ aspectRatio: comicPageAspectRatio, gridTemplateRows: `repeat(${pageRows}, minmax(22px, 1fr))` }}
                onContextMenu={(event) => openPageMenu(event, page.id)}
                onPointerMove={continueDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                {pagePanels.map((panel) => (
                  <button
                    key={panel.id}
                    type="button"
                    className={`story-panels-page-panel is-${panel.panelKind} ${selectedPanelId === panel.id ? 'is-selected' : ''} ${flashingPanelId === panel.id ? 'is-flashing' : ''} ${dragState?.panelId === panel.id ? 'is-dragging' : ''}`}
                    style={panelStyle(panel, pageRows)}
                    onClick={layoutMode === 'all-pages' ? undefined : () => onSelectPanel(panel.id)}
                    onDoubleClick={(event) => openPanelDetail(event, panel)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onPointerDown={layoutMode === 'all-pages' ? undefined : (event) => beginDrag(event, panel, 'move')}
                  >
                    {layoutMode !== 'all-pages' && (
                      <>
                        {panel.sourceKind === 'story' && panel.panelKind !== 'text' && (
                          <strong>Panel {storyPanelNumberById.get(panel.id) ?? ''}</strong>
                        )}
                        <span>{(panel.panelKind === 'text' && panel.id === selectedPanelId && customTextDraft ? customTextDraft : panel.panelKind === 'text' && panel.customText ? panel.customText : panel.selectedText || (panel.sourceKind === 'free-image' ? 'Cover image block' : '')).replace(/\s+/g, ' ').trim().slice(0, 120)}</span>
                        {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                          <span
                            key={corner}
                            className={`story-panels-resize-handle is-${corner}`}
                            aria-hidden="true"
                            onPointerDown={(event) => beginDrag(event, panel, 'resize', corner)}
                          />
                        ))}
                      </>
                    )}
                  </button>
                ))}
              </div>
            </article>
          );
        }) : <p className="muted">No pages yet.</p>}
        </div>
        {layoutMode === 'single' && (
          <aside className="story-panels-info-panel">
            <h3>Selected Panel</h3>
            {selectedPanel ? (
              <>
                <dl>
                  <div>
                    <dt>Panel</dt>
                    <dd>{storyPanelNumberById.get(selectedPanel.id) ?? ''}</dd>
                  </div>
                  <div>
                    <dt>Book range</dt>
                    <dd>{selectedPanel.startOffset} to {selectedPanel.endOffset}</dd>
                  </div>
                  <div>
                    <dt>Position</dt>
                    <dd>x {selectedPanel.rect.x}, y {selectedPanel.rect.y}, w {selectedPanel.rect.w}, h {selectedPanel.rect.h}</dd>
                  </div>
                </dl>
                <label>
                  Panel kind
                  <select
                    value={selectedPanel.panelKind}
                    disabled={isSaving}
                    onChange={(event) => updateSelectedPanel({ panelKind: event.target.value as StoryPanel['panelKind'] })}
                  >
                    <option value="image">Image panel</option>
                    <option value="text">Text / caption</option>
                  </select>
                </label>
                {selectedPanel.panelKind === 'text' && (
                  <label>
                    Custom comic text
                    <textarea
                      value={customTextDraft ?? ''}
                      rows={5}
                      disabled={isSaving}
                      placeholder="Text to show in the final comic panel"
                      onKeyDown={(event) => event.stopPropagation()}
                      onChange={(event) => setCustomTextDraft(event.target.value)}
                      onBlur={commitCustomTextDraft}
                    />
                  </label>
                )}
                <label>
                  Passage text
                  <textarea value={selectedPanel.selectedText} rows={5} readOnly />
                </label>
              </>
            ) : (
              <p className="muted">Select a page panel to see its settings and source text.</p>
            )}
          </aside>
        )}
        {layoutMode === 'single-chunks' && (
          <div className="story-panels-layout-side-panel" style={sidePanelHeight ? { height: sidePanelHeight } : undefined}>
            {sidePanel}
          </div>
        )}
        </div>
      )}
      {pageMenu && (
        <div className="story-panels-page-context-menu" style={{ left: pageMenu.x, top: pageMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          {pageMenu.kind === 'page' && (
            displayDocument.pages.find((page) => page.id === pageMenu.pageId)?.pageKind !== 'story' ? (
              <>
                <button type="button" onClick={() => addFreePanelAt(pageMenu.pageId, pageMenu.rect, 'free-text')}>Add text block here</button>
                <button type="button" onClick={() => addFreePanelAt(pageMenu.pageId, pageMenu.rect, 'free-image')}>Add image block here</button>
              </>
            ) : selectedPanel ? (
              <button type="button" onClick={() => placeSelectedPanelAt(pageMenu.pageId, pageMenu.rect)}>
                Place Panel {storyPanelNumberById.get(selectedPanel.id) ?? ''} here
              </button>
            ) : (
              <p className="muted">Select a panel chunk first.</p>
            )
          )}
        </div>
      )}
      {pendingPageDelete && (
        <div className="confirm-backdrop" onClick={() => setPendingPageDeleteId(null)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-story-page-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="delete-story-page-title">Delete {pendingPageDelete.title || pendingPageDelete.id}?</h2>
            <p>
              This will remove the page
              {pendingPageDeletePanelCount > 0 ? ` and ${pendingPageDeletePanelCount} panel${pendingPageDeletePanelCount === 1 ? '' : 's'} on it` : ''}
              . This can be undone from the header.
            </p>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setPendingPageDeleteId(null)}>Cancel</button>
              <button type="button" className="danger" disabled={isSaving} onClick={confirmDeleteSelectedPage}>Delete page</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
