import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { nonArchivedVariants } from '../canvas/shared';
import type { Asset, CanvasDocument, StoryPanel, StoryPanelDocument, StoryPanelImageCrop, StoryPanelRect, StoryPanelTextStyle, TagDefinition } from '../types';
import { assetThumbnailUrl } from './panelImageAssets';
import {
  focalFromPanDelta,
  imageCropForPanel,
  isDefaultImageCrop,
  panelImageCropStyle,
} from './panelImageCrop';
import {
  enforceLockedAspectOnResize,
  formatAspectRatioFromPixels,
  GEMINI_IMAGE_ASPECT_RATIOS,
  LAYOUT_PAGE_ROWS,
  loadImageDimensions,
  pageRowsForPanels,
  panelVisualAspectRatio,
  parseAspectRatio,
  snapRectToAspectRatio,
} from './panelAspectRatio';
import { PanelImagePicker } from './PanelImagePicker';
import {
  CAPTION_COLOR_PRESETS,
  captionPanelCssProperties,
  captionPanelClassName,
  captionSpeechKindFor,
  captionStyleForPanel,
  captionBackgroundForSpeech,
  defaultCaptionTextStyle,
  fitCaptionHeightRows,
} from './captionPanelStyle';
import {
  captionLabel,
  captionPanelsFor,
  CAPTION_GRID_SNAP,
  clampCaptionRect,
  defaultCaptionRect,
  imageInfoHostFor,
  panelKindHostFor,
  parentPanelFor,
  removePanelAndCaptionChildren,
} from './panelCaptions';
import { removeStoryPanelFromLayout } from './panelPlacement';
import { inferDocumentChangeLabel, type StoryPanelHistoryEntry } from './storyPanelHistory';
import { sortedStoryPages, storyPageNumberById as mapStoryPageNumbers } from './pageNumbers';
import { HoverTooltip } from '../ui';
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

export type StoryPanelLayoutMode = 'spread' | 'single' | 'single-chunks' | 'all-pages';

const gridColumns = 12;
const minPanelHeight = 2;
const minPanelWidth = 2;
const minTextPanelHeight = 0.5;
const minTextPanelWidth = 0.75;
const panelSnapScale = 4;
const comicPageAspectRatio = '5.5 / 8.5';
const defaultTextStyle: StoryPanelTextStyle = { fontFamily: 'serif', fontSize: 8, align: 'left' };
const textFontFamilies: Record<StoryPanelTextStyle['fontFamily'], string> = {
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  comic: '"Comic Sans MS", "Comic Sans", cursive',
};

type SinglePagePreviewMode = 'readable' | 'print';
const SINGLE_PAGE_PREVIEW_MODE_KEY = 'story-panels-single-page-preview-mode';

function readSinglePagePreviewMode(): SinglePagePreviewMode {
  try {
    const stored = localStorage.getItem(SINGLE_PAGE_PREVIEW_MODE_KEY);
    if (stored === 'readable' || stored === 'print') return stored;
  } catch {
    // Ignore storage read failures in private browsing or restricted contexts.
  }
  return 'print';
}

function writeSinglePagePreviewMode(mode: SinglePagePreviewMode) {
  try {
    localStorage.setItem(SINGLE_PAGE_PREVIEW_MODE_KEY, mode);
  } catch {
    // Ignore storage write failures.
  }
}

