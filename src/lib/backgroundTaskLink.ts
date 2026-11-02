/**
 * A chat card asks the composer's background-task list to open one task: the card knows the
 * pane and the task id, the list (BackgroundTasks.tsx) owns the sheet. One listener per mounted
 * list; a request for another pane is not that list's.
 */
type Listener = (paneId: string, taskId: string) => void;
const listeners = new Set<Listener>();

export function openBackgroundTask(paneId: string, taskId: string): void {
  for (const listener of listeners) listener(paneId, taskId);
}

export function onOpenBackgroundTask(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
