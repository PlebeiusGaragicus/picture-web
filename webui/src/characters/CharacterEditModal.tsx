import { useEffect, useState } from 'react';
import { Modal } from '../ui';
import { TagControlButton } from '../canvas/assetTagRow';
import { SYSTEM_TAGS } from '../canvas/shared';
import { slugifyKey } from './characterShared';
import type { usePiTask } from '../sessions/usePiTask';
import type { CharacterRecord, TagDefinition } from '../types';

type PiTaskController = ReturnType<typeof usePiTask>;

export interface CharacterVariantDraft {
  label: string;
  storyContext: string;
  mode: string;
  styleRef: string;
  prompt: string;
}

export interface CharacterDraft {
  name: string;
  summary: string;
  visualDescription: string;
  performanceNotes: string;
  continuityNotes: string;
  tagIds: string[];
  variants: Record<string, CharacterVariantDraft>;
  removedVariants: string[];
}

function draftFromRecord(record: CharacterRecord, entityTagId: string): CharacterDraft {
  return {
    name: record.name,
    summary: record.summary,
    visualDescription: record.visualDescription,
    performanceNotes: record.performanceNotes,
    continuityNotes: record.continuityNotes,
    tagIds: Array.from(new Set([entityTagId, ...record.userTags])),
    variants: Object.fromEntries(
      Object.entries(record.variants).map(([variantKey, variant]) => [
        variantKey,
        {
          label: variant.label,
          storyContext: variant.storyContext,
          mode: variant.mode,
          styleRef: variant.styleRef,
          prompt: variant.prompt,
        },
      ]),
    ),
    removedVariants: [],
  };
}

