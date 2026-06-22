import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { StoryPanel, StoryPanelPage } from '../types';
import { panelIsPlacedOnLayout } from './panelPlacement';
import { storyPagePlacementLabel } from './pageNumbers';
import {
  filterSidebarItems,
  manualPanelNumber,
  SIDEBAR_FILTER_OPTIONS,
  sidebarItemLabel,
  sidebarItemPrimaryText,
  sidebarItemSecondaryText,
  sortSidebarItems,
  type InsertDraftPayload,
  type SidebarFilter,
} from './storyPanelSidebar';

function compactText(value: string, maxLength = 180) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function itemTitle(panel: StoryPanel, panels: StoryPanel[], manualMode: boolean) {
  if (manualMode && panel.sourceKind === 'draft') {
    const number = manualPanelNumber(panels, panel.id);
    return number > 0 ? `Panel ${number}` : 'Panel';
  }
  return sidebarItemLabel(panel.sourceKind as 'story' | 'draft' | 'bookmark');
}

function deletePanelConfirmCopy(panel: StoryPanel, manualMode: boolean): { title: string; body: string } {
  if (panel.sourceKind === 'bookmark') {
    return {
      title: 'Delete bookmark?',
      body: 'This removes the bookmark from the reading list.',
    };
  }
  if (panel.sourceKind === 'draft') {
    return {
      title: manualMode ? 'Delete panel?' : 'Delete draft?',
      body: manualMode
        ? 'This removes the panel from your story and layout.'
        : 'This removes the draft from the reading list.',
    };
  }
  return {
    title: 'Delete panel chunk?',
    body: 'This removes the panel from the reading list and layout.',
  };
}

