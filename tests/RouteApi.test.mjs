import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  activateStoryBranch, createStoryBranch, createStoryBranchFromSwipe, createStoryTree, getStoryMessageId, resolveStoryBranch, syncActiveStoryBranch,
} from "../modules/StoryTree.js";

// Run the actual extension with only its SillyTavern core imports replaced.
const coreStub = "data:text/javascript," + encodeURIComponent(
  "export const swipeState = 'none'; export const isGenerating = () => false;"
  + "export const sendTextareaMessage = () => {}; export const updateSwipeCounter = async () => {};",
);
const enterStub = "data:text/javascript," + encodeURIComponent("export const shouldSendOnEnter = () => false;");
const source = (await readFile(new URL("../index.js", import.meta.url), "utf8"))
  .replace(/"\.\/modules\/RecentStories\.js(?:\?[^\"]*)?"/, JSON.stringify(new URL("../modules/RecentStories.js", import.meta.url).href))
  .replace(/"\.\/modules\/MuyooMemory\.js(?:\?[^\"]*)?"/, JSON.stringify(new URL("../modules/MuyooMemory.js", import.meta.url).href))
  .replace(/"\.\/modules\/MemoryEnhancementBridge\.js(?:\?[^\"]*)?"/, JSON.stringify(new URL("../modules/MemoryEnhancementBridge.js", import.meta.url).href))
  .replace(/"\.\/modules\/NativeStory\.js(?:\?[^\"]*)?"/, JSON.stringify(new URL("../modules/NativeStory.js", import.meta.url).href))
  .replace(/"\.\/modules\/StoryTree\.js(?:\?[^\"]*)?"/, JSON.stringify(new URL("../modules/StoryTree.js", import.meta.url).href))
  .replace(/"\.\/modules\/MemoryState\.js(?:\?[^\"]*)?"/, JSON.stringify(new URL("../modules/MemoryState.js", import.meta.url).href))
  .replace('"../../../../script.js"', JSON.stringify(coreStub))
  .replace('"../../../RossAscends-mods.js"', JSON.stringify(enterStub));
const extension = await import("data:text/javascript," + encodeURIComponent(source
  + "\nexport { installPublicApi, removePublicApi, replaceActiveProjection, handlePendingSend, syncLiveChat, handleMessageChanged, openBranchSwitchConfirm, invalidateMemoryTasks, clampViewScale, fitView, zoomAt, view, saveCardPosition, saveForkPosition, saveCompactPosition, saveEndingPosition, historicalReplySource, routeUsesReply, nativeStorage, handleChatLoaded, singleMemoryCompatibility, ensureSingleMemory };\n//# sourceURL=StoryBranchTree-index.test.js"));

