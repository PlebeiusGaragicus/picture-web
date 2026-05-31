# Refine Image In Chat

## Idea

Add a true Gemini chat refinement mode for images. Instead of treating every edit as a stateless generation request, the user can open a chat on an existing image and iteratively ask for changes like:

- "make the jacket darker"
- "keep the face, but change the background to a studio"
- "try that again, but more cinematic"

Each successful chat edit creates a new sibling image node on the canvas. The sibling shares the same parent lineage as the source image, but records the chat turn that produced it as its prompt/provenance.

## Why This Might Help

Google documents `thought_signature` as an encrypted representation of Gemini's internal reasoning state. The API uses it to preserve reasoning continuity across multi-turn and multi-step conversations. For image editing, Google specifically shows a Gemini 3 Pro Image workflow where turn 1 returns response parts that include thought signatures, then turn 2 sends the prior image plus a refinement instruction through the same chat.

This might make repeated refinements better than our current stateless flow because Gemini can retain provider-side conversational state between edits, rather than relying only on the latest image bytes and prompt.

References:

- [Google Cloud: Thought signatures](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures)
- [Google AI for Developers: Thought Signatures](https://ai.google.dev/gemini-api/docs/thought-signatures)

## Product Shape

From an image node, add a "Refine in chat" action. This opens a chat panel scoped to the active variant.

The user sends an edit instruction. The backend sends the current image and the message to Gemini as part of a chat session. When Gemini returns an image, the app saves that image as a new asset and creates a sibling node near the source image.

The chat panel remains open so the user can continue refining. Later turns should use the same Gemini chat/session state, including thought signatures, so Gemini sees the edit chain as one conversation.

## Data Model Direction

Keep asset metadata compact. Permanent asset JSON should continue stripping large opaque payloads such as `thought_signature` and inline image data. Those fields are not useful in immutable asset receipts and can be very large.

Store full thought-signature-bearing provider state only in a separate chat/session record, for example:

```text
photo-library/projects/<project>/chat-sessions/<session_id>.json
```

A session record should include:

- source project and source asset id
- created/updated timestamps
- model and generation settings
- user-visible chat turns
- Gemini conversation state needed to resume the chat, including exact returned parts with `thought_signature`
- generated asset ids created by each assistant image turn

Generated image assets should link back to the chat session and turn id, but should not duplicate the full Gemini chat state.

## Canvas Behavior

Every successful assistant image response creates a sibling node, not a variant of the original node.

Reason: a chat refinement changes the instruction history, not just generation parameters. Siblings make this visible in lineage:

```text
same parents + different chat/edit instruction -> new sibling node
```

If a single chat turn returns multiple image candidates, those candidates can be grouped as variants within the newly created sibling node.

## Open Questions

- Should chat sessions be resumable across app restarts, or only while the sidebar is open?
- How much Gemini state should we retain before compacting old sessions?
- Should chat sessions be deleted when all generated sibling assets are deleted?
- Should the chat panel show only user-visible messages, or also expose compact debug metadata?
- Should a chat refinement inherit the active asset's model settings exactly, or allow the user to change model/settings per turn?

## Implementation Notes

Use the Google Gen AI SDK chat/history features where possible, because the docs state thought signatures are handled automatically when using standard chat history features or appending the full model response to history.

Do not rebuild the chat history from stripped asset receipts. The stripped provider metadata is intentionally not sufficient for resuming a thought-signature-aware Gemini chat. Chat resumability needs its own storage path and retention policy.
