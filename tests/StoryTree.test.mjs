import test from "node:test";
import assert from "node:assert/strict";
import {
  activateStoryBranch,
  captureStoryBranchAdapterState,
  captureStoryBranchAdapterMetadata,
  createStoryBranch,
  createStoryBranchFromSwipe,
  createStoryTree,
  getStoryBranchRows,
  getStoryMessageId,
  resolveStoryBranch,
  syncActiveStoryBranch,
  validateStoryTree,
} from "../modules/StoryTree.js";
import { captureMemoryState } from "../modules/MemoryState.js";

function ids() {
  let next = 0;
  return () => `id-${++next}`;
}

function message(mes, options = {}) {
  return { name: "Rin", is_user: false, mes, ...options };
}

test("fork preparation shares saved bodies but isolates records, inherited state and returned messages", t => {
  const makeId = ids();
  const chat = [message("前文", { PluginMemory: { events: ["原状态"] }, is_hidden: true }), message("后续")];
  const root = createStoryTree(chat, makeId);
  captureStoryBranchAdapterState(root, root.rootBranchId, chat, "memory", ["PluginMemory"]);
  captureStoryBranchAdapterMetadata(root, root.rootBranchId, { notes: { text: "原容器" } }, "memory", ["notes"]);
  root.layout = { [root.rootBranchId]: { x: 1, y: 2 } };
  const saved = JSON.stringify(root);
  const original = globalThis.structuredClone;
  let treeCopies = 0;
  let chatCopies = 0;
  globalThis.structuredClone = value => {
    if (value?.messages && value?.branches) treeCopies++;
    if (Array.isArray(value) && value.some(item => typeof item?.mes === "string")) chatCopies++;
    return original(value);
  };
  t.after(() => { globalThis.structuredClone = original; });
  const next = createStoryBranch(root, getStoryMessageId(chat[0]), undefined, makeId);
  assert.equal(treeCopies, 0);
  assert.equal(chatCopies, 0);
  assert.equal(next.messages[getStoryMessageId(chat[1])], root.messages[getStoryMessageId(chat[1])]);
  assert.notEqual(next.branches[root.rootBranchId], root.branches[root.rootBranchId]);
  next.layout[root.rootBranchId].x = 9;
  const inherited = next.branches[next.activeBranchId].adapterStates.memory;
  inherited.messages[getStoryMessageId(chat[0])].PluginMemory.events.push("新路线");
  inherited.metadata.notes.text = "新容器";
  const previousRoute = resolveStoryBranch(next, root.rootBranchId);
  previousRoute[0].is_hidden = false;
  captureMemoryState(next.branches[root.rootBranchId], previousRoute);
  captureStoryBranchAdapterState(next, root.rootBranchId, previousRoute, "memory", ["PluginMemory"]);
  captureStoryBranchAdapterMetadata(next, root.rootBranchId, { notes: { text: "准备中的容器" } }, "memory", ["notes"]);
  const projected = resolveStoryBranch(next);
  projected[0].extra.arbitrary = { value: "外部改动" };
  assert.equal(JSON.stringify(root), saved);
  assert.equal(resolveStoryBranch(next)[0].extra.arbitrary, undefined);
});

test("graph labels do not expand inactive parent bodies or restore their native state", () => {
  const makeId = ids();
  const root = createStoryTree([message("开场"), message("分叉"), message("主线结尾")], makeId);
  let child = createStoryBranch(root, getStoryMessageId(resolveStoryBranch(root)[1]), undefined, makeId);
  child = syncActiveStoryBranch(child, [...resolveStoryBranch(child), message("子线结尾")]).tree;
  const childId = child.activeBranchId;
  const suffixId = child.branches[childId].messageIds[0];
  const nested = createStoryBranch(child, suffixId, undefined, makeId);
  const main = activateStoryBranch(nested, root.rootBranchId);
  const expected = getStoryBranchRows(main);
  Object.defineProperty(main.messages[suffixId], "UnusedMemory", {
    enumerable: true, get() { throw Error("inactive parent body was expanded"); },
  });
  Object.defineProperty(main.branches[childId].memoryState[suffixId].fields, "is_hidden", {
    enumerable: true, get() { throw Error("inactive parent native state was restored"); },
  });
  assert.deepEqual(getStoryBranchRows(main), expected);
});