function setup(t) {
  let sequence = 0;
  const tree = createStoryTree([
    { is_user: false, mes: "到达路口", extra: { memory: "旧摘要" } },
    { is_user: true, mes: "走主线" },
  ], () => `id-${++sequence}`);
  const target = new EventTarget();
  const ctx = {
    chatId: "test-chat", characterId: 0, chat: resolveStoryBranch(tree),
    chatMetadata: { story_branch_tree: tree },
    updateChatMetadata(patch) { Object.assign(this.chatMetadata, patch); },
    saveMetadataDebounced() {}, clearChat: async () => {}, printMessages: async () => {},
    saveChat: async () => {}, eventTypes: { CHAT_LOADED: "chat-loaded" },
    eventSource: { emit: async () => {} },
  };
  const saved = new Map(["SillyTavern", "dispatchEvent"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.SillyTavern = { getContext: () => ctx };
  globalThis.dispatchEvent = target.dispatchEvent.bind(target);
  extension.installPublicApi();
  t.after(() => {
    extension.removePublicApi();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { ctx, tree, target, api: globalThis.SillyTavernStoryBranchTree, makeId: () => `id-${++sequence}` };
}

test("reply API respects ownership, ordinary chats, target hooks and expired API references", async t => {
  const { ctx, api, makeId } = setup(t);
  const fields = ["PluginMemory"];
  api.registerRouteAdapter({ id: "reply-owner", messageFields: fields,
    beforeSwitch() { api.captureReplyMemory("reply-owner", 0); },
    onFork(change) { assert.equal(change.getReplyMemory(0).PluginMemory, 12); },
  });
  ctx.chat[0].PluginMemory = 12;
  api.captureReplyMemory("reply-owner", 0);
  const value = api.getReplyMemory("reply-owner", 0);
  value.PluginMemory = 50;
  assert.equal(api.getReplyMemory("reply-owner", 0).PluginMemory, 12);
  assert.throws(() => api.captureReplyMemory("unknown", 0), /未注册/);
  const initial = extension.syncLiveChat();
  await extension.replaceActiveProjection(ctx, createStoryBranch(initial, getStoryMessageId(ctx.chat[0]), undefined, makeId));
  extension.removePublicApi();
  assert.equal(api.getReplyMemory("reply-owner", 0), null);
  assert.throws(() => api.captureReplyMemory("reply-owner", 0), /停用/);
});

test("native public API exposes stable route identity without storing adapter snapshots", async t => {
  const { ctx, api } = setup(t);
  ctx.chatMetadata = { notes: { value: 1 } };
  ctx.characters = [{ avatar: "native-api.png", name: "Native" }];
  ctx.extensionSettings = {};
  await extension.nativeStorage.initialize();
  const info = api.getActiveRoute();
  assert.equal(info.storageMode, "native");
  assert.equal(info.cacheKey, JSON.stringify([info.storyId, info.branchId]));
  assert.equal(api.getActiveRouteKey(), info.cacheKey);
  api.registerRouteAdapter({ id: "native-api", messageFields: ["PluginMemory"], metadataFields: ["notes"] });
  ctx.chat[0].PluginMemory = { value: 2 };
  const savedView = extension.nativeStorage.saveView;
  extension.nativeStorage.saveView = () => { throw Error("memory notification must not save graph layout"); };
  t.after(() => { extension.nativeStorage.saveView = savedView; });
  api.notifyMemoryChanged("native-api");
  assert.equal(ctx.chatMetadata.story_branch_tree, undefined);
  assert.equal(ctx.chatMetadata.story_branch_tree_native.route.adapterStates, undefined);
  assert.deepEqual(api.getRouteMetadata("native-api"), { notes: { value: 1 } });
  assert.equal(api.getRouteMessages("not-loaded"), null);
  const copy = api.getRouteMessages();
  copy[0].PluginMemory.value = 9;
  assert.equal(ctx.chat[0].PluginMemory.value, 2);
  const task = api.beginMemoryTask("native-api");
  ctx.groupId = "group";
  assert.equal(api.getActiveRoute(), null);
  assert.equal(api.getActiveRouteKey(), null);
  assert.equal(task.isCurrent(), false);
});

test("ordinary chat loading synchronizes its data without requiring a mounted tree panel", async t => {
  const { ctx } = setup(t);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = { getElementById: () => null };
  t.after(() => { if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document; });
  ctx.chat[0].mes = "加载后的正文";
  await extension.handleChatLoaded();
  const tree = ctx.chatMetadata.story_branch_tree;
  assert.equal(resolveStoryBranch(tree)[0].mes, "加载后的正文");
});

test("ordinary synchronization does not recapture all replies; explicit route preparation captures once", async t => {
  setup(t);
  const original = extension.singleMemoryCompatibility.captureReplies;
  let captures = 0;
  extension.singleMemoryCompatibility.captureReplies = () => { captures++; };
  t.after(() => { extension.singleMemoryCompatibility.captureReplies = original; });
  for (let i = 0; i < 3; i++) extension.syncLiveChat();
  assert.equal(captures, 0);
  await extension.ensureSingleMemory({ captureReplies: true });
  assert.equal(captures, 1);
  await extension.ensureSingleMemory();
  assert.equal(captures, 1);
});

for (const [name, args] of [
  ["saveCardPosition", id => [id, { x: -40, y: 60 }]],
  ["saveForkPosition", id => [`fork:${id}`, { x: -40, y: 60 }, true]],
  ["saveCompactPosition", id => ["leaves", id, { x: -40, y: 60 }, true]],
  ["saveEndingPosition", id => [id, { x: -40, y: 60 }, true]],
]) {
  test(`${name} persists layout once without resynchronizing chat or memory`, async t => {
    const { ctx, api } = setup(t);
    ctx.chat[0].PluginMemory = { probe: "layout-memory", value: 1 };
    api.registerRouteAdapter({ id: "layout-memory", messageFields: ["PluginMemory"] });
    const tree = ctx.chatMetadata.story_branch_tree;
    const savedMessages = JSON.stringify(tree.messages);
    const savedState = tree.branches[tree.activeBranchId].adapterStates;
    ctx.chat[0].mes = "等待原消息事件处理的编辑";
    let copies = 0;
    let saves = 0;
    const original = globalThis.structuredClone;
    globalThis.structuredClone = value => { copies++; return original(value); };
    t.after(() => { globalThis.structuredClone = original; });
    ctx.saveChat = async () => { saves++; };
    await extension[name](...args(tree.activeBranchId));
    assert.equal(copies, 0);
    assert.equal(saves, 1);
    assert.equal(ctx.chatMetadata.story_branch_tree, tree);
    assert.equal(JSON.stringify(tree.messages), savedMessages);
    assert.equal(tree.branches[tree.activeBranchId].adapterStates, savedState);
    assert.equal(ctx.chat[0].mes, "等待原消息事件处理的编辑");
    if (name === "saveCompactPosition") assert.equal(tree.compactLayout.leaves[tree.activeBranchId].x, -40);
    else assert.ok(Object.values(tree.layout).some(position => position.x === -40 && position.y === 60));
  });
}

test("reply identity checks only copy the requested floor, including legacy aliases", t => {
  const { ctx, makeId } = setup(t);
  ctx.chat.push({ is_user: false, mes: "回复3", swipe_id: 2, swipes: ["回复1", "回复2", "回复3"],
    swipe_info: [{ extra: {} }, { extra: {} }, { extra: {} }] });
  const initial = extension.syncLiveChat();
  const sourceId = getStoryMessageId(ctx.chat[2]);
  const mainVariant = ctx.chat[2].swipe_info[2].extra.story_branch_tree_variant_id;
  const child = createStoryBranchFromSwipe(initial, sourceId, 0, undefined, makeId);
  delete child.branches[child.activeBranchId].sourceMessageId;
  const ignored = child.messages[getStoryMessageId(ctx.chat[0])];
  Object.defineProperty(ignored, "UnusedHugeMemory", { enumerable: true, get() { throw Error("copied unrelated floor"); } });
  const reply = extension.historicalReplySource(child, 2);
  assert.equal(reply.sourceId, sourceId);
  assert.equal(reply.ownerId, initial.rootBranchId);
  assert.equal(reply.currentIndex, 0);
  assert.equal(extension.routeUsesReply(child, initial.rootBranchId, sourceId, 2, mainVariant, 2), true);
  assert.equal(extension.routeUsesReply(child, child.activeBranchId, sourceId, 2, mainVariant, 2), false);
  assert.equal(extension.historicalReplySource(child, -1), null);
});

test("ranged reads copy only requested messages and fields, including archived routes", t => {
  const { ctx, tree, api, makeId } = setup(t);
  const child = createStoryBranch(tree, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  ctx.chatMetadata.story_branch_tree = child;
  const expected = [{ mes: "到达路口", extra: { memory: "旧摘要" } }];
  Object.defineProperty(ctx.chat[1], "expensive", { enumerable: true, get() { throw new Error("unselected live field read"); } });
  assert.deepEqual(api.getRouteMessages(tree.rootBranchId, { from: 0, to: 1, fields: ["mes", "extra.memory"] }), expected);
  Object.defineProperty(child.messages[tree.branches[tree.rootBranchId].messageIds[1]], "mes", {
    enumerable: true, get() { throw new Error("discarded ancestor message read"); },
  });
  assert.deepEqual(api.getRouteMessages(tree.rootBranchId, { from: 0, to: 1, fields: ["mes", "extra.memory"] }), expected);
  assert.throws(() => api.getRouteMessages(child.activeBranchId, { from: -1 }), /范围/);
  assert.throws(() => api.getRouteMessages(child.activeBranchId, { fields: ["extra.__proto__.x"] }), /字段/);
});

test("memory tasks expire on A-B-A switches, source changes and adapter disposal", async t => {
  const { ctx, tree, api, makeId } = setup(t);
  const dispose = api.registerRouteAdapter({ id: "task-memory" });
  const task = api.beginMemoryTask("task-memory", { from: 0, to: 1 });
  assert.equal(task.isCurrent(), true);
  ctx.chat[0].mes = "修改正文";
  assert.equal(task.isCurrent(), false);
  ctx.chat[0].mes = "到达路口";
  extension.invalidateMemoryTasks();
  assert.equal(task.signal.aborted, true);
  assert.throws(() => task.assertCurrent(), /过期/);
  const beforeSwitch = api.beginMemoryTask("task-memory");
  const child = createStoryBranch(tree, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  await extension.replaceActiveProjection(ctx, child);
  await extension.replaceActiveProjection(ctx, activateStoryBranch(child, tree.rootBranchId));
  assert.equal(beforeSwitch.isCurrent(), false);
  const beforeDispose = api.beginMemoryTask("task-memory");
  dispose();
  assert.equal(beforeDispose.signal.aborted, true);
  assert.equal(beforeDispose.isCurrent(), false);
  assert.throws(() => api.beginMemoryTask("missing"), /未注册/);
});

test("fork callbacks receive the exact boundary once after preparation and before restoration", async t => {
  const { ctx, tree, api, makeId } = setup(t);
  const order = [];
  api.registerRouteAdapter({ id: "fork-aware", beforeSwitch: () => order.push("prepare"),
    onFork: change => { order.push("fork"); assert.equal(change.fork.inheritedMessageCount, 1);
      assert.equal(change.fork.forkMessageId, getStoryMessageId(ctx.chat[0])); assert.equal(change.fork.kind, "continuation"); },
    afterSwitch: () => order.push("restore"),
  });
  const child = createStoryBranch(tree, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  await extension.replaceActiveProjection(ctx, child);
  assert.deepEqual(order, ["prepare", "fork", "restore"]);
  order.length = 0;
  await extension.replaceActiveProjection(ctx, activateStoryBranch(child, tree.rootBranchId));
  assert.deepEqual(order, ["prepare", "restore"]);
});

test("explicit memory notifications update only selected records while legacy capture remains automatic", t => {
  const { ctx, api } = setup(t);
  ctx.chat[0].PluginMemory = { facts: "旧记忆" };
  api.registerRouteAdapter({ id: "explicit-memory", messageFields: ["PluginMemory"], snapshotMode: "explicit" });
  const before = ctx.chatMetadata.story_branch_tree.branches[api.getActiveRoute().branchId].adapterStates["explicit-memory"].messages;
  ctx.chat[0].PluginMemory = { facts: "新记忆" };
  api.notifyMemoryChanged("explicit-memory", { from: 0, to: 1 });
  const after = ctx.chatMetadata.story_branch_tree.branches[api.getActiveRoute().branchId].adapterStates["explicit-memory"].messages;
  assert.equal(after[getStoryMessageId(ctx.chat[0])].PluginMemory.facts, "新记忆");
  assert.equal(after[getStoryMessageId(ctx.chat[1])], before[getStoryMessageId(ctx.chat[1])]);
  ctx.chat[0].PluginMemory.facts = "未通知变动";
  const updated = extension.syncLiveChat();
  assert.equal(updated.branches[updated.activeBranchId].adapterStates["explicit-memory"].messages[getStoryMessageId(ctx.chat[0])].PluginMemory.facts, "新记忆");
});

test("each adapter captures its fields once per sync without mutating the prior snapshot", t => {
  const { ctx, api } = setup(t);
  ctx.chat[0].PluginMemory = { measurementTag: "capture-probe", value: 1 };
  api.registerRouteAdapter({ id: "automatic-memory", messageFields: ["PluginMemory"] });
  const previous = ctx.chatMetadata.story_branch_tree;
  const saved = JSON.stringify(previous);
  const original = globalThis.structuredClone;
  let fieldCopies = 0;
  globalThis.structuredClone = value => { if (value?.measurementTag === "capture-probe") fieldCopies++; return original(value); };
  t.after(() => { globalThis.structuredClone = original; });
  ctx.chat[0].PluginMemory.value = 2;
  const next = extension.syncLiveChat();
  assert.equal(fieldCopies, 1);
  assert.equal(JSON.stringify(previous), saved);
  assert.equal(next.branches[next.activeBranchId].adapterStates["automatic-memory"].messages[getStoryMessageId(ctx.chat[0])].PluginMemory.value, 2);
});

test("swipe fork boundaries exclude the original reply and identify the selected version", async t => {
  const { ctx, api, makeId } = setup(t);
  ctx.chat.push({ is_user: false, mes: "回复3", swipe_id: 2, swipes: ["回复1", "回复2", "回复3"], swipe_info: [{ extra: {} }, { extra: {} }, { extra: {} }] });
  const initial = extension.syncLiveChat();
  let fork;
  api.registerRouteAdapter({ id: "swipe-memory", onFork: change => { fork = change.fork; } });
  const child = createStoryBranchFromSwipe(initial, getStoryMessageId(ctx.chat[2]), 0, undefined, makeId);
  await extension.replaceActiveProjection(ctx, child);
  assert.equal(fork.kind, "swipe");
  assert.equal(fork.inheritedMessageCount, 2);
  assert.equal(fork.forkFloor, 2);
  assert.equal(fork.replyFloor, 3);
  assert.equal(fork.sourceSwipeIndex, 0);
  assert.equal(fork.sourceMessageId, getStoryMessageId(resolveStoryBranch(initial)[2]));
  assert.equal(fork.sourceVariantId, initial.messages[fork.sourceMessageId].swipe_info[0].extra.story_branch_tree_variant_id);
  assert.equal(api.getRouteMessages(initial.rootBranchId)[2].swipe_id, 2);
});

test("fork failure aborts the prepared adapter and leaves the original route intact", async t => {
  const { ctx, tree, api, makeId } = setup(t);
  const order = [];
  api.registerRouteAdapter({ id: "fork-failure", beforeSwitch: () => order.push("prepare"),
    onFork: () => { throw new Error("history unavailable"); }, onSwitchAborted: () => order.push("abort"),
  });
  await assert.rejects(extension.replaceActiveProjection(ctx, createStoryBranch(tree, getStoryMessageId(ctx.chat[0]), undefined, makeId)), /history unavailable/);
  assert.deepEqual(order, ["prepare", "abort"]);
  assert.equal(api.getActiveRoute().branchId, tree.rootBranchId);
});

test("scoped tasks allow appended floors, reject changed replies, and never survive API replacement", t => {
  const { ctx, api } = setup(t);
  api.registerRouteAdapter({ id: "scoped" });
  const options = { from: 0, to: 1 };
  const scoped = api.beginMemoryTask("scoped", options);
  const whole = api.beginMemoryTask("scoped");
  ctx.chat.push({ mes: "新增楼层", extra: {} });
  delete options.from; delete options.to;
  assert.equal(scoped.isCurrent(), true);
  assert.equal(whole.isCurrent(), false);
  ctx.chat[0].extra.story_branch_tree_variant_id = "new-reply";
  assert.equal(scoped.isCurrent(), false);
  extension.removePublicApi();
  assert.equal(scoped.signal.aborted, true);
  assert.throws(() => api.beginMemoryTask("scoped"), /停用/);
  extension.installPublicApi();
  assert.equal(scoped.isCurrent(), false);
});

test("providers reject duplicate ownership and stale or mismatched memory notifications", t => {
  const { ctx, api } = setup(t);
  api.registerRouteAdapter({ id: "first", handles: ["database"], messageFields: ["OwnedMemory"] });
  assert.throws(() => api.registerRouteAdapter({ id: "duplicate", handles: ["database"] }), /重复注册/);
  assert.throws(() => api.registerRouteAdapter({ id: "field-duplicate", messageFields: ["OwnedMemory"] }), /重复注册/);
  assert.throws(() => api.registerRouteAdapter({ id: "bad", messageFields: "not-array" }), /数组/);
  api.registerRouteAdapter({ id: "second" });
  const task = api.beginMemoryTask("first");
  assert.throws(() => api.notifyMemoryChanged("second", { task }), /不匹配/);
  task.finish();
  assert.throws(() => api.notifyMemoryChanged("first", { task }), /过期/);
  assert.equal(ctx.chatMetadata.story_branch_tree.branches[api.getActiveRoute().branchId].adapterStates.first.messages[getStoryMessageId(ctx.chat[0])].OwnedMemory, undefined);
});

test("a memory commit invalidates competing tasks but keeps the writer valid through injection", t => {
  const { ctx, api } = setup(t);
  api.registerRouteAdapter({ id: "writer", messageFields: ["Memory"], snapshotMode: "explicit" });
  const writer = api.beginMemoryTask("writer", { from: 0, to: 1 });
  const stale = api.beginMemoryTask("writer", { from: 0, to: 1 });
  ctx.chat[0].Memory = { value: 2 };
  api.notifyMemoryChanged("writer", { from: 0, to: 1, task: writer });
  assert.equal(writer.isCurrent(), true);
  assert.equal(stale.signal.aborted, true);
  assert.equal(stale.isCurrent(), false);
  writer.finish();
  assert.equal(writer.isCurrent(), false);
});

test("route-only task guards do not traverse messages or copy chat content", t => {
  const { ctx, api } = setup(t);
  api.registerRouteAdapter({ id: "route-only" });
  Object.defineProperty(ctx.chat[0], "mes", { get() { throw new Error("body must not be read"); } });
  const task = api.beginMemoryTask("route-only");
  assert.deepEqual(task.sources, []);
  for (let index = 0; index < 100; index++) assert.equal(task.isCurrent(), true);
  task.finish();
});

test("failed registration rolls back snapshots and leaves the provider ID available", t => {
  const { ctx, tree, api, makeId } = setup(t);
  const child = createStoryBranch(tree, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  ctx.chatMetadata.story_branch_tree = child;
  ctx.chat.splice(0, ctx.chat.length, ...resolveStoryBranch(child));
  ctx.chat[0].BadMemory = () => {};
  assert.throws(() => api.registerRouteAdapter({ id: "failed-provider", messageFields: ["BadMemory"] }));
  for (const branch of Object.values(child.branches)) assert.equal(branch.adapterStates?.["failed-provider"], undefined);
  assert.throws(() => api.beginMemoryTask("failed-provider"), /未注册/);
  delete ctx.chat[0].BadMemory;
  assert.doesNotThrow(() => api.registerRouteAdapter({ id: "failed-provider", messageFields: ["BadMemory"] }));
});

test("new messages refresh branch buttons before a tree is initialized", t => {
  const { ctx } = setup(t);
  delete ctx.chatMetadata.story_branch_tree;
  let scans = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = { getElementById: id => id === "chat"
    ? { querySelectorAll() { scans++; return []; } } : null };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  });
  extension.handleMessageChanged();
  assert.equal(scans, 1);
  assert.equal(ctx.chatMetadata.story_branch_tree, undefined);
});

test("route queries read current messages without changing unsaved data or archived routes", t => {
  const { ctx, tree, api } = setup(t);
  ctx.chat[0].mes = "刚编辑的正文";
  ctx.chat[0].extra.memory = "刚更新的摘要";
  ctx.chat.push({ is_user: false, mes: "尚未同步的新回复" });
  const before = structuredClone(ctx.chat);
  const originalClone = globalThis.structuredClone;
  let cloneCalls = 0;
  globalThis.structuredClone = (value) => { cloneCalls++; return originalClone(value); };
  t.after(() => { globalThis.structuredClone = originalClone; });
  const info = api.getActiveRoute();
  assert.equal(cloneCalls, 0);
  assert.equal(info.messageCount, 3);
  assert.deepEqual(info.messageIds, [getStoryMessageId(ctx.chat[0]), getStoryMessageId(ctx.chat[1]), null]);
  assert.equal(info.cacheKey, JSON.stringify([ctx.chatId, tree.rootBranchId]));
  assert.equal(api.getActiveRouteKey(), info.cacheKey);
  const copy = api.getRouteMessages();
  assert.equal(cloneCalls, 1);
  assert.equal(copy[0].mes, "刚编辑的正文");
  assert.equal(copy[0].extra.memory, "刚更新的摘要");
  copy[0].extra.memory = "外部改动";
  assert.equal(ctx.chat[0].extra.memory, "刚更新的摘要");
  assert.equal(tree.messages[tree.branches[tree.rootBranchId].messageIds[0]].extra.memory, "旧摘要");
  assert.deepEqual(ctx.chat, before);
});

test("route APIs reject unsupported chat contexts and unknown branches", t => {
  const { ctx, api } = setup(t);
  assert.equal(api.getRouteMessages("missing-branch"), null);
  ctx.groupId = "a-group";
  assert.equal(api.getActiveRoute(), null);
  assert.equal(api.getRouteMessages(), null);
  delete ctx.groupId;
  delete ctx.chatMetadata.story_branch_tree;
  assert.equal(api.getActiveRoute(), null);
  assert.equal(api.getRouteMessages(), null);
  globalThis.SillyTavern = { getContext: () => null };
  assert.equal(api.getActiveRoute(), null);
  assert.equal(api.getRouteMessages(), null);
});

test("projection exposes the target route during rendering and correlates both switch events", async t => {
  const { ctx, tree, api, target, makeId } = setup(t);
  const child = createStoryBranch(tree, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  const events = [];
  ctx.printMessages = async () => {
    assert.equal(api.getActiveRoute().branchId, child.activeBranchId);
    assert.deepEqual(api.getRouteMessages(), ctx.chat);
  };
  ctx.saveChat = async () => events.push("saved");
  ctx.eventSource.emit = async (type, payload) => events.push({ type, detail: payload.detail.storyBranchTree });
  target.addEventListener(api.eventName, event => events.push({ type: "route-switch", detail: event.detail }));
  await extension.replaceActiveProjection(ctx, child);
  assert.equal(events[0], "saved");
  assert.equal(events[1].type, "chat-loaded");
  assert.equal(events[2].type, "route-switch");
  assert.ok(events[1].detail.transitionId);
  assert.equal(events[1].detail.transitionId, events[2].detail.transitionId);
  assert.equal(events[2].detail.previousBranchId, tree.rootBranchId);
  assert.equal(events[2].detail.branchId, child.activeBranchId);
  assert.equal(events[2].detail.messageCount, ctx.chat.length);
  const firstTransitionId = events[2].detail.transitionId;
  events.length = 0;
  await extension.replaceActiveProjection(ctx, child);
  assert.equal(events.length, 2);
  assert.equal(events[1].detail, undefined);
  ctx.printMessages = async () => {};
  events.length = 0;
  await extension.replaceActiveProjection(ctx, activateStoryBranch(child, tree.rootBranchId));
  assert.notEqual(events[2].detail.transitionId, firstTransitionId);
  assert.deepEqual(api.getRouteMessages(child.activeBranchId), resolveStoryBranch(child));
});

test("completed switch listeners can start memory tasks after the projection is released", async t => {
  const { ctx, tree, api, target, makeId } = setup(t);
  api.registerRouteAdapter({ id: "ready-task" });
  let task;
  let failure;
  target.addEventListener(api.eventName, () => {
    try { task = api.beginMemoryTask("ready-task", { from: 0, to: 1 }); }
    catch (error) { failure = error; }
  });
  const child = createStoryBranch(tree, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  await extension.replaceActiveProjection(ctx, child);
  assert.equal(failure, undefined);
  assert.equal(task.cacheKey, api.getActiveRouteKey());
  assert.equal(task.isCurrent(), true);
  task.finish();
});

test("a retained API reference becomes inactive after removal and remains inactive on reactivation", t => {
  const { api } = setup(t);
  assert.ok(api.getActiveRoute());
  extension.removePublicApi();
  assert.equal(globalThis.SillyTavernStoryBranchTree, undefined);
  assert.equal(api.getActiveRoute(), null);
  assert.equal(api.getRouteMessages(), null);
  extension.installPublicApi();
  assert.ok(globalThis.SillyTavernStoryBranchTree.getActiveRoute());
  assert.equal(api.getActiveRoute(), null);
  assert.equal(api.getActiveRouteKey(), null);
});

test("memory restoration is awaited before the switch event and promise complete", async t => {
  const { ctx, tree, api, target, makeId } = setup(t);
  let restored;
  let started;
  const waiting = new Promise(resolve => { restored = resolve; });
  const restoring = new Promise(resolve => { started = resolve; });
  const order = [];
  api.registerRouteAdapter({ id: "memory", messageFields: ["PluginMemory"],
    beforeSwitch: () => order.push("prepare"),
    afterSwitch: async () => { order.push("restore"); started(); await waiting; order.push("ready"); },
  });
  ctx.printMessages = async () => { order.push("render"); };
  target.addEventListener(api.eventName, () => order.push("event"));
  const child = createStoryBranch(tree, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  const switching = extension.replaceActiveProjection(ctx, child);
  await restoring;
  assert.deepEqual(order, ["prepare", "render", "restore"]);
  let prevented = 0;
  const event = { type: "click", target: { closest: () => ({}) },
    preventDefault: () => { prevented++; }, stopImmediatePropagation() {} };
  extension.handlePendingSend(event);
  assert.equal(prevented, 1);
  restored();
  await switching;
  assert.deepEqual(order, ["prepare", "render", "restore", "ready", "event"]);
  prevented = 0;
  extension.handlePendingSend(event);
  assert.equal(prevented, 0);
});

test("a veto leaves chat intact and restores adapters already prepared", async t => {
  const { ctx, tree, api, makeId } = setup(t);
  const initial = structuredClone(ctx.chat);
  const order = [];
  api.registerRouteAdapter({ id: "first", messageFields: [],
    beforeSwitch: () => order.push("prepare"), onSwitchAborted: () => order.push("abort"),
  });
  api.registerRouteAdapter({ id: "busy", messageFields: [],
    beforeSwitch: () => { throw new Error("memory is busy"); }, onSwitchAborted: () => order.push("unexpected-abort"),
  });
  ctx.clearChat = async () => { throw new Error("chat must not be cleared"); };
  const child = createStoryBranch(tree, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  await assert.rejects(extension.replaceActiveProjection(ctx, child), /memory is busy/);
  assert.deepEqual(ctx.chat, initial);
  assert.equal(api.getActiveRoute().branchId, tree.rootBranchId);
  assert.deepEqual(order, ["prepare", "abort"]);
});

test("render failure restores the previous projection and its adapter before repainting", async t => {
  const { ctx, tree, api, makeId } = setup(t);
  const initial = structuredClone(ctx.chat);
  const order = [];
  api.registerRouteAdapter({ id: "memory", messageFields: [],
    beforeSwitch: () => order.push("prepare"),
    onSwitchAborted: route => { assert.equal(route.branchId, tree.rootBranchId); order.push("restore-old-memory"); },
  });
  let first = true;
  ctx.printMessages = async () => {
    if (first) { first = false; throw new Error("new message cannot render"); }
    assert.equal(api.getActiveRoute().branchId, tree.rootBranchId);
    order.push("render-old-chat");
  };
  const child = createStoryBranch(tree, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  await assert.rejects(extension.replaceActiveProjection(ctx, child), /cannot render/);
  assert.deepEqual(ctx.chat, initial);
  assert.equal(api.getActiveRoute().branchId, tree.rootBranchId);
  assert.deepEqual(order, ["prepare", "restore-old-memory", "render-old-chat"]);
});

test("fork projection rollback does not change shared saved messages or the source route snapshots", async t => {
  const { ctx, api, makeId } = setup(t);
  ctx.chat[0].PluginMemory = { value: "saved" };
  api.registerRouteAdapter({ id: "fork-rollback", messageFields: ["PluginMemory"], metadataFields: ["notes"] });
  const source = extension.syncLiveChat();
  const saved = JSON.stringify(source);
  const child = createStoryBranch(source, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  ctx.chat[0].PluginMemory.value = "prepared";
  ctx.chat[0].is_hidden = true;
  ctx.chatMetadata.notes = { value: "prepared metadata" };
  let renders = 0;
  ctx.printMessages = async () => { if (!renders++) throw Error("fork-render-failure"); };
  await assert.rejects(extension.replaceActiveProjection(ctx, child), /fork-render-failure/);
  assert.equal(ctx.chatMetadata.story_branch_tree, source);
  assert.equal(JSON.stringify(source), saved);
  assert.equal(ctx.chat[0].PluginMemory.value, "prepared");
  assert.equal(ctx.chat[0].is_hidden, true);
  assert.equal(ctx.chatMetadata.notes.value, "prepared metadata");
});

test("chat changes during adapter preparation cannot overwrite the newly opened chat", async t => {
  const { ctx, tree, api, makeId } = setup(t);
  const other = createStoryTree([{ is_user: false, mes: "另一条聊天" }]);
  api.registerRouteAdapter({ id: "slow-memory", messageFields: [], beforeSwitch: async () => {
    ctx.chatId = "other-chat"; ctx.characterId = 1;
    ctx.chat.splice(0, ctx.chat.length, ...resolveStoryBranch(other));
    ctx.chatMetadata = { story_branch_tree: other };
  } });
  const child = createStoryBranch(tree, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  await assert.rejects(extension.replaceActiveProjection(ctx, child), /聊天已变化/);
  assert.equal(ctx.chat[0].mes, "另一条聊天");
  assert.equal(ctx.chatMetadata.story_branch_tree.activeBranchId, other.activeBranchId);
});

test("chat changes during rendering do not receive old route data or rollback variables", async t => {
  const { ctx, tree, makeId } = setup(t);
  const other = createStoryTree([{ is_user: false, mes: "新角色的聊天" }]);
  ctx.printMessages = async () => {
    ctx.chatId = "new-character-chat"; ctx.characterId = 2;
    ctx.chat.splice(0, ctx.chat.length, ...resolveStoryBranch(other));
    ctx.chatMetadata = { story_branch_tree: other, variables: { newCharacter: true } };
  };
  const child = createStoryBranch(tree, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  await assert.rejects(extension.replaceActiveProjection(ctx, child), /聊天已变化/);
  assert.equal(ctx.chat[0].mes, "新角色的聊天");
  assert.equal(ctx.chatMetadata.story_branch_tree.activeBranchId, other.activeBranchId);
  assert.deepEqual(ctx.chatMetadata.variables, { newCharacter: true });
});

test("late adapter registration pins existing ancestor memory before child edits are synchronized", async t => {
  const { ctx, tree, api, makeId } = setup(t);
  ctx.chat[0].PluginMemory = { events: ["主线原记忆"] };
  const initial = syncActiveStoryBranch(tree, ctx.chat).tree;
  const child = createStoryBranch(initial, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  ctx.chatMetadata.story_branch_tree = child;
  ctx.chat.splice(0, ctx.chat.length, ...resolveStoryBranch(child));
  api.registerRouteAdapter({ id: "late-memory", messageFields: ["PluginMemory"] });
  ctx.chat[0].PluginMemory.events.push("子分支独立记忆");
  const updated = syncActiveStoryBranch(child, ctx.chat).tree;
  ctx.chatMetadata.story_branch_tree = updated;
  await extension.replaceActiveProjection(ctx, activateStoryBranch(updated, updated.rootBranchId));
  assert.deepEqual(ctx.chat[0].PluginMemory.events, ["主线原记忆"]);
  assert.deepEqual(api.getRouteMessages(child.activeBranchId)[0].PluginMemory.events, ["主线原记忆", "子分支独立记忆"]);
});

test("an adapter registered before opening a chat pins all existing routes on chat load", async t => {
  const { ctx, tree, api, makeId } = setup(t);
  ctx.chat[0].PluginMemory = { events: ["主线原记忆"] };
  const initial = syncActiveStoryBranch(tree, ctx.chat).tree;
  const child = createStoryBranch(initial, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  delete ctx.chatMetadata.story_branch_tree;
  api.registerRouteAdapter({ id: "early-memory", messageFields: ["PluginMemory"] });
  ctx.chatMetadata.story_branch_tree = child;
  ctx.chat.splice(0, ctx.chat.length, ...resolveStoryBranch(child));
  extension.syncLiveChat();
  ctx.chat[0].PluginMemory.events.push("子分支新记忆");
  const updated = extension.syncLiveChat();
  await extension.replaceActiveProjection(ctx, activateStoryBranch(updated, updated.rootBranchId));
  assert.deepEqual(ctx.chat[0].PluginMemory.events, ["主线原记忆"]);
});

test("a new branch inherits memory persisted during preparation but existing branches stay pinned", async t => {
  const { ctx, api, makeId } = setup(t);
  let preparation = 0;
  ctx.chat[0].PluginMemory = { facts: "已保存" };
  api.registerRouteAdapter({ id: "pending-memory", messageFields: ["PluginMemory"],
    beforeSwitch: () => { ctx.chat[0].PluginMemory = { facts: `刚落盘${++preparation}` }; },
  });
  const initial = extension.syncLiveChat();
  const child = createStoryBranch(initial, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  await extension.replaceActiveProjection(ctx, child);
  assert.equal(ctx.chat[0].PluginMemory.facts, "刚落盘1");
  const current = extension.syncLiveChat();
  await extension.replaceActiveProjection(ctx, activateStoryBranch(current, current.rootBranchId));
  assert.equal(ctx.chat[0].PluginMemory.facts, "刚落盘1");
  assert.equal(api.getRouteMessages(child.activeBranchId)[0].PluginMemory.facts, "刚落盘2");
});

for (const swipe of [0, 1]) {
  test(`preparation refreshes current reply memory without copying it into alternate reply ${swipe}`, async t => {
    const { ctx, api, makeId } = setup(t);
    ctx.chat.push({ is_user: false, mes: "回复0", swipe_id: 0, swipes: ["回复0", "回复1"],
      PluginMemory: "回复0旧记忆", swipe_info: [{ extra: {} }, { extra: {
        story_branch_tree_swipe_message_fields: { PluginMemory: { present: true, value: "回复1记忆" } },
      } }] });
    api.registerRouteAdapter({ id: "reply-memory", messageFields: ["PluginMemory"],
      beforeSwitch: () => { ctx.chat.at(-1).PluginMemory = "回复0刚保存"; },
    });
    const initial = extension.syncLiveChat();
    const child = createStoryBranchFromSwipe(initial, getStoryMessageId(ctx.chat.at(-1)), swipe, undefined, makeId);
    await extension.replaceActiveProjection(ctx, child);
    assert.equal(ctx.chat.at(-1).PluginMemory, swipe === 0 ? "回复0刚保存" : "回复1记忆");
  });
}

test("metadata is restored before rendering, stays route-local, and survives JSONL-style serialization", async t => {
  const { ctx, api, makeId } = setup(t);
  ctx.chatMetadata.sheets = [{ value: "root" }];
  ctx.chatMetadata.unrelated = { value: "untouched" };
  api.registerRouteAdapter({ id: "metadata-memory", metadataFields: ["sheets"], snapshotMode: "explicit",
    onFork: () => ({ metadata: { sheets: [{ value: "fork" }] } }),
  });
  assert.equal(api.capabilities.metadataSnapshots, true);
  assert.throws(() => api.registerRouteAdapter({ id: "other", metadataFields: ["sheets"] }), /重复/);
  for (const field of ["variables", "story_branch_tree", "__proto__"]) {
    assert.throws(() => api.registerRouteAdapter({ id: "unsafe", metadataFields: [field] }), /元数据/);
  }
  const initial = extension.syncLiveChat();
  const child = createStoryBranch(initial, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  ctx.printMessages = async () => assert.equal(ctx.chatMetadata.sheets[0].value, "fork");
  await extension.replaceActiveProjection(ctx, child);
  ctx.chatMetadata.sheets[0].value = "child-only";
  api.notifyMemoryChanged("metadata-memory");
  const restored = JSON.parse(JSON.stringify(ctx.chatMetadata.story_branch_tree));
  ctx.chatMetadata.story_branch_tree = restored;
  ctx.printMessages = async () => assert.equal(ctx.chatMetadata.sheets[0].value, "root");
  await extension.replaceActiveProjection(ctx, activateStoryBranch(restored, restored.rootBranchId));
  assert.deepEqual(ctx.chatMetadata.unrelated, { value: "untouched" });
  assert.equal(api.getRouteMetadata("metadata-memory", child.activeBranchId).sheets[0].value, "child-only");
  const copy = api.getRouteMetadata("metadata-memory");
  copy.sheets[0].value = "mutated-copy";
  assert.equal(ctx.chatMetadata.sheets[0].value, "root");
});

test("metadata rendering failures roll back only owned keys, including absent values", async t => {
  const { ctx, api, makeId } = setup(t);
  api.registerRouteAdapter({ id: "metadata-memory", metadataFields: ["sheets"],
    onFork: () => ({ metadata: { sheets: ["child"] } }) });
  const initial = extension.syncLiveChat();
  const child = createStoryBranch(initial, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  let calls = 0;
  ctx.printMessages = async () => { if (!calls++) { ctx.chatMetadata.unrelated = 42; throw Error("render-failed"); } };
  await assert.rejects(extension.replaceActiveProjection(ctx, child), /render-failed/);
  assert.equal(Object.hasOwn(ctx.chatMetadata, "sheets"), false);
  assert.equal(ctx.chatMetadata.unrelated, 42);
  assert.equal(api.getActiveRoute().branchId, initial.rootBranchId);
});

test("explicit metadata snapshots do not recopy the cell pool on ordinary chat sync", t => {
  const { ctx, api } = setup(t);
  ctx.chatMetadata.sheets = [{ measurement: "pool" }];
  api.registerRouteAdapter({ id: "metadata-memory", metadataFields: ["sheets"], snapshotMode: "explicit" });
  const saved = ctx.chatMetadata.story_branch_tree.branches[api.getActiveRoute().branchId].adapterStates["metadata-memory"].metadata;
  ctx.chatMetadata.sheets.push({ measurement: "unsaved" });
  extension.syncLiveChat();
  assert.equal(api.getRouteMetadata("metadata-memory").sheets.length, 1);
  assert.equal(ctx.chatMetadata.story_branch_tree.branches[api.getActiveRoute().branchId].adapterStates["metadata-memory"].metadata, saved);
  api.notifyMemoryChanged("metadata-memory", { from: 0, to: 0 });
  assert.equal(api.getRouteMetadata("metadata-memory").sheets.length, 2);
});

test("an adapter restore failure blocks sends and can retry the same route", async t => {
  const { ctx, api, makeId } = setup(t);
  let fails = true;
  api.registerRouteAdapter({ id: "failing-memory", afterSwitch: () => { if (fails) throw Error("restore-failed"); } });
  const initial = extension.syncLiveChat();
  const child = createStoryBranch(initial, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  await assert.rejects(extension.replaceActiveProjection(ctx, child), /restore-failed/);
  let prevented = 0;
  const event = { type: "click", target: { closest: () => ({}) }, preventDefault() { prevented++; }, stopImmediatePropagation() {} };
  extension.handlePendingSend(event);
  assert.equal(prevented, 1);
  fails = false;
  await extension.replaceActiveProjection(ctx, ctx.chatMetadata.story_branch_tree);
  prevented = 0;
  extension.handlePendingSend(event);
  assert.equal(prevented, 0);
});

test("unregistering the failed provider releases only its recovery gate and invalidates its interface", async t => {
  const { ctx, api, makeId } = setup(t);
  const unregister = api.registerRouteAdapter({ id: "stopped-memory", metadataFields: ["ownMemory"],
    afterSwitch: () => { throw Error("restore-failed"); } });
  const initial = extension.syncLiveChat();
  const child = createStoryBranch(initial, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  await assert.rejects(extension.replaceActiveProjection(ctx, child), /restore-failed/);
  const unrelated = api.registerRouteAdapter({ id: "unrelated-memory" });
  let prevented = 0;
  const event = { type: "click", target: { closest: () => ({}) }, preventDefault() { prevented++; }, stopImmediatePropagation() {} };
  unrelated();
  extension.handlePendingSend(event);
  assert.equal(prevented, 1);
  unregister();
  prevented = 0;
  extension.handlePendingSend(event);
  assert.equal(prevented, 0);
  assert.throws(() => api.notifyMemoryChanged("stopped-memory"), /未注册/);
  assert.throws(() => api.beginMemoryTask("stopped-memory"), /未注册/);
});

test("automatic metadata snapshots refresh once during the ordinary sync entry", t => {
  const { ctx, api } = setup(t);
  ctx.chatMetadata.sheets = ["old"];
  api.registerRouteAdapter({ id: "automatic-metadata", metadataFields: ["sheets"] });
  ctx.chatMetadata.sheets = ["new"];
  extension.syncLiveChat();
  assert.deepEqual(api.getRouteMetadata("automatic-metadata").sheets, ["new"]);
});

test("route lists do not read message bodies or memory containers", t => {
  const { ctx, api } = setup(t);
  Object.defineProperty(ctx.chat[0], "mes", { get() { throw Error("body-read"); } });
  assert.equal(api.capabilities.routeList, true);
  const routes = api.getRoutes();
  routes[0].title = "changed-copy";
  assert.equal(api.getRoutes()[0].title, "主线");
});

test("scoped message notifications can skip unchanged metadata containers", t => {
  const { ctx, api } = setup(t);
  ctx.chatMetadata.sheets = ["unchanged"];
  ctx.chat[0].PluginMemory = "old";
  api.registerRouteAdapter({ id: "metadata-memory", messageFields: ["PluginMemory"], metadataFields: ["sheets"] });
  ctx.chat[0].PluginMemory = "new";
  Object.defineProperty(ctx.chatMetadata, "sheets", { get() { throw Error("unnecessary-pool-read"); } });
  api.notifyMemoryChanged("metadata-memory", { from: 0, to: 1, metadata: false });
  assert.equal(api.getRouteMessages()[0].PluginMemory, "new");
  assert.throws(() => api.notifyMemoryChanged("metadata-memory", { metadata: "false" }), /布尔/);
});

test("a disabled provider's saved metadata still follows existing routes", async t => {
  const { ctx, api, makeId } = setup(t);
  ctx.chatMetadata.sheets = ["root"];
  const dispose = api.registerRouteAdapter({ id: "metadata-memory", metadataFields: ["sheets"] });
  const initial = extension.syncLiveChat();
  const child = createStoryBranch(initial, getStoryMessageId(ctx.chat[0]), undefined, makeId);
  await extension.replaceActiveProjection(ctx, child);
  ctx.chatMetadata.sheets = ["child"];
  api.notifyMemoryChanged("metadata-memory");
  dispose();
  await extension.replaceActiveProjection(ctx, activateStoryBranch(ctx.chatMetadata.story_branch_tree, initial.rootBranchId));
  assert.deepEqual(ctx.chatMetadata.sheets, ["root"]);
  await extension.replaceActiveProjection(ctx, activateStoryBranch(ctx.chatMetadata.story_branch_tree, child.activeBranchId));
  assert.deepEqual(ctx.chatMetadata.sheets, ["child"]);
});

test("long trees fit both axes below the old zoom minimum and preserve the zoom anchor", t => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousView = { ...extension.view };
  const world = { style: { width: "100000", height: "200000" } };
  const level = {};
  const canvas = { clientWidth: 400, clientHeight: 600, getBoundingClientRect: () => ({ left: 20, top: 40 }) };
  globalThis.document = { querySelector: selector => selector.includes('"canvas"') ? canvas : selector.includes('"world"') ? world : level };
  t.after(() => {
    Object.assign(extension.view, previousView);
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
  });
  extension.fitView();
  assert.ok(extension.view.scale < 0.3);
  assert.ok(200000 * extension.view.scale <= 560);
  assert.ok(100000 * extension.view.scale <= 368);
  const anchor = { x: (200 - extension.view.x) / extension.view.scale, y: (300 - extension.view.y) / extension.view.scale };
  extension.zoomAt(16, 220, 340);
  assert.equal(extension.view.scale, 16);
  assert.ok(Math.abs((200 - extension.view.x) / extension.view.scale - anchor.x) < 0.000001);
  assert.ok(Math.abs((300 - extension.view.y) / extension.view.scale - anchor.y) < 0.000001);
  extension.zoomAt(8);
  assert.ok(Math.abs((200 - extension.view.x) / extension.view.scale - anchor.x) < 0.000001);
  assert.ok(Math.abs((300 - extension.view.y) / extension.view.scale - anchor.y) < 0.000001);
  extension.zoomAt(0.000001, 220, 340);
  assert.notEqual(level.textContent, "0%");
  assert.equal(extension.clampViewScale(Infinity), extension.view.scale);
  assert.equal(extension.clampViewScale(NaN), extension.view.scale);
  assert.equal(extension.clampViewScale(0), 0.000001);
  assert.equal(extension.clampViewScale(10000), 64);
});
