import { PhaseWorkflowActions, StyleRefCard } from './cards';
import { MomentSceneList } from './momentSceneList';
import { SceneListEditor } from './sceneListEditor';
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
  const workflowEnabled = isCharacters;
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

      <PhaseWorkflowActions
        kind={kind}
        adaptation={adaptation}
        workflow={workflow}
        validation={validation}
        onStartWorkflow={onStartWorkflow}
        onStartValidation={onStartValidation}
        workflowDisabled={!workflowEnabled}
        workflowDisabledReason={kind === 'locations' ? 'Locations are added when you extract scenes. Add or edit location files manually below.' : 'Workflow not available for this phase yet.'}
        validateEnabled
      />

      {fileEditor}
    </>
  );
}

export function PhaseScenes({
  projectSlug,
  adaptation,
  workflow,
  validation,
  isSavingSettings,
  onSaveStoryKind,
  onGenerateSceneList,
  onStartValidation,
  onPublishPhaseToCanvas,
  isPublishingPhase,
  onReloadAdaptation,
  artifactEditor,
}: {
  projectSlug: string;
  adaptation: AdaptationStatus;
  workflow: AdaptationWorkflowStatus | null;
  validation: AdaptationWorkflowStatus | null;
  isSavingSettings: boolean;
  onSaveStoryKind: (kind: StoryKind) => Promise<void>;
  onGenerateSceneList: () => Promise<void>;
  onStartValidation: () => Promise<void>;
  onPublishPhaseToCanvas: () => Promise<void>;
  isPublishingPhase: boolean;
  onReloadAdaptation: () => Promise<void>;
  artifactEditor: React.ReactNode;
}) {
  const sceneCount = Object.keys(adaptation.scenes).length;
  return (
    <>
      <section className="story-card">
        <h2>Story Kind</h2>
        <p className="muted">Choose the adaptation shape. This drives how scenes break down into pages or panels in later phases.</p>
        <select value={adaptation.settings.storyKind} disabled={isSavingSettings || workflow?.running} onChange={(event) => void onSaveStoryKind(event.target.value as StoryKind)}>
          <option value="picture-book">Picture book</option>
          <option value="illustrated-story">Illustrated story</option>
          <option value="comic-book">Comic book</option>
        </select>
      </section>

      <SceneListEditor
        projectSlug={projectSlug}
        adaptation={adaptation}
        workflow={workflow}
        onGenerateList={onGenerateSceneList}
        onReloadAdaptation={onReloadAdaptation}
      />

      <section className="story-card">
        <h2>Validate Scenes</h2>
        <button className="secondary" type="button" onClick={onStartValidation} disabled={validation?.running}>
          {validation?.running ? 'Validating...' : 'Run validation'}
        </button>
      </section>

      {artifactEditor}

      <section className="story-card">
        <h2>Scene Canvas</h2>
        <p className="muted">{sceneCount ? `${sceneCount} scene files are ready to publish as planning nodes.` : 'Extract scenes to create scene artifacts.'}</p>
        <button className="generate-button" onClick={onPublishPhaseToCanvas} disabled={!sceneCount || isPublishingPhase}>
          {isPublishingPhase ? 'Publishing...' : 'Publish scene nodes'}
        </button>
      </section>
    </>
  );
}

export function PhaseMoments({
  projectSlug,
  adaptation,
  workflow,
  validation,
  onStartValidation,
  onReloadAdaptation,
}: {
  projectSlug: string;
  adaptation: AdaptationStatus;
  workflow: AdaptationWorkflowStatus | null;
  validation: AdaptationWorkflowStatus | null;
  onStartValidation: () => Promise<void>;
  onReloadAdaptation: () => Promise<void>;
}) {
  const storyKind = adaptation.settings.storyKind;
  const storyKindLabel = storyKind === 'picture-book' ? 'Picture book' : storyKind === 'illustrated-story' ? 'Illustrated story' : 'Comic book';
  const plannedFiles = (adaptation.counts.pagePlans ?? 0) + (adaptation.counts.panelPrompts ?? 0);
  const extractedScenes = adaptation.counts.sceneArtifacts ?? 0;

  return (
    <>
      <section className="story-card">
        <h2>Story Kind</h2>
        <p className="muted">
          Moment density follows the story kind chosen in Phase 2. {storyKindLabel} plans go to{' '}
          {storyKind === 'comic-book' ? 'panel prompts' : 'page plans'}.
        </p>
        <p className="muted">
          {plannedFiles} scene moment file{plannedFiles === 1 ? '' : 's'} · {adaptation.counts.momentSections ?? 0} generatable moment
          {(adaptation.counts.momentSections ?? 0) === 1 ? '' : 's'}
          {extractedScenes ? ` · ${extractedScenes} extracted scene${extractedScenes === 1 ? '' : 's'} ready` : ''}
        </p>
        <p className="muted">Switch to View to generate images and edit narration in story order.</p>
      </section>

      <MomentSceneList
        projectSlug={projectSlug}
        adaptation={adaptation}
        workflow={workflow}
        onReloadAdaptation={onReloadAdaptation}
      />

      <section className="story-card">
        <h2>Validate Moments</h2>
        <button className="secondary" type="button" onClick={onStartValidation} disabled={validation?.running}>
          {validation?.running ? 'Validating...' : 'Run validation'}
        </button>
      </section>
    </>
  );
}
