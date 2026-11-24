import { z } from "zod";

const heldSubmit = z.looseObject({
  type: z.literal("submit"),
  delivery: z.literal("hold"),
  pane_id: z.string(),
  text: z.string(),
});

/** Seed a legacy queued receipt without changing how the current client handles it. */
export function legacyQueuedSubmit({
  raw,
  matches = () => true,
}: {
  raw: string | Buffer;
  matches?: (frame: z.infer<typeof heldSubmit>) => boolean;
}): string | Buffer {
  const frame = heldSubmit.safeParse(JSON.parse(String(raw)));
  if (!frame.success || !matches(frame.data)) return raw;
  return JSON.stringify({ ...frame.data, delivery: "queue" });
}
