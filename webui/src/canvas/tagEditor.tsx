import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TagDefinition } from '../types';
import { isValidTagName, normalizeTagName, tagColorOptions, tagColors } from './shared';

type TagEditorMode = 'assign' | 'filter';

export function TagColorPickerPopover({
  selectedColor,
  onSelect,
  onClose,
  anchorRef,
}: {
  selectedColor: string;
  onSelect: (color: string) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [isPositioned, setIsPositioned] = useState(false);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const popoverHeight = popover?.offsetHeight ?? 285;
    const popoverWidth = popover?.offsetWidth ?? 168;
    const gap = 6;
    const padding = 8;
    let top = rect.bottom + gap;
    if (top + popoverHeight > window.innerHeight - padding) {
      top = Math.max(padding, rect.top - popoverHeight - gap);
    }
    let left = rect.left;
    if (left + popoverWidth > window.innerWidth - padding) {
      left = window.innerWidth - popoverWidth - padding;
    }
    left = Math.max(padding, left);
    setPosition({ top, left });
    setIsPositioned(true);
  }, [anchorRef]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition, selectedColor]);

  useEffect(() => {
    const reposition = () => updatePosition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [updatePosition]);

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', closeOnOutsideClick, true);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick, true);
  }, [anchorRef, onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      className="tag-color-picker-popover"
      style={{ top: position.top, left: position.left, visibility: isPositioned ? 'visible' : 'hidden' }}
      onClick={(event) => event.stopPropagation()}
    >
      {tagColorOptions.map(({ color, label }) => (
        <button
          key={color}
          type="button"
          className={selectedColor === color ? 'active' : ''}
          onClick={() => {
            onSelect(color);
            onClose();
          }}
        >
          <span className="tag-color-dot" style={{ backgroundColor: color }} />
          <span>{label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function TagEditorPopover({
  mode,
  title,
  selectedTags,
  availableTags,
  tagCounts = {},
  onChange,
  onCreateTag,
}: {
  mode: TagEditorMode;
  title: string;
  selectedTags: string[];
  availableTags: TagDefinition[];
  tagCounts?: Record<string, number>;
  onChange: (tags: string[]) => void;
  onCreateTag?: (tag: TagDefinition) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedColor, setSelectedColor] = useState<string | null>(null);
  const normalizedQuery = normalizeTagName(query);
  const selected = new Set(selectedTags);
  const availableById = useMemo(() => new Map(availableTags.map((tag) => [tag.id, tag])), [availableTags]);
  const suggestions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return availableTags
      .filter((tag) => !needle || tag.name.toLowerCase().includes(needle) || tag.id.includes(normalizedQuery))
      .sort((first, second) => first.name.localeCompare(second.name));
  }, [availableTags, normalizedQuery, query]);
  const canShowCreate = mode === 'assign' && normalizedQuery && isValidTagName(normalizedQuery) && !availableById.has(normalizedQuery);
  const canCreate = Boolean(canShowCreate && selectedColor);

  const toggleTag = (tagId: string) => {
    onChange(selected.has(tagId) ? selectedTags.filter((item) => item !== tagId) : [...selectedTags, tagId]);
    setQuery('');
  };

  const createTag = () => {
    if (!canCreate || !onCreateTag) return;
    if (!selectedColor) return;
    const displayName = query.trim() || normalizedQuery;
    const tag = { id: normalizedQuery, name: displayName, color: selectedColor };
    onCreateTag(tag);
    onChange([...selectedTags, tag.id]);
    setQuery('');
    setSelectedColor(null);
  };

  const removeTag = (tagId: string) => onChange(selectedTags.filter((item) => item !== tagId));

  return (
    <div className="tag-editor-popover">
      <h3>{title}</h3>
      <div className="tag-editor-input">
        {selectedTags.map((tagId) => (
          <button key={tagId} className="tag-chip" onClick={() => removeTag(tagId)} style={{ backgroundColor: availableById.get(tagId)?.color ?? '#64748b' }}>
            {availableById.get(tagId)?.name ?? tagId}
          </button>
        ))}
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              const exact = availableById.get(normalizedQuery);
              if (exact) toggleTag(exact.id);
              else createTag();
            }
            if (event.key === 'Backspace' && !query && selectedTags.length) {
              removeTag(selectedTags[selectedTags.length - 1]);
            }
          }}
          placeholder={selectedTags.length ? '' : mode === 'assign' ? 'Add tag' : 'Filter tags'}
          autoFocus
        />
      </div>
      <div className="tag-suggestion-list">
        {mode === 'filter' && (
          <button className="tag-clear-row" disabled={selectedTags.length === 0} onClick={() => onChange([])}>
            Clear
          </button>
        )}
        {suggestions.map((tag) => (
          <button key={tag.id} className={selected.has(tag.id) ? 'active' : ''} onClick={() => toggleTag(tag.id)}>
            <span className="tag-color-dot" style={{ backgroundColor: tag.color }} />
            <span className="tag-suggestion-name">{tag.name}</span>
            {tagCounts[tag.id] !== undefined && <span className="tag-suggestion-count">({tagCounts[tag.id]})</span>}
          </button>
        ))}
        {canShowCreate && (
          <>
            <button className="tag-create-row" onClick={createTag} disabled={!canCreate}>
              <span className="tag-color-dot empty" />
              Create new tag "{query.trim() || normalizedQuery}"
            </button>
            <div className="tag-color-row">
              {tagColors.map((color) => (
                <button
                  key={color}
                  className={selectedColor === color ? 'active' : ''}
                  onClick={() => setSelectedColor(color)}
                  aria-label={`Use ${color}`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
