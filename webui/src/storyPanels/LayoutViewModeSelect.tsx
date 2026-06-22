import type { StoryPanelLayoutMode } from './PageLayoutEditor';

export function LayoutViewModeSelect({
  value,
  onChange,
  disabled = false,
  className = '',
}: {
  value: StoryPanelLayoutMode;
  onChange: (mode: StoryPanelLayoutMode) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label className={`story-panels-view-control project-top-bar-layout-view ${className}`.trim()}>
      <select
        value={value}
        aria-label="Layout view"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as StoryPanelLayoutMode)}
      >
        <option value="all-pages">All pages (a)</option>
        <option value="spread">Two-page spread (2)</option>
        <option value="single">Single page (s)</option>
      </select>
    </label>
  );
}
