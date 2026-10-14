import test from "node:test";
import assert from "node:assert/strict";
import { createStoryTree, createStoryBranch, resolveStoryBranch, getStoryMessageId } from "../modules/StoryTree.js";
import { captureMemoryState, restoreMemoryState } from "../modules/MemoryState.js";

test("native hidden and system flags stay isolated per route", () => {
  const tree = createStoryTree([
    { mes: "前文", is_hidden: true, is_system: true },
    { mes: "分叉点" },
  ]);
  const anchor = resolveStoryBranch(tree)[1];
  const branch = createStoryBranch(tree, getStoryMessageId(anchor));
  const root = tree.branches[tree.rootBranchId];
  const child = branch.branches[branch.activeBranchId];

  const childMessages = resolveStoryBranch(branch);
  childMessages[0].is_hidden = false;
  childMessages[0].is_system = false;
  captureMemoryState(child, childMessages);

  const restoredChild = resolveStoryBranch(branch, child.id);
  restoreMemoryState(child, restoredChild);
  assert.equal(restoredChild[0].is_hidden, false);
  assert.equal(restoredChild[0].is_system, false);

  const restoredRoot = resolveStoryBranch(branch, root.id);
  restoreMemoryState(root, restoredRoot);
  assert.equal(restoredRoot[0].is_hidden, true);
  assert.equal(restoredRoot[0].is_system, true);
});

test("restoring native flags leaves plugin-owned message data untouched", () => {
  const tree = createStoryTree([{ mes: "消息", PluginMemory: { note: "独立状态" }, is_hidden: true }]);
  const branch = tree.branches[tree.rootBranchId];
  const messages = resolveStoryBranch(tree);
  captureMemoryState(branch, messages);

  messages[0].is_hidden = false;
  messages[0].PluginMemory.note = "插件更新";
  restoreMemoryState(branch, messages);

  assert.equal(messages[0].is_hidden, true);
  assert.equal(messages[0].PluginMemory.note, "插件更新");
});
