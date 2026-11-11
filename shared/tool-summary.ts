/** What a tool call is about, in one line: read by the server's transcript parsers and the client's subagent view. */

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const label = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/** The one-line summary a collapsed tool chip shows. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  // an OmO or omp `task` call: the summary it gave the person, one per task of a batch
  if (name === "task") {
    const items = Array.isArray(input["tasks"]) ? input["tasks"].map(record) : [input];
    const titles = items.map((item) => label(item["task_summary"]) ?? label(item["description"])).filter((title) => title !== null);
    if (titles.length > 0) return titles.join(" · ").slice(0, 120);
  }
  // what the agent itself said the call is for: OmO's eval `summary`, the `description` Claude
  // gives a Bash command or a subagent's prompt. Another tool's `description` is its own data.
  const said = typeof input["code"] === "string" ? label(input["summary"])
    : typeof input["command"] === "string" || typeof input["prompt"] === "string" ? label(input["description"]) : null;
  if (said !== null) return said.slice(0, 120);
  // pi names a file `path` where Claude names it `file_path`, and a notebook `notebook_path`.
  const first = input["command"] ?? input["file_path"] ?? input["notebook_path"] ?? input["path"] ?? input["pattern"] ?? input["description"] ?? input["url"];
  return typeof first === "string" ? first.slice(0, 120) : name;
}

