/**
 * photo-web domain tools for narrow pi task agents.
 *
 * Loaded explicitly by the API's pi runtime (`--extension`), never via
 * project-trust discovery. The runtime scopes each task through env:
 *
 *   PHOTO_WEB_API           API origin, e.g. http://127.0.0.1:8787
 *   PHOTO_WEB_PROJECT       project slug the task operates on
 *   PHOTO_WEB_ALLOWED_TOOLS comma-separated allow-list; only these tools are
 *                           registered, so out-of-profile tools do not exist
 *                           in the system prompt at all
 *   PHOTO_WEB_TASK          task id (diagnostics only)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const API = process.env.PHOTO_WEB_API ?? "http://127.0.0.1:8787";
const PROJECT = process.env.PHOTO_WEB_PROJECT ?? "";

async function callApi(method: string, path: string, body: unknown): Promise<string> {
  if (!PROJECT) {
    throw new Error("PHOTO_WEB_PROJECT is not set; the runtime must provide the project slug");
  }
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text)?.detail ?? text;
    } catch {
      // Non-JSON error body; report it as-is.
    }
    throw new Error(`photo-web API ${response.status}: ${detail}`);
  }
  return text;
}

type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

const TOOLS: Record<string, ToolDefinition> = {
  set_panel_image_prompt: {
    name: "set_panel_image_prompt",
    label: "Set panel image prompt",
    description:
      "Save a finished image-generation prompt onto a story panel as a new prompt. " +
      "Call exactly once with the complete final prompt text.",
    parameters: Type.Object({
      panelId: Type.String({ description: "The target panel id, e.g. panel-004" }),
      prompt: Type.String({ description: "The complete imagen-ready prompt text (plain prose)" }),
    }),
    async execute(_toolCallId, params) {
      const result = await callApi(
        "POST",
        `/api/projects/${PROJECT}/story-panels/panels/${params.panelId}/image-prompts`,
        { text: params.prompt },
      );
      return { content: [{ type: "text", text: `Saved: ${result}` }], details: {} };
    },
  },
  replace_panel_image_prompt: {
    name: "replace_panel_image_prompt",
    label: "Replace panel image prompt",
    description:
      "Replace the text of one existing image prompt on a story panel with a revised version. " +
      "Call exactly once with the complete revised prompt text.",
    parameters: Type.Object({
      panelId: Type.String({ description: "The target panel id, e.g. panel-004" }),
      promptId: Type.String({ description: "The id of the prompt being revised, e.g. prompt-001" }),
      prompt: Type.String({ description: "The complete revised prompt text (plain prose)" }),
    }),
    async execute(_toolCallId, params) {
      const result = await callApi(
        "PUT",
        `/api/projects/${PROJECT}/story-panels/panels/${params.panelId}/image-prompts/${params.promptId}`,
        { text: params.prompt },
      );
      return { content: [{ type: "text", text: `Replaced: ${result}` }], details: {} };
    },
  },
  create_concept_card: {
    name: "create_concept_card",
    label: "Create concept card",
    description:
      "Create one new concept-art card with a finished image-generation prompt. " +
      "Call exactly once per invented concept.",
    parameters: Type.Object({
      subjectKind: StringEnum(["character", "location"] as const),
      displayName: Type.String({ description: "Short human-readable name for the concept" }),
      prompt: Type.String({ description: "The complete concept-art prompt text" }),
    }),
    async execute(_toolCallId, params) {
      const result = await callApi("POST", `/api/projects/${PROJECT}/concept-cards`, {
        subjectKind: params.subjectKind,
        displayName: params.displayName,
        prompt: params.prompt,
      });
      return { content: [{ type: "text", text: `Created: ${result}` }], details: {} };
    },
  },
};

export default function (pi: ExtensionAPI) {
  const allowed = (process.env.PHOTO_WEB_ALLOWED_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of allowed) {
    const tool = TOOLS[name];
    if (tool) pi.registerTool(tool);
  }
}