function TrashIcon() {
  return (
    <svg className="story-panels-trash-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M3 4.5h10" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M6 4.5V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M5 4.5l.5 8a1 1 0 0 0 1 .9h3a1 1 0 0 0 1-.9l.5-8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M7 7v4M9 7v4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function StyleIcon() {
  return (
    <svg className="story-panels-style-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        d="M8 1.75l1.35 2.74 3.02.44-2.19 2.13.52 3.01L8 8.98 5.3 10.07l.52-3.01-2.19-2.13 3.02-.44L8 1.75z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M3.5 13.25h9" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}
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

type PageContextMenu =
  | {
    kind: 'page';
    x: number;
    y: number;
    pageId: string;
    rect: StoryPanelRect;
  }
  | {
    kind: 'panel';
    x: number;
    y: number;
    panelId: string;
  };

type CropDragState = {
  panelId: string;
  startClientX: number;
  startClientY: number;
  startCrop: StoryPanelImageCrop;
  panelWidth: number;
  panelHeight: number;
};

function plainTextToRichText(value: string) {
  const doc = document.implementation.createHTMLDocument('');
  const container = doc.createElement('div');
  value.split(/\n/).forEach((line, index) => {
    if (index > 0) container.appendChild(doc.createElement('br'));
    container.appendChild(doc.createTextNode(line));
  });
  return container.innerHTML;
}

function sanitizeRichText(value: string) {
  const doc = document.implementation.createHTMLDocument('');
  const template = doc.createElement('template');
  template.innerHTML = value;
  const output = doc.createElement('div');
  const appendClean = (node: Node, parent: HTMLElement) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(doc.createTextNode(node.textContent ?? ''));
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tagName = node.tagName.toLowerCase();
    if (tagName === 'br') {
      parent.appendChild(doc.createElement('br'));
      return;
    }
    const mappedTag = tagName === 'b' || tagName === 'strong'
      ? 'strong'
      : tagName === 'i' || tagName === 'em'
        ? 'em'
        : tagName === 'u'
          ? 'u'
          : tagName === 'div' || tagName === 'p'
            ? 'div'
            : '';
    const nextParent = mappedTag ? doc.createElement(mappedTag) : parent;
    Array.from(node.childNodes).forEach((child) => appendClean(child, nextParent));
    if (mappedTag) parent.appendChild(nextParent);
  };
  Array.from(template.content.childNodes).forEach((node) => appendClean(node, output));
  return output.innerHTML.trim();
}

function richTextToPlainText(value: string) {
  const doc = document.implementation.createHTMLDocument('');
  const element = doc.createElement('div');
  element.innerHTML = sanitizeRichText(value);
  return element.textContent ?? '';
}

function richTextForPanel(panel: StoryPanel, draft: string | null = null) {
  if (draft !== null) return draft;
  if (panel.richText) return panel.richText;
  return plainTextToRichText(panel.customText || panel.selectedText);
}

function textStyleForPanel(panel: StoryPanel): StoryPanelTextStyle {
  return { ...defaultTextStyle, ...(panel.textStyle ?? {}) };
}

function textPanelCssProperties(
  panel: StoryPanel,
  styleOverride?: Partial<StoryPanelTextStyle>,
  mode: 'canvas' | 'editor' = 'canvas',
): StoryPanelCssProperties {
  const textStyle = { ...textStyleForPanel(panel), ...styleOverride };
  const base = {
    fontFamily: textFontFamilies[textStyle.fontFamily],
    textAlign: textStyle.align,
  };
  if (mode === 'editor') {
    return { ...base, fontSize: textStyle.fontSize };
  }
  return {
    ...base,
    '--story-text-panel-font-size': `${(textStyle.fontSize / 360) * 100}cqw`,
  };
}

function textStyleOverrideFromFontSizeInput(
  panel: StoryPanel,
  selectedPanelId: string | null,
  fontSizeInput: string | null,
): Partial<StoryPanelTextStyle> | undefined {
  if (panel.id !== selectedPanelId || fontSizeInput === null) return undefined;
  const parsed = Number(fontSizeInput);
  if (!Number.isFinite(parsed)) return undefined;
  return { fontSize: Math.min(48, Math.max(6, Math.trunc(parsed))) };
}

function panelCanvasTextStyle(
  panel: StoryPanel,
  selectedPanelId: string | null,
  fontSizeInput: string | null,
): StoryPanelCssProperties {
  const override = textStyleOverrideFromFontSizeInput(panel, selectedPanelId, fontSizeInput);
  const base = textPanelCssProperties(panel, override);
  if (panel.sourceKind !== 'caption') return base;
  return { ...base, ...captionPanelCssProperties(panel) };
}

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
  let h = Math.max(minHeight, roundStep(rect.h, panelSnapScale));
  h = Math.min(h, LAYOUT_PAGE_ROWS);
  const x = Math.min(gridColumns - w, Math.max(0, roundStep(rect.x, panelSnapScale)));
  let y = Math.max(0, roundStep(rect.y, panelSnapScale));
  y = Math.min(y, LAYOUT_PAGE_ROWS - h);
  return { x, y, w, h };
}

function clampPanelRect(rect: StoryPanelRect, panel: Pick<StoryPanel, 'panelKind' | 'sourceKind'>): StoryPanelRect {
  if (panel.sourceKind === 'caption') return clampCaptionRect(rect);
  return clampRect(rect, panel.panelKind);
}

function resizeRectFromCorner(rect: StoryPanelRect, corner: ResizeCorner, deltaColumns: number, deltaRows: number, panel: Pick<StoryPanel, 'panelKind' | 'sourceKind'>): StoryPanelRect {
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  const minWidth = panel.sourceKind === 'caption' ? 0.5 : panel.panelKind === 'text' ? minTextPanelWidth : minPanelWidth;
  const minHeight = panel.sourceKind === 'caption' ? 0.25 : panel.panelKind === 'text' ? minTextPanelHeight : minPanelHeight;
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
  return clampPanelRect({ x, y, w, h }, panel);
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
  spreadPanelInfoEnabled = true,
  assets,
  projectTags,
  canvas,
  projectSlug,
  navigateToPanelId,
  onNavigateToPanelComplete,
}: {
  document: StoryPanelDocument;
  selectedPanelId: string | null;
  layoutMode: StoryPanelLayoutMode;
  onSelectPanel: (panelId: string | null) => void;
  onSaveDocument: (document: StoryPanelDocument) => void;
  isSaving: boolean;
  sidePanel?: ReactNode;
  onLayoutModeChange?: (layoutMode: StoryPanelLayoutMode) => void;
  onHistoryControlsChange?: (controls: ReactNode) => void;
  onPageControlsChange?: (controls: ReactNode) => void;
  spreadPanelInfoEnabled?: boolean;
  assets: Asset[];
  projectTags: TagDefinition[];
  canvas: CanvasDocument;
  projectSlug: string;
  navigateToPanelId?: string | null;
  onNavigateToPanelComplete?: () => void;
}) {
  const pageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const sideHeightSourceRef = useRef<HTMLElement | null>(null);
  const previousPageIndexRef = useRef(0);
  const richTextEditorRef = useRef<HTMLDivElement | null>(null);
  const customTextDraftRef = useRef<string | null>(null);
  const displayDocumentRef = useRef<StoryPanelDocument>(document);
  const draftDocumentRef = useRef<StoryPanelDocument | null>(null);
  const richTextEditingPanelIdRef = useRef<string | null>(null);
  const infoPanelBodyRef = useRef<HTMLDivElement | null>(null);
  const spreadWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const zoomDragPanelIdRef = useRef<string | null>(null);
  const persistPanelTextDraftRef = useRef<(panelId: string, draftHtml: string | null | undefined) => void>(() => {});
  const [draftDocument, setDraftDocument] = useState<StoryPanelDocument | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [cropDragState, setCropDragState] = useState<CropDragState | null>(null);
  const [cropModePanelId, setCropModePanelId] = useState<string | null>(null);
  const [pageMenu, setPageMenu] = useState<PageContextMenu | null>(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [pendingPageDeleteId, setPendingPageDeleteId] = useState<string | null>(null);
  const [pendingPanelDeleteId, setPendingPanelDeleteId] = useState<string | null>(null);
  const [pendingCaptionDeleteId, setPendingCaptionDeleteId] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<StoryPanelHistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<StoryPanelHistoryEntry[]>([]);
  const [customTextDraft, setCustomTextDraft] = useState<string | null>(null);
  const [fontSizeInput, setFontSizeInput] = useState<string | null>(null);
  const [singlePagePreviewMode, setSinglePagePreviewMode] = useState<SinglePagePreviewMode>(readSinglePagePreviewMode);
  const selectSinglePagePreviewMode = (mode: SinglePagePreviewMode) => {
    setSinglePagePreviewMode(mode);
    writeSinglePagePreviewMode(mode);
  };
  const [sidePanelHeight, setSidePanelHeight] = useState<number | null>(null);
  const [flashingPanelId, setFlashingPanelId] = useState<string | null>(null);
  const [pickerPanelId, setPickerPanelId] = useState<string | null>(null);
  const [ratioPopoverOpen, setRatioPopoverOpen] = useState(false);
  const [captionStylePopoverId, setCaptionStylePopoverId] = useState<string | null>(null);
  const [captionFontSizeDraft, setCaptionFontSizeDraft] = useState<{ captionId: string; value: string } | null>(null);
  const [isSnappingAspect, setIsSnappingAspect] = useState(false);
  const [captionTextDrafts, setCaptionTextDrafts] = useState<Record<string, string>>({});
  const [infoPopoverAnchor, setInfoPopoverAnchor] = useState<'left' | 'right'>('right');
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const displayDocument = draftDocument ?? document;
  displayDocumentRef.current = displayDocument;
  draftDocumentRef.current = draftDocument;
  customTextDraftRef.current = customTextDraft;
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
  const isSinglePageMode = layoutMode !== 'spread';
  const hasSinglePageSidePanel = layoutMode === 'single' || layoutMode === 'single-chunks';
  const showsSelectedPanelInfo = layoutMode === 'single' || (layoutMode === 'spread' && spreadPanelInfoEnabled);
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
  const visibleSelectedPanel = selectedPanel && selectedPanel.pageId && visiblePageIds.has(selectedPanel.pageId) ? selectedPanel : null;
  const panelKindHost = panelKindHostFor(displayDocument, visibleSelectedPanel);
  const imageInfoHost = imageInfoHostFor(displayDocument, visibleSelectedPanel);
  const captionHostPanel = imageInfoHost;
  const childCaptions = captionHostPanel ? captionPanelsFor(displayDocument, captionHostPanel.id) : [];
  const selectedPage = selectedPageId ? pages.find((page) => page.id === selectedPageId) ?? null : null;
  const selectedPageCanChangeOrder = isStoryPage(selectedPage);
  const storyPages = sortedStoryPages(pages);
  const storyPageNumberById = mapStoryPageNumbers(pages);
  const currentStoryPageNumbers = visiblePages
    .filter((page): page is StoryPanelDocument['pages'][number] => page !== null && page.pageKind === 'story')
    .map((page) => storyPageNumberById.get(page.id))
    .filter((pageNumber): pageNumber is number => typeof pageNumber === 'number');
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
  const pendingCaptionDelete = pendingCaptionDeleteId
    ? displayDocument.panels.find((panel) => panel.id === pendingCaptionDeleteId) ?? null
    : null;
  const storyPanelNumberById = new Map(
    displayDocument.panels
      .filter((panel) => panel.sourceKind === 'story')
      .sort((a, b) => storyOffset(a) - storyOffset(b) || a.order - b.order)
      .map((panel, index) => [panel.id, index + 1]),
  );
  const persistPanelTextDraft = (panelId: string, draftHtml: string | null | undefined) => {
    if (draftHtml == null) return;
    const doc = displayDocumentRef.current;
    const panel = doc.panels.find((candidate) => candidate.id === panelId);
    if (!panel || panel.panelKind !== 'text') return;
    const nextRichText = sanitizeRichText(draftHtml);
    const currentRichText = panel.richText || plainTextToRichText(panel.customText || panel.selectedText);
    if (nextRichText === currentRichText) return;
    const nextDocument = {
      ...doc,
      panels: doc.panels.map((candidate) => (
        candidate.id === panelId
          ? { ...candidate, richText: nextRichText, customText: richTextToPlainText(nextRichText) }
          : candidate
      )),
    };
    setDraftDocument(nextDocument);
    setUndoStack((current) => [...current, { document: doc, label: 'Edit text' }]);
    setRedoStack([]);
    onSaveDocument(nextDocument);
  };
  persistPanelTextDraftRef.current = persistPanelTextDraft;
  useEffect(() => {
    if (!pageMenu) return;
    const close = () => setPageMenu(null);
    window.document.addEventListener('pointerdown', close);
    return () => window.document.removeEventListener('pointerdown', close);
  }, [pageMenu]);
  useEffect(() => {
    setRatioPopoverOpen(false);
    setCaptionStylePopoverId(null);
    setCaptionFontSizeDraft(null);
  }, [selectedPanelId]);
  useEffect(() => {
    if (cropModePanelId && selectedPanelId !== cropModePanelId) {
      setCropModePanelId(null);
    }
  }, [selectedPanelId, cropModePanelId]);
  useLayoutEffect(() => {
    if (layoutMode !== 'single' && layoutMode !== 'spread') return;
    if (visibleSelectedPanel?.sourceKind !== 'caption') return;
    infoPanelBodyRef.current?.scrollTo({ top: 0 });
  }, [layoutMode, visibleSelectedPanel?.id, visibleSelectedPanel?.sourceKind]);
  const updateInfoPopoverAnchor = useCallback(() => {
    if (layoutMode !== 'spread' || !visibleSelectedPanel) return;
    const workspace = spreadWorkspaceRef.current;
    const panelEl = workspace?.querySelector('.story-panels-page-panel.is-selected');
    if (!workspace || !(panelEl instanceof HTMLElement)) {
      setInfoPopoverAnchor('right');
      return;
    }
    const workspaceRect = workspace.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    const panelCenterX = panelRect.left + panelRect.width / 2;
    const workspaceCenterX = workspaceRect.left + workspaceRect.width / 2;
    setInfoPopoverAnchor(panelCenterX < workspaceCenterX ? 'right' : 'left');
  }, [layoutMode, visibleSelectedPanel?.id, visibleSelectedPanel?.rect]);
  useLayoutEffect(() => {
    if (layoutMode !== 'spread' || !visibleSelectedPanel) return;
    updateInfoPopoverAnchor();
    const workspace = spreadWorkspaceRef.current;
    if (!workspace) return;
    const observer = new ResizeObserver(updateInfoPopoverAnchor);
    observer.observe(workspace);
    const panelEl = workspace.querySelector('.story-panels-page-panel.is-selected');
    if (panelEl instanceof HTMLElement) observer.observe(panelEl);
    window.addEventListener('resize', updateInfoPopoverAnchor);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateInfoPopoverAnchor);
    };
  }, [layoutMode, visibleSelectedPanel?.id, visibleSelectedPanel?.rect, clampedPageIndex, dragState, updateInfoPopoverAnchor]);
  useEffect(() => {
    if (!ratioPopoverOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('.story-panels-info-aspect-popover-wrap')) return;
      setRatioPopoverOpen(false);
    };
    window.document.addEventListener('mousedown', close, true);
    return () => window.document.removeEventListener('mousedown', close, true);
  }, [ratioPopoverOpen]);
  useEffect(() => {
    if (!captionStylePopoverId) return;
    const close = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('.story-panels-info-caption-style-wrap')) return;
      setCaptionStylePopoverId(null);
    };
    window.document.addEventListener('mousedown', close, true);
    return () => window.document.removeEventListener('mousedown', close, true);
  }, [captionStylePopoverId]);
  useEffect(() => {
    if (!captionStylePopoverId) setCaptionFontSizeDraft(null);
  }, [captionStylePopoverId]);
  useLayoutEffect(() => {
    const previousPanelId = richTextEditingPanelIdRef.current;
    const activePanelId = showsSelectedPanelInfo && visibleSelectedPanel?.panelKind === 'text' && visibleSelectedPanel.sourceKind !== 'caption'
      ? visibleSelectedPanel.id
      : null;

    if (previousPanelId && previousPanelId !== activePanelId) {
      persistPanelTextDraft(
        previousPanelId,
        customTextDraftRef.current ?? richTextEditorRef.current?.innerHTML,
      );
    }

    if (!showsSelectedPanelInfo || !visibleSelectedPanel || visibleSelectedPanel.panelKind !== 'text' || visibleSelectedPanel.sourceKind === 'caption') {
      if (!visibleSelectedPanel || visibleSelectedPanel.panelKind !== 'text' || visibleSelectedPanel.sourceKind === 'caption') {
        setCustomTextDraft(null);
      }
      richTextEditingPanelIdRef.current = activePanelId;
      return;
    }
    const nextDraft = richTextForPanel(visibleSelectedPanel);
    setCustomTextDraft(nextDraft);
    richTextEditingPanelIdRef.current = activePanelId;
    const editor = richTextEditorRef.current;
    if (!editor || window.document.activeElement === editor) return;
    const nextHtml = sanitizeRichText(nextDraft);
    if (editor.innerHTML !== nextHtml) {
      editor.innerHTML = nextHtml;
    }
  }, [
    layoutMode,
    visibleSelectedPanel?.id,
    visibleSelectedPanel?.panelKind,
    visibleSelectedPanel?.richText,
    visibleSelectedPanel?.customText,
  ]);
  useEffect(() => {
    if (!showsSelectedPanelInfo || !visibleSelectedPanel || visibleSelectedPanel.panelKind !== 'text') return;
    if (customTextDraft === null) return;
    const panelId = visibleSelectedPanel.id;
    const timer = window.setTimeout(() => {
      persistPanelTextDraftRef.current(
        panelId,
        customTextDraftRef.current ?? richTextEditorRef.current?.innerHTML,
      );
    }, 600);
    return () => window.clearTimeout(timer);
  }, [customTextDraft, showsSelectedPanelInfo, visibleSelectedPanel?.id, visibleSelectedPanel?.panelKind]);
  useEffect(() => {
    return () => {
      const panelId = richTextEditingPanelIdRef.current;
      if (!panelId) return;
      persistPanelTextDraftRef.current(
        panelId,
        customTextDraftRef.current ?? richTextEditorRef.current?.innerHTML,
      );
    };
  }, []);
  useEffect(() => {
    setFontSizeInput(null);
  }, [selectedPanel?.id]);
  useEffect(() => {
    if (dragState || isSaving) return;
    setDraftDocument(null);
  }, [document, dragState, isSaving]);
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
    if (!selectedPanel || layoutMode === 'all-pages' || layoutMode === 'single-chunks') return;
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
  }, [layoutMode, selectedPanel?.id, selectedPanel?.pageId]);
  useEffect(() => {
    if (!navigateToPanelId) return;
    const panel = displayDocument.panels.find((candidate) => candidate.id === navigateToPanelId);
    if (!panel) {
      onNavigateToPanelComplete?.();
      return;
    }
    const pageIndex = pages.findIndex((page) => page.id === panel.pageId);
    if (pageIndex >= 0) {
      setCurrentPageIndex(layoutMode === 'spread' ? pageIndex === 0 ? 0 : pageIndex % 2 === 0 ? pageIndex - 1 : pageIndex : pageIndex);
    }
    setFlashingPanelId(null);
    const start = window.setTimeout(() => setFlashingPanelId(panel.id), 0);
    const stop = window.setTimeout(() => setFlashingPanelId((current) => (current === panel.id ? null : current)), 1400);
    onNavigateToPanelComplete?.();
    return () => {
      window.clearTimeout(start);
      window.clearTimeout(stop);
    };
  }, [displayDocument.panels, layoutMode, navigateToPanelId, onNavigateToPanelComplete, pages]);
  useEffect(() => {
    const undoEntry = undoStack[undoStack.length - 1];
    const redoEntry = redoStack[redoStack.length - 1];
    onHistoryControlsChange?.(
      <>
        <HoverTooltip text={undoEntry ? `Undo: ${undoEntry.label}` : 'Undo'} placement="bottom">
          <button type="button" className="secondary small-button" disabled={isSaving || undoStack.length === 0} onClick={undo} aria-label={undoEntry ? `Undo ${undoEntry.label}` : 'Undo'}>
            <span aria-hidden="true">↩</span>
          </button>
        </HoverTooltip>
        <HoverTooltip text={redoEntry ? `Redo: ${redoEntry.label}` : 'Redo'} placement="bottom">
          <button type="button" className="secondary small-button" disabled={isSaving || redoStack.length === 0} onClick={redo} aria-label={redoEntry ? `Redo ${redoEntry.label}` : 'Redo'}>
            <span aria-hidden="true">↪</span>
          </button>
        </HoverTooltip>
      </>,
    );
    return () => onHistoryControlsChange?.(null);
  }, [isSaving, onHistoryControlsChange, redoStack, undoStack]);
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
  const createPageDocument = (afterPageId?: string, count = 1) => {
    const insertionIndex = afterPageId ? pages.findIndex((page) => page.id === afterPageId) + 1 : displayDocument.pages.length;
    const ids = new Set(displayDocument.pages.map((page) => page.id));
    let nextPageIndex = displayDocument.pages.length + 1;
    const storyPageCount = pages.filter((candidate) => candidate.pageKind === 'story').length;
    const newPages = Array.from({ length: count }, (_, offset): StoryPanelDocument['pages'][number] => {
      while (ids.has(`page-${String(nextPageIndex).padStart(3, '0')}`)) nextPageIndex += 1;
      const id = `page-${String(nextPageIndex).padStart(3, '0')}`;
      ids.add(id);
      nextPageIndex += 1;
      return {
        id,
        order: insertionIndex + offset,
        title: `Page ${storyPageCount + offset + 1}`,
        pageKind: 'story',
      };
    });
    const nextPages = [...pages];
    nextPages.splice(insertionIndex < 0 ? pages.length : insertionIndex, 0, ...newPages);
    return {
      ...displayDocument,
      pages: nextPages.map((candidate, index) => ({ ...candidate, order: index })),
    };
  };
  const pushHistory = (beforeDocument: StoryPanelDocument, label: string) => {
    setUndoStack((current) => [...current, { document: beforeDocument, label }]);
    setRedoStack([]);
  };
  const commitDocument = (nextDocument: StoryPanelDocument, label?: string) => {
    pushHistory(displayDocument, label ?? inferDocumentChangeLabel(displayDocument, nextDocument));
    onSaveDocument(nextDocument);
  };
  const undo = () => {
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    setUndoStack((current) => current.slice(0, -1));
    setRedoStack((current) => [...current, { document, label: entry.label }]);
    onSaveDocument(entry.document);
  };
  const redo = () => {
    const entry = redoStack[redoStack.length - 1];
    if (!entry) return;
    setRedoStack((current) => current.slice(0, -1));
    setUndoStack((current) => [...current, { document, label: entry.label }]);
    onSaveDocument(entry.document);
  };
  const pagesToReachNextStorySignature = () => {
    const remainder = storyPages.length % 4;
    return remainder === 0 ? 4 : 4 - remainder;
  };
  const nextExistingPageIndex = layoutMode === 'spread'
      ? clampedPageIndex === 0 ? 1 : clampedPageIndex + 2
      : clampedPageIndex + 1;
  const lastExistingPageIndex = layoutMode === 'spread' ? lastSpreadStartIndex : pages.length - 1;
  const canGoNextExistingPage = nextExistingPageIndex <= lastExistingPageIndex;
  const goNext = () => {
    if (canGoNextExistingPage) {
      setCurrentPageIndex(nextExistingPageIndex);
    }
  };
  const goNextExistingPage = () => {
    if (canGoNextExistingPage) {
      setCurrentPageIndex(nextExistingPageIndex);
    }
  };
  const addPagesToNextStorySignature = () => {
    const lastStoryPage = storyPages[storyPages.length - 1];
    const newPageIndex = pages.length;
    const nextDocument = lastStoryPage
      ? createPageDocument(lastStoryPage.id, pagesToReachNextStorySignature())
      : createPageDocument(undefined, pagesToReachNextStorySignature());
    const insertedPageIndex = sortedPages(nextDocument).findIndex((page) => !pages.some((existingPage) => existingPage.id === page.id));
    commitDocument(nextDocument, pagesToReachNextStorySignature() > 1 ? 'Add pages' : 'Add page');
    setCurrentPageIndex(insertedPageIndex >= 0 ? insertedPageIndex : layoutMode === 'spread' && newPageIndex > 0 && newPageIndex % 2 === 0 ? newPageIndex - 1 : newPageIndex);
  };
  const selectedPageIndex = selectedPageId ? pages.findIndex((page) => page.id === selectedPageId) : -1;
  const addPageAfterSelected = () => {
    const anchorId = selectedPageCanChangeOrder ? selectedPageId : null;
    if (!anchorId) return;
    const nextDocument = createPageDocument(anchorId);
    const anchorIndex = sortedPages(nextDocument).findIndex((page) => page.id === anchorId);
    const insertedPage = sortedPages(nextDocument)[Math.max(0, anchorIndex + 1)];
    commitDocument(nextDocument, 'Add page');
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
    if (layoutMode !== 'single' && layoutMode !== 'spread') return;
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
    }, 'Delete page');
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
    commitDocument({ ...displayDocument, pages: nextPages.map((candidate, index) => ({ ...candidate, order: index })) }, 'Reorder pages');
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
    if (layoutMode === 'all-pages') return;
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
  }, [layoutMode, clampedPageIndex, pages.length, isSaving]);
  const placeSelectedPanelAt = (pageId: string, rect: StoryPanelRect) => {
    if (!selectedPanel) return;
    const page = displayDocument.pages.find((candidate) => candidate.id === pageId);
    if (selectedPanel.sourceKind === 'story' && page?.pageKind !== 'story') return;
    if (selectedPanel.sourceKind === 'draft' && page?.pageKind !== 'story') return;
    commitDocument({
      ...displayDocument,
      panels: displayDocument.panels.map((panel) => (
        panel.id === selectedPanel.id ? { ...panel, pageId, rect: clampRect({ ...panel.rect, x: rect.x, y: rect.y }, panel.panelKind) } : panel
      )),
    }, 'Place panel');
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
      richText: sourceKind === 'free-text' ? plainTextToRichText(page.pageKind === 'inside-cover' ? 'Copyright information' : 'Text block') : '',
      textStyle: defaultTextStyle,
      pageId,
      panelKind: sourceKind === 'free-text' ? 'text' : 'image',
      rect: clampRect({ ...rect, w: sourceKind === 'free-text' ? 5 : 8, h: sourceKind === 'free-text' ? 1.5 : 4 }, sourceKind === 'free-text' ? 'text' : 'image'),
      layer: 0,
      parentPanelId: null,
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
    const nextDocument = {
      ...displayDocument,
      panels: displayDocument.panels.map((panel) => panel.id === selectedPanel.id ? { ...panel, ...patch } : panel),
    };
    setDraftDocument(nextDocument);
    commitDocument(nextDocument);
  };
  const updatePanelById = (panelId: string, patch: Partial<StoryPanel>) => {
    const nextDocument = {
      ...displayDocument,
      panels: displayDocument.panels.map((panel) => panel.id === panelId ? { ...panel, ...patch } : panel),
    };
    setDraftDocument(nextDocument);
    commitDocument(nextDocument);
  };
  const updateCaptionStyle = (captionId: string, patch: Partial<StoryPanelTextStyle>) => {
    const caption = displayDocument.panels.find((panel) => panel.id === captionId);
    if (!caption) return;
    updatePanelById(captionId, { textStyle: { ...captionStyleForPanel(caption), ...patch } });
  };
  const setCaptionSpeechKind = (captionId: string, speechKind: 'dialogue' | 'narration') => {
    const caption = displayDocument.panels.find((panel) => panel.id === captionId);
    if (!caption) return;
    const current = captionStyleForPanel(caption);
    updatePanelById(captionId, {
      textStyle: {
        ...current,
        speechKind,
        background: captionBackgroundForSpeech(speechKind),
      },
    });
  };
  const shrinkCaptionToFit = (captionId: string) => {
    const caption = displayDocument.panels.find((panel) => panel.id === captionId);
    if (!caption?.pageId) return;
    const grid = pageRefs.current[caption.pageId];
    if (!grid) return;
    const pageRows = LAYOUT_PAGE_ROWS;
    const text = captionTextDrafts[captionId] ?? caption.customText;
    const nextHeight = fitCaptionHeightRows(caption, text, grid, pageRows, CAPTION_GRID_SNAP);
    updatePanelById(captionId, { rect: clampCaptionRect({ ...caption.rect, h: nextHeight }) });
  };
  const commitCaptionFontSizeInput = (captionId: string) => {
    if (captionFontSizeDraft?.captionId !== captionId) return;
    const caption = displayDocument.panels.find((panel) => panel.id === captionId);
    if (!caption) {
      setCaptionFontSizeDraft(null);
      return;
    }
    const parsed = Number(captionFontSizeDraft.value);
    const currentSize = captionStyleForPanel(caption).fontSize;
    const nextSize = Number.isFinite(parsed)
      ? Math.min(48, Math.max(6, Math.trunc(parsed)))
      : currentSize;
    setCaptionFontSizeDraft(null);
    if (nextSize !== currentSize) {
      updateCaptionStyle(captionId, { fontSize: nextSize });
    }
  };
  const panelLabelFor = (panel: StoryPanel) => {
    if (panel.sourceKind === 'caption') {
      const parent = parentPanelFor(displayDocument, panel);
      const captions = parent ? captionPanelsFor(displayDocument, parent.id) : [];
      const index = captions.findIndex((caption) => caption.id === panel.id);
      const parentLabel = parent?.sourceKind === 'story'
        ? `Panel ${storyPanelNumberById.get(parent.id) ?? ''}`
        : 'image';
      return `${captionLabel(Math.max(0, index))} for ${parentLabel}`;
    }
    if (panel.sourceKind === 'story') return `Panel ${storyPanelNumberById.get(panel.id) ?? ''}`;
    if (panel.sourceKind === 'free-image') return 'Cover image block';
    return 'Image block';
  };
  const addCaptionPanel = (parent: StoryPanel) => {
    const captions = captionPanelsFor(displayDocument, parent.id);
    const nextPanel: StoryPanel = {
      id: nextPanelId(displayDocument),
      order: Math.max(...displayDocument.panels.map((panel) => panel.order), -1) + 1,
      sourceKind: 'caption',
      startOffset: null,
      endOffset: null,
      selectedText: '',
      customText: '',
      richText: plainTextToRichText(''),
      textStyle: { ...defaultCaptionTextStyle },
      pageId: parent.pageId,
      panelKind: 'text',
      rect: clampCaptionRect(defaultCaptionRect(parent, captions)),
      layer: parent.layer + 1 + captions.length,
      parentPanelId: parent.id,
      assetIds: [],
      activeAssetId: null,
      finalized: false,
    };
    commitDocument({ ...displayDocument, panels: [...displayDocument.panels, nextPanel] });
  };
  const removeCaptionPanel = (captionId: string) => {
    const caption = displayDocument.panels.find((panel) => panel.id === captionId);
    const parentId = caption?.parentPanelId ?? null;
    const nextDocument = {
      ...displayDocument,
      panels: displayDocument.panels.filter((panel) => panel.id !== captionId),
    };
    commitDocument(nextDocument);
    setCaptionTextDrafts((current) => {
      const next = { ...current };
      delete next[captionId];
      return next;
    });
    if (selectedPanelId === captionId && parentId) {
      onSelectPanel(parentId);
    }
  };
  const confirmDeleteCaption = () => {
    const captionId = pendingCaptionDeleteId;
    if (!captionId) return;
    removeCaptionPanel(captionId);
    setPendingCaptionDeleteId(null);
  };
  const commitCaptionTextDraft = (captionId: string) => {
    const draft = captionTextDrafts[captionId];
    if (draft === undefined) return;
    const caption = displayDocument.panels.find((panel) => panel.id === captionId);
    if (!caption || caption.sourceKind !== 'caption') return;
    const nextRichText = plainTextToRichText(draft);
    if (caption.customText === draft && (caption.richText || plainTextToRichText(caption.customText)) === nextRichText) {
      setCaptionTextDrafts((current) => {
        const next = { ...current };
        delete next[captionId];
        return next;
      });
      return;
    }
    updatePanelById(captionId, { customText: draft, richText: nextRichText });
    setCaptionTextDrafts((current) => {
      const next = { ...current };
      delete next[captionId];
      return next;
    });
  };
  const assignPanelImage = (panelId: string, assetId: string) => {
    const panel = displayDocument.panels.find((candidate) => candidate.id === panelId);
    if (!panel) return;
    const nextIds = panel.assetIds.includes(assetId) ? panel.assetIds : [...panel.assetIds, assetId];
    updatePanelById(panelId, { assetIds: nextIds, activeAssetId: assetId, imageCrop: null });
    setCropModePanelId((current) => (current === panelId ? null : current));
  };
  const clearPanelImage = (panelId: string) => {
    updatePanelById(panelId, { assetIds: [], activeAssetId: null, imageCrop: null });
    setCropModePanelId((current) => (current === panelId ? null : current));
  };
  const setPanelActiveAsset = (panelId: string, assetId: string) => {
    updatePanelById(panelId, { activeAssetId: assetId });
  };
  const updatePanelImageCrop = (panelId: string, patch: Partial<StoryPanelImageCrop>) => {
    const panel = displayDocument.panels.find((candidate) => candidate.id === panelId);
    if (!panel) return;
    updatePanelById(panelId, { imageCrop: { ...imageCropForPanel(panel), ...patch } });
  };
  const resetPanelImageCrop = (panelId: string) => {
    updatePanelById(panelId, { imageCrop: null });
  };
  const applyZoomDraft = (panelId: string, scalePercent: number) => {
    const scale = scalePercent / 100;
    setDraftDocument((current) => {
      const doc = current ?? displayDocumentRef.current;
      const nextDocument = {
        ...doc,
        panels: doc.panels.map((panel) => (
          panel.id === panelId
            ? { ...panel, imageCrop: { ...imageCropForPanel(panel), scale } }
            : panel
        )),
      };
      draftDocumentRef.current = nextDocument;
      return nextDocument;
    });
  };
  const beginZoomAdjust = (event: React.PointerEvent, panelId: string) => {
    event.stopPropagation();
    zoomDragPanelIdRef.current = panelId;
    draftDocumentRef.current = displayDocumentRef.current;
    setDraftDocument(displayDocumentRef.current);
  };
  const endZoomAdjust = (panelId: string, scalePercent: number) => {
    if (zoomDragPanelIdRef.current !== panelId) return;
    const scale = scalePercent / 100;
    const doc = draftDocumentRef.current ?? displayDocumentRef.current;
    const nextDocument = {
      ...doc,
      panels: doc.panels.map((panel) => (
        panel.id === panelId
          ? { ...panel, imageCrop: { ...imageCropForPanel(panel), scale } }
          : panel
      )),
    };
    zoomDragPanelIdRef.current = null;
    draftDocumentRef.current = null;
    setDraftDocument(null);
    commitDocument(nextDocument, 'Zoom image');
  };
  const cancelZoomAdjust = () => {
    zoomDragPanelIdRef.current = null;
    draftDocumentRef.current = null;
    setDraftDocument(null);
  };
  const snapPanelToAspectRatio = (panel: StoryPanel, aspectRatio: string) => {
    if (!panel.pageId) return;
    const pageRows = pageRowsForPanels(displayDocument.panels, panel.pageId);
    const nextRect = snapRectToAspectRatio(panel.rect, pageRows, parseAspectRatio(aspectRatio), panel.panelKind, clampRect);
    updatePanelById(panel.id, { rect: nextRect, aspectRatio });
  };
  const snapSelectedPanelToImageRatio = async (panel: StoryPanel) => {
    if (!panel.activeAssetId) return;
    setIsSnappingAspect(true);
    try {
      const url = `/api/projects/${projectSlug}/assets/${panel.activeAssetId}/image`;
      const { width, height } = await loadImageDimensions(url);
      snapPanelToAspectRatio(panel, formatAspectRatioFromPixels(width, height));
    } finally {
      setIsSnappingAspect(false);
    }
  };
  const togglePanelAspectRatioLock = (panel: StoryPanel) => {
    if (panel.aspectRatioLocked) {
      updatePanelById(panel.id, { aspectRatioLocked: false });
      return;
    }
    if (!panel.pageId) return;
    const pageRows = pageRowsForPanels(displayDocument.panels, panel.pageId);
    const visualRatio = panelVisualAspectRatio(panel.rect, pageRows);
    const currentRatio = panel.aspectRatio ?? formatAspectRatioFromPixels(
      Math.round(visualRatio * 10000),
      10000,
    );
    updatePanelById(panel.id, { aspectRatio: currentRatio, aspectRatioLocked: true });
  };
  const renderImagePanelBody = (panel: StoryPanel, cropModeActive = false) => {
    const activeAsset = panel.activeAssetId ? assetById.get(panel.activeAssetId) ?? null : null;
    const passage = (panel.selectedText || (panel.sourceKind === 'free-image' ? 'Cover image block' : '')).replace(/\s+/g, ' ').trim();
    if (activeAsset) {
      const crop = imageCropForPanel(panel);
      if (cropModeActive) {
        return (
          <div
            className={`story-panels-page-panel-crop-layer ${cropDragState?.panelId === panel.id ? 'is-crop-dragging' : ''}`}
            onPointerDown={(event) => beginCropPan(event, panel)}
            onPointerMove={(event) => {
              if ((event.target as HTMLElement).closest('.story-panels-page-panel-crop-zoom')) return;
              continueCropPan(event);
            }}
            onPointerUp={endCropPan}
            onPointerCancel={endCropPan}
          >
            <img
              className="story-panels-page-panel-image"
              src={assetThumbnailUrl(projectSlug, activeAsset)}
              alt=""
              draggable={false}
              style={panelImageCropStyle(crop)}
            />
            <div className="story-panels-page-panel-crop-zoom">
              <input
                type="range"
                min={100}
                max={400}
                step={5}
                aria-label="Image zoom"
                disabled={isSaving}
                value={Math.round(crop.scale * 100)}
                onPointerDown={(event) => beginZoomAdjust(event, panel.id)}
                onInput={(event) => {
                  event.stopPropagation();
                  applyZoomDraft(panel.id, Number(event.currentTarget.value));
                }}
                onPointerUp={(event) => {
                  event.stopPropagation();
                  endZoomAdjust(panel.id, Number(event.currentTarget.value));
                }}
                onLostPointerCapture={(event) => {
                  if (zoomDragPanelIdRef.current === panel.id) {
                    endZoomAdjust(panel.id, Number(event.currentTarget.value));
                  }
                }}
                onPointerCancel={(event) => {
                  event.stopPropagation();
                  cancelZoomAdjust();
                }}
                onKeyUp={(event) => {
                  if (event.key === 'Enter') {
                    endZoomAdjust(panel.id, Number(event.currentTarget.value));
                  }
                }}
              />
            </div>
          </div>
        );
      }
      return (
        <img
          className="story-panels-page-panel-image"
          src={assetThumbnailUrl(projectSlug, activeAsset)}
          alt=""
          draggable={false}
          style={panelImageCropStyle(crop)}
        />
      );
    }
    return (
      <>
        {panel.sourceKind === 'story' && (
          <strong>Panel {storyPanelNumberById.get(panel.id) ?? ''}</strong>
        )}
        <span>{passage.slice(0, 120)}</span>
      </>
    );
  };
  const updateSelectedPanelTextStyle = (patch: Partial<StoryPanelTextStyle>) => {
    if (!selectedPanel) return;
    updateSelectedPanel({ textStyle: { ...textStyleForPanel(selectedPanel), ...patch } });
  };
  const commitFontSizeInput = () => {
    if (!selectedPanel) return;
    if (fontSizeInput === null) return;
    const parsed = Number(fontSizeInput);
    const nextSize = Number.isFinite(parsed)
      ? Math.min(48, Math.max(6, Math.trunc(parsed)))
      : textStyleForPanel(selectedPanel).fontSize;
    setFontSizeInput(null);
    if (nextSize !== textStyleForPanel(selectedPanel).fontSize) {
      updateSelectedPanelTextStyle({ fontSize: nextSize });
    }
  };
  const requestDeleteSelectedPanel = () => {
    if (!visibleSelectedPanel || isSaving) return;
    setPendingPanelDeleteId(visibleSelectedPanel.id);
  };
  const confirmRemoveSelectedPanel = () => {
    const panelId = pendingPanelDeleteId;
    if (!panelId) return;
    const panel = displayDocument.panels.find((candidate) => candidate.id === panelId);
    if (!panel) return;
    if (panel.sourceKind === 'story') {
      commitDocument(removeStoryPanelFromLayout(displayDocument, panelId));
    } else {
      commitDocument({
        ...displayDocument,
        panels: panel.panelKind === 'image'
          ? removePanelAndCaptionChildren(displayDocument, panelId)
          : displayDocument.panels.filter((candidate) => candidate.id !== panelId),
      });
    }
    setPendingPanelDeleteId(null);
    onSelectPanel(null);
  };
  const selectedPanelRemoveLabel = visibleSelectedPanel?.sourceKind === 'story' ? 'Remove' : 'Delete';
  const commitCustomTextDraft = () => {
    if (!selectedPanel) return;
    persistPanelTextDraft(selectedPanel.id, richTextEditorRef.current?.innerHTML ?? customTextDraft);
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
    const rowHeight = Math.max(22, bounds.height / LAYOUT_PAGE_ROWS);
    const draggedPanel = displayDocument.panels.find((panel) => panel.id === state.panelId);
    const snapScale = draggedPanel?.sourceKind === 'caption' ? CAPTION_GRID_SNAP : panelSnapScale;
    const deltaColumns = targetPageId === state.pageId ? roundStep((event.clientX - state.startClientX) / columnWidth, snapScale) : roundStep((event.clientX - bounds.left) / columnWidth, snapScale) - state.startRect.x;
    const deltaRows = targetPageId === state.pageId ? roundStep((event.clientY - state.startClientY) / rowHeight, snapScale) : roundStep((event.clientY - bounds.top) / rowHeight, snapScale) - state.startRect.y;
    const nextPanels = displayDocument.panels.map((panel) => {
      if (panel.id !== state.panelId) return panel;
      const pageRows = pageRowsForPanels(displayDocument.panels, targetPageId);
      if (state.mode === 'resize') {
        let rect = resizeRectFromCorner(state.startRect, state.corner ?? 'se', deltaColumns, deltaRows, panel);
        if (panel.aspectRatioLocked && panel.aspectRatio) {
          rect = enforceLockedAspectOnResize(
            rect,
            state.startRect,
            state.corner ?? 'se',
            pageRows,
            parseAspectRatio(panel.aspectRatio),
            panel.panelKind,
            (nextRect) => clampPanelRect(nextRect, panel),
          );
        }
        return { ...panel, rect };
      }
      return {
        ...panel,
        pageId: targetPageId,
        rect: clampPanelRect({
          ...state.startRect,
          x: state.startRect.x + deltaColumns,
          y: state.startRect.y + deltaRows,
        }, panel),
      };
    });
    setDraftDocument({ ...displayDocument, panels: nextPanels });
  };
  const beginDrag = (event: React.PointerEvent, panel: StoryPanel, mode: DragMode, corner?: ResizeCorner) => {
    if (isSaving || !panel.pageId) return;
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
    const label = dragState.mode === 'resize' ? 'Resize panel' : 'Move panel';
    const nextDocument = draftDocument;
    setDragState(null);
    setDraftDocument(null);
    commitDocument(nextDocument, label);
  };
  const beginCropPan = (event: React.PointerEvent<HTMLDivElement>, panel: StoryPanel) => {
    if (isSaving || cropModePanelId !== panel.id || !panel.activeAssetId) return;
    if ((event.target as HTMLElement).closest('.story-panels-page-panel-crop-zoom')) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    setCropDragState({
      panelId: panel.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCrop: imageCropForPanel(panel),
      panelWidth: bounds.width,
      panelHeight: bounds.height,
    });
    setDraftDocument(displayDocument);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const continueCropPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!cropDragState || !draftDocument) return;
    const deltaX = event.clientX - cropDragState.startClientX;
    const deltaY = event.clientY - cropDragState.startClientY;
    const nextFocal = focalFromPanDelta(
      cropDragState.startCrop,
      deltaX,
      deltaY,
      cropDragState.panelWidth,
      cropDragState.panelHeight,
    );
    setDraftDocument({
      ...draftDocument,
      panels: draftDocument.panels.map((panel) => (
        panel.id === cropDragState.panelId
          ? { ...panel, imageCrop: { ...cropDragState.startCrop, ...nextFocal } }
          : panel
      )),
    });
  };
  const endCropPan = () => {
    if (!cropDragState || !draftDocument) return;
    const nextDocument = draftDocument;
    setCropDragState(null);
    setDraftDocument(null);
    commitDocument(nextDocument, 'Adjust image crop');
  };
  const openPanelMenu = (event: React.MouseEvent, panel: StoryPanel) => {
    event.preventDefault();
    event.stopPropagation();
    if (panel.panelKind !== 'image') return;
    onSelectPanel(panel.id);
    setPageMenu({ kind: 'panel', x: event.clientX, y: event.clientY, panelId: panel.id });
  };
  const openPageMenu = (event: React.MouseEvent<HTMLDivElement>, pageId: string) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const columnWidth = bounds.width / gridColumns;
    const rows = LAYOUT_PAGE_ROWS;
    const rowHeight = Math.max(22, bounds.height / rows);
    const minWidth = selectedPanel?.panelKind === 'text' ? minTextPanelWidth : minPanelWidth;
    const x = Math.min(gridColumns - minWidth, Math.max(0, roundStep((event.clientX - bounds.left) / columnWidth, panelSnapScale)));
    const y = Math.max(0, roundStep((event.clientY - bounds.top) / rowHeight, panelSnapScale));
    setPageMenu({ kind: 'page', x: event.clientX, y: event.clientY, pageId, rect: { x, y, w: selectedPanel?.rect.w ?? 6, h: selectedPanel?.rect.h ?? 3 } });
  };
  const clearPanelSelection = () => {
    if (!selectedPanelId || isSaving || dragState) return;
    const editingPanelId = richTextEditingPanelIdRef.current;
    if (editingPanelId) {
      persistPanelTextDraft(
        editingPanelId,
        customTextDraftRef.current ?? richTextEditorRef.current?.innerHTML,
      );
    }
    onSelectPanel(null);
  };
  const handlePageBackgroundClick = (event: React.MouseEvent<HTMLElement>) => {
    if (layoutMode === 'all-pages') return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('.story-panels-page-panel')) return;
    clearPanelSelection();
  };
  const handlePagePreviewBackgroundClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (layoutMode === 'all-pages') return;
    if (event.target !== event.currentTarget) return;
    clearPanelSelection();
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
    captureSideHeight?: (element: HTMLDivElement | null) => void,
  ) => {
    if (!hasSinglePageSidePanel) return grid;
    const printSlot = singlePrintSlotForPage(page, fallbackIndex);
    return (
      <div
        ref={captureSideHeight}
        className={`story-panels-single-page-preview is-${singlePagePreviewMode} is-print-slot-${printSlot}`}
        style={singlePagePreviewMode === 'print' ? singlePrintFrameStyle(printSlot) : undefined}
        onClick={handlePagePreviewBackgroundClick}
      >
        {grid}
      </div>
    );
  };
  const applyRichTextCommand = (command: 'bold' | 'italic' | 'underline') => {
    window.document.execCommand(command);
    const active = window.document.activeElement;
    if (active instanceof HTMLElement && active.classList.contains('story-panels-rich-text-editor')) {
      setCustomTextDraft(sanitizeRichText(active.innerHTML));
    }
  };
  useEffect(() => {
    onPageControlsChange?.(
      <div className="story-panels-page-nav" aria-label="Page navigation">
        {layoutMode === 'all-pages' ? (
          <>
            <button type="button" className="secondary" disabled={isSaving || !selectedPageCanChangeOrder || selectedStoryPageIndex <= 0} onClick={() => moveSelectedPage(-1)}>Move left</button>
            <button type="button" className="secondary" disabled={isSaving || !selectedPageCanChangeOrder || selectedStoryPageIndex < 0 || selectedStoryPageIndex >= storyPages.length - 1} onClick={() => moveSelectedPage(1)}>Move right</button>
            <button type="button" className="secondary" disabled={isSaving || !selectedPageCanChangeOrder} onClick={addPageAfterSelected}>Add story page after</button>
            <button
              type="button"
              className="secondary story-panels-delete-page-button"
              disabled={isSaving || !selectedPageCanChangeOrder || storyPages.length <= 1}
              onClick={requestDeleteSelectedPage}
              aria-label="Delete page"
              title="Delete page"
            >
              <TrashIcon />
            </button>
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
              className="secondary small-button"
              disabled={isSaving || !canGoNextExistingPage}
              onClick={goNext}
              aria-label="Next page"
              title="Next page"
            >
              <span aria-hidden="true">→</span>
            </button>
            <button
              type="button"
              className="secondary"
              disabled={isSaving}
              onClick={addPagesToNextStorySignature}
              aria-label={`Add ${pagesToReachNextStorySignature()} pages`}
              title={`Add ${pagesToReachNextStorySignature()} pages to reach a multiple of 4 story pages`}
            >
              + Pages
            </button>
            {hasSinglePageSidePanel && (
              <div className="story-panels-preview-toggle" role="group" aria-label="Single page preview mode">
                <button
                  type="button"
                  className={singlePagePreviewMode === 'readable' ? 'active' : ''}
                  onClick={() => selectSinglePagePreviewMode('readable')}
                >
                  Readable area
                </button>
                <button
                  type="button"
                  className={singlePagePreviewMode === 'print' ? 'active' : ''}
                  onClick={() => selectSinglePagePreviewMode('print')}
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
      <div
        ref={spreadWorkspaceRef}
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
                const pageRows = LAYOUT_PAGE_ROWS;
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
                      onClick={handlePageBackgroundClick}
                      onContextMenu={(event) => openPageMenu(event, page.id)}
                      onPointerMove={continueDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                    >
                      {pagePanels.map((panel) => (
                        <div
                          key={panel.id}
                          role="presentation"
                          className={`story-panels-page-panel is-${panel.panelKind} ${panel.sourceKind === 'caption' ? 'is-caption' : ''} ${captionPanelClassName(panel)} ${panel.panelKind === 'image' && panel.activeAssetId ? 'has-image' : ''} ${cropModePanelId === panel.id ? 'is-crop-mode' : ''} ${selectedPanelId === panel.id ? 'is-selected' : ''} ${flashingPanelId === panel.id ? 'is-flashing' : ''} ${dragState?.panelId === panel.id ? 'is-dragging' : ''}`}
                          style={{
                            ...panelStyle(panel, pageRows),
                            ...(panel.panelKind === 'text' ? panelCanvasTextStyle(
                              panel,
                              selectedPanelId,
                              fontSizeInput,
                            ) : {}),
                          }}
                          onClick={() => onSelectPanel(panel.id)}
                          onDoubleClick={(event) => openPanelDetail(event, panel)}
                          onContextMenu={(event) => openPanelMenu(event, panel)}
                          onPointerDown={(event) => {
                            if ((event.target as HTMLElement).closest('.story-panels-page-panel-crop-layer')) return;
                            beginDrag(event, panel, 'move');
                          }}
                        >
                          {panel.panelKind === 'text' ? (
                            <span
                              className="story-panels-page-panel-rich-text"
                              dangerouslySetInnerHTML={{ __html: sanitizeRichText(richTextForPanel(panel, panel.id === selectedPanelId ? customTextDraft : null)) }}
                            />
                          ) : renderImagePanelBody(panel, cropModePanelId === panel.id)}
                          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                            <span
                              key={corner}
                              className={`story-panels-resize-handle is-${corner}`}
                              aria-hidden="true"
                              onPointerDown={(event) => beginDrag(event, panel, 'resize', corner)}
                            />
                          ))}
                        </div>
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
                  hasSinglePageSidePanel ? (element) => { sideHeightSourceRef.current = element; } : undefined,
                )}
              </article>
            );
          }
          const pagePanels = sortedPanelsForPage(displayDocument, page.id);
          const pageRows = LAYOUT_PAGE_ROWS;
          return (
            <article
              key={`${page.id}-${pageIndex}`}
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
                  onClick={handlePageBackgroundClick}
                  onContextMenu={(event) => openPageMenu(event, page.id)}
                  onPointerMove={continueDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                >
                  {pagePanels.map((panel) => (
                    <div
                      key={panel.id}
                      role="presentation"
                      className={`story-panels-page-panel is-${panel.panelKind} ${panel.sourceKind === 'caption' ? 'is-caption' : ''} ${captionPanelClassName(panel)} ${panel.panelKind === 'image' && panel.activeAssetId ? 'has-image' : ''} ${cropModePanelId === panel.id ? 'is-crop-mode' : ''} ${selectedPanelId === panel.id ? 'is-selected' : ''} ${flashingPanelId === panel.id ? 'is-flashing' : ''} ${dragState?.panelId === panel.id ? 'is-dragging' : ''}`}
                      style={{
                        ...panelStyle(panel, pageRows),
                        ...(panel.panelKind === 'text' ? panelCanvasTextStyle(
                          panel,
                          selectedPanelId,
                          fontSizeInput,
                        ) : {}),
                      }}
                      onClick={layoutMode === 'all-pages' ? undefined : () => onSelectPanel(panel.id)}
                      onDoubleClick={(event) => openPanelDetail(event, panel)}
                      onContextMenu={(event) => openPanelMenu(event, panel)}
                      onPointerDown={layoutMode === 'all-pages' ? undefined : (event) => {
                        if ((event.target as HTMLElement).closest('.story-panels-page-panel-crop-layer')) return;
                        beginDrag(event, panel, 'move');
                      }}
                    >
                      {layoutMode !== 'all-pages' && (
                        <>
                          {panel.panelKind === 'text' ? (
                            <span
                              className="story-panels-page-panel-rich-text"
                              dangerouslySetInnerHTML={{ __html: sanitizeRichText(richTextForPanel(panel, panel.id === selectedPanelId ? customTextDraft : null)) }}
                            />
                          ) : renderImagePanelBody(panel, cropModePanelId === panel.id)}
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
                    </div>
                  ))}
                </div>,
                hasSinglePageSidePanel && pageIndex === 0
                  ? (element) => { sideHeightSourceRef.current = element; }
                  : undefined,
              )}
            </article>
          );
        })
          )
        ) : <p className="muted">No pages yet.</p>}
        </div>
        {(layoutMode === 'single' || (layoutMode === 'spread' && visibleSelectedPanel && spreadPanelInfoEnabled)) && (
          <aside
            className={`story-panels-info-panel${layoutMode === 'spread' ? ` story-panels-info-popover is-anchor-${infoPopoverAnchor}` : ''}`}
            style={layoutMode === 'single' && sidePanelHeight ? { height: sidePanelHeight } : undefined}
            role={layoutMode === 'spread' ? 'dialog' : undefined}
            aria-label={layoutMode === 'spread' ? 'Selected panel settings' : undefined}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {visibleSelectedPanel ? (
              <>
                <div className="story-panels-info-head">
                  <h3>Selected Panel</h3>
                  <button type="button" className="danger" disabled={isSaving} onClick={requestDeleteSelectedPanel}>
                    {selectedPanelRemoveLabel}
                  </button>
                </div>
                <div className="story-panels-info-panel-body" ref={infoPanelBodyRef}>
                {panelKindHost && (
                <div className="story-panels-info-control">
                  <span>Panel kind</span>
                  <div className="story-panels-kind-toggle" role="tablist" aria-label="Panel kind">
                    <button
                      type="button"
                      className={panelKindHost.panelKind === 'image' ? 'active' : ''}
                      role="tab"
                      aria-selected={panelKindHost.panelKind === 'image'}
                      disabled={isSaving}
                      onClick={() => updatePanelById(panelKindHost.id, { panelKind: 'image' })}
                    >
                      Image panel
                    </button>
                    <button
                      type="button"
                      className={panelKindHost.panelKind === 'text' ? 'active' : ''}
                      role="tab"
                      aria-selected={panelKindHost.panelKind === 'text'}
                      disabled={isSaving}
                      onClick={() => updatePanelById(panelKindHost.id, { panelKind: 'text' })}
                    >
                      Text / caption
                    </button>
                  </div>
                </div>
                )}
                {imageInfoHost?.panelKind === 'image' && (
                  <div className="story-panels-info-image-section">
                    <span>Image</span>
                    <div className="story-panels-info-image-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={isSaving}
                        onClick={() => setPickerPanelId(imageInfoHost.id)}
                      >
                        Choose image…
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={isSaving || !imageInfoHost.activeAssetId}
                        onClick={() => clearPanelImage(imageInfoHost.id)}
                      >
                        Clear image
                      </button>
                    </div>
                    <div className="story-panels-info-aspect-group">
                      <div className="story-panels-info-aspect-head">
                        <span>Ratio</span>
                        {imageInfoHost.aspectRatio && (
                          <span className="story-panels-info-aspect-current">
                            {imageInfoHost.aspectRatio}
                            {imageInfoHost.aspectRatioLocked ? ' · locked' : ''}
                          </span>
                        )}
                      </div>
                      <div className="story-panels-info-aspect-controls">
                        <button
                          type="button"
                          className="secondary"
                          disabled={isSaving || isSnappingAspect || !imageInfoHost.activeAssetId}
                          onClick={() => void snapSelectedPanelToImageRatio(imageInfoHost)}
                        >
                          {isSnappingAspect ? 'Snapping…' : 'Snap to image ratio'}
                        </button>
                        <button
                          type="button"
                          className={`secondary ${imageInfoHost.aspectRatioLocked ? 'active' : ''}`}
                          disabled={isSaving}
                          onClick={() => togglePanelAspectRatioLock(imageInfoHost)}
                        >
                          {imageInfoHost.aspectRatioLocked ? '🔓 ratio' : '🔒 ratio'}
                        </button>
                        <div className="story-panels-info-aspect-popover-wrap">
                          <button
                            type="button"
                            className={`secondary ${ratioPopoverOpen ? 'active' : ''}`}
                            disabled={isSaving}
                            onClick={() => setRatioPopoverOpen((open) => !open)}
                          >
                            Snap to preset…
                          </button>
                          {ratioPopoverOpen && (
                            <div className="story-panels-aspect-ratio-popover" role="menu" aria-label="Image aspect ratios">
                              {GEMINI_IMAGE_ASPECT_RATIOS.map((ratio) => (
                                <button
                                  key={ratio}
                                  type="button"
                                  role="menuitem"
                                  className={imageInfoHost.aspectRatio === ratio ? 'active' : ''}
                                  disabled={isSaving}
                                  onClick={() => {
                                    snapPanelToAspectRatio(imageInfoHost, ratio);
                                    setRatioPopoverOpen(false);
                                  }}
                                >
                                  {ratio}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    {imageInfoHost.activeAssetId && (
                      <div className="story-panels-info-crop-group">
                        <div className="story-panels-info-crop-head">
                          <span>Crop</span>
                          {(imageInfoHost.imageCrop && !isDefaultImageCrop(imageInfoHost.imageCrop)) && (
                            <button
                              type="button"
                              className="secondary story-panels-info-crop-reset"
                              disabled={isSaving}
                              onClick={() => resetPanelImageCrop(imageInfoHost.id)}
                            >
                              Reset
                            </button>
                          )}
                        </div>
                        <label className="story-panels-info-crop-control">
                          <span>Horizontal</span>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            disabled={isSaving}
                            value={Math.round(imageCropForPanel(imageInfoHost).focalX * 100)}
                            onChange={(event) => {
                              updatePanelImageCrop(imageInfoHost.id, {
                                focalX: Number(event.target.value) / 100,
                              });
                            }}
                          />
                        </label>
                        <label className="story-panels-info-crop-control">
                          <span>Vertical</span>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            disabled={isSaving}
                            value={Math.round(imageCropForPanel(imageInfoHost).focalY * 100)}
                            onChange={(event) => {
                              updatePanelImageCrop(imageInfoHost.id, {
                                focalY: Number(event.target.value) / 100,
                              });
                            }}
                          />
                        </label>
                      </div>
                    )}
                    {imageInfoHost.assetIds.length > 1 && (
                      <div className="story-panels-info-image-variants moment-sequence-thumbs">
                        {nonArchivedVariants(assets, imageInfoHost.assetIds).map((asset) => (
                          <button
                            key={asset.id}
                            type="button"
                            className={`moment-sequence-thumb ${asset.id === imageInfoHost.activeAssetId ? 'is-active' : ''}`}
                            disabled={isSaving}
                            onClick={() => setPanelActiveAsset(imageInfoHost.id, asset.id)}
                          >
                            <img src={assetThumbnailUrl(projectSlug, asset)} alt="" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {imageInfoHost?.sourceKind === 'story' && (
                <label>
                  {`Passage text (${imageInfoHost.startOffset} to ${imageInfoHost.endOffset})`}
                  <textarea
                    value={imageInfoHost.selectedText}
                    rows={5}
                    readOnly
                  />
                </label>
                )}
                {captionHostPanel && (
                  <div className="story-panels-info-captions-group">
                    <button
                      type="button"
                      className="secondary"
                      disabled={isSaving}
                      onClick={() => addCaptionPanel(captionHostPanel)}
                    >
                      Add caption
                    </button>
                    {childCaptions.length === 0 ? (
                      <p className="muted">No captions yet. Add one to place linked text below this image on the layout.</p>
                    ) : (
                      <div className="story-panels-info-caption-list">
                        {childCaptions.map((caption, index) => (
                          <div
                            key={caption.id}
                            className={`story-panels-info-caption-entry ${visibleSelectedPanel?.id === caption.id ? 'is-selected' : ''}`}
                          >
                            <textarea
                              aria-label={captionLabel(index)}
                              value={captionTextDrafts[caption.id] ?? caption.customText}
                              rows={3}
                              disabled={isSaving}
                              onChange={(event) => {
                                setCaptionTextDrafts((current) => ({
                                  ...current,
                                  [caption.id]: event.target.value,
                                }));
                              }}
                              onBlur={() => commitCaptionTextDraft(caption.id)}
                              onKeyDown={(event) => event.stopPropagation()}
                            />
                            <div className="story-panels-info-caption-entry-actions">
                              <button
                                type="button"
                                className="story-panels-delete-caption-button"
                                disabled={isSaving}
                                aria-label={`Delete ${captionLabel(index)}`}
                                onClick={() => setPendingCaptionDeleteId(caption.id)}
                              >
                                <TrashIcon />
                              </button>
                              <div className="story-panels-info-caption-style-wrap">
                                <button
                                  type="button"
                                  className={`story-panels-caption-style-button ${captionStylePopoverId === caption.id ? 'active' : ''}`}
                                  disabled={isSaving}
                                  aria-label={`Style ${captionLabel(index)}`}
                                  aria-expanded={captionStylePopoverId === caption.id}
                                  onClick={() => setCaptionStylePopoverId((current) => (current === caption.id ? null : caption.id))}
                                >
                                  <StyleIcon />
                                </button>
                                {captionStylePopoverId === caption.id && (
                                  <div
                                    className="story-panels-caption-style-popover"
                                    role="dialog"
                                    aria-label={`${captionLabel(index)} appearance`}
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <div className="story-panels-caption-style-field">
                                      <span>Type</span>
                                      <div className="story-panels-caption-style-options">
                                        <button
                                          type="button"
                                          className={captionSpeechKindFor(captionStyleForPanel(caption)) === 'dialogue' ? 'active' : ''}
                                          disabled={isSaving}
                                          onClick={() => setCaptionSpeechKind(caption.id, 'dialogue')}
                                        >
                                          Dialogue
                                        </button>
                                        <button
                                          type="button"
                                          className={captionSpeechKindFor(captionStyleForPanel(caption)) === 'narration' ? 'active' : ''}
                                          disabled={isSaving}
                                          onClick={() => setCaptionSpeechKind(caption.id, 'narration')}
                                        >
                                          Narration
                                        </button>
                                      </div>
                                    </div>
                                    <div className="story-panels-caption-style-field">
                                      <button
                                        type="button"
                                        className="secondary"
                                        disabled={isSaving}
                                        onClick={() => shrinkCaptionToFit(caption.id)}
                                      >
                                        Shrink height to fit text
                                      </button>
                                    </div>
                                    <div className="story-panels-caption-style-field">
                                      <span>Text color</span>
                                      <div className="story-panels-caption-color-presets">
                                        {CAPTION_COLOR_PRESETS.map((color) => (
                                          <button
                                            key={color}
                                            type="button"
                                            className={captionStyleForPanel(caption).color === color ? 'active' : ''}
                                            disabled={isSaving}
                                            aria-label={color}
                                            style={{ backgroundColor: color }}
                                            onClick={() => updateCaptionStyle(caption.id, { color })}
                                          />
                                        ))}
                                      </div>
                                      <label className="story-panels-caption-color-input">
                                        Custom
                                        <input
                                          type="color"
                                          value={captionStyleForPanel(caption).color ?? '#111827'}
                                          disabled={isSaving}
                                          onChange={(event) => updateCaptionStyle(caption.id, { color: event.target.value })}
                                        />
                                      </label>
                                    </div>
                                    {captionStyleForPanel(caption).background === 'transparent' && (
                                      <div className="story-panels-caption-style-field">
                                        <span>Outline color</span>
                                        <div className="story-panels-caption-color-presets">
                                          {CAPTION_COLOR_PRESETS.map((color) => (
                                            <button
                                              key={`outline-${color}`}
                                              type="button"
                                              className={captionStyleForPanel(caption).outlineColor === color ? 'active' : ''}
                                              disabled={isSaving}
                                              aria-label={color}
                                              style={{ backgroundColor: color }}
                                              onClick={() => updateCaptionStyle(caption.id, { outlineColor: color })}
                                            />
                                          ))}
                                        </div>
                                        <label className="story-panels-caption-color-input">
                                          Custom
                                          <input
                                            type="color"
                                            value={captionStyleForPanel(caption).outlineColor ?? '#ffffff'}
                                            disabled={isSaving}
                                            onChange={(event) => updateCaptionStyle(caption.id, { outlineColor: event.target.value })}
                                          />
                                        </label>
                                      </div>
                                    )}
                                    <div className="story-panels-caption-style-field">
                                      <label>
                                        Font
                                        <select
                                          value={captionStyleForPanel(caption).fontFamily}
                                          disabled={isSaving}
                                          onChange={(event) => updateCaptionStyle(caption.id, { fontFamily: event.target.value as StoryPanelTextStyle['fontFamily'] })}
                                        >
                                          <option value="serif">Serif</option>
                                          <option value="sans">Sans</option>
                                          <option value="mono">Mono</option>
                                          <option value="comic">Comic Sans</option>
                                        </select>
                                      </label>
                                      <label>
                                        Size
                                        <input
                                          type="number"
                                          min={6}
                                          max={48}
                                          value={
                                            captionFontSizeDraft?.captionId === caption.id
                                              ? captionFontSizeDraft.value
                                              : captionStyleForPanel(caption).fontSize
                                          }
                                          disabled={isSaving}
                                          onChange={(event) => setCaptionFontSizeDraft({ captionId: caption.id, value: event.target.value })}
                                          onBlur={() => commitCaptionFontSizeInput(caption.id)}
                                          onKeyDown={(event) => {
                                            if (event.key === 'Enter') event.currentTarget.blur();
                                          }}
                                        />
                                      </label>
                                      <label>
                                        Align
                                        <select
                                          value={captionStyleForPanel(caption).align}
                                          disabled={isSaving}
                                          onChange={(event) => updateCaptionStyle(caption.id, { align: event.target.value as StoryPanelTextStyle['align'] })}
                                        >
                                          <option value="left">Left</option>
                                          <option value="center">Center</option>
                                          <option value="right">Right</option>
                                        </select>
                                      </label>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {visibleSelectedPanel.panelKind === 'text' && visibleSelectedPanel.sourceKind !== 'caption' && (
                  <div className="story-panels-text-editor-panel">
                    <span>Caption text</span>
                    <div className="story-panels-text-style-row">
                      <label>
                        Font
                        <select
                          value={textStyleForPanel(visibleSelectedPanel).fontFamily}
                          disabled={isSaving}
                          onChange={(event) => updateSelectedPanelTextStyle({ fontFamily: event.target.value as StoryPanelTextStyle['fontFamily'] })}
                        >
                          <option value="serif">Serif</option>
                          <option value="sans">Sans</option>
                          <option value="mono">Mono</option>
                          <option value="comic">Comic Sans</option>
                        </select>
                      </label>
                      <label>
                        Size
                        <input
                          type="number"
                          min={6}
                          max={48}
                          value={fontSizeInput ?? textStyleForPanel(visibleSelectedPanel).fontSize}
                          disabled={isSaving}
                          onChange={(event) => setFontSizeInput(event.target.value)}
                          onBlur={commitFontSizeInput}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') event.currentTarget.blur();
                          }}
                        />
                      </label>
                      <label>
                        Align
                        <select
                          value={textStyleForPanel(visibleSelectedPanel).align}
                          disabled={isSaving}
                          onChange={(event) => updateSelectedPanelTextStyle({ align: event.target.value as StoryPanelTextStyle['align'] })}
                        >
                          <option value="left">Left</option>
                          <option value="center">Center</option>
                          <option value="right">Right</option>
                        </select>
                      </label>
                    </div>
                    <div className="story-panels-rich-text-toolbar" aria-label="Text formatting">
                      <button type="button" className="secondary" disabled={isSaving} onMouseDown={(event) => event.preventDefault()} onClick={() => applyRichTextCommand('bold')}>Bold</button>
                      <button type="button" className="secondary" disabled={isSaving} onMouseDown={(event) => event.preventDefault()} onClick={() => applyRichTextCommand('italic')}>Italic</button>
                      <button type="button" className="secondary" disabled={isSaving} onMouseDown={(event) => event.preventDefault()} onClick={() => applyRichTextCommand('underline')}>Underline</button>
                    </div>
                    <div
                      ref={richTextEditorRef}
                      className="story-panels-rich-text-editor"
                      contentEditable={!isSaving}
                      suppressContentEditableWarning
                      style={textPanelCssProperties(
                        visibleSelectedPanel,
                        textStyleOverrideFromFontSizeInput(visibleSelectedPanel, selectedPanelId, fontSizeInput),
                        'editor',
                      )}
                      onKeyDown={(event) => event.stopPropagation()}
                      onInput={(event) => setCustomTextDraft(sanitizeRichText(event.currentTarget.innerHTML))}
                      onBlur={commitCustomTextDraft}
                    />
                  </div>
                )}
                </div>
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
          {pageMenu.kind === 'panel' && (() => {
            const menuPanel = displayDocument.panels.find((panel) => panel.id === pageMenu.panelId);
            if (!menuPanel || menuPanel.panelKind !== 'image') return null;
            return (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setPickerPanelId(menuPanel.id);
                    setPageMenu(null);
                  }}
                >
                  Choose image…
                </button>
                {menuPanel.activeAssetId && (
                  <>
                    <button
                      type="button"
                      className={cropModePanelId === menuPanel.id ? 'active' : ''}
                      onClick={() => {
                        onSelectPanel(menuPanel.id);
                        setCropModePanelId((current) => (current === menuPanel.id ? null : menuPanel.id));
                        setPageMenu(null);
                      }}
                    >
                      {cropModePanelId === menuPanel.id ? 'Done cropping' : 'Crop'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        clearPanelImage(menuPanel.id);
                        setPageMenu(null);
                      }}
                    >
                      Clear image
                    </button>
                    {!isDefaultImageCrop(menuPanel.imageCrop) && (
                      <button
                        type="button"
                        onClick={() => {
                          resetPanelImageCrop(menuPanel.id);
                          setPageMenu(null);
                        }}
                      >
                        Reset crop
                      </button>
                    )}
                  </>
                )}
              </>
            );
          })()}
        </div>
      )}
      {pendingCaptionDelete && (
        <div className="confirm-backdrop" onClick={() => setPendingCaptionDeleteId(null)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-story-caption-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="delete-story-caption-title">Delete {panelLabelFor(pendingCaptionDelete)}?</h2>
            <p>This will remove the caption from the page layout.</p>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setPendingCaptionDeleteId(null)}>Cancel</button>
              <button type="button" className="danger" disabled={isSaving} onClick={confirmDeleteCaption}>Delete caption</button>
            </div>
          </div>
        </div>
      )}
      {pendingPanelDelete && (
        <div className="confirm-backdrop" onClick={() => setPendingPanelDeleteId(null)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-story-panel-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="delete-story-panel-title">
              {pendingPanelDelete.sourceKind === 'story'
                ? `Remove Panel ${storyPanelNumberById.get(pendingPanelDelete.id) ?? ''} from layout?`
                : pendingPanelDelete.sourceKind === 'caption'
                ? `Delete ${panelLabelFor(pendingPanelDelete)}?`
                : pendingPanelDelete.panelKind === 'text' ? 'Delete text block?' : 'Delete image block?'}
            </h2>
            <p>
              {pendingPanelDelete.sourceKind === 'story'
                ? 'This removes the panel from the page layout. The panel chunk stays in Panel Chunks and can be placed again.'
                : 'This will remove the layout item from the page.'}
            </p>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setPendingPanelDeleteId(null)}>Cancel</button>
              <button type="button" className="danger" disabled={isSaving} onClick={confirmRemoveSelectedPanel}>
                {pendingPanelDelete.sourceKind === 'story' ? 'Remove from layout' : 'Delete'}
              </button>
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
              {pendingPageDeletePanelCount > 0 ? ` and ${pendingPageDeletePanelCount} panel${pendingPageDeletePanelCount === 1 ? '' : 's'} on it` : ''}.
            </p>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setPendingPageDeleteId(null)}>Cancel</button>
              <button type="button" className="danger" disabled={isSaving} onClick={confirmDeleteSelectedPage}>Delete page</button>
            </div>
          </div>
        </div>
      )}
      {pickerPanelId && (() => {
        const pickerPanel = displayDocument.panels.find((panel) => panel.id === pickerPanelId);
        if (!pickerPanel || pickerPanel.panelKind !== 'image') return null;
        return (
          <PanelImagePicker
            projectSlug={projectSlug}
            panelLabel={panelLabelFor(pickerPanel)}
            assets={assets}
            projectTags={projectTags}
            canvas={canvas}
            currentActiveAssetId={pickerPanel.activeAssetId}
            onSelect={(assetId) => {
              assignPanelImage(pickerPanelId, assetId);
              setPickerPanelId(null);
            }}
            onClose={() => setPickerPanelId(null)}
          />
        );
      })()}
    </>
  );
}
