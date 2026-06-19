import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdaptationWorkflowStatus } from '../types';

const WORKFLOW_STAGES = new Set(['ingest', 'characters', 'scene-list', 'scenes', 'locations', 'moments']);
const LIFECYCLE_TYPES = new Set([
  'agent_start',
  'turn_start',
  'turn_end',
  'agent_end',
  'compaction_start',
  'compaction_end',
]);

const LOG_FILE_LABELS: Record<string, string> = {
  log: 'Run log',
  summary: 'Summary',
  manifest: 'Manifest',
  tasksDir: 'Task logs',
};

type PiWorkflowEvent =
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_start'; toolName: string; args: string }
  | { type: 'tool_end'; toolName: string; isError: boolean; size: number; result: string }
  | { type: 'retry'; attempt: number; maxAttempts: number; message: string }
  | { type: 'agent_start' | 'turn_start' | 'turn_end' | 'agent_end' | 'compaction_start' | 'compaction_end' };

type WorkflowActivityRow =
  | { kind: 'event'; event: PiWorkflowEvent }
  | { kind: 'lifecycle'; event: PiWorkflowEvent }
  | { kind: 'text'; text: string };

type ParsedWorkflowStep = {
  id: number;
  type: 'step';
  stage: string;
  title: string;
  output?: string;
  taskLog?: string;
  stderr: string[];
  rows: WorkflowActivityRow[];
  lifecycleCount: number;
};

export type WorkflowTimelineBlock =
  | { id: number; type: 'startup'; meta: Record<string, string> }
  | { id: number; type: 'load'; messages: string[] }
  | ParsedWorkflowStep
  | { id: number; type: 'summary'; rows: Array<{ key: string; value: string } | { kind: 'text'; text: string }> }
  | { id: number; type: 'error'; text: string; severity: 'error' | 'success' | 'fail' };

function parseStartupLine(text: string): { key: string; value: string } | null {
  const match = /^\[start\]\s+([^:]+):\s*(.+)$/.exec(text);
  if (!match) return null;
  return { key: match[1].trim(), value: match[2].trim() };
}

function parseLoadLine(text: string): string | null {
  const match = /^\[load\]\s+(.+)$/.exec(text);
  return match ? match[1].trim() : null;
}

function parseStepHeader(text: string): { stage: string; title: string } | null {
  const match = /^\[([^\]]+)\]\s+(.+)$/.exec(text);
  if (!match) return null;
  const stage = match[1].trim().toLowerCase();
  if (!WORKFLOW_STAGES.has(stage)) return null;
  return { stage, title: match[2].trim() };
}

function parseIndentedMeta(rawLine: string): { key: string; value: string } | null {
  const match = /^\s{4}([^:]+):\s*(.+)$/.exec(rawLine);
  if (!match) return null;
  return { key: match[1].trim().toLowerCase(), value: match[2].trim() };
}

function parseSummaryKv(text: string): { key: string; value: string } | null {
  const match = /^([A-Za-z][A-Za-z ]*):\s+(.+)$/.exec(text.trim());
  if (!match) return null;
  const key = match[1].trim();
  if (key === 'OK' || key === 'FAIL' || key === 'error') return null;
  return { key, value: match[2].trim() };
}

function isLifecycleEvent(event: PiWorkflowEvent): boolean {
  return LIFECYCLE_TYPES.has(event.type);
}

function applyIndentedMeta(step: ParsedWorkflowStep, meta: { key: string; value: string }, text: string) {
  if (meta.key === 'output') {
    step.output = meta.value;
  } else if (meta.key === 'task log') {
    step.taskLog = meta.value;
  } else if (meta.key === 'pi stderr') {
    step.stderr.push(meta.value);
  } else {
    step.rows.push({ kind: 'text', text });
  }
}

