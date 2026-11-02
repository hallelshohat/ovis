import { expect, it } from "bun:test";

import { onOpenBackgroundTask, openBackgroundTask } from "./backgroundTaskLink.ts";

it("hands a card's request to every list until it stops listening", () => {
  const heard: string[] = [];
  const stop = onOpenBackgroundTask((pane, task) => heard.push(`${pane}/${task}`));
  openBackgroundTask("w1:p1", "b1");
  stop();
  openBackgroundTask("w1:p1", "b2");
  expect(heard).toEqual(["w1:p1/b1"]);
});
