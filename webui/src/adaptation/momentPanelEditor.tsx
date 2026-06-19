import { useState } from 'react';
import type { AdaptationStatus, MomentLayoutSection, StoryKind } from '../types';

function textFieldsForStoryKind(storyKind: StoryKind): Array<'narration' | 'dialogue' | 'caption'> {
  if (storyKind === 'comic-book') return ['dialogue', 'caption'];
  if (storyKind === 'illustrated-story') return ['narration', 'caption'];
  return ['narration'];
}

function textFieldLabel(field: 'narration' | 'dialogue' | 'caption') {
  if (field === 'narration') return 'Narration';
  if (field === 'dialogue') return 'Dialogue';
  return 'Caption';
}

function momentSuffix(storyKind: StoryKind) {
  return storyKind === 'comic-book' ? 'panel' : 'page';
}

function nextSectionKey(sceneSlug: string, storyKind: StoryKind, sections: MomentLayoutSection[]) {
  const suffix = momentSuffix(storyKind);
  const used = new Set(sections.map((section) => section.key));
  for (let index = 1; index < 100; index += 1) {
    const key = `${sceneSlug}-${suffix}-${String(index).padStart(2, '0')}`;
    if (!used.has(key)) return key;
  }
  return `${sceneSlug}-${suffix}-99`;
}

function emptySection(sceneSlug: string, storyKind: StoryKind, sections: MomentLayoutSection[]): MomentLayoutSection {
  const label = storyKind === 'comic-book' ? 'Panel' : 'Page';
  return {
    key: nextSectionKey(sceneSlug, storyKind, sections),
    refs: '',
    narration: '',
    dialogue: '',
    caption: '',
    prompt: `${label} description. No watermarks.`,
  };
}

function validateSections(sections: MomentLayoutSection[]): string | null {
  const keys = sections.map((section) => section.key.trim());
  if (keys.some((key) => !key)) return 'Every panel needs a slug.';
  if (new Set(keys).size !== keys.length) return 'Panel slugs must be unique.';
  for (const section of sections) {
    if (!section.prompt.trim()) return `Panel ${section.key} needs an image prompt.`;
    if (!section.prompt.includes('No watermarks.')) {
      return `Panel ${section.key} prompt must end with "No watermarks."`;
    }
  }
  return null;
}

