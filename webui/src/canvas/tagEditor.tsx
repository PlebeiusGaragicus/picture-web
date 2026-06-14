import { useMemo, useState } from 'react';
import type { TagDefinition } from '../types';
import { isValidTagName, normalizeTagName, tagColors } from './shared';

type TagEditorMode = 'assign' | 'filter';

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
  const availableByName = useMemo(() => new Map(availableTags.map((tag) => [tag.name, tag])), [availableTags]);
  const suggestions = useMemo(() => {
    return availableTags
      .filter((tag) => !normalizedQuery || tag.name.includes(normalizedQuery))
      .sort((first, second) => first.name.localeCompare(second.name));
  }, [availableTags, normalizedQuery]);
  const canShowCreate = mode === 'assign' && normalizedQuery && isValidTagName(normalizedQuery) && !availableByName.has(normalizedQuery);
  const canCreate = Boolean(canShowCreate && selectedColor);

  const toggleTag = (tag: string) => {
    onChange(selected.has(tag) ? selectedTags.filter((item) => item !== tag) : [...selectedTags, tag]);
    setQuery('');
  };

  const createTag = () => {
    if (!canCreate || !onCreateTag) return;
    if (!selectedColor) return;
    const tag = { name: normalizedQuery, color: selectedColor };
    onCreateTag(tag);
    onChange([...selectedTags, tag.name]);
    setQuery('');
  };

  const removeTag = (tag: string) => onChange(selectedTags.filter((item) => item !== tag));

  return (
    <div className="tag-editor-popover">
      <h3>{title}</h3>
      <div className="tag-editor-input">
        {selectedTags.map((tag) => (
          <button key={tag} className="tag-chip" onClick={() => removeTag(tag)} style={{ backgroundColor: availableByName.get(tag)?.color ?? '#64748b' }}>
            {tag}
          </button>
        ))}
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              const exact = availableByName.get(normalizedQuery);
              if (exact) toggleTag(exact.name);
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
          <button className={selectedTags.length === 0 ? 'active' : ''} onClick={() => onChange([])}>
            All
          </button>
        )}
        {suggestions.map((tag) => (
          <button key={tag.name} className={selected.has(tag.name) ? 'active' : ''} onClick={() => toggleTag(tag.name)}>
            <span className="tag-color-dot" style={{ backgroundColor: tag.color }} />
            <span className="tag-suggestion-name">{tag.name}</span>
            {tagCounts[tag.name] !== undefined && <span className="tag-suggestion-count">({tagCounts[tag.name]})</span>}
          </button>
        ))}
        {canShowCreate && (
          <>
            <button className="tag-create-row" onClick={createTag} disabled={!canCreate}>
              <span className="tag-color-dot empty" />
              Create new tag "{normalizedQuery}"
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
