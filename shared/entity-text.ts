/**
 * Where a record's text has a named entity (`&eacute;`), the form readSaid keeps of it has this in
 * its place: Codex shows it as up to a few letters (a ligature, an accented letter) or none.
 */
export const ENTITY = "\uE000";

/** Steps of ENTITY matching (throughEntities) one weighing may take; past them, a record may show the word. */
export const ENTITY_STEPS = 1 << 20;

/**
 * Whether `text` holds `word`, each ENTITY in it standing for up to three of its letters or none;
 * also once `steps` run out.
 */
export function throughEntities({ text, word, steps }: { text: string; word: string; steps: { left: number } }): boolean {
  for (let entity = text.indexOf(ENTITY); entity >= 0; entity = text.indexOf(ENTITY, entity + 1)) {
    // a match through this entity begins at most a word's length before it
    for (let start = Math.max(0, entity - word.length); start <= entity; start++) {
      let reached = new Set([0]);
      for (let at = start; at < text.length && reached.size > 0 && at - start <= 4 * word.length; at++) {
        if (--steps.left < 0) return true;
        const next = new Set<number>();
        for (const done of reached) {
          if (text[at] === ENTITY) for (let more = 0; more <= 3 && done + more <= word.length; more++) next.add(done + more);
          else if (word[done] === text[at]) next.add(done + 1);
        }
        if (next.has(word.length)) return true;
        reached = next;
      }
    }
  }
  return false;
}

