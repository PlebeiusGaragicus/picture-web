import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { StoryPanel, StoryPanelPage } from '../types';
import { panelIsPlacedOnLayout } from './panelPlacement';
import { storyPagePlacementLabel } from './pageNumbers';
import {
  filterSidebarItems,
  SIDEBAR_FILTER_OPTIONS,
  sidebarItemLabel,
  sidebarItemPrimaryText,
  sidebarItemSecondaryText,
  sortSidebarItems,
  type SidebarFilter,
} from './storyPanelSidebar';

function compactText(value: string, maxLength = 180) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function itemTitle(panel: StoryPanel, storyIndex: number | null) {
  const kind = sidebarItemLabel(panel.sourceKind as 'story' | 'draft' | 'note' | 'bookmark');
  if (panel.sourceKind === 'story' && storyIndex !== null) return `${kind} ${storyIndex}`;
  return kind;
}

function ChunkActionsMenu({
  isOpen,
  onToggle,
  onClose,
  onDelete,
  onNewPanel,
  showNewPanel,
  isSaving,
}: {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onDelete?: () => void;
  onNewPanel?: () => void;
  showNewPanel: boolean;
  isSaving: boolean;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 });
  const [isPositioned, setIsPositioned] = useState(false);

  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const popoverWidth = popover?.offsetWidth ?? 140;
    const popoverHeight = popover?.offsetHeight ?? 88;
    const gap = 4;
    const padding = 8;
    let top = rect.bottom + gap;
    if (top + popoverHeight > window.innerHeight - padding) {
      top = Math.max(padding, rect.top - popoverHeight - gap);
    }
    let left = rect.right - popoverWidth;
    left = Math.max(padding, Math.min(left, window.innerWidth - popoverWidth - padding));
    setPopoverPosition({ top, left });
    setIsPositioned(true);
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) {
      setIsPositioned(false);
      return;
    }
    updatePopoverPosition();
  }, [isOpen, showNewPanel, updatePopoverPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const reposition = () => updatePopoverPosition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    const list = triggerRef.current?.closest('.story-panels-chunk-list');
    list?.addEventListener('scroll', reposition);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      list?.removeEventListener('scroll', reposition);
    };
  }, [isOpen, updatePopoverPosition]);

  useEffect(() => {
    if (!isOpen || !popoverRef.current) return;
    const observer = new ResizeObserver(() => updatePopoverPosition());
    observer.observe(popoverRef.current);
    return () => observer.disconnect();
  }, [isOpen, updatePopoverPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [isOpen, onClose]);

  const popover = isOpen ? (
    <div
      ref={popoverRef}
      className="story-panels-chunk-menu-popover is-portaled"
      role="menu"
      style={{
        top: popoverPosition.top,
        left: popoverPosition.left,
        visibility: isPositioned ? 'visible' : 'hidden',
      }}
    >
      {showNewPanel && onNewPanel && (
        <button
          type="button"
          role="menuitem"
          className="story-panels-chunk-menu-item"
          disabled={isSaving}
          onClick={() => {
            onClose();
            onNewPanel();
          }}
        >
          New panel
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          role="menuitem"
          className="story-panels-chunk-menu-item story-panels-chunk-menu-item--danger"
          disabled={isSaving}
          onClick={() => {
            onClose();
            onDelete();
          }}
        >
          Delete
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="story-panels-chunk-menu" ref={menuRef} onClick={(event) => event.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        className="story-panels-chunk-menu-trigger"
        aria-label="Panel actions"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        disabled={isSaving}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        ⋯
      </button>
      {popover && createPortal(popover, document.body)}
    </div>
  );
}

export function PanelChunkList({
  bookLength,
  panels,
  pages,
  selectedPanelId,
  focusedPanelId,
  onSelectPanel,
  onOpenPanelPlacement,
  onDeletePanel,
  onCreatePanel,
  isSaving,
  variant = 'card',
}: {
  bookLength: number;
  panels: StoryPanel[];
  pages: StoryPanelPage[];
  selectedPanelId: string | null;
  focusedPanelId: string | null;
  onSelectPanel: (panelId: string) => void;
  onOpenPanelPlacement?: (panelId: string) => void;
  onDeletePanel: (panelId: string) => void;
  onCreatePanel?: (customText: string, insertAfterPanelId?: string | null) => Promise<void>;
  isSaving: boolean;
  variant?: 'card' | 'plain';
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const chunkRefs = useRef<Record<string, HTMLElement | null>>({});
  const [flashingPanelId, setFlashingPanelId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [insertAfterPanelId, setInsertAfterPanelId] = useState<string | null>(null);
  const [sidebarFilter, setSidebarFilter] = useState<SidebarFilter>('all');
  const [showNewPanelDialog, setShowNewPanelDialog] = useState(false);
  const [newPanelText, setNewPanelText] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const allItems = sortSidebarItems(panels);
  const sortedPanels = filterSidebarItems(panels, sidebarFilter);
  const storyNumberById = new Map(
    allItems.filter((panel) => panel.sourceKind === 'story').map((panel, index) => [panel.id, index + 1]),
  );
  const coveredChars = allItems
    .filter((panel) => panel.sourceKind === 'story' && panel.startOffset !== null && panel.endOffset !== null)
    .reduce((total, panel) => total + (panel.endOffset! - panel.startOffset!), 0);
  const counts = {
    all: allItems.length,
    story: allItems.filter((panel) => panel.sourceKind === 'story').length,
    note: allItems.filter((panel) => panel.sourceKind === 'note').length,
    bookmark: allItems.filter((panel) => panel.sourceKind === 'bookmark').length,
    draft: allItems.filter((panel) => panel.sourceKind === 'draft').length,
  };
  const coverage = bookLength > 0 ? Math.round((coveredChars / bookLength) * 100) : 0;

  useEffect(() => {
    if (!focusedPanelId) return;
    const chunk = chunkRefs.current[focusedPanelId];
    if (!chunk) return;
    const list = listRef.current;
    if (list) {
      const listRect = list.getBoundingClientRect();
      const chunkRect = chunk.getBoundingClientRect();
      const relativeTop = chunkRect.top - listRect.top + list.scrollTop;
      const relativeBottom = relativeTop + chunkRect.height;
      const padding = 12;
      let targetTop = list.scrollTop;
      if (relativeTop < list.scrollTop + padding) {
        targetTop = relativeTop - padding;
      } else if (relativeBottom > list.scrollTop + list.clientHeight - padding) {
        targetTop = relativeBottom - list.clientHeight + padding;
      }
      list.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    } else {
      chunk.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    setFlashingPanelId(focusedPanelId);
    const timeout = window.setTimeout(() => setFlashingPanelId((current) => (current === focusedPanelId ? null : current)), 1400);
    return () => window.clearTimeout(timeout);
  }, [focusedPanelId]);

  const openNewPanelDialog = (afterPanelId: string | null = null) => {
    setInsertAfterPanelId(afterPanelId);
    setOpenMenuId(null);
    setShowNewPanelDialog(true);
  };

  const submitNewPanel = async () => {
    const text = newPanelText.trim();
    if (!text || !onCreatePanel) return;
    setIsCreating(true);
    try {
      await onCreatePanel(text, insertAfterPanelId);
      setNewPanelText('');
      setInsertAfterPanelId(null);
      setShowNewPanelDialog(false);
    } finally {
      setIsCreating(false);
    }
  };

  const rootClassName = variant === 'plain' ? 'story-panels-chunks-pane' : 'story-card story-panels-list-card';
  const canCreatePanel = Boolean(onCreatePanel);

  const filterRow = (
    <div className="story-panels-sidebar-filters" role="tablist" aria-label="Filter reading items">
      {SIDEBAR_FILTER_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={sidebarFilter === option.id}
          className={`story-panels-sidebar-filter ${sidebarFilter === option.id ? 'is-active' : ''}`}
          onClick={() => setSidebarFilter(option.id)}
        >
          {option.label}
          <span className="story-panels-sidebar-filter-count">{counts[option.id]}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className={rootClassName}>
      {variant === 'card' && (
        <div className="story-panels-section-head">
          <div>
            <h2>Reading</h2>
            <p className="muted">
              {bookLength > 0
                ? `${counts.story} panels cover ${coverage}% of the book text.`
                : `${counts.all} item${counts.all === 1 ? '' : 's'}.`}
            </p>
          </div>
        </div>
      )}
      {variant === 'plain' && (
        <div className="story-panels-chunks-meta-row">
          <p className="story-panels-chunks-meta muted">
            {counts.all} item{counts.all === 1 ? '' : 's'}
            {bookLength > 0 ? ` · ${counts.story} panels · ${coverage}% covered` : ''}
          </p>
        </div>
      )}
      {filterRow}
      <div ref={listRef} className="story-panels-chunk-list">
        {sortedPanels.length === 0 ? (
          <div className="story-panels-chunk-empty">
            <p className="muted">
              {canCreatePanel
                ? 'No items yet. Open the menu to add one, or select a passage in Story.'
                : 'No items yet. Select a passage in the book text to begin.'}
            </p>
            {canCreatePanel && (
              <ChunkActionsMenu
                isOpen={openMenuId === '__empty__'}
                onToggle={() => setOpenMenuId((current) => (current === '__empty__' ? null : '__empty__'))}
                onClose={() => setOpenMenuId(null)}
                onNewPanel={() => openNewPanelDialog(null)}
                showNewPanel
                isSaving={isSaving || isCreating}
              />
            )}
          </div>
        ) : sortedPanels.map((panel) => {
          const storyIndex = panel.sourceKind === 'story' ? storyNumberById.get(panel.id) ?? null : null;
          const primaryText = sidebarItemPrimaryText(panel);
          const secondaryText = sidebarItemSecondaryText(panel);
          const showPlacement = panel.sourceKind === 'story' || panel.sourceKind === 'draft';
          const showNewPanelAction = canCreatePanel && (panel.sourceKind === 'story' || panel.sourceKind === 'draft');
          return (
          <article
            key={panel.id}
            ref={(element) => {
              chunkRefs.current[panel.id] = element;
            }}
            className={`story-panels-chunk story-panels-chunk--${panel.sourceKind} ${selectedPanelId === panel.id ? 'is-selected' : ''} ${openMenuId === panel.id ? 'is-menu-open' : ''} ${flashingPanelId === panel.id ? 'is-flashing' : ''}`}
            onClick={() => onSelectPanel(panel.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectPanel(panel.id);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div className="story-panels-chunk-main">
              <div className="story-panels-chunk-title-row">
                <strong>{itemTitle(panel, storyIndex)}</strong>
                <ChunkActionsMenu
                  isOpen={openMenuId === panel.id}
                  onToggle={() => setOpenMenuId((current) => (current === panel.id ? null : panel.id))}
                  onClose={() => setOpenMenuId(null)}
                  onDelete={() => onDeletePanel(panel.id)}
                  onNewPanel={showNewPanelAction ? () => openNewPanelDialog(panel.id) : undefined}
                  showNewPanel={showNewPanelAction}
                  isSaving={isSaving || isCreating}
                />
                {panel.sourceKind === 'story' && panel.startOffset !== null && panel.endOffset !== null ? (
                  <span className="story-panels-chunk-range">{panel.startOffset}-{panel.endOffset}</span>
                ) : panel.sourceKind === 'draft' ? (
                  <span className="story-panels-chunk-kind">Draft</span>
                ) : panel.startOffset !== null && panel.endOffset !== null ? (
                  <span className="story-panels-chunk-range">{panel.startOffset}-{panel.endOffset}</span>
                ) : null}
              </div>
              {showPlacement && (
                panelIsPlacedOnLayout(pages, panel) ? (
                  <button
                    type="button"
                    className="story-panels-placement-badge is-placed"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenPanelPlacement?.(panel.id);
                    }}
                  >
                    {storyPagePlacementLabel(pages, panel.pageId)}
                  </button>
                ) : (
                  <span className="story-panels-placement-badge is-unplaced">
                    {storyPagePlacementLabel(pages, panel.pageId)}
                  </span>
                )
              )}
              <p>{compactText(primaryText)}</p>
              {secondaryText && <p className="story-panels-chunk-excerpt muted">{compactText(secondaryText, 120)}</p>}
            </div>
          </article>
          );
        })}
      </div>
      {showNewPanelDialog && onCreatePanel && (
        <div className="confirm-backdrop" onClick={() => !isCreating && setShowNewPanelDialog(false)}>
          <div className="confirm-dialog story-panels-new-panel-dialog" role="dialog" aria-modal="true" aria-labelledby="new-panel-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="new-panel-title">New panel</h2>
            <p className="muted">
              {insertAfterPanelId
                ? 'Write the passage for the new panel inserted after this one.'
                : 'Write the passage, caption, or scene text for this panel chunk.'}
            </p>
            <label>
              Panel text
              <textarea
                value={newPanelText}
                rows={6}
                autoFocus
                disabled={isCreating}
                placeholder="Once upon a time..."
                onChange={(event) => setNewPanelText(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="secondary" disabled={isCreating} onClick={() => {
                setShowNewPanelDialog(false);
                setInsertAfterPanelId(null);
              }}>Cancel</button>
              <button type="button" disabled={isCreating || !newPanelText.trim()} onClick={() => void submitNewPanel()}>
                {isCreating ? 'Creating…' : 'Create panel'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
