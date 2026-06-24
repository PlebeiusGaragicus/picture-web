export function formatRequestError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  return 'Something went wrong. Try again or rephrase the prompt.';
}

export function formatWorkflowStatusError(status: { returnCode?: number | null; log?: string | null }): string | null {
  if (status.returnCode === 0) return null;
  const log = status.log ?? '';
  for (const line of log.split('\n').reverse()) {
    const match = /^error:\s*(.+)$/i.exec(line.trim());
    if (match?.[1]) return match[1].trim();
  }
  if (status.returnCode != null) {
    return `Workflow failed (exit ${status.returnCode})`;
  }
  return 'Workflow failed';
}