export function MomentPanelEditor({
  sceneSlug,
  storyKind,
  adaptation,
  initialSections,
  initialBody,
  isSaving,
  onSaveSections,
  onSaveBody,
  onCancel,
}: {
  sceneSlug: string;
  storyKind: StoryKind;
  adaptation: AdaptationStatus;
  initialSections: MomentLayoutSection[];
  initialBody: string;
  isSaving: boolean;
  onSaveSections: (sections: MomentLayoutSection[]) => Promise<void>;
  onSaveBody: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [tab, setTab] = useState<'panels' | 'raw'>('panels');
  const [sections, setSections] = useState<MomentLayoutSection[]>(initialSections);
  const [rawBody, setRawBody] = useState(initialBody);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(initialSections[0]?.key ?? null);
  const [error, setError] = useState<string | null>(null);

  const textFields = textFieldsForStoryKind(storyKind);
  const itemLabel = storyKind === 'comic-book' ? 'Panel' : 'Page';

  const updateSection = (index: number, patch: Partial<MomentLayoutSection>) => {
    setSections((current) => current.map((section, itemIndex) => (itemIndex === index ? { ...section, ...patch } : section)));
  };

  const moveSection = (from: number, to: number) => {
    if (to < 0 || to >= sections.length || from === to) return;
    setSections((current) => {
      const next = [...current];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const onDrop = (targetIndex: number) => {
    if (dragIndex === null) return;
    moveSection(dragIndex, targetIndex);
    setDragIndex(null);
  };

  const addSection = () => {
    const section = emptySection(sceneSlug, storyKind, sections);
    setSections((current) => [...current, section]);
    setExpandedKey(section.key);
  };

  const deleteSection = (index: number) => {
    const section = sections[index];
    const link = adaptation.panels[section.key] ?? adaptation.pages[section.key];
    if (link?.assetIds?.length) {
      const confirmed = window.confirm(
        `Delete ${section.key}? It has ${link.assetIds.length} generated image(s); metadata for this panel will be removed.`,
      );
      if (!confirmed) return;
    }
    setSections((current) => current.filter((_, itemIndex) => itemIndex !== index));
    if (expandedKey === section.key) {
      setExpandedKey(sections[index + 1]?.key ?? sections[index - 1]?.key ?? null);
    }
  };

  const save = async () => {
    setError(null);
    if (tab === 'raw') {
      await onSaveBody(rawBody);
      return;
    }
    const validationError = validateSections(sections);
    if (validationError) {
      setError(validationError);
      return;
    }
    await onSaveSections(sections);
  };

  return (
    <div className="adaptation-file-form moment-panel-editor">
      <div className="moment-panel-editor-tabs">
        <button
          type="button"
          className={tab === 'panels' ? 'is-active' : 'secondary'}
          onClick={() => setTab('panels')}
        >
          {itemLabel}s
        </button>
        <button
          type="button"
          className={tab === 'raw' ? 'is-active' : 'secondary'}
          onClick={() => setTab('raw')}
        >
          Raw markdown
        </button>
      </div>

      {tab === 'panels' ? (
        <>
          <div className="moment-panel-editor-toolbar">
            <button type="button" className="secondary" onClick={addSection} disabled={isSaving}>
              Add {itemLabel.toLowerCase()}
            </button>
            <span className="muted">{sections.length} {itemLabel.toLowerCase()}{sections.length === 1 ? '' : 's'}</span>
          </div>
          <div className="moment-panel-editor-list">
            {sections.map((section, index) => {
              const expanded = expandedKey === section.key;
              return (
                <div
                  key={`${section.key}-${index}`}
                  className={`moment-panel-editor-row scene-list-row ${dragIndex === index ? 'is-dragging' : ''}`}
                  draggable={!isSaving}
                  onDragStart={() => setDragIndex(index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => onDrop(index)}
                >
                  <button type="button" className="scene-list-drag-handle" aria-label="Drag to reorder" tabIndex={-1}>
                    ⋮⋮
                  </button>
                  <div className="moment-panel-editor-row-main">
                    <button
                      type="button"
                      className="moment-panel-editor-summary"
                      onClick={() => setExpandedKey(expanded ? null : section.key)}
                    >
                      <strong>{section.key || 'Untitled panel'}</strong>
                      <small className="muted">{expanded ? 'Collapse' : 'Expand'}</small>
                    </button>
                    {expanded && (
                      <div className="moment-panel-editor-fields">
                        <label className="field-label">
                          Slug
                          <input
                            value={section.key}
                            disabled={isSaving}
                            onChange={(event) => updateSection(index, { key: event.target.value.trim().toLowerCase() })}
                          />
                        </label>
                        <label className="field-label">
                          Refs
                          <input
                            value={section.refs}
                            disabled={isSaving}
                            onChange={(event) => updateSection(index, { refs: event.target.value })}
                            placeholder="character:hero-base, location:barn"
                          />
                        </label>
                        {textFields.map((field) => (
                          <label key={field} className="field-label">
                            {textFieldLabel(field)}
                            <textarea
                              className="modal-textarea"
                              rows={field === 'narration' ? 3 : 2}
                              value={section[field]}
                              disabled={isSaving}
                              onChange={(event) => updateSection(index, { [field]: event.target.value })}
                            />
                          </label>
                        ))}
                        <label className="field-label">
                          Image prompt
                          <textarea
                            className="modal-textarea"
                            rows={5}
                            value={section.prompt}
                            disabled={isSaving}
                            onChange={(event) => updateSection(index, { prompt: event.target.value })}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                  <div className="scene-list-row-actions">
                    <button type="button" className="secondary" disabled={index === 0 || isSaving} onClick={() => moveSection(index, index - 1)}>
                      ↑
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={index === sections.length - 1 || isSaving}
                      onClick={() => moveSection(index, index + 1)}
                    >
                      ↓
                    </button>
                    <button type="button" className="secondary" disabled={isSaving} onClick={() => deleteSection(index)}>
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
            {!sections.length && <p className="muted">No panels yet. Add one or switch to Raw markdown.</p>}
          </div>
        </>
      ) : (
        <textarea
          className="modal-textarea"
          value={rawBody}
          onChange={(event) => setRawBody(event.target.value)}
          rows={18}
          disabled={isSaving}
        />
      )}

      {error && <p className="moment-panel-editor-error">{error}</p>}

      <div className="scene-list-header-actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={isSaving}>
          Cancel
        </button>
        <button type="button" className="generate-button" onClick={() => void save()} disabled={isSaving}>
          {isSaving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}
