import { z } from "zod";

/** Every string, including JSON encoded inside a string (tool arguments and results). */
export const deepStrings = (value: unknown): string[] => stringsIn(value).flatMap((text) => {
  if (!/^\s*[[{]/.test(text)) return [text];
  try {
    const parsed = json.safeParse(JSON.parse(text));
    return parsed.success ? [text, ...deepStrings(parsed.data)] : [text];
  } catch { return [text]; }
});

/** Every string in a value, however deep. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return value !== null && typeof value === "object" ? Object.values(value).flatMap(stringsIn) : [];
}

const json = z.json();
