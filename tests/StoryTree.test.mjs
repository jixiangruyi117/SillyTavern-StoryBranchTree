import test from "node:test";
import assert from "node:assert/strict";
import {
  activateStoryBranch,
  createStoryBranch,
  createStoryBranchFromSwipe,
  createStoryTree,
  getStoryBranchRows,
  getStoryMessageId,
  resolveStoryBranch,
  syncActiveStoryBranch,
  validateStoryTree,
} from "../modules/StoryTree.js";

function ids() {
  let next = 0;
  return () => `id-${++next}`;
}

function message(mes, options = {}) {
  return { name: "Rin", is_user: false, mes, ...options };
}

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

test("keeps message metadata and chat-wide root state separate by route", () => {
  const chat = [
    message("开场", { horae_meta: { locationMemory: { 城堡: { desc: "主线城堡" } }, relationships: [{ summary: "主线关系" }] } }),
    message("分岔点", { horae_meta: { events: [{ summary: "共同事件" }] } }),
  ];
  const makeId = ids();
  const root = createStoryTree(chat, makeId);
  const forkId = getStoryMessageId(chat[1]);
  const left = createStoryBranch(root, forkId, "左线", makeId);
  const leftPath = resolveStoryBranch(left).map((item, index) => index === 0
    ? { ...item, horae_meta: { locationMemory: { 森林: { desc: "左线森林" } }, relationships: [{ summary: "左线关系" }] } }
    : item);
  const leftSynced = syncActiveStoryBranch(left, [
    ...leftPath,
    message("左线事件", { horae_meta: { events: [{ summary: "左线独有事件" }] } }),
  ]).tree;

  const rootView = resolveStoryBranch(leftSynced, leftSynced.rootBranchId);
  const leftView = resolveStoryBranch(leftSynced, leftSynced.activeBranchId);
  assert.equal(rootView[0].horae_meta.locationMemory.城堡.desc, "主线城堡");
  assert.equal(leftView[0].horae_meta.locationMemory.森林.desc, "左线森林");
  assert.deepEqual(leftView[1].horae_meta.events, [{ summary: "共同事件" }]);
  assert.equal(leftView[2].horae_meta.events[0].summary, "左线独有事件");

  const right = createStoryBranch(activateStoryBranch(leftSynced, leftSynced.rootBranchId), forkId, "右线", makeId);
  assert.equal(resolveStoryBranch(right)[0].horae_meta.locationMemory.城堡.desc, "主线城堡");
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