function variantDisplayLabel(variantKey: string, draft: CharacterVariantDraft): string {
  if (variantKey === 'base') return 'Base';
  return draft.label.trim() || variantKey
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function sortedVariantKeys(keys: string[]): string[] {
  return [...keys].sort((left, right) => {
    if (left === 'base') return -1;
    if (right === 'base') return 1;
    return left.localeCompare(right);
  });
}

export function CharacterEditModal({
  characterSlug,
  record,
  isExtracted,
  hasBookSession,
  projectTags,
  busy,
  extractTask,
  refineTask,
  onSave,
  onClose,
  onRequestDelete,
  onCreateTag,
}: {
  characterSlug: string;
  record: CharacterRecord;
  isExtracted: boolean;
  hasBookSession: boolean;
  projectTags: TagDefinition[];
  busy: boolean;
  extractTask: PiTaskController;
  refineTask: PiTaskController;
  onSave: (draft: CharacterDraft) => Promise<void>;
  onClose: () => void;
  onRequestDelete: () => void;
  onCreateTag: (tag: TagDefinition) => void;
}) {
  const [draft, setDraft] = useState<CharacterDraft>(() => draftFromRecord(record, characterSlug));
  const [newVariantKey, setNewVariantKey] = useState('');
  const [refineFeedback, setRefineFeedback] = useState('');

  // Re-seed the form when the agent lands an extract/refine result for this record.
  useEffect(() => {
    setDraft(draftFromRecord(record, characterSlug));
  }, [characterSlug, record.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const extracting = extractTask.isActive && extractTask.target === characterSlug;
  const refining = refineTask.isActive && refineTask.target === characterSlug;
  const agentBusy = extracting || refining;

  const setField = (field: keyof CharacterDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const setVariantField = (variantKey: string, field: keyof CharacterVariantDraft, value: string) => {
    setDraft((current) => ({
      ...current,
      variants: {
        ...current.variants,
        [variantKey]: { ...current.variants[variantKey], [field]: value },
      },
    }));
  };

  const addVariant = () => {
    const key = slugifyKey(newVariantKey || 'variant');
    if (!key || draft.variants[key]) return;
    setDraft((current) => ({
      ...current,
      variants: {
        ...current.variants,
        [key]: {
          label: newVariantKey.trim(),
          storyContext: '',
          mode: key === 'base' ? 'new-image' : 'edit-reference',
          styleRef: '',
          prompt: '',
        },
      },
      removedVariants: current.removedVariants.filter((removed) => removed !== key),
    }));
    setNewVariantKey('');
  };

  const removeVariant = (variantKey: string) => {
    setDraft((current) => {
      const variants = { ...current.variants };
      delete variants[variantKey];
      return {
        ...current,
        variants,
        removedVariants: record.variants[variantKey]
          ? Array.from(new Set([...current.removedVariants, variantKey]))
          : current.removedVariants,
      };
    });
  };

  const startExtract = () => {
    void extractTask.start({ target: characterSlug });
  };

  const startRefine = () => {
    const feedback = refineFeedback.trim();
    if (!feedback) return;
    void refineTask.start({ target: characterSlug, instructions: feedback });
    setRefineFeedback('');
  };

  const variantKeys = sortedVariantKeys(Object.keys(draft.variants));

  return (
    <Modal
      title={draft.name || characterSlug}
      dialogClassName="editor-dialog--character-edit"
      onClose={onClose}
    >
      <div className="adaptation-file-form character-edit-form">
        {!isExtracted && (
          <div className="character-edit-agent-row">
            <p className="muted">
              This character is registered but empty. Extract it to fill in the description and reference-sheet prompts from the book.
            </p>
            <button
              className="generate-button"
              type="button"
              disabled={!hasBookSession || agentBusy}
              title={hasBookSession ? 'Fill this record from the book with pi' : 'Read the book first (Story view)'}
              onClick={startExtract}
            >
              {extracting ? 'Extracting…' : 'Extract with pi'}
            </button>
          </div>
        )}
        <label className="field-label character-edit-name">
          Character name
          <input
            type="text"
            value={draft.name}
            onChange={(event) => setField('name', event.target.value)}
            placeholder="Character name"
          />
        </label>
        <div className="field-label">
          Tags
          <div className="character-edit-tags">
            <TagControlButton
              tagIds={draft.tagIds}
              projectTags={projectTags}
              onPartitionedTagsChange={(userTags, characterTags, locationTags) => {
                setDraft((current) => ({
                  ...current,
                  tagIds: Array.from(new Set([
                    ...current.tagIds.filter((tagId) => SYSTEM_TAGS.has(tagId)),
                    ...userTags,
                    characterSlug,
                    ...characterTags.filter((tagId) => tagId !== characterSlug),
                    ...locationTags,
                  ])),
                }));
              }}
              onCreateTag={onCreateTag}
              className="character-edit-tag-control"
              portaled
            />
          </div>
        </div>
        <label className="field-label">
          Summary
          <textarea
            className="modal-textarea"
            rows={3}
            value={draft.summary}
            onChange={(event) => setField('summary', event.target.value)}
            placeholder="Who they are and why they matter in the story"
          />
        </label>
        <label className="field-label">
          Visual description
          <textarea
            className="modal-textarea"
            rows={6}
            value={draft.visualDescription}
            onChange={(event) => setField('visualDescription', event.target.value)}
            placeholder="Body, face, clothing, silhouette, recurring visual traits"
          />
        </label>
        <label className="field-label">
          Performance notes
          <textarea
            className="modal-textarea"
            rows={4}
            value={draft.performanceNotes}
            onChange={(event) => setField('performanceNotes', event.target.value)}
            placeholder="Temperament, speech, posture, mannerisms — the material expressions are chosen from"
          />
        </label>
        <label className="field-label">
          Continuity notes
          <textarea
            className="modal-textarea"
            rows={3}
            value={draft.continuityNotes}
            onChange={(event) => setField('continuityNotes', event.target.value)}
            placeholder="Traits that must stay consistent across panels and variants"
          />
        </label>

        <div className="character-edit-variant-list">
          <h3 className="character-edit-section-heading">Variants</h3>
          {variantKeys.length === 0 && (
            <p className="muted">No variants yet. Extract with pi, or add a base variant to write a reference-sheet prompt by hand.</p>
          )}
          {variantKeys.map((variantKey) => {
            const variant = draft.variants[variantKey];
            return (
              <div key={variantKey} className="character-edit-variant-item character-edit-variant-card">
                <div className="character-edit-variant-head">
                  <strong>{variantDisplayLabel(variantKey, variant)}</strong>
                  <code className="muted">{variantKey}</code>
                  {variantKey !== 'base' && (
                    <button className="secondary character-edit-variant-remove" type="button" onClick={() => removeVariant(variantKey)}>
                      Remove
                    </button>
                  )}
                </div>
                {variantKey !== 'base' && (
                  <div className="character-edit-variant-meta">
                    <label className="field-label">
                      Label
                      <input
                        type="text"
                        value={variant.label}
                        onChange={(event) => setVariantField(variantKey, 'label', event.target.value)}
                        placeholder="Post-duel"
                      />
                    </label>
                    <label className="field-label">
                      Story context
                      <input
                        type="text"
                        value={variant.storyContext}
                        onChange={(event) => setVariantField(variantKey, 'storyContext', event.target.value)}
                        placeholder="After the duel in chapter 2"
                      />
                    </label>
                  </div>
                )}
                <label className="field-label">
                  Image prompt
                  <textarea
                    className="modal-textarea"
                    rows={6}
                    value={variant.prompt}
                    onChange={(event) => setVariantField(variantKey, 'prompt', event.target.value)}
                  />
                </label>
                <details className="character-edit-variant-advanced">
                  <summary className="muted">Advanced</summary>
                  <div className="character-edit-variant-meta">
                    <label className="field-label">
                      Mode
                      <input
                        type="text"
                        value={variant.mode}
                        onChange={(event) => setVariantField(variantKey, 'mode', event.target.value)}
                        placeholder="new-image | edit-reference"
                      />
                    </label>
                    <label className="field-label">
                      Style ref
                      <input
                        type="text"
                        value={variant.styleRef}
                        onChange={(event) => setVariantField(variantKey, 'styleRef', event.target.value)}
                      />
                    </label>
                  </div>
                </details>
              </div>
            );
          })}
          <div className="character-edit-variant-add">
            <input
              type="text"
              value={newVariantKey}
              onChange={(event) => setNewVariantKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addVariant();
                }
              }}
              placeholder={variantKeys.length ? 'New variant, e.g. "young" or "post-duel"' : 'base'}
            />
            <button className="secondary" type="button" onClick={addVariant} disabled={!slugifyKey(newVariantKey || 'variant') || Boolean(draft.variants[slugifyKey(newVariantKey || 'variant')])}>
              + variant
            </button>
          </div>
        </div>

        {isExtracted && (
          <div className="character-edit-refine">
            <h3 className="character-edit-section-heading">Refine with pi</h3>
            <div className="character-edit-refine-row">
              <input
                type="text"
                value={refineFeedback}
                onChange={(event) => setRefineFeedback(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    startRefine();
                  }
                }}
                placeholder={'Feedback, e.g. "make her scar more prominent, add a post-duel variant"'}
                disabled={agentBusy || !hasBookSession}
              />
              <button
                className="secondary"
                type="button"
                onClick={startRefine}
                disabled={agentBusy || !hasBookSession || !refineFeedback.trim()}
                title={hasBookSession ? 'Have pi revise this record against the book' : 'Read the book first (Story view)'}
              >
                {refining ? 'Refining…' : 'Refine'}
              </button>
            </div>
            {refining && <p className="muted">pi is revising this record — the form refreshes when it lands.</p>}
            {refineTask.error && <p className="error">{refineTask.error}</p>}
          </div>
        )}
        {extractTask.error && <p className="error">{extractTask.error}</p>}
      </div>
      <div className="modal-actions character-edit-modal-actions">
        <button onClick={() => void onSave(draft)} disabled={busy || agentBusy || !draft.name.trim()}>
          {busy ? 'Saving...' : 'Save'}
        </button>
        <button className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <span className="character-edit-actions-spacer" />
        <button className="danger" type="button" disabled={busy || agentBusy} onClick={onRequestDelete}>
          Delete
        </button>
      </div>
    </Modal>
  );
}
