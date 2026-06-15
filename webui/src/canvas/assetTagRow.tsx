import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TagDefinition } from '../types';
import { TagEditorPopover } from './tagEditor';
import { SYSTEM_TAGS, isEntityTag } from './shared';

export function resolveUserTags(tagIds: string[], projectTags: TagDefinition[]): TagDefinition[] {
  const byId = new Map(projectTags.map((tag) => [tag.id, tag]));
  return tagIds
    .filter((tagId) => !SYSTEM_TAGS.has(tagId))
    .map((tagId) => byId.get(tagId) ?? { id: tagId, name: tagId, color: '#64748b' });
}

export function NodeAssetTagRow({
  tagIds,
  projectTags,
  onChange,
  onCreateTag,
}: {
  tagIds: string[];
  projectTags: TagDefinition[];
  onChange: (tags: string[]) => void;
  onCreateTag: (tag: TagDefinition) => void;
}) {
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const resolvedTags = useMemo(() => resolveUserTags(tagIds, projectTags), [tagIds, projectTags]);
  const selectedTagIds = useMemo(() => resolvedTags.map((tag) => tag.id), [resolvedTags]);
  const hoverLabel = resolvedTags.map((tag) => tag.name).join(', ');

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const check = () => setIsTruncated(row.scrollWidth > row.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(row);
    return () => observer.disconnect();
  }, [resolvedTags]);

  useEffect(() => {
    if (!isEditorOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (menuRef.current?.contains(target)) return;
      setIsEditorOpen(false);
    };
    document.addEventListener('click', closeOnOutsideClick, true);
    return () => document.removeEventListener('click', closeOnOutsideClick, true);
  }, [isEditorOpen]);

  return (
    <div
      ref={menuRef}
      className="node-tag-menu nodrag nopan"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="node-tag-row-wrap"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          ref={rowRef}
          type="button"
          className={`node-tag-row ${isTruncated ? 'is-truncated' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            setIsEditorOpen((current) => !current);
          }}
          aria-expanded={isEditorOpen}
          aria-label={resolvedTags.length ? `Edit tags: ${hoverLabel}` : 'Add tags'}
        >
          <span className="node-tag-label">tags:</span>
          {resolvedTags.length === 0 ? (
            <span className="node-tag-placeholder">Add tags</span>
          ) : (
            resolvedTags.map((tag) => (
              <span
                key={tag.id}
                className={`node-tag-pill ${isEntityTag(tag.id, projectTags) ? 'entity-tag-pill' : ''}`}
                style={{ backgroundColor: tag.color }}
              >
                {tag.name}
              </span>
            ))
          )}
        </button>
        {resolvedTags.length > 0 && (isTruncated || resolvedTags.length > 1) && (
          <span className="node-tag-row-bubble" role="tooltip">
            {hoverLabel}
          </span>
        )}
      </div>
      {isEditorOpen && (
        <TagEditorPopover
          mode="assign"
          title="Assign tags"
          selectedTags={selectedTagIds}
          availableTags={projectTags}
          onChange={onChange}
          onCreateTag={onCreateTag}
        />
      )}
    </div>
  );
}
