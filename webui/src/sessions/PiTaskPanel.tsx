import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { isTerminalTaskState } from './usePiTask';
import type { PiTaskEvent, PiTaskState } from '../types';

type PanelItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'progress'; key: string; index: number; label: string }
  | { kind: 'tool'; key: string; name: string; args: string; state: 'running' | 'ok' | 'error'; result: string };

function buildItems(events: PiTaskEvent[]): PanelItem[] {
  const items: PanelItem[] = [];
  for (const record of events) {
    const event = record.event;
    if (event.type === 'assistant_text' && typeof event.text === 'string') {
      items.push({ kind: 'text', key: `e${record.seq}`, text: event.text });
    } else if (event.type === 'task_progress') {
      items.push({
        kind: 'progress',
        key: `e${record.seq}`,
        index: Number(event.index ?? 0),
        label: String(event.label ?? ''),
      });
    } else if (event.type === 'tool_start') {
      items.push({
        kind: 'tool',
        key: `e${record.seq}`,
        name: String(event.toolName ?? ''),
        args: String(event.args ?? ''),
        state: 'running',
        result: '',
      });
    } else if (event.type === 'tool_end') {
      const open = [...items].reverse().find(
        (item): item is Extract<PanelItem, { kind: 'tool' }> =>
          item.kind === 'tool' && item.state === 'running' && item.name === String(event.toolName ?? ''),
      );
      if (open) {
        open.state = event.isError ? 'error' : 'ok';
        open.result = String(event.result ?? '');
      }
    }
  }
  return items;
}

function stateLabel(state: PiTaskState | null): string {
  switch (state) {
    case 'starting':
      return 'Starting…';
    case 'running':
      return 'Running';
    case 'aborting':
      return 'Cancelling…';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return '';
  }
}

export function PiTaskPanel({
  title,
  state,
  events,
  error,
  onAbort,
  onDismiss,
}: {
  title: string;
  state: PiTaskState | null;
  events: PiTaskEvent[];
  error: string | null;
  onAbort: () => void;
  onDismiss: () => void;
}) {
  const items = useMemo(() => buildItems(events), [events]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [items.length, state]);

  if (state === null) return null;
  const terminal = isTerminalTaskState(state);

  return (
    <section className={clsx('pi-task-panel', `is-${state}`)} aria-live="polite">
      <header className="pi-task-panel-header">
        <span className={clsx('pi-task-state-dot', `is-${state}`)} aria-hidden />
        <h3>{title}</h3>
        <span className="pi-task-state-label">{stateLabel(state)}</span>
        {!terminal && (
          <button className="secondary pi-task-panel-button" type="button" onClick={onAbort} disabled={state === 'aborting'}>
            Cancel
          </button>
        )}
        {terminal && (
          <button className="secondary pi-task-panel-button" type="button" onClick={onDismiss} aria-label="Dismiss task panel">
            ✕
          </button>
        )}
      </header>
      {error && <p className="error pi-task-panel-error">{error}</p>}
      <div className="pi-task-panel-body" ref={bodyRef}>
        {items.map((item) =>
          item.kind === 'text' ? (
            <p key={item.key} className="pi-task-text">{item.text}</p>
          ) : item.kind === 'progress' ? (
            <p key={item.key} className="pi-task-progress">
              Step {item.index}: {item.label}
            </p>
          ) : (
            <button
              key={item.key}
              type="button"
              className={clsx('pi-task-tool-chip', `is-${item.state}`, expandedKey === item.key && 'is-expanded')}
              onClick={() => setExpandedKey((current) => (current === item.key ? null : item.key))}
            >
              <span className="pi-task-tool-name">
                {item.state === 'running' ? '⋯' : item.state === 'error' ? '✕' : '✓'} {item.name}
              </span>
              {expandedKey === item.key && (
                <span className="pi-task-tool-detail">
                  {item.args && <code>{item.args}</code>}
                  {item.result && <code>{item.result}</code>}
                </span>
              )}
            </button>
          ),
        )}
        {!items.length && <p className="muted">Waiting for the agent…</p>}
      </div>
    </section>
  );
}
