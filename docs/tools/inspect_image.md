# inspect_image

> Analyze a local image or turn attachment with a vision-capable model and return compact text findings.

## Source

- Entry: `packages/coding-agent/src/tools/inspect-image.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/inspect-image.md`
- Image loading and size policy: `packages/coding-agent/src/utils/image-loading.ts`, `packages/coding-agent/src/utils/image-limits.ts`
- Tool registration: `packages/coding-agent/src/tools/index.ts`

## Availability and metadata

- Built-in, discoverable tool with `approval = "read"` and a non-strict schema.
- The tool submits the selected image to a vision-capable model; it is not a replacement for `read` when only file text is needed.
- Image submission can be disabled by `images.blockImages`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `path` | `string` | Yes | Local image path, local `.svg`/`.svgz` path with the `:img` selector, `Image #N` attachment label, or `attachment://N` / `image://N` attachment URI. |
| `question` | `string` | Yes | Specific question or requested extraction/format, grounded in observable image content. |

## Behavior and model selection

1. The tool resolves a vision-capable model in this order: `@vision`, `@default`, the active model, another image-capable model from the active provider, then any available image-capable model.
2. It resolves a filesystem path relative to the session working directory, or resolves the referenced image attachment from the current turn.
3. It detects the image from file content, loads it, and sends one image part plus the question to the selected model. Explicit `:img` on `.svg`/`.svgz` rasterizes the SVG before submission.
4. The question is sent as provided; ask for uncertainty when details are unclear and specify formats such as bullets, a table, JSON, or verbatim OCR when needed.

## Outputs

The result contains one text content block with the vision model's text-only analysis. It does not return an image content block.

Structured `details` contains:

- `model`: selected `<provider>/<model-id>`.
- `imagePath`: resolved filesystem path or attachment URI used as the image source.
- `mimeType`: MIME type submitted to the model, including any conversion or resize result.
- `usage`: model usage information.

## Limits and guardrails

- Supported file-content types are PNG, JPEG, GIF, and WEBP. SVG/SVGZ is accepted only with `:img` and is rasterized to PNG.
- The image input pipeline caps a local file or rasterized SVG source at `20 MiB` (`MAX_IMAGE_INPUT_BYTES`).
- The selected model must accept image input and have an available API key. If no vision-capable model or credential is available, execution fails with an actionable error.
- When `images.blockImages = true`, execution fails rather than submitting the image.
- The request observes the caller abort signal and the optional `images.questionTimeoutMs`; a configured positive timeout reports an `inspect_image` timeout error.
- Unknown input fields are rejected by the schema. Invalid, missing, unreadable, unsupported, or empty image inputs fail rather than being sent as text.

## Examples

OCR visible text:

```json
{"path":"screenshots/error.png","question":"Extract all visible text verbatim. Return as bullet list in reading order."}
```

Diagnose a screenshot:

```json
{"path":"screenshots/settings.png","question":"Identify the likely cause of the disabled Save button. Return: (1) observations, (2) likely cause, (3) confidence."}
```
