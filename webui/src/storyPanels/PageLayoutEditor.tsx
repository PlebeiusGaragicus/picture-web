import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { StoryPanel, StoryPanelDocument, StoryPanelRect } from '../types';
import { sortedStoryPages, storyPageNumberById as mapStoryPageNumbers } from './pageNumbers';
import {
  PRINT_HALF_WIDTH,
  PRINT_INNER_GUTTER,
  PRINT_OUTER_MARGIN,
  PRINT_PAGE_HEIGHT,
  PRINT_PAGE_WIDTH,
  PRINT_SHEET_ASPECT_RATIO,
  PRINT_SHEET_GRID_COLUMNS,
  PRINT_SHEET_GRID_ROWS,
  PRINT_SHEET_HEIGHT,
} from './printLayout';

export type StoryPanelLayoutMode = 'spread' | 'single' | 'single-chunks' | 'all-pages' | 'book' | 'book-chunks';

const gridColumns = 12;
const minPanelHeight = 2;
const minPanelWidth = 2;
const minTextPanelHeight = 0.5;
const minTextPanelWidth = 0.75;
const panelSnapScale = 4;
const comicPageAspectRatio = '5.5 / 8.5';

type SinglePagePreviewMode = 'readable' | 'print';
type StoryPanelCssProperties = CSSProperties & Record<`--${string}`, string | number>;

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
  if (pageKind === 'cover') return 'Front cover';
  if (pageKind === 'inside-cover') return 'Inside front cover';
  if (pageKind === 'inside-back-cover') return 'Inside back cover';
  if (pageKind === 'back-cover') return 'Back cover';
  return 'Story page';
}

function isStoryPage(page: StoryPanelDocument['pages'][number] | null | undefined) {
  return page?.pageKind === 'story';
}

