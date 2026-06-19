import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { MomentRefInputsView } from './momentRefInputsView';
import { defaultVisualStyleId } from './visualStyleUtils';
import type { AdaptationStatus, MomentSequenceEntry, StoryKind, VisualStyleDefinition } from '../types';

type GallerySlide = {
  momentKey: string;
  assetId: string;
  caption: string | null;
};

function displayStoryText(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /^none\.?$/i.test(trimmed)) return null;
  return trimmed;
}

function MomentSequenceLightbox({
  projectSlug,
  slides,
  index,
  onIndexChange,
  onClose,
}: {
  projectSlug: string;
  slides: GallerySlide[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const slide = slides[index];
  const hasPrev = index > 0;
  const hasNext = index < slides.length - 1;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key === 'ArrowLeft' && hasPrev) {
        onIndexChange(index - 1);
        return;
      }
      if (event.key === 'ArrowRight' && hasNext) {
        onIndexChange(index + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasNext, hasPrev, index, onClose, onIndexChange]);

  if (!slide) return null;

  return (
    <div
      className={`moment-sequence-lightbox${slide.caption ? ' has-caption' : ''}`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Panel preview: ${slide.momentKey}`}
    >
      <button type="button" className="moment-sequence-lightbox-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="moment-sequence-lightbox-frame" onClick={(event) => event.stopPropagation()}>
        <div className="moment-sequence-lightbox-viewport">
          <div className="moment-sequence-lightbox-image-wrap">
            <img
              src={`/api/projects/${projectSlug}/assets/${slide.assetId}/image`}
              alt={slide.momentKey}
            />
            {hasPrev && (
              <button
                type="button"
                className="moment-sequence-lightbox-nav is-prev"
                onClick={() => onIndexChange(index - 1)}
                aria-label="Previous panel"
              >
                ‹
              </button>
            )}
            {hasNext && (
              <button
                type="button"
                className="moment-sequence-lightbox-nav is-next"
                onClick={() => onIndexChange(index + 1)}
                aria-label="Next panel"
              >
                ›
              </button>
            )}
          </div>
        </div>
      </div>
      {slide.caption && (
        <footer className="moment-sequence-lightbox-page-caption">
          <p>{slide.caption}</p>
        </footer>
      )}
    </div>
  );
}

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

export function MomentSequenceView({
  projectSlug,
  adaptation,
  onReloadAdaptation,
}: {
  projectSlug: string;
  adaptation: AdaptationStatus;
  onReloadAdaptation: () => Promise<void>;
}) {
  const [moments, setMoments] = useState<MomentSequenceEntry[]>([]);
  const [counts, setCounts] = useState({ total: 0, illustrated: 0, finalized: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [visualStyleId, setVisualStyleId] = useState('');
  const [generatingKey, setGeneratingKey] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [expandedPromptKey, setExpandedPromptKey] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const storyKind = adaptation.settings.storyKind;
  const textFields = textFieldsForStoryKind(storyKind);

  const loadSequence = useCallback(async () => {
    setIsLoading(true);
    try {
      const document = await api.getMomentSequence(projectSlug);
      setMoments(document.moments);
      setCounts(document.counts);
    } finally {
      setIsLoading(false);
    }
  }, [projectSlug]);

  useEffect(() => {
    void loadSequence();
  }, [loadSequence, adaptation.counts.illustratedMoments, adaptation.counts.finalizedMoments, adaptation.counts.momentSections]);

  useEffect(() => {
    if (visualStyleId) return;
    const resolved = adaptation.defaultVisualStyleId ?? defaultVisualStyleId(adaptation.visualStyles);
    if (resolved) setVisualStyleId(resolved);
  }, [adaptation.defaultVisualStyleId, adaptation.visualStyles, visualStyleId]);

  const grouped = useMemo(() => {
    const groups: Array<{ sceneSlug: string; moments: MomentSequenceEntry[] }> = [];
    for (const moment of moments) {
      const last = groups[groups.length - 1];
      if (last && last.sceneSlug === moment.sceneSlug) {
        last.moments.push(moment);
      } else {
        groups.push({ sceneSlug: moment.sceneSlug, moments: [moment] });
      }
    }
    return groups;
  }, [moments]);

  const gallerySlides = useMemo(
    () =>
      moments.flatMap((moment) => {
        const assetId = moment.activeAssetId ?? moment.assetIds[moment.assetIds.length - 1] ?? null;
        return assetId
          ? [{ momentKey: moment.momentKey, assetId, caption: displayStoryText(moment.caption) }]
          : [];
      }),
    [moments],
  );

  const openLightbox = (momentKey: string) => {
    const index = gallerySlides.findIndex((slide) => slide.momentKey === momentKey);
    if (index >= 0) setLightboxIndex(index);
  };

  const updateMoment = (updated: MomentSequenceEntry) => {
    setMoments((current) => current.map((moment) => (moment.momentKey === updated.momentKey ? updated : moment)));
    setCounts((current) => {
      const nextMoments = moments.map((moment) => (moment.momentKey === updated.momentKey ? updated : moment));
      return {
        total: nextMoments.length,
        illustrated: nextMoments.filter((moment) => moment.activeAssetId || moment.assetIds.length).length,
        finalized: nextMoments.filter((moment) => moment.finalized).length,
      };
    });
  };

  const patchMoment = async (momentKey: string, patch: Parameters<typeof api.patchMoment>[2]) => {
    setSavingKey(momentKey);
    try {
      const updated = await api.patchMoment(projectSlug, momentKey, patch);
      updateMoment(updated);
      await onReloadAdaptation();
    } finally {
      setSavingKey(null);
    }
  };

  const generateMoment = async (moment: MomentSequenceEntry) => {
    if (!visualStyleId) return;
    setGeneratingKey(moment.momentKey);
    try {
      await api.generateAdaptationArtifact(projectSlug, {
        artifactKind: moment.artifactKind,
        artifactKey: moment.momentKey,
        visualStyleId,
      });
      await onReloadAdaptation();
      await loadSequence();
    } finally {
      setGeneratingKey(null);
    }
  };

  if (isLoading) {
    return <p className="muted">Loading moment sequence...</p>;
  }

  if (!moments.length) {
    return (
      <section className="story-card">
        <h2>Moment Sequence</h2>
        <p className="muted">Plan scenes in List mode first. Moments appear here in story order once moment files exist.</p>
      </section>
    );
  }

  return (
    <div className="moment-sequence">
      {lightboxIndex !== null && gallerySlides.length > 0 && (
        <MomentSequenceLightbox
          projectSlug={projectSlug}
          slides={gallerySlides}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
      <section className="story-card moment-sequence-header">
        <div>
          <h2>Moment Sequence</h2>
          <p className="muted">
            {counts.illustrated} / {counts.total} illustrated · {counts.finalized} finalized
          </p>
        </div>
        <label className="field-label moment-sequence-style">
          Visual style
          <select value={visualStyleId} onChange={(event) => setVisualStyleId(event.target.value)}>
            {adaptation.visualStyles.map((style: VisualStyleDefinition) => (
              <option key={style.id} value={style.id}>
                {style.name}
                {style.default ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>
      </section>

      {grouped.map((group) => (
        <section key={group.sceneSlug} className="moment-sequence-scene">
          <h3 className="moment-sequence-scene-title">{group.sceneSlug}</h3>
          <div className="moment-sequence-cards">
            {group.moments.map((moment) => {
              const previewId = moment.activeAssetId ?? moment.assetIds[moment.assetIds.length - 1] ?? null;
              const isGenerating = generatingKey === moment.momentKey;
              const isSaving = savingKey === moment.momentKey;
              const generateBlocked = !moment.canGenerate || moment.referenceLimitExceeded;
              return (
                <article key={moment.momentKey} className={`moment-sequence-card ${moment.finalized ? 'is-finalized' : ''}`}>
                  <div className="moment-sequence-card-media">
                    {previewId ? (
                      <div className="moment-sequence-card-media-frame">
                        <img
                          src={`/api/projects/${projectSlug}/assets/${previewId}/image`}
                          alt={moment.momentKey}
                        />
                        <button
                          type="button"
                          className="moment-sequence-preview-eye"
                          onClick={() => openLightbox(moment.momentKey)}
                          title="View full screen"
                          aria-label={`View ${moment.momentKey} full screen`}
                        >
                          👁️
                        </button>
                      </div>
                    ) : (
                      <div className="moment-sequence-placeholder">No image yet</div>
                    )}
                  </div>
                  <div className="moment-sequence-card-body">
                    <div className="moment-sequence-card-head">
                      <strong>{moment.momentKey}</strong>
                      <label className="moment-sequence-finalize">
                        <input
                          type="checkbox"
                          checked={moment.finalized}
                          disabled={isSaving}
                          onChange={(event) => void patchMoment(moment.momentKey, { finalized: event.target.checked })}
                        />
                        Finalized
                      </label>
                    </div>
                    <MomentRefInputsView
                      projectSlug={projectSlug}
                      refInputs={moment.refInputs ?? []}
                      referenceImageCount={moment.referenceImageCount}
                      referenceImageLimit={moment.referenceImageLimit}
                      referenceLimitExceeded={moment.referenceLimitExceeded}
                    />
                    {textFields.map((field) => (
                      <label key={field} className="field-label">
                        {textFieldLabel(field)}
                        <textarea
                          className="modal-textarea"
                          rows={field === 'narration' ? 3 : 2}
                          value={moment[field]}
                          disabled={isSaving}
                          onChange={(event) => {
                            const value = event.target.value;
                            setMoments((current) =>
                              current.map((item) => (item.momentKey === moment.momentKey ? { ...item, [field]: value } : item)),
                            );
                          }}
                          onBlur={(event) => {
                            const value = event.target.value;
                            if (value === moment[field]) return;
                            void patchMoment(moment.momentKey, { [field]: value });
                          }}
                        />
                      </label>
                    ))}
                    <button
                      type="button"
                      className="secondary moment-sequence-prompt-toggle"
                      onClick={() => setExpandedPromptKey((current) => (current === moment.momentKey ? null : moment.momentKey))}
                    >
                      {expandedPromptKey === moment.momentKey ? 'Hide image prompt' : 'Show image prompt'}
                    </button>
                    {expandedPromptKey === moment.momentKey && (
                      <pre className="moment-sequence-prompt">{moment.prompt}</pre>
                    )}
                    <div className="moment-sequence-card-actions">
                      <button
                        type="button"
                        className="generate-button"
                        disabled={!visualStyleId || isGenerating || generateBlocked}
                        title={
                          generateBlocked
                            ? moment.referenceLimitExceeded
                              ? `Too many reference images (${moment.referenceImageCount}); limit is ${moment.referenceImageLimit}`
                              : 'Tag all panel references on the canvas before generating'
                            : undefined
                        }
                        onClick={() => void generateMoment(moment)}
                      >
                        {isGenerating ? 'Generating...' : 'Generate'}
                      </button>
                    </div>
                    {moment.assetIds.length > 1 && (
                      <div className="moment-sequence-thumbs">
                        {moment.assetIds.map((assetId) => (
                          <button
                            key={assetId}
                            type="button"
                            className={`moment-sequence-thumb ${assetId === previewId ? 'is-active' : ''}`}
                            onClick={() => void patchMoment(moment.momentKey, { activeAssetId: assetId })}
                          >
                            <img src={`/api/projects/${projectSlug}/assets/${assetId}/thumb`} alt="" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