function ChunkActionsMenu({
  isOpen,
  onToggle,
  onClose,
  onDelete,
  onInsertAfter,
  onEditNote,
  onEditText,
  showInsert,
  showEditNote,
  showEditText,
  isSaving,
}: {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onDelete?: () => void;
  onInsertAfter?: () => void;
  onEditNote?: () => void;
  onEditText?: () => void;
  showInsert: boolean;
  showEditNote: boolean;
  showEditText: boolean;
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
  }, [isOpen, showInsert, showEditNote, showEditText, updatePopoverPosition]);

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
      {showInsert && onInsertAfter && (
        <button
          type="button"
          role="menuitem"
          className="story-panels-chunk-menu-item"
          disabled={isSaving}
          onClick={() => {
            onClose();
            onInsertAfter();
          }}
        >
          Insert after…
        </button>
      )}
      {showEditNote && onEditNote && (
        <button
          type="button"
          role="menuitem"
          className="story-panels-chunk-menu-item"
          disabled={isSaving}
          onClick={() => {
            onClose();
            onEditNote();
          }}
        >
          Edit note…
        </button>
      )}
      {showEditText && onEditText && (
        <button
          type="button"
          role="menuitem"
          className="story-panels-chunk-menu-item"
          disabled={isSaving}
          onClick={() => {
            onClose();
            onEditText();
          }}
        >
          Edit text…
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
  onInsertDraft,
  onEditPanelNote,
  onEditPanelText,
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
  onDeletePanel: (panelId: string) => void | Promise<void>;
  onInsertDraft?: (payload: InsertDraftPayload) => Promise<void>;
  onEditPanelNote?: (panelId: string, noteText: string) => Promise<void>;
  onEditPanelText?: (panelId: string, text: string) => Promise<void>;
  isSaving: boolean;
  variant?: 'card' | 'plain';
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const chunkRefs = useRef<Record<string, HTMLElement | null>>({});
  const [flashingPanelId, setFlashingPanelId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [insertAfterPanelId, setInsertAfterPanelId] = useState<string | null>(null);
  const [sidebarFilter, setSidebarFilter] = useState<SidebarFilter>('all');
  const [showInsertDialog, setShowInsertDialog] = useState(false);
  const [showNoteDialog, setShowNoteDialog] = useState(false);
  const [notePanelId, setNotePanelId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [noteText, setNoteText] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [pendingDeletePanelId, setPendingDeletePanelId] = useState<string | null>(null);
  const [showEditTextDialog, setShowEditTextDialog] = useState(false);
  const [editTextPanelId, setEditTextPanelId] = useState<string | null>(null);
  const [editTextValue, setEditTextValue] = useState('');
  const hasBookText = bookLength > 0;
  const manualMode = !hasBookText;
  const allItems = sortSidebarItems(panels);
  const sortedPanels = filterSidebarItems(panels, sidebarFilter);
  const coveredChars = allItems
    .filter((panel) => panel.sourceKind === 'story' && panel.startOffset !== null && panel.endOffset !== null)
    .reduce((total, panel) => total + (panel.endOffset! - panel.startOffset!), 0);
  const counts = {
    all: allItems.length,
    story: allItems.filter((panel) => panel.sourceKind === 'story').length,
    bookmark: allItems.filter((panel) => panel.sourceKind === 'bookmark').length,
    draft: allItems.filter((panel) => panel.sourceKind === 'draft').length,
  };
  const coverage = bookLength > 0 ? Math.round((coveredChars / bookLength) * 100) : 0;
  const canInsertDraft = Boolean(onInsertDraft) && !hasBookText;
  const pendingDeletePanel = pendingDeletePanelId
    ? panels.find((panel) => panel.id === pendingDeletePanelId) ?? null
    : null;

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

  const openInsertDialog = (afterPanelId: string | null = null) => {
    setInsertAfterPanelId(afterPanelId);
    setDraftText('');
    setOpenMenuId(null);
    setShowInsertDialog(true);
  };

  const openEditTextDialog = (panelId: string) => {
    const panel = panels.find((item) => item.id === panelId);
    setEditTextPanelId(panelId);
    setEditTextValue(panel ? sidebarItemPrimaryText(panel) : '');
    setOpenMenuId(null);
    setShowEditTextDialog(true);
  };

  const submitEditText = async () => {
    if (!editTextPanelId || !onEditPanelText) return;
    setIsCreating(true);
    try {
      await onEditPanelText(editTextPanelId, editTextValue.trim());
      setEditTextPanelId(null);
      setEditTextValue('');
      setShowEditTextDialog(false);
    } finally {
      setIsCreating(false);
    }
  };

  const openNoteDialog = (panelId: string) => {
    const panel = panels.find((item) => item.id === panelId);
    setNotePanelId(panelId);
    setNoteText(panel?.customText ?? '');
    setOpenMenuId(null);
    setShowNoteDialog(true);
  };

  const submitInsertDraft = async () => {
    const text = draftText.trim();
    if (!text || !onInsertDraft) return;
    setIsCreating(true);
    try {
      await onInsertDraft({ customText: text, insertAfterPanelId });
      setDraftText('');
      setInsertAfterPanelId(null);
      setShowInsertDialog(false);
    } finally {
      setIsCreating(false);
    }
  };

  const submitPanelNote = async () => {
    if (!notePanelId || !onEditPanelNote) return;
    setIsCreating(true);
    try {
      await onEditPanelNote(notePanelId, noteText.trim());
      setNotePanelId(null);
      setNoteText('');
      setShowNoteDialog(false);
    } finally {
      setIsCreating(false);
    }
  };

  const confirmDeletePanel = async () => {
    if (!pendingDeletePanelId) return;
    await onDeletePanel(pendingDeletePanelId);
    setPendingDeletePanelId(null);
  };

  const filterRow = !manualMode ? (
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
  ) : null;

  return (
    <div className={variant === 'plain' ? 'story-panels-chunks-pane' : 'story-card story-panels-list-card'}>
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
            {manualMode
              ? `${counts.all} panel${counts.all === 1 ? '' : 's'}`
              : `${counts.all} item${counts.all === 1 ? '' : 's'}${bookLength > 0 ? ` · ${counts.story} panels · ${coverage}% covered` : ''}`}
          </p>
          {canInsertDraft && (
            <button type="button" className="secondary story-panels-add-panel-button" disabled={isSaving || isCreating} onClick={() => openInsertDialog(null)}>
              + Add panel
            </button>
          )}
        </div>
      )}
      {filterRow}
      <div ref={listRef} className="story-panels-chunk-list">
        {sortedPanels.length === 0 ? (
          <div className="story-panels-chunk-empty">
            <p className="muted">
              {canInsertDraft
                ? manualMode
                  ? 'No panels yet. Add one here or continue writing in the story pane.'
                  : 'No items yet. Open the menu to insert a draft, or select a passage in Story.'
                : 'No items yet. Select a passage in the book text to begin.'}
            </p>
            {canInsertDraft && (
              <button type="button" className="secondary" disabled={isSaving || isCreating} onClick={() => openInsertDialog(null)}>
                Add first panel
              </button>
            )}
            {canInsertDraft && !manualMode && (
              <ChunkActionsMenu
                isOpen={openMenuId === '__empty__'}
                onToggle={() => setOpenMenuId((current) => (current === '__empty__' ? null : '__empty__'))}
                onClose={() => setOpenMenuId(null)}
                onInsertAfter={() => openInsertDialog(null)}
                showInsert
                showEditNote={false}
                showEditText={false}
                isSaving={isSaving || isCreating}
              />
            )}
          </div>
        ) : sortedPanels.map((panel) => {
          const primaryText = sidebarItemPrimaryText(panel);
          const secondaryText = sidebarItemSecondaryText(panel);
          const showPlacement = panel.sourceKind === 'story' || panel.sourceKind === 'draft';
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
                <strong>{itemTitle(panel, panels, manualMode)}</strong>
                <ChunkActionsMenu
                  isOpen={openMenuId === panel.id}
                  onToggle={() => setOpenMenuId((current) => (current === panel.id ? null : panel.id))}
                  onClose={() => setOpenMenuId(null)}
                  onDelete={() => setPendingDeletePanelId(panel.id)}
                  onInsertAfter={canInsertDraft ? () => openInsertDialog(panel.id) : undefined}
                  onEditNote={onEditPanelNote && panel.sourceKind === 'story' ? () => openNoteDialog(panel.id) : undefined}
                  onEditText={onEditPanelText && panel.sourceKind === 'draft' && manualMode ? () => openEditTextDialog(panel.id) : undefined}
                  showInsert={canInsertDraft}
                  showEditNote={Boolean(onEditPanelNote && panel.sourceKind === 'story')}
                  showEditText={Boolean(onEditPanelText && panel.sourceKind === 'draft' && manualMode)}
                  isSaving={isSaving || isCreating}
                />
                {!manualMode && panel.sourceKind === 'story' && panel.startOffset !== null && panel.endOffset !== null ? (
                  <span className="story-panels-chunk-range">{panel.startOffset}-{panel.endOffset}</span>
                ) : !manualMode && panel.sourceKind === 'draft' ? (
                  <span className="story-panels-chunk-kind">Draft</span>
                ) : !manualMode && panel.startOffset !== null && panel.endOffset !== null ? (
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
      {showInsertDialog && onInsertDraft && (
        <div className="confirm-backdrop" onClick={() => !isCreating && setShowInsertDialog(false)}>
          <div className="confirm-dialog story-panels-insert-dialog" role="dialog" aria-modal="true" aria-labelledby="insert-draft-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="insert-draft-title">{insertAfterPanelId ? 'Insert after' : manualMode ? 'Add panel' : 'Insert after'}</h2>
            <p className="muted">
              {manualMode
                ? 'Write the scene, dialogue, or narration for this panel.'
                : 'Write the passage, caption, or scene text for this draft chunk.'}
            </p>
            <label>
              {manualMode ? 'Panel text' : 'Draft text'}
              <textarea
                value={draftText}
                rows={6}
                autoFocus
                disabled={isCreating}
                placeholder="Once upon a time..."
                onChange={(event) => setDraftText(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="secondary" disabled={isCreating} onClick={() => {
                setShowInsertDialog(false);
                setInsertAfterPanelId(null);
              }}>Cancel</button>
              <button type="button" disabled={isCreating || !draftText.trim()} onClick={() => void submitInsertDraft()}>
                {isCreating ? 'Adding…' : manualMode ? 'Add panel' : 'Insert draft'}
              </button>
            </div>
          </div>
        </div>
      )}
      {showEditTextDialog && onEditPanelText && (
        <div className="confirm-backdrop" onClick={() => !isCreating && setShowEditTextDialog(false)}>
          <div className="confirm-dialog story-panels-insert-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-panel-text-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="edit-panel-text-title">Edit panel</h2>
            <label>
              Panel text
              <textarea
                value={editTextValue}
                rows={6}
                autoFocus
                disabled={isCreating}
                onChange={(event) => setEditTextValue(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="secondary" disabled={isCreating} onClick={() => setShowEditTextDialog(false)}>Cancel</button>
              <button type="button" disabled={isCreating || !editTextValue.trim()} onClick={() => void submitEditText()}>
                {isCreating ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
      {showNoteDialog && onEditPanelNote && (
        <div className="confirm-backdrop" onClick={() => !isCreating && setShowNoteDialog(false)}>
          <div className="confirm-dialog story-panels-insert-dialog" role="dialog" aria-modal="true" aria-labelledby="panel-note-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="panel-note-title">Panel note</h2>
            <p className="muted">Optional note about this passage.</p>
            <label>
              Note
              <textarea
                value={noteText}
                rows={5}
                autoFocus
                disabled={isCreating}
                placeholder="Adaptation notes, tone reminders..."
                onChange={(event) => setNoteText(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="secondary" disabled={isCreating} onClick={() => setShowNoteDialog(false)}>Cancel</button>
              <button type="button" disabled={isCreating} onClick={() => void submitPanelNote()}>
                {isCreating ? 'Saving…' : 'Save note'}
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingDeletePanel && (
        <div className="confirm-backdrop" onClick={() => !isSaving && setPendingDeletePanelId(null)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-chunk-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="delete-chunk-title">{deletePanelConfirmCopy(pendingDeletePanel, manualMode).title}</h2>
            <p>{deletePanelConfirmCopy(pendingDeletePanel, manualMode).body}</p>
            <div className="modal-actions">
              <button type="button" className="secondary" disabled={isSaving} onClick={() => setPendingDeletePanelId(null)}>Cancel</button>
              <button type="button" className="danger" disabled={isSaving} onClick={() => void confirmDeletePanel()}>
                {isSaving ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