test("graph reply labels track stable variants on nested and imported legacy routes", () => {
  const makeId = ids();
  const chat = [message("问题", { is_user: true }), message("回复 B", {
    swipes: ["回复 A", "回复 B"], swipe_id: 1, swipe_info: [{ extra: {} }, { extra: {} }],
  })];
  const root = createStoryTree(chat, makeId);
  const child = createStoryBranchFromSwipe(root, getStoryMessageId(chat[1]), 0, undefined, makeId);
  const childId = child.activeBranchId;
  const continued = syncActiveStoryBranch(child, [...resolveStoryBranch(child), message("下一步 Y", {
    swipes: ["下一步 X", "下一步 Y"], swipe_id: 1, swipe_info: [{ extra: {} }, { extra: {} }],
  })]).tree;
  const replyId = continued.branches[childId].messageIds.at(-1);
  const nested = createStoryBranchFromSwipe(continued, replyId, 0, undefined, makeId);
  const nestedId = nested.activeBranchId;
  const originalRows = getStoryBranchRows(nested);
  assert.equal(originalRows.find(row => row.id === childId).branchNumber, "1.R2.1");
  assert.equal(originalRows.find(row => row.id === nestedId).branchNumber, "1.R2.1.R3.1");
  const imported = JSON.parse(JSON.stringify(nested));
  delete imported.branches[nestedId].sourceMessageId;
  const source = imported.messages[replyId];
  source.swipes.reverse();
  source.swipe_info.reverse();
  const rows = getStoryBranchRows(imported);
  const row = rows.find(row => row.id === nestedId);
  assert.equal(row.sourceMessageId, replyId);
  assert.equal(row.replyIndex, 1);
  assert.equal(row.sourceVariantPresent, true);
  assert.equal(row.branchNumber, "1.R2.1.R3.1");
});

test("sync copies live messages once without cloning the read-only saved projection", t => {
  const makeId = ids();
  const initial = createStoryTree([message("回复3", {
    swipe_id: 2, swipes: ["回复1", "回复2", "回复3"], swipe_info: [{ extra: {} }, { extra: {} }, { extra: {} }],
  }), message("后续")], makeId);
  const tree = syncActiveStoryBranch(initial, resolveStoryBranch(initial)).tree;
  const live = resolveStoryBranch(tree);
  const saved = JSON.stringify(tree);
  const original = globalThis.structuredClone;
  let projections = 0;
  globalThis.structuredClone = value => {
    if (Array.isArray(value) && value.length && value.every(item => typeof item?.mes === "string")) projections++;
    return original(value);
  };
  t.after(() => { globalThis.structuredClone = original; });
  const result = syncActiveStoryBranch(tree, live);
  assert.equal(projections, 1);
  assert.equal(JSON.stringify(tree), saved);
  result.messages[0].swipe_info[2].extra.test = "new";
  assert.equal(live[0].swipe_info[2].extra.test, undefined);
  assert.equal(resolveStoryBranch(tree)[0].swipe_info[2].extra.test, undefined);
});

test("branch numbering uses read-only paths without cloning chat bodies", t => {
  const makeId = ids();
  const root = createStoryTree([message("开场"), message("分叉"), message("后续")], makeId);
  const child = createStoryBranch(root, getStoryMessageId(resolveStoryBranch(root)[1]), undefined, makeId);
  const saved = JSON.stringify(child);
  const original = globalThis.structuredClone;
  let copies = 0;
  globalThis.structuredClone = value => { copies++; return original(value); };
  t.after(() => { globalThis.structuredClone = original; });
  const rows = getStoryBranchRows(child);
  assert.equal(copies, 0);
  assert.equal(rows.find(row => row.id === child.activeBranchId).branchNumber, "1.2.1");
  assert.equal(JSON.stringify(child), saved);
});

test("creates a tree only when asked and forks at a stable message identity", () => {
  const chat = [message("到达路口"), message("夜色降临")];
  const makeId = ids();
  const tree = createStoryTree(chat, makeId);
  assert.equal(Object.keys(tree.branches).length, 1);
  assert.ok(getStoryMessageId(chat[0]));

  const branch = createStoryBranch(tree, getStoryMessageId(chat[0]), "走进森林", makeId);
  assert.equal(Object.keys(branch.branches).length, 2);
  assert.equal(branch.branches[branch.activeBranchId].forkMessageId, getStoryMessageId(chat[0]));
  assert.deepEqual(resolveStoryBranch(branch).map((item) => item.mes), ["到达路口"]);
});

test("child branches store only their suffix and preserve sibling routes", () => {
  const chat = [message("A"), message("B"), message("C")];
  const makeId = ids();
  const root = createStoryTree(chat, makeId);
  const forkId = getStoryMessageId(chat[1]);
  const left = createStoryBranch(root, forkId, "左路", makeId);
  const leftProjection = resolveStoryBranch(left);
  const leftSynced = syncActiveStoryBranch(left, [...leftProjection, message("左路结局")]).tree;
  assert.equal(leftSynced.branches[leftSynced.activeBranchId].messageIds.length, 1);
  assert.deepEqual(resolveStoryBranch(leftSynced).map((item) => item.mes), ["A", "B", "左路结局"]);

  const right = createStoryBranch(activateStoryBranch(leftSynced, leftSynced.rootBranchId), forkId, "右路", makeId);
  const rightSynced = syncActiveStoryBranch(right, [...resolveStoryBranch(right), message("右路结局")]).tree;
  assert.deepEqual(resolveStoryBranch(rightSynced).map((item) => item.mes), ["A", "B", "右路结局"]);
  assert.deepEqual(resolveStoryBranch(rightSynced, leftSynced.activeBranchId).map((item) => item.mes), ["A", "B", "左路结局"]);
  assert.equal(getStoryBranchRows(rightSynced).length, 3);
  assert.equal(validateStoryTree(rightSynced), true);
});