export function parseWorkflowLog(log: string): WorkflowTimelineBlock[] {
  const blocks: WorkflowTimelineBlock[] = [];
  let nextId = 0;
  const ctx = { step: null as ParsedWorkflowStep | null };
  let pendingStartup: Record<string, string> | null = null;
  let pendingLoad: string[] | null = null;
  let pendingSummary: Extract<WorkflowTimelineBlock, { type: 'summary' }> | null = null;

  const flushStartup = () => {
    if (pendingStartup && Object.keys(pendingStartup).length > 0) {
      blocks.push({ id: nextId++, type: 'startup', meta: pendingStartup });
    }
    pendingStartup = null;
  };

  const flushLoad = () => {
    if (pendingLoad && pendingLoad.length > 0) {
      blocks.push({ id: nextId++, type: 'load', messages: pendingLoad });
    }
    pendingLoad = null;
  };

  const flushSummary = () => {
    if (pendingSummary && pendingSummary.rows.length > 0) {
      blocks.push(pendingSummary);
    }
    pendingSummary = null;
  };

  const startStep = (stage: string, title: string) => {
    flushStartup();
    flushLoad();
    flushSummary();
    const step: ParsedWorkflowStep = {
      id: nextId++,
      type: 'step',
      stage,
      title,
      stderr: [],
      rows: [],
      lifecycleCount: 0,
    };
    ctx.step = step;
    blocks.push(step);
  };

  const ensureSummary = () => {
    flushStartup();
    flushLoad();
    if (!pendingSummary) {
      pendingSummary = { id: nextId++, type: 'summary', rows: [] };
    }
    ctx.step = null;
  };

  const pushEvent = (event: PiWorkflowEvent) => {
    if (!ctx.step) {
      startStep('ingest', 'Activity');
    }
    const step = ctx.step!;
    if (isLifecycleEvent(event)) {
      step.lifecycleCount += 1;
      step.rows.push({ kind: 'lifecycle', event });
    } else {
      step.rows.push({ kind: 'event', event });
    }
  };

  for (const rawLine of log.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;

    const startup = parseStartupLine(line);
    if (startup) {
      flushLoad();
      flushSummary();
      ctx.step = null;
      if (!pendingStartup) pendingStartup = {};
      pendingStartup[startup.key] = startup.value;
      continue;
    }

    const loadMsg = parseLoadLine(line);
    if (loadMsg) {
      flushStartup();
      flushSummary();
      ctx.step = null;
      if (!pendingLoad) pendingLoad = [];
      pendingLoad.push(loadMsg);
      continue;
    }

    const stepHeader = parseStepHeader(line);
    if (stepHeader) {
      startStep(stepHeader.stage, stepHeader.title);
      continue;
    }

    const failMatch = /^FAIL:\s*(.+)$/.exec(line.trim());
    if (failMatch) {
      flushStartup();
      flushLoad();
      flushSummary();
      ctx.step = null;
      blocks.push({ id: nextId++, type: 'error', text: failMatch[1].trim(), severity: 'fail' });
      continue;
    }

    const okMatch = /^OK:\s*(.+)$/.exec(line.trim());
    if (okMatch) {
      flushStartup();
      flushLoad();
      flushSummary();
      ctx.step = null;
      blocks.push({ id: nextId++, type: 'error', text: okMatch[1].trim(), severity: 'success' });
      continue;
    }

    const errorMatch = /^error:\s*(.+)$/i.exec(line.trim());
    if (errorMatch) {
      flushStartup();
      flushLoad();
      flushSummary();
      ctx.step = null;
      blocks.push({ id: nextId++, type: 'error', text: errorMatch[1].trim(), severity: 'error' });
      continue;
    }

    const indented = parseIndentedMeta(rawLine);
    if (indented && ctx.step !== null) {
      applyIndentedMeta(ctx.step, indented, line.trim());
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as { type?: unknown };
        if (parsed && typeof parsed.type === 'string') {
          pushEvent(parsed as PiWorkflowEvent);
          continue;
        }
      } catch {
        // fall through to plain text
      }
    }

    const summaryKv = parseSummaryKv(line);
    if (summaryKv) {
      ensureSummary();
      pendingSummary!.rows.push(summaryKv);
      continue;
    }

    if (/^Done\./.test(trimmed) || /^Validation (passed|failed)/i.test(trimmed)) {
      ensureSummary();
      pendingSummary!.rows.push({ kind: 'text', text: trimmed });
      continue;
    }

    if (ctx.step !== null) {
      ctx.step.rows.push({ kind: 'text', text: trimmed });
    } else {
      ensureSummary();
      pendingSummary!.rows.push({ kind: 'text', text: trimmed });
    }
  }

  flushStartup();
  flushLoad();
  flushSummary();

  return blocks;
}

