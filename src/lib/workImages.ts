/**
 * The pictures a work line shows at its end (components/ChatView.tsx LineImages): what the tools
 * of a folded work block, or of one row, returned. The Claude app's folded "Read 2 files" line
 * shows them the same way, small, beside the words, so a reader sees what the agent saw without
 * opening anything.
 */
import { CODEX_IMAGE_REF, CODEX_TOOL_IMAGE_REF } from "../../shared/codex-image-refs.ts";
import type { ConversationPart } from "../../shared/protocol.ts";
import type { ToolPart } from "./workBlocks.ts";

export interface WorkImage {
  part: ToolPart;
  ref: string;
  mediaType: string;
  ordinal: number;
}

export const LINE_IMAGES_SHOWN = 4;
export const LINE_IMAGES_SHOWN_TOUCH = 3;
export const PREVIEW_MARGIN_PX = 8;

type Box = { top: number; bottom: number; left: number; width: number };

export function previewPlace(target: Box, size: { width: number; height: number }, viewport: { width: number; height: number }): { left: number; top: number } {
  const edge = PREVIEW_MARGIN_PX;
  const roomAbove = target.top - 2 * edge;
  const roomBelow = viewport.height - target.bottom - 2 * edge;
  const up = size.height <= roomAbove || (size.height > roomBelow && roomAbove > roomBelow);
  const top = up ? target.top - edge - size.height : target.bottom + edge;
  return {
    left: Math.max(edge, Math.min(target.left + target.width / 2 - size.width / 2, viewport.width - size.width - edge)),
    top: Math.max(edge, Math.min(top, viewport.height - size.height - edge)),
  };
}

export function workImages(parts: readonly ConversationPart[]): WorkImage[] {
  return parts.flatMap((part) => part.kind !== "tool" || part.images === undefined ? []
    : part.images.map((image, ordinal) => ({ part, ref: image.ref, mediaType: image.media_type, ordinal })));
}

/**
 * The refs the browser keeps once fetched, so a line may fetch their pictures before anything is
 * opened: Claude's (`<entry uuid>:<block>[:<index>]`), pi's (`pi:`, `pi-prompt:`), Grok's
 * (`grok-image:<digest of the bytes>`) and Copilot's (`copilot:<digest of the bytes>`) name bytes
 * that never change, and server/pane-routes.ts serves
 * them immutable. Codex and OpenCode refs are
 * served no-store, and an agent not listed here is taken to be. Codex also shows thumbnails
 * through linePictures, without changing that cache policy.
 */
const CACHED_IMAGE_REFS = [/^[0-9a-f-]{8,64}:\d{1,3}(?::\d{1,3})?$/i, /^pi:/, /^pi-prompt:/, /^grok-image:[a-f0-9]{64}$/, /^copilot:[a-f0-9]{64}$/];

export function cachedImageRef(ref: string): boolean {
  return CACHED_IMAGE_REFS.some((pattern) => pattern.test(ref));
}

/** Cached pictures and Codex results stay visible as thumbnails when their tools fold. */
export function linePictures(parts: readonly ConversationPart[]): WorkImage[] {
  return workImages(parts).filter((image) => cachedImageRef(image.ref) || CODEX_IMAGE_REF.test(image.ref) || CODEX_TOOL_IMAGE_REF.test(image.ref));
}

export function lineImages<T>(images: readonly T[], shown = LINE_IMAGES_SHOWN): { hidden: number; shown: readonly T[] } {
  if (images.length <= shown) return { hidden: 0, shown: images };
  return { hidden: images.length - shown, shown: images.slice(images.length - shown) };
}
