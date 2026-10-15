import test from "node:test";
import assert from "node:assert/strict";
import { captureReplyMemory, readReplyMemory, restoreReplyMemory } from "../modules/StoryTree.js";

test("reply memory preserves manual fields, explicit absence and independent swipe versions", () => {
  const m = { mes: "A", swipes: ["A", "B"], swipe_id: 0, swipe_info: [{ extra: {} }, { extra: {} }], Memory: { value: 11 } };
  captureReplyMemory(m, ["Memory", "Optional"]);
  m.Memory.value = 99;
  assert.equal(readReplyMemory(m, ["Memory"]).Memory.value, 11);
  m.swipe_id = 1; m.mes = "B"; m.extra = {}; m.Memory = { value: 22 };
  captureReplyMemory(m, ["Memory", "Optional"]);
  assert.equal(readReplyMemory(m, ["Memory"], { swipeId: 0 }).Memory.value, 11);
  m.swipe_id = 0; m.mes = "A"; m.extra = structuredClone(m.swipe_info[0].extra); m.Optional = "stale";
  assert.equal(restoreReplyMemory(m, ["Memory", "Optional"]), true);
  assert.deepEqual(m.Memory, { value: 11 });
  assert.equal(Object.hasOwn(m, "Optional"), false);
  const restored = JSON.parse(JSON.stringify(m));
  assert.equal(readReplyMemory(restored, ["Memory"], { swipeId: 1 }).Memory.value, 22);
});

test("unrecorded, changed text and broken snapshots never masquerade as restored memory", () => {
  const m = { mes: "A", Memory: 1 };
  assert.equal(readReplyMemory(m, ["Memory"]), null);
  captureReplyMemory(m, ["Memory"]);
  m.mes = "edited A";
  assert.equal(restoreReplyMemory(m, ["Memory"]), false);
  assert.equal(m.Memory, 1);
  assert.throws(() => captureReplyMemory(m, ["mes"]), /只能/);
  assert.throws(() => captureReplyMemory({ mes: "user", is_user: true }, ["Memory"]), /AI/);
  m.mes = "A";
  m.extra.story_branch_tree_swipe_message_fields.Memory.present = "yes";
  assert.throws(() => readReplyMemory(m, ["Memory"]), /损坏/);
});

test("two owners update only their declared reply fields", () => {
  const m = { mes: "A", First: { x: 1 }, Second: { x: 2 } };
  captureReplyMemory(m, ["First"]);
  captureReplyMemory(m, ["Second"]);
  m.First.x = 3;
  captureReplyMemory(m, ["First"]);
  assert.equal(readReplyMemory(m, ["Second"]).Second.x, 2);
  assert.equal(readReplyMemory(m, ["First"]).First.x, 3);
});
