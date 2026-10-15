import test from "node:test";
import assert from "node:assert/strict";
import { recentStoryGroups } from "../modules/RecentStories.js";

const entry = (chatName, storyId, id) => ({ chatName, storyId, route: { id } });

test("recent rows fold only exact known files in the same character and story", () => {
  const catalog = { a: { routes: { r: entry("main", "story", "r"), c: entry("child", "story", "c"), z: entry("other", "other-story", "z") } },
    b: { routes: { r: entry("main", "story", "r"), c: entry("child", "story", "c") } } };
  const rows = [{ avatar: "a", file: "main.jsonl" }, { avatar: "a", file: "child" }, { avatar: "a", file: "other" },
    { avatar: "a", file: "main - Branch #88" }, { avatar: "a", file: "main", group: "group" },
    { avatar: "b", file: "main" }, { avatar: "b", file: "child" }];
  const before = structuredClone({ catalog, rows });
  const groups = recentStoryGroups(rows, catalog);
  assert.deepEqual(groups, [[rows[0], rows[1]], [rows[5], rows[6]]]);
  assert.deepEqual({ catalog, rows }, before);
});

test("ambiguous file owners stay visible rather than disappearing into a guessed story", () => {
  const rows = [{ avatar: "a", file: "main" }, { avatar: "a", file: "child" }];
  const catalog = { a: { routes: { r: entry("main", "story", "r"), duplicate: entry("main", "different", "x"), c: entry("child", "story", "c") } } };
  assert.deepEqual(recentStoryGroups(rows, catalog), []);
  assert.deepEqual(recentStoryGroups(rows), []);
});
