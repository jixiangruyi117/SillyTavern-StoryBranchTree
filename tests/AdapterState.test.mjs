import test from "node:test";
import assert from "node:assert/strict";
import {
  createStoryTree, createStoryBranch, createStoryBranchFromSwipe, activateStoryBranch,
  captureStoryBranchAdapterState, getStoryMessageId, resolveStoryBranch, syncActiveStoryBranch,
  SWIPE_MESSAGE_FIELDS_KEY,
} from "../modules/StoryTree.js";

function setup() {
  let sequence = 0;
  const makeId = () => `adapter-${++sequence}`;
  const chat = [
    { is_user: false, mes: "共同前文", PluginMemory: { events: ["起点"] } },
    { is_user: true, mes: "选择路线" },
    { is_user: false, mes: "主线后续", PluginMemory: { events: ["起点", "主线"] } },
  ];
  const tree = createStoryTree(chat, makeId);
  captureStoryBranchAdapterState(tree, tree.rootBranchId, chat, "test-memory", ["PluginMemory"]);
  return { tree, chat, makeId };
}

test("shared story text has separate memory snapshots for the main route, child, and nested child", () => {
  const { tree, chat, makeId } = setup();
  let next = createStoryBranch(tree, getStoryMessageId(chat[1]), undefined, makeId);
  const childId = next.activeBranchId;
  let main = resolveStoryBranch(next, next.rootBranchId);
  main[0].PluginMemory.events.push("主线重新总结前文");
  next = syncActiveStoryBranch(activateStoryBranch(next, next.rootBranchId), main).tree;
  assert.deepEqual(resolveStoryBranch(next, childId)[0].PluginMemory.events, ["起点"]);
  let child = resolveStoryBranch(next, childId);
  child[0].PluginMemory.events.push("子路线单独修改");
  next = syncActiveStoryBranch(activateStoryBranch(next, childId), child).tree;
  const nested = createStoryBranch(next, getStoryMessageId(child[1]), undefined, makeId);
  const restored = JSON.parse(JSON.stringify(nested));
  assert.deepEqual(resolveStoryBranch(restored)[0].PluginMemory.events, ["起点", "子路线单独修改"]);
  assert.deepEqual(resolveStoryBranch(restored, restored.rootBranchId)[0].PluginMemory.events, ["起点", "主线重新总结前文"]);
  const external = resolveStoryBranch(restored, childId);
  external[0].PluginMemory.events.push("外部改动");
  assert.equal(resolveStoryBranch(restored, childId)[0].PluginMemory.events.length, 2);
});

test("missing fields and appended messages stay route-local after saving and re-importing", () => {
  const { tree, chat, makeId } = setup();
  let child = createStoryBranch(tree, getStoryMessageId(chat[1]), undefined, makeId);
  const projection = resolveStoryBranch(child);
  delete projection[0].PluginMemory;
  projection.push({ is_user: false, mes: "分支新回复", PluginMemory: { events: ["分支事件"] } });
  child = syncActiveStoryBranch(child, projection).tree;
  const imported = JSON.parse(JSON.stringify(child));
  assert.equal(resolveStoryBranch(imported)[0].PluginMemory, undefined);
  assert.deepEqual(resolveStoryBranch(imported).at(-1).PluginMemory.events, ["分支事件"]);
  assert.deepEqual(resolveStoryBranch(imported, imported.rootBranchId)[0].PluginMemory.events, ["起点"]);
});

test("a selected reply restores its own memory and MVU state without changing the original route", () => {
  const snapshots = value => ({ PluginMemory: { present: true, value: { events: [value] } } });
  const messages = [
    { is_user: true, mes: "提示" },
    { is_user: false, mes: "回复 A", swipe_id: 0, swipes: ["回复 A", "回复 B"],
      PluginMemory: { events: ["A"] }, variables: [{ stat_data: "A" }, { stat_data: "B" }],
      extra: { [SWIPE_MESSAGE_FIELDS_KEY]: snapshots("A") },
      swipe_info: [{ extra: { [SWIPE_MESSAGE_FIELDS_KEY]: snapshots("A") } },
        { extra: { [SWIPE_MESSAGE_FIELDS_KEY]: snapshots("B") } }],
    },
  ];
  const tree = createStoryTree(messages);
  captureStoryBranchAdapterState(tree, tree.rootBranchId, messages, "test-memory", ["PluginMemory"]);
  const child = createStoryBranchFromSwipe(tree, getStoryMessageId(messages[1]), 1);
  assert.equal(resolveStoryBranch(child).at(-1).mes, "回复 B");
  assert.deepEqual(resolveStoryBranch(child).at(-1).PluginMemory.events, ["B"]);
  assert.equal(resolveStoryBranch(child).at(-1).variables[0].stat_data, "B");
  assert.deepEqual(resolveStoryBranch(child, child.rootBranchId).at(-1).PluginMemory.events, ["A"]);
  assert.equal(resolveStoryBranch(child, child.rootBranchId).at(-1).mes, "回复 A");
  delete messages[1].swipe_info[1].extra[SWIPE_MESSAGE_FIELDS_KEY];
  delete messages[1].extra[SWIPE_MESSAGE_FIELDS_KEY];
  const unknown = createStoryTree(messages);
  captureStoryBranchAdapterState(unknown, unknown.rootBranchId, messages, "test-memory", ["PluginMemory"]);
  const newReply = createStoryBranchFromSwipe(unknown, getStoryMessageId(messages[1]), 1);
  assert.equal(resolveStoryBranch(newReply).at(-1).PluginMemory, undefined);
  assert.deepEqual(resolveStoryBranch(newReply, newReply.rootBranchId).at(-1).PluginMemory.events, ["A"]);
});

test("adapter fields cannot replace story content, native reply data, or variable state", () => {
  const { tree, chat } = setup();
  for (const field of ["mes", "extra", "variables", "swipes", "__proto__"]) {
    assert.throws(() => captureStoryBranchAdapterState(tree, tree.rootBranchId, chat, "test", [field]));
  }
  assert.equal(resolveStoryBranch(tree)[0].mes, "共同前文");
});

test("imported message IDs cannot alter the prototype of a memory snapshot map", () => {
  const chat = [{ is_user: false, mes: "导入消息", extra: { story_branch_tree_message_id: "__proto__" }, PluginMemory: { value: 7 } }];
  const tree = createStoryTree(chat);
  captureStoryBranchAdapterState(tree, tree.rootBranchId, chat, "test-memory", ["PluginMemory"]);
  const restored = JSON.parse(JSON.stringify(tree));
  assert.equal(resolveStoryBranch(restored)[0].PluginMemory.value, 7);
});

test("corrupt route memory is reported instead of being treated as an empty snapshot", () => {
  const { tree, chat } = setup();
  tree.branches[tree.rootBranchId].adapterStates["test-memory"].messages[getStoryMessageId(chat[0])] = null;
  assert.throws(() => resolveStoryBranch(tree), /记忆快照损坏/);
});