test("pins the displayed swipe and its live metadata at the branch point", () => {
  const chat = [message("选择的第二版", {
    swipe_id: 1,
    swipes: ["第一版", "选择的第二版"],
    swipe_info: [
      { send_date: "one", extra: { marker: 1 } },
      { send_date: "stale", extra: { marker: 9 } },
    ],
    send_date: "two",
    extra: { marker: 2 },
  })];
  const tree = createStoryTree(chat, ids());
  const branch = createStoryBranch(tree, getStoryMessageId(chat[0]), "第二版后续", ids());
  const forked = resolveStoryBranch(branch)[0];
  assert.equal(forked.mes, "选择的第二版");
  assert.equal(forked.send_date, "two");
  assert.equal(forked.extra.marker, 2);
  assert.equal(forked.swipe_id, 1);
});

test("keeps a fork snapshot stable if the source swipe list changes later", () => {
  const chat = [message("第二版", {
    swipe_id: 1,
    swipes: ["第一版", "第二版"],
    swipe_info: [{ send_date: "one" }, { send_date: "two" }],
    send_date: "two",
  })];
  const tree = createStoryTree(chat, ids());
  const branch = createStoryBranch(tree, getStoryMessageId(chat[0]), "固定版本", ids());
  const forkId = getStoryMessageId(chat[0]);
  const changedSource = syncActiveStoryBranch(activateStoryBranch(branch, branch.rootBranchId), [{
    ...chat[0],
    mes: "第一版",
    swipe_id: 0,
    swipes: ["第一版"],
    swipe_info: [{ send_date: "one" }],
  }]).tree;

  assert.equal(resolveStoryBranch(changedSource, branch.activeBranchId)[0].mes, "第二版");
  assert.equal(resolveStoryBranch(changedSource, branch.activeBranchId)[0].send_date, "two");
  assert.equal(resolveStoryBranch(changedSource, branch.activeBranchId)[0].extra.story_branch_tree_message_id, forkId);
});

test("returns to reply 1 after branching from the displayed reply 3", () => {
  const makeId = ids();
  const chat = [
    message("用户提问", { is_user: true }),
    message("回复 3", {
      swipe_id: 2,
      swipes: ["回复 1", "回复 2", "回复 3"],
      swipe_info: [
        { extra: { memory: "第一版记忆" } },
        { extra: { memory: "第二版记忆" } },
        { extra: { memory: "第三版记忆" } },
      ],
      extra: { memory: "第三版记忆" },
    }),
  ];
  const root = createStoryTree(chat, makeId);
  const branch = createStoryBranchFromSwipe(root, getStoryMessageId(chat[1]), 2, "回复 3 路线", makeId);
  const branchId = branch.activeBranchId;
  assert.equal(branch.branches[branchId].originSwipeIndex, 2);
  assert.equal(branch.branches[branchId].sourceSwipeIndex, 2);
  assert.equal(resolveStoryBranch(branch)[1].mes, "回复 3");
  assert.equal(resolveStoryBranch(branch, branch.rootBranchId)[1].swipe_id, 2);
  assert.deepEqual(resolveStoryBranch(branch, branch.rootBranchId)[1].swipes, ["回复 1", "回复 2", "回复 3"]);

  const main = activateStoryBranch(branch, branch.rootBranchId);
  const mainChat = resolveStoryBranch(main);
  mainChat[1].swipe_id = 0;
  mainChat[1].mes = mainChat[1].swipes[0];
  mainChat[1].extra.memory = "第一版记忆";
  const continued = syncActiveStoryBranch(main, [...mainChat, message("沿着回复 1 继续")]).tree;
  const restored = JSON.parse(JSON.stringify(continued));
  assert.deepEqual(resolveStoryBranch(restored).map((item) => item.mes), ["用户提问", "回复 1", "沿着回复 1 继续"]);
  assert.equal(resolveStoryBranch(restored)[1].swipe_id, 0);
  assert.deepEqual(resolveStoryBranch(restored, branchId).map((item) => item.mes), ["用户提问", "回复 3"]);
  assert.equal(resolveStoryBranch(restored, branchId)[1].extra.memory, "第三版记忆");
  assert.equal(resolveStoryBranch(branch, branch.rootBranchId)[1].swipe_id, 2);
});

