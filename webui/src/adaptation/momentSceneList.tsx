import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Modal } from '../ui';
import { MomentPanelEditor } from './momentPanelEditor';
import type {
  AdaptationStatus,
  AdaptationWorkflowStatus,
  Asset,
  MomentLayoutSection,
  SceneListLine,
  SceneMomentsDocument,
  StoryKind,
} from '../types';

function momentLabel(storyKind: StoryKind, sectionCount: number) {
  if (sectionCount === 0) return 'Skipped';
  if (storyKind === 'comic-book') return `${sectionCount} panel${sectionCount === 1 ? '' : 's'}`;
  return sectionCount === 1 ? '1 page' : `${sectionCount} pages`;
}

export function MomentSceneList({
  projectSlug,
  adaptation,
  assets,
  workflow,
  onReloadAdaptation,
}: {
  projectSlug: string;
  adaptation: AdaptationStatus;
  assets: Asset[];
  workflow: AdaptationWorkflowStatus | null;
  onReloadAdaptation: () => Promise<void>;
}) {
  const [lines, setLines] = useState<SceneListLine[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [momentsBySlug, setMomentsBySlug] = useState<Record<string, SceneMomentsDocument>>({});
  const [planningSlug, setPlanningSlug] = useState<string | null>(null);
  const [editSlug, setEditSlug] = useState<string | null>(null);
  const [editDocument, setEditDocument] = useState<SceneMomentsDocument | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const storyKind = adaptation.settings.storyKind;

  const loadLines = useCallback(async () => {
    setIsLoading(true);
    try {
      const document = await api.getSceneList(projectSlug);
      setLines(document.lines);
    } finally {
      setIsLoading(false);
    }
  }, [projectSlug]);

  const loadMomentStatuses = useCallback(async (sceneLines: SceneListLine[]) => {
    const extracted = sceneLines.filter((line) => Boolean(adaptation.scenes[line.slug]));
    const results = await Promise.all(
      extracted.map(async (line) => {
        const document = await api.getSceneMoments(projectSlug, line.slug);
        return [line.slug, document] as const;
      }),
    );
    setMomentsBySlug(Object.fromEntries(results));
  }, [adaptation.scenes, projectSlug]);

  useEffect(() => {
    void loadLines();
  }, [loadLines]);

  useEffect(() => {
    if (!lines.length) {
      setMomentsBySlug({});
      return;
    }
    void loadMomentStatuses(lines);
  }, [lines, loadMomentStatuses, adaptation.counts.pagePlans, adaptation.counts.panelPrompts, adaptation.counts.momentSections]);

  const planScene = async (slug: string) => {
    setPlanningSlug(slug);
    try {
      await api.startScenePlan(projectSlug, slug);
    } catch (error) {
      setPlanningSlug(null);
      throw error;
    }
  };

  useEffect(() => {
    if (!planningSlug) return;
    const timer = window.setInterval(async () => {
      const status = await api.getScenePlan(projectSlug, planningSlug);
      if (!status.running) {
        setPlanningSlug(null);
        await onReloadAdaptation();
        await loadLines();
        const document = await api.getSceneMoments(projectSlug, planningSlug);
        setMomentsBySlug((current) => ({ ...current, [planningSlug]: document }));
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [loadLines, onReloadAdaptation, planningSlug, projectSlug]);

  const openEditor = async (slug: string) => {
    const document = await api.getSceneMoments(projectSlug, slug);
    setEditSlug(slug);
    setEditDocument(document);
    setMomentsBySlug((current) => ({ ...current, [slug]: document }));
  };

  const closeEditor = () => {
    setEditSlug(null);
    setEditDocument(null);
  };

  const saveSections = async (sections: MomentLayoutSection[]) => {
    if (!editSlug) return;
    setIsSaving(true);
    try {
      const document = await api.putSceneMoments(projectSlug, editSlug, { sections });
      setMomentsBySlug((current) => ({ ...current, [editSlug]: document }));
      await onReloadAdaptation();
      closeEditor();
    } finally {
      setIsSaving(false);
    }
  };

  const saveBody = async (body: string) => {
    if (!editSlug) return;
    setIsSaving(true);
    try {
      const document = await api.putSceneMoments(projectSlug, editSlug, { body });
      setMomentsBySlug((current) => ({ ...current, [editSlug]: document }));
      await onReloadAdaptation();
      closeEditor();
    } finally {
      setIsSaving(false);
    }
  };

  const extractedCount = lines.filter((line) => Boolean(adaptation.scenes[line.slug])).length;
  const plannedCount = lines.filter((line) => momentsBySlug[line.slug]?.exists).length;

  return (
    <section className="story-card adaptation-file-card">
      <div className="adaptation-file-header">
        <div>
          <h2>Scene Moments</h2>
          <p className="muted">
            {lines.length
              ? `${plannedCount} / ${extractedCount || lines.length} scenes planned · plan one scene at a time`
              : 'Extract scenes in Phase 2 before planning moments.'}
          </p>
        </div>
      </div>

      {isLoading ? (
        <p className="muted">Loading scenes...</p>
      ) : (
        <div className="scene-list-rows">
          {lines.map((line) => {
            const extracted = Boolean(adaptation.scenes[line.slug]);
            const moment = momentsBySlug[line.slug];
            const planned = Boolean(moment?.exists);
            const planning = planningSlug === line.slug;
            const sectionCount = moment?.sectionCount ?? 0;
            const statusLabel = !extracted
              ? 'Needs extract'
              : planning
                ? 'Planning...'
                : planned
                  ? `Planned · ${momentLabel(storyKind, sectionCount)}`
                  : 'Pending';
            return (
              <div key={line.slug} className="scene-list-row">
                <div className="scene-list-row-body">
                  <strong>{line.slug}</strong>
                  <small>{line.description || 'No description'}</small>
                  <small className="scene-list-row-status">{statusLabel}</small>
                </div>
                <div className="scene-list-row-actions">
                  <button
                    type="button"
                    className="generate-button"
                    disabled={!adaptation.hasBookSession || !extracted || planning || Boolean(planningSlug) || workflow?.running || planned}
                    onClick={() => void planScene(line.slug)}
                  >
                    {planning ? 'Planning...' : 'Plan'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={!planned}
                    onClick={() => void openEditor(line.slug)}
                  >
                    Edit panels
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editSlug !== null && editDocument !== null && (
        <Modal title={`Edit panels: ${editSlug}`} onClose={closeEditor}>
          <MomentPanelEditor
            projectSlug={projectSlug}
            sceneSlug={editSlug}
            storyKind={editDocument.storyKind}
            adaptation={adaptation}
            assets={assets}
            initialSections={editDocument.sections}
            initialBody={editDocument.body}
            isSaving={isSaving}
            onSaveSections={saveSections}
            onSaveBody={saveBody}
            onCancel={closeEditor}
          />
        </Modal>
      )}
    </section>
  );
}