function fixedPageShortLabel(page: StoryPanelDocument['pages'][number] | null | undefined) {
  if (!page) return '';
  if (page.pageKind === 'cover') return 'F';
  if (page.pageKind === 'inside-cover') return 'IFC';
  if (page.pageKind === 'inside-back-cover') return 'IBC';
  if (page.pageKind === 'back-cover') return 'B';
  return '';
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

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable;
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
  onPageControlsChange,
}: {
  document: StoryPanelDocument;
  selectedPanelId: string | null;
  layoutMode: StoryPanelLayoutMode;
  onSelectPanel: (panelId: string | null) => void;
  onSaveDocument: (document: StoryPanelDocument) => void;
  isSaving: boolean;
  sidePanel?: React.ReactNode;
  onLayoutModeChange?: (layoutMode: StoryPanelLayoutMode) => void;
  onHistoryControlsChange?: (controls: React.ReactNode) => void;
  onPageControlsChange?: (controls: React.ReactNode) => void;
}) {
  const pageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const sideHeightSourceRef = useRef<HTMLElement | null>(null);
  const previousPageIndexRef = useRef(0);
  const [draftDocument, setDraftDocument] = useState<StoryPanelDocument | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [pageMenu, setPageMenu] = useState<PageContextMenu | null>(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [pendingPageDeleteId, setPendingPageDeleteId] = useState<string | null>(null);
  const [pendingPanelDeleteId, setPendingPanelDeleteId] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<StoryPanelDocument[]>([]);
  const [redoStack, setRedoStack] = useState<StoryPanelDocument[]>([]);
  const [customTextDraft, setCustomTextDraft] = useState<string | null>(null);
  const [singlePagePreviewMode, setSinglePagePreviewMode] = useState<SinglePagePreviewMode>('readable');
  const [sidePanelHeight, setSidePanelHeight] = useState<number | null>(null);
  const [flashingPanelId, setFlashingPanelId] = useState<string | null>(null);
  const displayDocument = draftDocument ?? document;
  const pages = sortedPages(displayDocument);
  const clampedPageIndex = Math.min(Math.max(currentPageIndex, 0), Math.max(0, pages.length - 1));
  const coverPage = pages.find((page) => page.pageKind === 'cover') ?? null;
  const backCoverPage = pages.find((page) => page.pageKind === 'back-cover') ?? null;
  const interiorSpreadPages = pages.filter((page) => page.pageKind !== 'cover' && page.pageKind !== 'back-cover');
  const lastInteriorSpreadStart = interiorSpreadPages.length <= 1
    ? 0
    : interiorSpreadPages.length % 2 === 0
      ? interiorSpreadPages.length - 2
      : interiorSpreadPages.length - 1;
  const lastSpreadStartIndex = interiorSpreadPages.length > 0
    ? pages.findIndex((page) => page.id === interiorSpreadPages[lastInteriorSpreadStart]?.id)
    : 0;
  const isPageLayoutMode = layoutMode !== 'book' && layoutMode !== 'book-chunks';
  const isSinglePageMode = isPageLayoutMode && layoutMode !== 'spread';
  const hasSinglePageSidePanel = layoutMode === 'single' || layoutMode === 'single-chunks';
  const singlePagePreviewAspect = singlePagePreviewMode === 'print'
    ? `${PRINT_HALF_WIDTH} / ${PRINT_SHEET_HEIGHT}`
    : `${PRINT_PAGE_WIDTH} / ${PRINT_PAGE_HEIGHT}`;
  const singlePagePreviewWidthRatio = singlePagePreviewMode === 'print'
    ? PRINT_HALF_WIDTH / PRINT_SHEET_HEIGHT
    : PRINT_PAGE_WIDTH / PRINT_PAGE_HEIGHT;
  const pageLayoutStyle: StoryPanelCssProperties | undefined = hasSinglePageSidePanel
    ? {
      '--story-single-page-preview-aspect': singlePagePreviewAspect,
      '--story-single-page-width-ratio': singlePagePreviewWidthRatio,
    }
    : undefined;
  const visiblePages = pages.length === 0 ? [] : layoutMode === 'all-pages'
    ? pages
    : isSinglePageMode
    ? pages.slice(clampedPageIndex, clampedPageIndex + 1)
    : clampedPageIndex === 0 && coverPage && backCoverPage
      ? [coverPage, backCoverPage]
    : clampedPageIndex === 0
      ? [null, coverPage ?? pages[0]].filter((page, index) => index === 0 || Boolean(page))
      : interiorSpreadPages.slice(Math.max(0, clampedPageIndex - 1), Math.max(0, clampedPageIndex - 1) + 2);
  const selectedPanel = displayDocument.panels.find((panel) => panel.id === selectedPanelId) ?? null;
  const visiblePageIds = new Set(
    visiblePages.flatMap((page) => (page ? [page.id] : [])),
  );
  const visibleSelectedPanel = selectedPanel && visiblePageIds.has(selectedPanel.pageId) ? selectedPanel : null;
  const selectedPage = selectedPageId ? pages.find((page) => page.id === selectedPageId) ?? null : null;
  const selectedPageCanChangeOrder = isStoryPage(selectedPage);
  const storyPages = sortedStoryPages(pages);
  const storyPageNumberById = mapStoryPageNumbers(pages);
  const currentStoryPageNumbers = visiblePages
    .filter((page): page is StoryPanelDocument['pages'][number] => page !== null && page.pageKind === 'story')
    .map((page) => storyPageNumberById.get(page.id))
    .filter((pageNumber): pageNumber is number => typeof pageNumber === 'number');
  const isLastStoryPageInView = currentStoryPageNumbers.includes(storyPages.length);
  const currentPageLabel = layoutMode === 'spread' && clampedPageIndex === 0 && coverPage && backCoverPage
    ? 'F/B'
    : currentStoryPageNumbers.length > 1
      ? `${currentStoryPageNumbers[0]}-${currentStoryPageNumbers[currentStoryPageNumbers.length - 1]}`
      : currentStoryPageNumbers[0]?.toString() ?? fixedPageShortLabel(visiblePages.find(Boolean));
  const selectedStoryPageIndex = selectedPageId ? storyPages.findIndex((page) => page.id === selectedPageId) : -1;
  const pendingPageDelete = pendingPageDeleteId ? pages.find((page) => page.id === pendingPageDeleteId) ?? null : null;
  const pendingPageDeletePanelCount = pendingPageDeleteId
    ? displayDocument.panels.filter((panel) => panel.pageId === pendingPageDeleteId).length
    : 0;
  const pendingPanelDelete = pendingPanelDeleteId
    ? displayDocument.panels.find((panel) => panel.id === pendingPanelDeleteId) ?? null
    : null;
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
    if (layoutMode !== 'single' || !selectedPanel) {
      previousPageIndexRef.current = clampedPageIndex;
      return;
    }
    if (previousPageIndexRef.current === clampedPageIndex) return;
    previousPageIndexRef.current = clampedPageIndex;
    const currentPage = pages[clampedPageIndex];
    if (!currentPage || currentPage.id !== selectedPanel.pageId) {
      onSelectPanel(null);
    }
  }, [clampedPageIndex, layoutMode, onSelectPanel, pages, selectedPanel?.id, selectedPanel?.pageId]);
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
        <button type="button" className="secondary small-button" disabled={isSaving || undoStack.length === 0} onClick={undo} aria-label="Undo" title="Undo">
          <span aria-hidden="true">↩</span>
        </button>
        <button type="button" className="secondary small-button" disabled={isSaving || redoStack.length === 0} onClick={redo} aria-label="Redo" title="Redo">
          <span aria-hidden="true">↪</span>
        </button>
      </>,
    );
    return () => onHistoryControlsChange?.(null);
  }, [isSaving, onHistoryControlsChange, redoStack.length, undoStack.length]);
  useLayoutEffect(() => {
    if (!hasSinglePageSidePanel || !sideHeightSourceRef.current) {
      setSidePanelHeight(null);
      return;
    }
    const source = sideHeightSourceRef.current;
    const updateHeight = () => setSidePanelHeight(source.getBoundingClientRect().height);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(source);
    return () => observer.disconnect();
  }, [hasSinglePageSidePanel, clampedPageIndex, visiblePages.length]);
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
    if (isLastStoryPageInView) {
      const lastStoryPage = storyPages[storyPages.length - 1];
      if (!lastStoryPage) return;
      const nextDocument = createPageDocument(lastStoryPage.id);
      const insertedPageIndex = sortedPages(nextDocument).findIndex((page) => !pages.some((existingPage) => existingPage.id === page.id));
      commitDocument(nextDocument);
      setCurrentPageIndex(insertedPageIndex >= 0 ? insertedPageIndex : pages.findIndex((page) => page.id === lastStoryPage.id));
      return;
    }
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
  const goNextExistingPage = () => {
    const nextPageIndex = layoutMode === 'spread'
      ? clampedPageIndex === 0 ? 1 : clampedPageIndex + 2
      : clampedPageIndex + 1;
    const lastPageIndex = layoutMode === 'spread' ? lastSpreadStartIndex : pages.length - 1;
    if (nextPageIndex <= lastPageIndex) {
      setCurrentPageIndex(nextPageIndex);
    }
  };
  const selectedPageIndex = selectedPageId ? pages.findIndex((page) => page.id === selectedPageId) : -1;
  const addPageAfterSelected = () => {
    const anchorId = selectedPageCanChangeOrder ? selectedPageId : null;
    if (!anchorId) return;
    const nextDocument = createPageDocument(anchorId);
    const anchorIndex = sortedPages(nextDocument).findIndex((page) => page.id === anchorId);
    const insertedPage = sortedPages(nextDocument)[Math.max(0, anchorIndex + 1)];
    commitDocument(nextDocument);
    setSelectedPageId(insertedPage?.id ?? null);
  };
  const requestDeleteSelectedPage = () => {
    if (!selectedPageId || !selectedPageCanChangeOrder || storyPages.length <= 1) return;
    setPendingPageDeleteId(selectedPageId);
  };
  useEffect(() => {
    if (layoutMode !== 'all-pages') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableShortcutTarget(event.target)) return;
      if (event.key.toLowerCase() !== 'd') return;
      event.preventDefault();
      requestDeleteSelectedPage();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [layoutMode, selectedPageId, selectedPageCanChangeOrder, storyPages.length]);
  useEffect(() => {
    if (layoutMode !== 'single') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableShortcutTarget(event.target)) return;
      if (event.key.toLowerCase() !== 'd') return;
      if (!visibleSelectedPanel || isSaving || pendingPanelDeleteId) return;
      event.preventDefault();
      requestDeleteSelectedPanel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSaving, layoutMode, pendingPanelDeleteId, visibleSelectedPanel?.id]);
  const confirmDeleteSelectedPage = () => {
    const pageId = pendingPageDeleteId;
    const page = pages.find((candidate) => candidate.id === pageId);
    if (!pageId || !isStoryPage(page) || storyPages.length <= 1) return;
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
    if (!selectedPageId || !selectedPageCanChangeOrder || selectedStoryPageIndex < 0) return;
    const targetStoryPage = storyPages[selectedStoryPageIndex + direction];
    if (!targetStoryPage) return;
    const targetIndex = pages.findIndex((page) => page.id === targetStoryPage.id);
    if (selectedPageIndex < 0 || targetIndex < 0) return;
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
  useEffect(() => {
    if (!isPageLayoutMode || layoutMode === 'all-pages') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableShortcutTarget(event.target)) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goPrevious();
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goNextExistingPage();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPageLayoutMode, layoutMode, clampedPageIndex, pages.length, isSaving]);
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
  const requestDeleteSelectedPanel = () => {
    if (!visibleSelectedPanel || isSaving) return;
    setPendingPanelDeleteId(visibleSelectedPanel.id);
  };
  const confirmDeleteSelectedPanel = () => {
    const panelId = pendingPanelDeleteId;
    if (!panelId) return;
    commitDocument({
      ...displayDocument,
      panels: displayDocument.panels.filter((panel) => panel.id !== panelId),
    });
    setPendingPanelDeleteId(null);
    onSelectPanel(null);
  };
  const commitCustomTextDraft = () => {
    if (!selectedPanel || customTextDraft === null || customTextDraft === (selectedPanel.customText ?? '')) return;
    updateSelectedPanel({ customText: customTextDraft });
  };
  const jumpToPage = (value: number) => {
    if (!Number.isFinite(value)) return;
    const targetStoryPage = storyPages[Math.min(Math.max(Math.trunc(value) - 1, 0), Math.max(0, storyPages.length - 1))];
    if (!targetStoryPage) return;
    const pageIndex = pages.findIndex((page) => page.id === targetStoryPage.id);
    if (pageIndex < 0) return;
    if (layoutMode === 'spread') {
      const interiorIndex = interiorSpreadPages.findIndex((page) => page.id === targetStoryPage.id);
      const spreadInteriorIndex = interiorIndex <= 1 ? 0 : interiorIndex % 2 === 0 ? interiorIndex : interiorIndex - 1;
      const spreadPage = interiorSpreadPages[spreadInteriorIndex];
      const spreadPageIndex = pages.findIndex((page) => page.id === spreadPage?.id);
      setCurrentPageIndex(spreadPageIndex >= 0 ? spreadPageIndex : pageIndex);
      return;
    }
    setCurrentPageIndex(pageIndex);
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
  const singlePrintSlotForPage = (page: StoryPanelDocument['pages'][number] | null, fallbackIndex: number) => {
    const pageIndex = page ? pages.findIndex((candidate) => candidate.id === page.id) : fallbackIndex;
    return pageIndex >= 0 && pageIndex % 2 === 0 ? 'left' : 'right';
  };
  const singlePrintFrameStyle = (printSlot: 'left' | 'right'): CSSProperties => ({
    gridTemplateColumns: printSlot === 'left'
      ? `${PRINT_OUTER_MARGIN}fr ${PRINT_PAGE_WIDTH}fr ${PRINT_INNER_GUTTER}fr`
      : `${PRINT_INNER_GUTTER}fr ${PRINT_PAGE_WIDTH}fr ${PRINT_OUTER_MARGIN}fr`,
    gridTemplateRows: PRINT_SHEET_GRID_ROWS,
  });
  const renderSinglePagePreviewFrame = (
    page: StoryPanelDocument['pages'][number] | null,
    fallbackIndex: number,
    grid: ReactNode,
  ) => {
    if (!hasSinglePageSidePanel) return grid;
    const printSlot = singlePrintSlotForPage(page, fallbackIndex);
    return (
      <div
        className={`story-panels-single-page-preview is-${singlePagePreviewMode} is-print-slot-${printSlot}`}
        style={singlePagePreviewMode === 'print' ? singlePrintFrameStyle(printSlot) : undefined}
      >
        {grid}
      </div>
    );
  };
  useEffect(() => {
    if (!isPageLayoutMode) {
      onPageControlsChange?.(null);
      return;
    }
    onPageControlsChange?.(
      <div className="story-panels-page-nav" aria-label="Page navigation">
        {layoutMode === 'all-pages' ? (
          <>
            <button type="button" className="secondary" disabled={isSaving || !selectedPageCanChangeOrder || selectedStoryPageIndex <= 0} onClick={() => moveSelectedPage(-1)}>Move left</button>
            <button type="button" className="secondary" disabled={isSaving || !selectedPageCanChangeOrder || selectedStoryPageIndex < 0 || selectedStoryPageIndex >= storyPages.length - 1} onClick={() => moveSelectedPage(1)}>Move right</button>
            <button type="button" className="secondary" disabled={isSaving || !selectedPageCanChangeOrder} onClick={addPageAfterSelected}>Add story page after</button>
            <button type="button" className="secondary" disabled={isSaving || !selectedPageCanChangeOrder || storyPages.length <= 1} onClick={requestDeleteSelectedPage}>Delete page</button>
          </>
        ) : (
          <>
            <button type="button" className="secondary small-button" disabled={isSaving || clampedPageIndex <= 0} onClick={goPrevious} aria-label="Previous page" title="Previous page">
              <span aria-hidden="true">←</span>
            </button>
            <label className="story-panels-page-jump">
              <input
                type="text"
                inputMode="numeric"
                value={currentPageLabel}
                disabled={isSaving || storyPages.length === 0}
                aria-label="Current page"
                onChange={(event) => jumpToPage(Number(event.target.value))}
              />
              <span aria-hidden="true">/</span>
              <input type="text" value={Math.max(1, storyPages.length)} readOnly aria-label="Total story pages" />
            </label>
            <button
              type="button"
              className={isLastStoryPageInView ? 'secondary' : 'secondary small-button'}
              disabled={isSaving}
              onClick={goNext}
              aria-label={isLastStoryPageInView ? 'Add page' : 'Next page'}
              title={isLastStoryPageInView ? 'Add page' : 'Next page'}
            >
              {isLastStoryPageInView ? 'Add page' : <span aria-hidden="true">→</span>}
            </button>
            {hasSinglePageSidePanel && (
              <div className="story-panels-preview-toggle" role="group" aria-label="Single page preview mode">
                <button
                  type="button"
                  className={singlePagePreviewMode === 'readable' ? 'active' : ''}
                  onClick={() => setSinglePagePreviewMode('readable')}
                >
                  Readable area
                </button>
                <button
                  type="button"
                  className={singlePagePreviewMode === 'print' ? 'active' : ''}
                  onClick={() => setSinglePagePreviewMode('print')}
                >
                  Print preview
                </button>
              </div>
            )}
          </>
        )}
      </div>,
    );
    return () => onPageControlsChange?.(null);
  }, [
    clampedPageIndex,
    currentPageLabel,
    hasSinglePageSidePanel,
    isLastStoryPageInView,
    isPageLayoutMode,
    isSaving,
    layoutMode,
    onPageControlsChange,
    redoStack.length,
    selectedPageCanChangeOrder,
    selectedStoryPageIndex,
    singlePagePreviewMode,
    storyPages.length,
    undoStack.length,
  ]);

  return (
    <>
      {isPageLayoutMode && (
        <div
          className={`story-panels-layout-workspace is-${layoutMode} ${hasSinglePageSidePanel ? `is-single-preview-${singlePagePreviewMode}` : ''}`}
          style={pageLayoutStyle}
        >
        <div className="story-panels-pages">
        {visiblePages.length ? (
          layoutMode === 'spread' ? (
            <div className="story-panels-spread-wrap">
              <div className="story-panels-spread-labels" style={{ gridTemplateColumns: PRINT_SHEET_GRID_COLUMNS }}>
                {visiblePages.map((page, pageIndex) => (
                  <h3
                    key={page ? `${page.id}-label` : `spread-blank-label-${pageIndex}`}
                    className={`is-spread-slot-${pageIndex === 0 ? 'left' : 'right'}`}
                  >
                    {page ? (
                      <>
                        {page.title || page.id} <span>{pageKindLabel(page.pageKind)}</span>
                      </>
                    ) : (
                      'Intentionally Blank'
                    )}
                  </h3>
                ))}
              </div>
              <div
                className="story-panels-print-sheet"
                style={{
                  aspectRatio: PRINT_SHEET_ASPECT_RATIO,
                  gridTemplateColumns: PRINT_SHEET_GRID_COLUMNS,
                  gridTemplateRows: PRINT_SHEET_GRID_ROWS,
                }}
              >
              {visiblePages.map((page, pageIndex) => {
                const spreadSlot = pageIndex === 0 ? 'left' : 'right';
                if (!page) {
                  return (
                    <article
                      key={`spread-blank-${spreadSlot}`}
                      className={`story-panels-page is-blank is-spread-slot is-spread-slot-${spreadSlot}`}
                    >
                      <div className="story-panels-page-grid story-panels-blank-page">
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
                    className={`story-panels-page is-spread-slot is-spread-slot-${spreadSlot}`}
                  >
                    <div
                      ref={(element) => {
                        pageRefs.current[page.id] = element;
                      }}
                      className="story-panels-page-grid"
                      style={{ gridTemplateRows: `repeat(${pageRows}, minmax(22px, 1fr))` }}
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
                          onClick={() => onSelectPanel(panel.id)}
                          onDoubleClick={(event) => openPanelDetail(event, panel)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onPointerDown={(event) => beginDrag(event, panel, 'move')}
                        >
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
                        </button>
                      ))}
                    </div>
                  </article>
                );
              })}
              {visiblePages.map((page, pageIndex) => {
                const pageNumber = page ? storyPageNumberById.get(page.id) : undefined;
                if (!page || !pageNumber) return null;
                return (
                  <span
                    key={`${page.id}-spread-page-number`}
                    className={`story-panels-print-page-number is-spread-slot-${pageIndex === 0 ? 'left' : 'right'}`}
                  >
                    {pageNumber}
                  </span>
                );
              })}
              {visiblePages.length > 1 && <div className="story-panels-print-gutter" aria-hidden="true" />}
              </div>
            </div>
          ) : (
            visiblePages.map((page, pageIndex) => {
          if (!page) {
            return (
            <article
              key="intentional-blank-start"
              ref={(element) => {
                if (hasSinglePageSidePanel && pageIndex === 0) sideHeightSourceRef.current = element;
              }}
              className={`story-panels-page is-blank ${layoutMode === 'all-pages' && selectedPageId === null ? 'is-page-selected' : ''}`}
            >
                <h3>Intentionally Blank</h3>
                {renderSinglePagePreviewFrame(
                  null,
                  clampedPageIndex,
                  <div
                    className="story-panels-page-grid story-panels-blank-page"
                    style={layoutMode === 'all-pages' ? { aspectRatio: comicPageAspectRatio } : undefined}
                  >
                    <p>This page intentionally left blank.</p>
                  </div>,
                )}
              </article>
            );
          }
          const pagePanels = sortedPanelsForPage(displayDocument, page.id);
          const pageRows = Math.max(10, ...pagePanels.map((panel) => panel.rect.y + panel.rect.h));
          return (
            <article
              key={`${page.id}-${pageIndex}`}
              ref={(element) => {
                if (hasSinglePageSidePanel && pageIndex === 0) sideHeightSourceRef.current = element;
              }}
              className={`story-panels-page ${layoutMode === 'all-pages' && selectedPageId === page.id ? 'is-page-selected' : ''}`}
              onClick={() => setSelectedPageId(page.id)}
              onDoubleClick={layoutMode === 'all-pages' ? () => openPageDetail(page.id) : undefined}
            >
              <h3>{page.title || page.id} <span>{pageKindLabel(page.pageKind)}</span></h3>
              {renderSinglePagePreviewFrame(
                page,
                pageIndex,
                <div
                  ref={(element) => {
                    pageRefs.current[page.id] = element;
                  }}
                  className="story-panels-page-grid"
                  style={{
                    ...(layoutMode === 'all-pages' ? { aspectRatio: comicPageAspectRatio } : {}),
                    gridTemplateRows: `repeat(${pageRows}, minmax(22px, 1fr))`,
                  }}
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
                </div>,
              )}
            </article>
          );
        })
          )
        ) : <p className="muted">No pages yet.</p>}
        </div>
        {layoutMode === 'single' && (
          <aside className="story-panels-info-panel" style={sidePanelHeight ? { height: sidePanelHeight } : undefined}>
            {visibleSelectedPanel ? (
              <>
                <div className="story-panels-info-head">
                  <h3>Selected Panel</h3>
                  <button type="button" className="danger" disabled={isSaving} onClick={requestDeleteSelectedPanel}>
                    Delete
                  </button>
                </div>
                <div className="story-panels-info-control">
                  <span>Panel kind</span>
                  <div className="story-panels-kind-toggle" role="tablist" aria-label="Panel kind">
                    <button
                      type="button"
                      className={visibleSelectedPanel.panelKind === 'image' ? 'active' : ''}
                      role="tab"
                      aria-selected={visibleSelectedPanel.panelKind === 'image'}
                      disabled={isSaving}
                      onClick={() => updateSelectedPanel({ panelKind: 'image' })}
                    >
                      Image panel
                    </button>
                    <button
                      type="button"
                      className={visibleSelectedPanel.panelKind === 'text' ? 'active' : ''}
                      role="tab"
                      aria-selected={visibleSelectedPanel.panelKind === 'text'}
                      disabled={isSaving}
                      onClick={() => updateSelectedPanel({ panelKind: 'text' })}
                    >
                      Text / caption
                    </button>
                  </div>
                </div>
                <label>
                  {visibleSelectedPanel.sourceKind === 'story' ? `Passage text (${visibleSelectedPanel.startOffset} to ${visibleSelectedPanel.endOffset})` : 'Passage text'}
                  <textarea
                    value={visibleSelectedPanel.sourceKind === 'story' ? visibleSelectedPanel.selectedText : ''}
                    rows={5}
                    readOnly
                    disabled={visibleSelectedPanel.sourceKind !== 'story'}
                    placeholder={visibleSelectedPanel.sourceKind !== 'story' ? 'No source passage for this free layout item' : undefined}
                  />
                </label>
                {visibleSelectedPanel.panelKind === 'text' && (
                  <label>
                    Caption text
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
      {pendingPanelDelete && (
        <div className="confirm-backdrop" onClick={() => setPendingPanelDeleteId(null)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-story-panel-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="delete-story-panel-title">
              Delete {pendingPanelDelete.sourceKind === 'story'
                ? `Panel ${storyPanelNumberById.get(pendingPanelDelete.id) ?? ''}`
                : pendingPanelDelete.panelKind === 'text' ? 'text block' : 'image block'}?
            </h2>
            <p>
              {pendingPanelDelete.sourceKind === 'story'
                ? 'This will remove the panel chunk and its page layout placement. This can be undone from the header.'
                : 'This will remove the layout item from the page. This can be undone from the header.'}
            </p>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setPendingPanelDeleteId(null)}>Cancel</button>
              <button type="button" className="danger" disabled={isSaving} onClick={confirmDeleteSelectedPanel}>Delete panel</button>
            </div>
          </div>
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
