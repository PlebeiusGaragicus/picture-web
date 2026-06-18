import { PhaseWorkflowActions, StyleRefCard } from './cards';
import { styleRefStatusFromAdaptation } from '../styleRefs';
import type { AdaptationStatus, AdaptationWorkflowStatus, Asset, StoryKind, StyleRefKind } from '../types';

export function PhaseAssetType({
  kind,
  projectSlug,
  adaptation,
  assets,
  workflow,
  validation,
  onImportStyleRef,
  onSaveStylePrompt,
  onOpenStyleRefOnCanvas,
  onStartWorkflow,
  onStartValidation,
  fileEditor,
}: {
  kind: 'characters' | 'locations';
  projectSlug: string;
  adaptation: AdaptationStatus;
  assets: Asset[];
  workflow: AdaptationWorkflowStatus | null;
  validation: AdaptationWorkflowStatus | null;
  onImportStyleRef: (refKind: StyleRefKind, file: File) => Promise<void>;
  onSaveStylePrompt: (refKind: StyleRefKind, prompt: string) => Promise<void>;
  onOpenStyleRefOnCanvas: (refKind: StyleRefKind) => Promise<void>;
  onStartWorkflow: () => Promise<void>;
  onStartValidation: () => Promise<void>;
  fileEditor: React.ReactNode;
}) {
  const isCharacters = kind === 'characters';
  const workflowEnabled = kind === 'characters' || kind === 'locations';
  const styleRefStatus = styleRefStatusFromAdaptation(isCharacters ? 'archetype-character' : 'archetype-scene', adaptation, assets);
  return (
    <>
      <div className="archetype-row">
        <StyleRefCard
          status={styleRefStatus}
          projectSlug={projectSlug}
          asset={styleRefStatus.asset}
          onImportStyleRef={onImportStyleRef}
          onSavePrompt={onSaveStylePrompt}
          onOpenStyleRefOnCanvas={onOpenStyleRefOnCanvas}
        />
      </div>

      <PhaseWorkflowActions kind={kind} adaptation={adaptation} workflow={workflow} validation={validation} onStartWorkflow={onStartWorkflow} onStartValidation={onStartValidation} workflowDisabled={!workflowEnabled} />

      {fileEditor}
    </>
  );
}

export function PhaseScenes({ adaptation, workflow, validation, isSavingSettings, onSaveStoryKind, onStartWorkflow, onStartValidation, onPublishPhaseToCanvas, isPublishingPhase, fileEditor }: {
  adaptation: AdaptationStatus;
  workflow: AdaptationWorkflowStatus | null;
  validation: AdaptationWorkflowStatus | null;
  isSavingSettings: boolean;
  onSaveStoryKind: (kind: StoryKind) => Promise<void>;
  onStartWorkflow: () => Promise<void>;
  onStartValidation: () => Promise<void>;
  onPublishPhaseToCanvas: () => Promise<void>;
  isPublishingPhase: boolean;
  fileEditor: React.ReactNode;
}) {
  const sceneCount = Object.keys(adaptation.scenes).length;
  return (
    <>
      {fileEditor}
      <section className="story-card">
        <h2>Story Kind</h2>
        <p className="muted">Choose the adaptation shape. This drives how scenes break down into pages or panels in later phases.</p>
        <select value={adaptation.settings.storyKind} disabled={isSavingSettings || workflow?.running} onChange={(event) => void onSaveStoryKind(event.target.value as StoryKind)}>
          <option value="picture-book">Picture book</option>
          <option value="illustrated-story">Illustrated story</option>
          <option value="comic-book">Comic book</option>
        </select>
      </section>
      <section className="story-card">
        <h2>Acts And Scenes</h2>
        <p className="muted">Scene extraction workflow is not available yet. Author scene files manually or wait for a later release.</p>
        <button className="generate-button workflow-run-button" disabled>
          Run scene workflow
        </button>
      </section>
      <section className="story-card">
        <h2>Scene Canvas</h2>
        <p className="muted">{sceneCount ? `${sceneCount} scene files are ready to publish as planning nodes.` : 'No scene files yet.'}</p>
        <button className="generate-button" onClick={onPublishPhaseToCanvas} disabled={!sceneCount || isPublishingPhase}>
          {isPublishingPhase ? 'Publishing...' : 'Publish scene nodes'}
        </button>
      </section>
      <section className="story-card">
        <h2>Validate Scenes</h2>
        <button className="secondary" disabled>Run validation</button>
      </section>
    </>
  );
}

export function PhaseMoments({ adaptation, workflow, validation, onStartWorkflow, onStartValidation, onPublishPhaseToCanvas, isPublishingPhase }: {
  adaptation: AdaptationStatus;
  workflow: AdaptationWorkflowStatus | null;
  validation: AdaptationWorkflowStatus | null;
  onStartWorkflow: () => Promise<void>;
  onStartValidation: () => Promise<void>;
  onPublishPhaseToCanvas: () => Promise<void>;
  isPublishingPhase: boolean;
}) {
  const momentNodeCount = Object.keys(adaptation.pages).length + Object.keys(adaptation.panels).length;
  return (
    <>
      <section className="story-card">
        <h2>Moments, Beats, Panels</h2>
        <p className="muted">Moment planning workflow is not available yet.</p>
        <button className="generate-button workflow-run-button" disabled>
          Run moment planning
        </button>
      </section>
      <section className="story-card">
        <h2>Moment Canvas</h2>
        <p className="muted">{momentNodeCount ? `${momentNodeCount} page/panel prompts are ready for the moment image canvas.` : 'No page or panel prompts yet.'}</p>
        <button className="generate-button" onClick={onPublishPhaseToCanvas} disabled={!momentNodeCount || isPublishingPhase}>
          {isPublishingPhase ? 'Publishing...' : 'Publish moment nodes'}
        </button>
      </section>
      <section className="story-card">
        <h2>Validate Moment Prompts</h2>
        <button className="secondary" disabled>Run validation</button>
      </section>
    </>
  );
}
