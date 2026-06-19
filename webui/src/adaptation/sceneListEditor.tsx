import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Modal } from '../ui';
import type { AdaptationStatus, AdaptationWorkflowStatus, SceneListLine } from '../types';

export function SceneListEditor({
  projectSlug,
  adaptation,
  workflow,
  onGenerateList,
  onReloadAdaptation,
}: {
  projectSlug: string;
  adaptation: AdaptationStatus;
  workflow: AdaptationWorkflowStatus | null;
  onGenerateList: () => Promise<void>;
  onReloadAdaptation: () => Promise<void>;
}) {
  const [lines, setLines] = useState<SceneListLine[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [extractingSlug, setExtractingSlug] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [newDescription, setNewDescription] = useState('');

  const loadLines = useCallback(async () => {
    setIsLoading(true);
    try {
      const document = await api.getSceneList(projectSlug);
      setLines(document.lines);
    } finally {
      setIsLoading(false);
    }
  }, [projectSlug]);

  useEffect(() => {
    void loadLines();
  }, [loadLines, adaptation.counts.sceneListLines, adaptation.counts.sceneArtifacts]);

  const persistOrder = async (nextLines: SceneListLine[]) => {
    setIsSaving(true);
    try {
      const document = await api.putSceneList(projectSlug, nextLines);
      setLines(document.lines);
    } finally {
      setIsSaving(false);
    }
  };

  const moveLine = async (from: number, to: number) => {
    if (to < 0 || to >= lines.length || from === to) return;
    const next = [...lines];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setLines(next);
    await persistOrder(next);
  };

  const onDrop = async (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null);
      return;
    }
    const next = [...lines];
    const [item] = next.splice(dragIndex, 1);
    next.splice(targetIndex, 0, item);
    setDragIndex(null);
    setLines(next);
    await persistOrder(next);
  };

  const extractScene = async (slug: string) => {
    setExtractingSlug(slug);
    try {
      await api.startSceneExtract(projectSlug, slug);
    } catch (error) {
      setExtractingSlug(null);
      throw error;
    }
  };

  useEffect(() => {
    if (!extractingSlug) return;
    const timer = window.setInterval(async () => {
      const status = await api.getSceneExtract(projectSlug, extractingSlug);
      if (!status.running) {
        setExtractingSlug(null);
        await onReloadAdaptation();
        await loadLines();
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [extractingSlug, loadLines, onReloadAdaptation, projectSlug]);

  const addLine = async () => {
    const slug = newSlug.trim().toLowerCase();
    if (!slug) return;
    setIsSaving(true);
    try {
      const document = await api.addSceneListLine(projectSlug, { slug, description: newDescription.trim() });
      setLines(document.lines);
      setIsModalOpen(false);
      setNewSlug('');
      setNewDescription('');
      await onReloadAdaptation();
    } finally {
      setIsSaving(false);
    }
  };

  const deleteLine = async (slug: string) => {
    setIsSaving(true);
    try {
      const document = await api.deleteSceneListLine(projectSlug, slug);
      setLines(document.lines);
      await onReloadAdaptation();
    } finally {
      setIsSaving(false);
    }
  };

  const isExtracted = (slug: string) => Boolean(adaptation.scenes[slug]);
  const hasCharacterSheets = (adaptation.counts.characterSheets ?? 0) > 0;
  const extractBlockedReason = hasCharacterSheets
    ? undefined
    : 'Complete Phase 1 character sheets before extracting scenes.';

  return (
    <section className="story-card adaptation-file-card">
      <div className="adaptation-file-header">
        <div>
          <h2>Scene List</h2>
          <p className="muted">
            {lines.length
              ? `${lines.length} scenes · drag to reorder${hasCharacterSheets ? '' : ' · finish character sheets before extract'}`
              : 'Generate or add scenes, then extract one at a time.'}
          </p>
        </div>
        <div className="scene-list-header-actions">
          <button className="secondary" type="button" onClick={() => setIsModalOpen(true)} disabled={isSaving}>
            New scene
          </button>
          <button
            className="generate-button workflow-run-button"
            type="button"
            onClick={() => void onGenerateList()}
            disabled={!adaptation.hasBookSession || workflow?.running}
          >
            {workflow?.running && <span className="spinner" aria-hidden="true" />}
            {workflow?.running ? 'Generating list...' : 'Generate scene list'}
          </button>
        </div>
      </div>

      {isLoading ? (
        <p className="muted">Loading scene list...</p>
      ) : (
        <div className="scene-list-rows">
          {lines.map((line, index) => {
            const extracted = isExtracted(line.slug);
            const extracting = extractingSlug === line.slug;
            return (
              <div
                key={line.slug}
                className={`scene-list-row ${dragIndex === index ? 'is-dragging' : ''}`}
                draggable={!isSaving}
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => void onDrop(index)}
              >
                <button type="button" className="scene-list-drag-handle" aria-label="Drag to reorder" tabIndex={-1}>
                  ⋮⋮
                </button>
                <div className="scene-list-row-body">
                  <strong>{line.slug}</strong>
                  <small>{line.description || 'No description'}</small>
                  <small className="scene-list-row-status">
                    {extracting ? 'Extracting...' : extracted ? 'Extracted' : 'Pending'}
                  </small>
                </div>
                <div className="scene-list-row-actions">
                  <button type="button" className="secondary" disabled={index === 0 || isSaving} onClick={() => void moveLine(index, index - 1)}>
                    ↑
                  </button>
                  <button type="button" className="secondary" disabled={index === lines.length - 1 || isSaving} onClick={() => void moveLine(index, index + 1)}>
                    ↓
                  </button>
                  <button
                    type="button"
                    className="generate-button"
                    disabled={
                      !adaptation.hasBookSession ||
                      !hasCharacterSheets ||
                      extracting ||
                      Boolean(extractingSlug) ||
                      workflow?.running ||
                      extracted
                    }
                    title={extractBlockedReason}
                    onClick={() => void extractScene(line.slug)}
                  >
                    {extracting ? 'Extracting...' : 'Extract'}
                  </button>
                  <button type="button" className="secondary" disabled={isSaving || extracted} onClick={() => void deleteLine(line.slug)}>
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
          {!lines.length && <p className="muted">No scenes in list yet.</p>}
        </div>
      )}

      {isModalOpen && (
        <Modal title="New scene" onClose={() => setIsModalOpen(false)}>
          <div className="adaptation-file-form">
            <label className="field-label">
              Slug
              <input value={newSlug} onChange={(event) => setNewSlug(event.target.value)} placeholder="001-garden-party" />
            </label>
            <label className="field-label">
              Summary
              <textarea className="modal-textarea" rows={4} value={newDescription} onChange={(event) => setNewDescription(event.target.value)} />
            </label>
            <button className="generate-button" type="button" disabled={isSaving || !newSlug.trim()} onClick={() => void addLine()}>
              Add scene
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