function formatCharCount(n: number): string {
  if (n < 1000) return `${n} chars`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k chars`;
  return `${(n / 1_000_000).toFixed(1)}M chars`;
}

function WorkflowToolResult({ event }: { event: Extract<PiWorkflowEvent, { type: 'tool_end' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`workflow-event workflow-event-tool-end ${event.isError ? 'is-error' : ''}`}>
      <span className="workflow-event-icon" aria-hidden="true">{event.isError ? '✗' : '✓'}</span>
      <span className="workflow-tool-name">{event.toolName}</span>
      <span className="workflow-tool-size">{formatCharCount(event.size)}</span>
      {event.result && (
        <button type="button" className="workflow-tool-toggle" onClick={() => setOpen((value) => !value)}>
          {open ? 'hide' : 'preview'}
        </button>
      )}
      {open && event.result && <pre className="workflow-tool-result">{event.result}</pre>}
    </div>
  );
}

function WorkflowEventRow({ event }: { event: PiWorkflowEvent }) {
  if (event.type === 'assistant_text') {
    return (
      <div className="workflow-event workflow-event-assistant">
        <span className="workflow-event-icon" aria-hidden="true">✦</span>
        <div className="workflow-event-text">{event.text}</div>
      </div>
    );
  }
  if (event.type === 'tool_start') {
    return (
      <div className="workflow-event workflow-event-tool">
        <span className="workflow-event-icon" aria-hidden="true">→</span>
        <span className="workflow-tool-name">{event.toolName}</span>
        {event.args && <code className="workflow-tool-args">{event.args}</code>}
      </div>
    );
  }
  if (event.type === 'tool_end') {
    return <WorkflowToolResult event={event} />;
  }
  if (event.type === 'retry') {
    return (
      <div className="workflow-event workflow-event-retry">
        <span className="workflow-event-icon" aria-hidden="true">↻</span>
        <span>retry {event.attempt}/{event.maxAttempts}</span>
        {event.message && <span className="workflow-event-text">{event.message}</span>}
      </div>
    );
  }
  if (isLifecycleEvent(event)) {
    return (
      <div className="workflow-event workflow-event-lifecycle">
        <span className="workflow-event-icon" aria-hidden="true">·</span>
        <span className="workflow-lifecycle-label">{event.type.replace(/_/g, ' ')}</span>
      </div>
    );
  }
  return null;
}

function WorkflowStartupBlock({
  meta,
  defaultCollapsed,
}: {
  meta: Record<string, string>;
  defaultCollapsed: boolean;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
  const entries = Object.entries(meta);
  return (
    <section className="workflow-block workflow-startup">
      <button type="button" className="workflow-startup-toggle" onClick={() => setOpen((value) => !value)}>
        <span>Environment</span>
        <span className="workflow-startup-hint">{open ? 'hide' : `${entries.length} details`}</span>
      </button>
      {open && (
        <div className="workflow-kv-grid">
          {entries.map(([key, value]) => (
            <div key={key} className="workflow-kv-row">
              <span className="workflow-kv-key">{key}</span>
              <p className="workflow-kv-value"><code>{value}</code></p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function WorkflowLoadBlock({ messages }: { messages: string[] }) {
  return (
    <section className="workflow-block workflow-load-banner" aria-label="Session load">
      {messages.map((message, index) => (
        <p key={index}>{message}</p>
      ))}
    </section>
  );
}

function WorkflowStepBlockView({ block }: { block: ParsedWorkflowStep }) {
  const [showLifecycle, setShowLifecycle] = useState(false);
  const visibleRows = block.rows.filter((row) => row.kind !== 'lifecycle' || showLifecycle);
  return (
    <section className="workflow-step">
      <header className="workflow-step-head">
        <span className={`workflow-step-badge workflow-step-badge-${block.stage}`}>{block.stage}</span>
        <span className="workflow-step-label">{block.title}</span>
      </header>
      {(block.output || block.taskLog) && (
        <div className="workflow-step-meta">
          {block.output && (
            <div className="workflow-step-meta-row">
              <span className="workflow-step-meta-label">output</span>
              <code className="workflow-step-output" title={block.output}>{block.output}</code>
            </div>
          )}
          {block.taskLog && (
            <div className="workflow-step-meta-row">
              <span className="workflow-step-meta-label">task log</span>
              <code className="workflow-step-output" title={block.taskLog}>{block.taskLog}</code>
            </div>
          )}
        </div>
      )}
      <div className="workflow-step-body">
        {visibleRows.map((row, index) =>
          row.kind === 'text' ? (
            <div key={index} className="workflow-line">{row.text}</div>
          ) : (
            <WorkflowEventRow key={index} event={row.event} />
          ),
        )}
        {block.stderr.length > 0 && (
          <div className="workflow-stderr-block">
            <span className="workflow-stderr-label">pi stderr</span>
            {block.stderr.map((line, index) => (
              <pre key={index} className="workflow-stderr-line">{line}</pre>
            ))}
          </div>
        )}
        {block.lifecycleCount > 0 && (
          <button
            type="button"
            className="workflow-lifecycle-toggle"
            onClick={() => setShowLifecycle((value) => !value)}
          >
            {showLifecycle ? 'Hide agent lifecycle' : `Show agent lifecycle (${block.lifecycleCount})`}
          </button>
        )}
      </div>
    </section>
  );
}

function WorkflowSummaryBlock({
  rows,
}: {
  rows: Array<{ key: string; value: string } | { kind: 'text'; text: string }>;
}) {
  return (
    <section className="workflow-block workflow-summary">
      <div className="workflow-kv-grid">
        {rows.map((row, index) =>
          'key' in row ? (
            <div key={index} className="workflow-kv-row">
              <span className="workflow-kv-key">{row.key}</span>
              <p className="workflow-kv-value"><code>{row.value}</code></p>
            </div>
          ) : (
            <p key={index} className="workflow-summary-text">{row.text}</p>
          ),
        )}
      </div>
    </section>
  );
}

function WorkflowErrorBlock({ text, severity }: { text: string; severity: 'error' | 'success' | 'fail' }) {
  return (
    <section className={`workflow-block workflow-alert workflow-alert-${severity}`}>
      <span className="workflow-alert-label">{severity === 'success' ? 'OK' : severity === 'fail' ? 'FAIL' : 'Error'}</span>
      <span>{text}</span>
    </section>
  );
}

function WorkflowTimelineBlockView({
  block,
  runComplete,
}: {
  block: WorkflowTimelineBlock;
  runComplete: boolean;
}) {
  if (block.type === 'startup') {
    return <WorkflowStartupBlock meta={block.meta} defaultCollapsed={runComplete} />;
  }
  if (block.type === 'load') {
    return <WorkflowLoadBlock messages={block.messages} />;
  }
  if (block.type === 'step') {
    return <WorkflowStepBlockView block={block} />;
  }
  if (block.type === 'summary') {
    return <WorkflowSummaryBlock rows={block.rows} />;
  }
  if (block.type === 'error') {
    return <WorkflowErrorBlock text={block.text} severity={block.severity} />;
  }
  return null;
}

function WorkflowLogFiles({ logFiles }: { logFiles: Record<string, string> }) {
  const entries = ['log', 'summary', 'manifest', 'tasksDir'].filter((key) => logFiles[key]);
  if (entries.length === 0) return null;
  return (
    <footer className="workflow-log-files">
      <span className="workflow-log-files-title">Project logs</span>
      <div className="workflow-kv-grid">
        {entries.map((key) => (
          <div key={key} className="workflow-kv-row">
            <span className="workflow-kv-key">{LOG_FILE_LABELS[key] ?? key}</span>
            <p className="workflow-kv-value"><code>{logFiles[key]}</code></p>
          </div>
        ))}
      </div>
    </footer>
  );
}

export function WorkflowLogPanel({
  title = 'Adaptation Output',
  workflow,
}: {
  title?: string;
  workflow: AdaptationWorkflowStatus;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const blocks = useMemo(() => parseWorkflowLog(workflow.log), [workflow.log]);
  const runComplete = !workflow.running && workflow.returnCode === 0;
  const stageLabel = useMemo(() => {
    const startup = blocks.find((block): block is Extract<WorkflowTimelineBlock, { type: 'startup' }> => block.type === 'startup');
    return startup?.meta.stage ?? null;
  }, [blocks]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [workflow.log]);

  const statusText = workflow.running
    ? 'running'
    : workflow.returnCode === 0
      ? 'complete'
      : workflow.returnCode === null || workflow.returnCode === undefined
        ? 'idle'
        : `exited ${workflow.returnCode}`;
  const statusClass = workflow.running
    ? 'running'
    : workflow.returnCode === 0
      ? 'complete'
      : workflow.returnCode
        ? 'error'
        : '';

  return (
    <div className="workflow-log-panel">
      <div className="workflow-log-header">
        <div className="workflow-log-header-main">
          <strong>{title}</strong>
          {stageLabel && <span className="workflow-log-stage">{stageLabel}</span>}
        </div>
        <span className={`workflow-log-status ${statusClass}`}>
          {workflow.running && <span className="spinner" aria-hidden="true" />}
          {statusText}
        </span>
      </div>
      <div className="workflow-timeline" ref={scrollRef} role="log" aria-live="polite">
        {blocks.length === 0 ? (
          <p className="workflow-timeline-empty">Waiting for output…</p>
        ) : (
          blocks.map((block) => (
            <WorkflowTimelineBlockView key={block.id} block={block} runComplete={runComplete} />
          ))
        )}
      </div>
      {workflow.logFiles && <WorkflowLogFiles logFiles={workflow.logFiles} />}
    </div>
  );
}
