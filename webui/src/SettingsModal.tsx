import { useEffect, useState } from 'react';
import { api } from './api';
import { Modal } from './ui';
import type { SettingsInfo } from './types';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then(setInfo)
      .catch((error: Error) => setLoadError(error.message));
  }, []);

  const saveKey = async () => {
    const apiKey = keyDraft.trim();
    if (!apiKey || saving) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      setInfo(await api.putGeminiKey(apiKey));
      setKeyDraft('');
      setSaved(true);
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Settings" onClose={() => !saving && onClose()}>
      <div className="settings-modal-body">
        {loadError && <p className="error error-banner">{loadError}</p>}
        {!info && !loadError && <p className="muted">Loading…</p>}
        {info && (
          <>
            <section className="settings-section">
              <h3>Image generation</h3>
              <p className="muted">
                {info.geminiKeyConfigured
                  ? 'A Google AI Studio key is configured.'
                  : 'No Gemini API key configured — image generation is disabled.'}
              </p>
              <div className="settings-key-row">
                <input
                  type="password"
                  placeholder={info.geminiKeyConfigured ? 'Replace API key…' : 'Paste Google AI Studio API key…'}
                  value={keyDraft}
                  onChange={(event) => {
                    setKeyDraft(event.target.value);
                    setSaved(false);
                  }}
                  onKeyDown={(event) => event.key === 'Enter' && saveKey()}
                />
                <button type="button" disabled={!keyDraft.trim() || saving} onClick={saveKey}>
                  {saving ? 'Validating…' : 'Save'}
                </button>
              </div>
              {saveError && <p className="error">{saveError}</p>}
              {saved && <p className="muted">Key validated and saved.</p>}
            </section>
            <section className="settings-section">
              <h3>Agent (pi)</h3>
              <p className="muted">
                comic-canvas drives the pi agent installed on your system, using your own pi
                configuration, models, and credentials.
              </p>
              <ul className="settings-checks">
                {info.checks.map((check) => (
                  <li key={check.name} className={check.ok ? 'is-ok' : 'is-missing'}>
                    <strong>{check.ok ? '✓' : '✕'} {check.name}</strong> — {check.detail}
                    {!check.ok && check.hint && <div className="muted">{check.hint}</div>}
                  </li>
                ))}
              </ul>
            </section>
            <section className="settings-section">
              <h3>About</h3>
              <p className="muted">
                comic-canvas v{info.appVersion}
                {info.libraryVersion && info.libraryVersion !== info.appVersion && (
                  <> — library last used with v{info.libraryVersion}; pre-1.0 schemas may have changed.</>
                )}
              </p>
              <p className="muted">Your projects live at <code>{info.homePath}/projects</code>. Back that folder up like any document folder.</p>
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
