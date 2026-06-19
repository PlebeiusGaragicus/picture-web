import type { MomentRefInput } from '../types';

export function MomentRefInputsView({
  projectSlug,
  refInputs,
  referenceImageCount,
  referenceImageLimit,
  referenceLimitExceeded,
}: {
  projectSlug: string;
  refInputs: MomentRefInput[];
  referenceImageCount?: number;
  referenceImageLimit?: number;
  referenceLimitExceeded?: boolean;
}) {
  if (!refInputs.length) return null;

  return (
    <div className="moment-ref-inputs">
      <div className="moment-ref-inputs-head">
        <strong>Image inputs</strong>
        {referenceImageCount !== undefined && referenceImageLimit !== undefined && (
          <small className="muted">
            {referenceImageCount} / {referenceImageLimit} reference image{referenceImageLimit === 1 ? '' : 's'}
          </small>
        )}
      </div>
      {referenceLimitExceeded && (
        <p className="moment-panel-editor-error">
          Too many reference images ({referenceImageCount}); limit is {referenceImageLimit}. Remove tags or reduce refs.
        </p>
      )}
      <ul className="moment-ref-inputs-list">
        {refInputs.map((input) => (
          <li key={input.ref} className={`moment-ref-input-row ${input.ready ? 'is-ready' : 'is-missing'}`}>
            <div className="moment-ref-input-row-head">
              <span className="moment-ref-input-label">{input.ref}</span>
              <span className={`moment-ref-input-status ${input.ready ? 'is-ready' : 'is-missing'}`}>
                {input.ready ? `Ready (${input.assetIds.length})` : 'Missing'}
              </span>
            </div>
            {input.tagId && <small className="muted">Canvas tag: {input.tagId}</small>}
            {!input.ready && input.detail && <small className="moment-ref-input-detail">{input.detail}</small>}
            {input.assetIds.length > 0 && (
              <div className="moment-ref-input-thumbs">
                {input.assetIds.map((assetId) => (
                  <img
                    key={assetId}
                    src={`/api/projects/${projectSlug}/assets/${assetId}/thumb`}
                    alt=""
                  />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
