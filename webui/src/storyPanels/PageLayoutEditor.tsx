import { useRef, useState } from 'react';
import type { StoryPanel, StoryPanelDocument, StoryPanelRect } from '../types';

const gridColumns = 12;
const minPanelHeight = 2;
const minPanelWidth = 2;

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

function sortedPages(document: StoryPanelDocument) {
  return [...document.pages].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function sortedPanelsForPage(document: StoryPanelDocument, pageId: string) {
  return document.panels
    .filter((panel) => panel.pageId === pageId)
    .sort((a, b) => panelLayer(a) - panelLayer(b) || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

function panelLayer(panel: StoryPanel) {
  return panel.panelKind === 'inlay' ? Math.max(1, panel.layer) : 0;
}

function rectsOverlap(a: StoryPanelRect, b: StoryPanelRect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function clampRect(rect: StoryPanelRect): StoryPanelRect {
  const w = Math.min(gridColumns, Math.max(minPanelWidth, Math.round(rect.w)));
  const h = Math.max(minPanelHeight, Math.round(rect.h));
  const x = Math.min(gridColumns - w, Math.max(0, Math.round(rect.x)));
  return { x, y: Math.max(0, Math.round(rect.y)), w, h };
}

function resizeRectFromCorner(rect: StoryPanelRect, corner: ResizeCorner, deltaColumns: number, deltaRows: number): StoryPanelRect {
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  let x = rect.x;
  let y = rect.y;
  let w = rect.w;
  let h = rect.h;
  if (corner.includes('w')) {
    x = Math.min(right - minPanelWidth, Math.max(0, rect.x + deltaColumns));
    w = right - x;
  } else {
    w = rect.w + deltaColumns;
  }
  if (corner.includes('n')) {
    y = Math.min(bottom - minPanelHeight, Math.max(0, rect.y + deltaRows));
    h = bottom - y;
  } else {
    h = rect.h + deltaRows;
  }
  return clampRect({ x, y, w, h });
}

function packPagePanels(panels: StoryPanel[]) {
  const placed: StoryPanel[] = [];
  const basePanels = panels.filter((panel) => panel.panelKind !== 'inlay').sort((a, b) => a.order - b.order || a.startOffset - b.startOffset);
  const inlayPanels = panels.filter((panel) => panel.panelKind === 'inlay');
  for (const panel of basePanels) {
    const rect = clampRect(panel.rect);
    let y = 0;
    while (placed.some((placedPanel) => rectsOverlap({ ...rect, y }, placedPanel.rect))) {
      y += 1;
    }
    placed.push({ ...panel, rect: { ...rect, y } });
  }
  return [
    ...placed,
    ...inlayPanels.map((panel) => ({ ...panel, rect: clampRect(panel.rect) })),
  ];
}

function packDocument(document: StoryPanelDocument): StoryPanelDocument {
  const panelsByPage = new Map<string, StoryPanel[]>();
  for (const panel of document.panels) {
    panelsByPage.set(panel.pageId, [...(panelsByPage.get(panel.pageId) ?? []), panel]);
  }
  const packedPanelsById = new Map<string, StoryPanel>();
  for (const panels of panelsByPage.values()) {
    for (const panel of packPagePanels(panels)) {
      packedPanelsById.set(panel.id, panel);
    }
  }
  return {
    ...document,
    panels: document.panels.map((panel) => packedPanelsById.get(panel.id) ?? panel),
  };
}

function nextPageId(document: StoryPanelDocument) {
  const ids = new Set(document.pages.map((page) => page.id));
  let index = document.pages.length + 1;
  while (ids.has(`page-${String(index).padStart(3, '0')}`)) index += 1;
  return `page-${String(index).padStart(3, '0')}`;
}

export function PageLayoutEditor({
  document,
  selectedPanelId,
  onSelectPanel,
  onSaveDocument,
  isSaving,
}: {
  document: StoryPanelDocument;
  selectedPanelId: string | null;
  onSelectPanel: (panelId: string) => void;
  onSaveDocument: (document: StoryPanelDocument) => void;
  isSaving: boolean;
}) {
  const pageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [draftDocument, setDraftDocument] = useState<StoryPanelDocument | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [undoStack, setUndoStack] = useState<StoryPanelDocument[]>([]);
  const [redoStack, setRedoStack] = useState<StoryPanelDocument[]>([]);
  const displayDocument = draftDocument ?? document;
  const pages = sortedPages(displayDocument);
  const clampedPageIndex = Math.min(Math.max(currentPageIndex, 0), Math.max(0, pages.length - 1));
  const spreadPages = pages.slice(clampedPageIndex, clampedPageIndex + 2);
  const currentPage = spreadPages[0] ?? pages[0] ?? null;
  const selectedPanel = displayDocument.panels.find((panel) => panel.id === selectedPanelId) ?? null;
  const pageAspectRatio = `${displayDocument.pageSettings.width} / ${displayDocument.pageSettings.height}`;
  const createPageDocument = () => {
    const id = nextPageId(displayDocument);
    return {
      ...displayDocument,
      pages: [...displayDocument.pages, { id, order: displayDocument.pages.length, title: `Page ${displayDocument.pages.length + 1}` }],
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
  const addPage = () => {
    const nextPageIndex = displayDocument.pages.length;
    commitDocument(createPageDocument());
    setCurrentPageIndex(nextPageIndex);
  };
  const goNext = () => {
    if (clampedPageIndex < pages.length - 1) {
      setCurrentPageIndex((index) => Math.min(pages.length - 1, index + 1));
      return;
    }
    const nextPageIndex = pages.length;
    commitDocument(createPageDocument());
    setCurrentPageIndex(nextPageIndex);
  };
  const moveToPage = (pageId: string) => {
    if (!selectedPanel) return;
    commitDocument({
      ...displayDocument,
      panels: displayDocument.panels.map((panel) => panel.id === selectedPanel.id ? { ...panel, pageId } : panel),
    });
  };
  const updateSelectedPanelKind = (panelKind: StoryPanel['panelKind']) => {
    if (!selectedPanel) return;
    const nextPanels = displayDocument.panels.map((panel) => {
      if (panel.id !== selectedPanel.id) return panel;
      if (panelKind === 'inlay') {
        return { ...panel, panelKind, layer: 1 };
      }
      return { ...panel, panelKind, layer: 0 };
    });
    commitDocument({ ...displayDocument, panels: nextPanels });
  };
  const updatePageSettings = (patch: Partial<StoryPanelDocument['pageSettings']>) => {
    commitDocument({
      ...displayDocument,
      pageSettings: {
        ...displayDocument.pageSettings,
        ...patch,
      },
    });
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
    const deltaColumns = targetPageId === state.pageId ? Math.round((event.clientX - state.startClientX) / columnWidth) : Math.round((event.clientX - bounds.left) / columnWidth) - state.startRect.x;
    const deltaRows = targetPageId === state.pageId ? Math.round((event.clientY - state.startClientY) / rowHeight) : Math.round((event.clientY - bounds.top) / rowHeight) - state.startRect.y;
    const nextPanels = displayDocument.panels.map((panel) => {
      if (panel.id !== state.panelId) return panel;
      if (state.mode === 'resize') {
        return {
          ...panel,
          rect: resizeRectFromCorner(state.startRect, state.corner ?? 'se', deltaColumns, deltaRows),
        };
      }
      return {
        ...panel,
        pageId: targetPageId,
        rect: clampRect({
          ...state.startRect,
          x: state.startRect.x + deltaColumns,
          y: state.startRect.y + deltaRows,
        }),
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
  const fixOverlaps = () => {
    commitDocument(packDocument(displayDocument));
  };

  return (
    <section className="story-card story-panels-layout-card">
      <div className="story-panels-section-head">
        <div>
          <h2>Page Layout</h2>
          <p className="muted">Arrange selected text chunks as comic page panels.</p>
        </div>
      </div>
      <div className="story-panels-page-settings">
        <fieldset>
          <legend>Page ratio</legend>
          <label>
            Width
            <input
              type="number"
              min={1}
              max={100}
              value={displayDocument.pageSettings.width}
              disabled={isSaving}
              onChange={(event) => updatePageSettings({ width: Math.max(1, Number(event.target.value) || 1) })}
            />
          </label>
          <span aria-hidden="true">:</span>
          <label>
            Height
            <input
              type="number"
              min={1}
              max={100}
              value={displayDocument.pageSettings.height}
              disabled={isSaving}
              onChange={(event) => updatePageSettings({ height: Math.max(1, Number(event.target.value) || 1) })}
            />
          </label>
        </fieldset>
        <div className="story-panels-page-nav" aria-label="Page navigation">
          <button type="button" className="secondary" disabled={isSaving || clampedPageIndex <= 0} onClick={() => setCurrentPageIndex((index) => Math.max(0, index - 1))}>
            Previous
          </button>
          <label>
            Page
            <input
              type="number"
              min={1}
              max={Math.max(1, pages.length)}
              value={pages.length ? clampedPageIndex + 1 : 0}
              disabled={isSaving || pages.length === 0}
              onChange={(event) => jumpToPage(Number(event.target.value))}
            />
          </label>
          <span className="story-panels-page-count">of {Math.max(1, pages.length)}</span>
          <button type="button" className="secondary" disabled={isSaving} onClick={goNext}>
            {clampedPageIndex >= pages.length - 1 ? 'New page' : 'Next'}
          </button>
          <button type="button" className="secondary" disabled={isSaving} onClick={addPage}>
            Add page
          </button>
        </div>
      </div>
      {selectedPanel && (
        <div className="story-panels-layout-controls">
          {currentPage && selectedPanel.pageId !== currentPage.id && (
            <button type="button" className="secondary" disabled={isSaving} onClick={() => moveToPage(currentPage.id)}>
              Move selected panel to this page
            </button>
          )}
          <label>
            Selected panel type
            <select value={selectedPanel.panelKind} disabled={isSaving} onChange={(event) => updateSelectedPanelKind(event.target.value as StoryPanel['panelKind'])}>
              <option value="image">Image panel</option>
              <option value="inlay">Inlay panel</option>
              <option value="text">Text / caption</option>
            </select>
          </label>
          <p className="story-panels-layout-hint">Drag panels to move them across the spread. Pull any corner handle to resize.</p>
        </div>
      )}
      <div className="story-panels-overlap-controls">
        <p className="story-panels-layout-hint">Panels may overlap while you tune sizing. Use cleanup when you want the current layout compacted again.</p>
        <div className="story-panels-history-actions">
          <button type="button" className="secondary" disabled={isSaving || undoStack.length === 0} onClick={undo}>
            Undo
          </button>
          <button type="button" className="secondary" disabled={isSaving || redoStack.length === 0} onClick={redo}>
            Redo
          </button>
          <button type="button" className="secondary" disabled={isSaving} onClick={fixOverlaps}>
            Fix overlaps
          </button>
        </div>
      </div>
      <div className="story-panels-pages">
        {spreadPages.length ? spreadPages.map((page) => {
          const pagePanels = sortedPanelsForPage(displayDocument, page.id);
          const pageRows = Math.max(10, ...pagePanels.map((panel) => panel.rect.y + panel.rect.h));
          return (
            <article key={page.id} className="story-panels-page">
              <h3>{page.title || page.id}</h3>
              <div
                ref={(element) => {
                  pageRefs.current[page.id] = element;
                }}
                className="story-panels-page-grid"
                style={{ aspectRatio: pageAspectRatio, gridTemplateRows: `repeat(${pageRows}, minmax(22px, 1fr))` }}
                onPointerMove={continueDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                {pagePanels.map((panel) => (
                  <button
                    key={panel.id}
                    type="button"
                    className={`story-panels-page-panel is-${panel.panelKind} ${selectedPanelId === panel.id ? 'is-selected' : ''} ${dragState?.panelId === panel.id ? 'is-dragging' : ''}`}
                    style={{
                      gridColumn: `${panel.rect.x + 1} / span ${panel.rect.w}`,
                      gridRow: `${panel.rect.y + 1} / span ${panel.rect.h}`,
                      zIndex: panelLayer(panel) + 1,
                    }}
                    onClick={() => onSelectPanel(panel.id)}
                    onPointerDown={(event) => beginDrag(event, panel, 'move')}
                  >
                    <strong>{panel.panelKind === 'text' ? 'Text' : panel.id}</strong>
                    <span>{panel.selectedText.replace(/\s+/g, ' ').trim().slice(0, 120)}</span>
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
        }) : <p className="muted">No pages yet.</p>}
      </div>
    </section>
  );
}