test("preserves generic message data in each route's fork anchor", () => {
  const chat = [
    message("开场"),
    message("分岔点", { routeMemory: { event: "主线事件" } }),
  ];
  const makeId = ids();
  const root = createStoryTree(chat, makeId);
  const forkId = getStoryMessageId(chat[1]);
  const left = createStoryBranch(root, forkId, "左线", makeId);
  const leftPath = resolveStoryBranch(left).map((item, index) => index === 1
    ? { ...item, routeMemory: { event: "左线事件" } }
    : item);
  const leftSynced = syncActiveStoryBranch(left, leftPath).tree;

  const rootView = resolveStoryBranch(leftSynced, leftSynced.rootBranchId);
  const leftView = resolveStoryBranch(leftSynced, leftSynced.activeBranchId);
  assert.deepEqual(rootView[1].routeMemory, { event: "主线事件" });
  assert.deepEqual(leftView[1].routeMemory, { event: "左线事件" });

  const right = createStoryBranch(activateStoryBranch(leftSynced, leftSynced.rootBranchId), forkId, "右线", makeId);
  assert.deepEqual(resolveStoryBranch(right)[1].routeMemory, { event: "主线事件" });
});

test("rejects a missing fork anchor and a deleted message without discarding the graph", () => {
  const chat = [message("A"), message("B")];
  const tree = createStoryTree(chat, ids());
  const branch = createStoryBranch(tree, getStoryMessageId(chat[0]), "备用路线", ids());
  assert.throws(() => resolveStoryBranch({
    ...branch,
    branches: {
      ...branch.branches,
      [branch.activeBranchId]: { ...branch.branches[branch.activeBranchId], forkMessageId: "missing" },
    },
  }), /分叉点/);
  assert.throws(() => syncActiveStoryBranch(branch, []), /删除/);
  assert.deepEqual(resolveStoryBranch(branch).map((item) => item.mes), ["A"]);
});

test("accepts deletion of an unshared message while keeping sibling routes", () => {
  const makeId = ids();
  const chat = [message("A"), message("B"), message("C")];
  const root = createStoryTree(chat, makeId);
  const child = createStoryBranch(root, getStoryMessageId(chat[0]), "另一条路", makeId);
  const main = activateStoryBranch(child, root.rootBranchId);
  const shortened = syncActiveStoryBranch(main, resolveStoryBranch(main).slice(0, -1)).tree;
  assert.deepEqual(resolveStoryBranch(shortened).map((item) => item.mes), ["A", "B"]);
  assert.deepEqual(resolveStoryBranch(shortened, child.activeBranchId).map((item) => item.mes), ["A"]);
  assert.equal(shortened.messages[getStoryMessageId(chat[2])], undefined);
  assert.deepEqual(resolveStoryBranch(main).map((item) => item.mes), ["A", "B", "C"]);
});

test("keeps the message identity when the final reply is regenerated", () => {
  const makeId = ids();
  const chat = [message("用户提问", { is_user: true }), message("旧回复")];
  const root = createStoryTree(chat, makeId);
  const oldId = getStoryMessageId(chat[1]);
  const child = createStoryBranch(root, oldId, "旧回复后续", makeId);
  const current = resolveStoryBranch(activateStoryBranch(child, root.rootBranchId));
  const replacement = message("新回复");
  const updated = syncActiveStoryBranch(activateStoryBranch(child, root.rootBranchId), [current[0], replacement]).tree;
  assert.equal(getStoryMessageId(updated.messages[oldId]), oldId);
  assert.equal(resolveStoryBranch(updated)[1].mes, "新回复");
  assert.equal(resolveStoryBranch(updated, child.activeBranchId)[1].mes, "旧回复");
});

test("still rejects deletion of a shared fork point", () => {
  const makeId = ids();
  const chat = [message("A"), message("B")];
  const root = createStoryTree(chat, makeId);
  const child = createStoryBranch(root, getStoryMessageId(chat[1]), "从 B 继续", makeId);
  const main = activateStoryBranch(child, root.rootBranchId);
  assert.throws(() => syncActiveStoryBranch(main, resolveStoryBranch(main).slice(0, -1)), /共用楼层或分叉点/);
});

test("assigns unique message IDs when copied/imported data contains duplicate extension fields", () => {
  const chat = [message("A", { extra: { story_branch_tree_message_id: "same" } }), message("B", { extra: { story_branch_tree_message_id: "same" } })];
  createStoryTree(chat, ids());
  assert.notEqual(getStoryMessageId(chat[0]), getStoryMessageId(chat[1]));
});
