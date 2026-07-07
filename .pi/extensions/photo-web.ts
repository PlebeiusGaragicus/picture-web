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

async function callApi(method: string, path: string, body?: unknown): Promise<string> {
  if (!PROJECT) {
    throw new Error("PHOTO_WEB_PROJECT is not set; the runtime must provide the project slug");
  }
  const response = await fetch(`${API}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
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
      "Save a finished image-generation prompt onto a story panel as a new prompt, " +
      "tagging which canonical characters and location the panel depicts. " +
      "Call exactly once with the complete final prompt text.",
    parameters: Type.Object({
      panelId: Type.String({ description: "The target panel id, e.g. panel-004" }),
      prompt: Type.String({ description: "The complete imagen-ready prompt text (plain prose)" }),
      characterSlugs: Type.Array(Type.String(), {
        description:
          "Slugs of every character visible in this panel, chosen only from the canonical character slugs in the context. Empty array if none.",
      }),
      locationSlug: Type.Optional(
        Type.String({
          description:
            "Slug of the panel's setting, chosen only from the canonical location slugs in the context. Omit if no listed location fits.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const result = await callApi(
        "POST",
        `/api/projects/${PROJECT}/story-panels/panels/${params.panelId}/image-prompts`,
        {
          text: params.prompt,
          characterSlugs: params.characterSlugs ?? [],
          locationSlug: params.locationSlug ?? null,
        },
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
  register_character: {
    name: "register_character",
    label: "Register character",
    description:
      "Register one character from the book as a new character record. " +
      "Call exactly once per character; use update_character afterwards to fill in details.",
    parameters: Type.Object({
      name: Type.String({ description: "Canonical display name, e.g. \"Pinkie Pie\"" }),
      summary: Type.String({
        description: "One-to-three sentence summary: who they are and why they matter in the story",
      }),
    }),
    async execute(_toolCallId, params) {
      const result = await callApi("POST", `/api/projects/${PROJECT}/characters`, {
        name: params.name,
        summary: params.summary,
      });
      return { content: [{ type: "text", text: `Registered: ${result}` }], details: {} };
    },
  },
  list_characters: {
    name: "list_characters",
    label: "List characters",
    description:
      "List every registered character record: slug, name, extraction state, and variant keys. " +
      "Use the returned slugs when calling update_character.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const result = await callApi("GET", `/api/projects/${PROJECT}/characters`);
      const records = JSON.parse(result) as Array<{
        slug: string;
        name: string;
        visualDescription: string;
        variants: Record<string, { prompt: string }>;
      }>;
      const lines = records.map((record) => {
        const extracted = record.visualDescription.trim() && record.variants.base?.prompt?.trim();
        const variantKeys = Object.keys(record.variants).join(", ") || "none";
        return `${record.slug} | ${record.name || record.slug} | ${extracted ? "extracted" : "empty"} | variants: ${variantKeys}`;
      });
      const text = lines.length ? lines.join("\n") : "(no characters registered)";
      return { content: [{ type: "text", text }], details: {} };
    },
  },
  update_character: {
    name: "update_character",
    label: "Update character",
    description:
      "Patch one registered character record: any of the description fields and/or variants. " +
      "Only include the fields you are changing; omitted fields keep their current value. " +
      "Variants are upserted by key ('base' plus optional durable-look variants like 'aged' or 'post-duel').",
    parameters: Type.Object({
      slug: Type.String({ description: "Character slug from the task context or list_characters" }),
      name: Type.Optional(Type.String({ description: "Canonical display name" })),
      summary: Type.Optional(Type.String({ description: "Who they are and why they matter" })),
      visualDescription: Type.Optional(
        Type.String({ description: "Source-supported appearance: body, face, clothing, silhouette, recurring visual traits" }),
      ),
      performanceNotes: Type.Optional(
        Type.String({ description: "Visual acting: temperament, speech, posture, recurring mannerisms and expressions" }),
      ),
      continuityNotes: Type.Optional(
        Type.String({ description: "Traits that must stay consistent across panels and variants; open design choices" }),
      ),
      variants: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({
            label: Type.Optional(Type.String({ description: "Short human label, e.g. \"Post-duel\"" })),
            storyContext: Type.Optional(
              Type.String({ description: "When this look applies in the story, e.g. \"after the duel in chapter 2\"" }),
            ),
            prompt: Type.Optional(Type.String({ description: "Complete reference-sheet prompt with layout block and Expressions line" })),
          }),
          { description: "Variant patches keyed by variant slug; 'base' is required for a complete character" },
        ),
      ),
      removeVariants: Type.Optional(
        Type.Array(Type.String(), { description: "Variant keys to delete from the record" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const { slug, ...patch } = params as { slug: string } & Record<string, unknown>;
      const result = await callApi("PATCH", `/api/projects/${PROJECT}/characters/${slug}`, patch);
      return { content: [{ type: "text", text: `Updated: ${result}` }], details: {} };
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
