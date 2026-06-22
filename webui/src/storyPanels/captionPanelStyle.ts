import type { CSSProperties } from 'react';
import type { StoryPanel, StoryPanelTextStyle } from '../types';

export const CAPTION_COLOR_PRESETS = [
  '#111827',
  '#ffffff',
  '#eab308',
  '#1e40af',
  '#991b1b',
  '#166534',
  '#6d28d9',
] as const;

export const defaultCaptionTextStyle: StoryPanelTextStyle = {
  fontFamily: 'serif',
  fontSize: 7,
  align: 'center',
  shape: 'square',
  background: 'white',
  color: '#111827',
  outlineColor: '#ffffff',
};

export function captionStyleForPanel(panel: StoryPanel): StoryPanelTextStyle {
  return { ...defaultCaptionTextStyle, ...(panel.textStyle ?? {}) };
}

export function captionTextOutlineShadow(outlineColor: string): string {
  const outline = outlineColor || '#ffffff';
  return [
    `-1px -1px 0 ${outline}`,
    `1px -1px 0 ${outline}`,
    `-1px 1px 0 ${outline}`,
    `1px 1px 0 ${outline}`,
    `0 -1px 0 ${outline}`,
    `0 1px 0 ${outline}`,
    `-1px 0 0 ${outline}`,
    `1px 0 0 ${outline}`,
  ].join(', ');
}

export function captionPanelClassName(panel: StoryPanel): string {
  if (panel.sourceKind !== 'caption') return '';
  return captionStyleForPanel(panel).background === 'transparent' ? 'is-caption-bg-transparent' : '';
}

export function captionPanelCssProperties(panel: StoryPanel): CSSProperties & Record<string, string> {
  const style = captionStyleForPanel(panel);
  const transparent = style.background === 'transparent';
  const outlineShadow = captionTextOutlineShadow(style.outlineColor ?? '#ffffff');
  return {
    '--story-caption-color': style.color ?? '#111827',
    '--story-caption-bg': transparent ? 'transparent' : '#ffffff',
    '--story-caption-border-color': transparent ? 'transparent' : '#cbd5e1',
    '--story-caption-radius': style.shape === 'oval' ? '9999px' : '2px',
    '--story-caption-outline-shadow': transparent ? outlineShadow : 'none',
    color: style.color ?? '#111827',
    backgroundColor: transparent ? 'transparent' : '#ffffff',
    ...(transparent ? { textShadow: outlineShadow } : {}),
  };
}
