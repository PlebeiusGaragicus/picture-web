import type { VisualStyleDefinition } from '../types';

export function VisualStyleSelect({
  styles,
  value,
  onChange,
  disabled = false,
}: {
  styles: VisualStyleDefinition[];
  value: string | null | undefined;
  onChange: (styleId: string | null) => void;
  disabled?: boolean;
}) {
  const selected = value ?? '';
  const missingLabel = selected && !styles.some((style) => style.id === selected) ? `Missing style (${selected})` : null;
  return (
    <label className="field-label">
      Visual style
      <select
        value={selected}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">None</option>
        {missingLabel && <option value={selected}>{missingLabel}</option>}
        {styles.map((style) => (
          <option key={style.id} value={style.id}>{style.name}</option>
        ))}
      </select>
    </label>
  );
}
