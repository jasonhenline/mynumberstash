import { countAchievements } from "./achievements";

self.addEventListener("message", (event: MessageEvent<string[]>) => {
  self.postMessage(countAchievements(event.data));
});
