import test from "node:test";
import assert from "node:assert/strict";
import { NativeStoryStorage, NATIVE_KEY, MODE_KEY, storyMode, nativeRows, ensureNativeIdentities } from "../modules/NativeStory.js";
import { getStoryMessageId } from "../modules/StoryTree.js";
import { legacyDigest } from "../modules/LegacyNative.js";

function setup(t, hooks = {}) {
  const files = new Map();
  const calls = [];
  const ctx = { characterId: 0, groupId: null, chatId: "main", characters: [{ avatar: "fixture.png", name: "Fixture" }],
    chat: [{ mes: "提问", is_user: true, extra: {} },
      { mes: "回复 A", is_user: false, swipe_id: 0, swipes: ["回复 A", "回复 B"], swipe_info: [{ extra: {} }, { extra: {} }], extra: {} },
      { mes: "A 后续", is_user: true, extra: {} }],
    chatMetadata: { variables: { score: 1 } }, extensionSettings: {},
    getRequestHeaders: () => ({ "Content-Type": "application/json" }), saveSettingsDebounced() {},
    updateChatMetadata(patch) { Object.assign(this.chatMetadata, patch); },
    async saveChat() { files.set(this.chatId, structuredClone([{ chat_metadata: this.chatMetadata }, ...this.chat])); },
    async openCharacterChat(name) {
      const records = structuredClone(files.get(name));
      assert.ok(records);
      this.chatId = name;
      this.chatMetadata = records[0].chat_metadata;
      this.chat.splice(0, this.chat.length, ...records.slice(1));
    },
  };
  let serial = 0;
  const selectSwipe = (message, index) => {
    if (typeof message.swipes?.[index] !== "string") return false;
    message.mes = message.swipes[index];
    message.swipe_id = index;
    message.extra = structuredClone(message.swipe_info[index].extra);
    return true;
  };
  const storage = new NativeStoryStorage(() => ctx, { selectSwipe, ...hooks,
    fork: async (index, options) => {
      calls.push({ path: "core:createBranch", options });
      const name = `branch-${++serial}`;
      const snapshot = structuredClone(ctx.chat.slice(0, index + 1));
      if (options.swipeId != null) selectSwipe(snapshot[index], options.swipeId);
      files.set(name, structuredClone([{ chat_metadata: { ...ctx.chatMetadata, integrity: name, main_chat: ctx.chatId } }, ...snapshot]));
      return name;
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, options) => {
    const body = JSON.parse(options.body);
    calls.push({ path, body });
    let data;
    if (path === "/api/chats/get") data = structuredClone(files.get(body.file_name) ?? {});
    else if (path === "/api/chats/save") { files.set(body.file_name, structuredClone(body.chat)); data = { ok: true }; }
    else if (path === "/api/chats/delete") { files.delete(body.chatfile.replace(/\.jsonl$/, "")); data = { ok: true }; }
    else if (path === "/api/characters/chats") data = [...files].map(([name, records]) => ({ file_name: name + ".jsonl", preview_message: "预览",
      ...(body.metadata ? { chat_metadata: structuredClone(records[0].chat_metadata) } : {}) }));
    else throw Error("Unexpected endpoint " + path);
    return { ok: true, json: async () => data };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return { ctx, storage, calls, files };
}

async function oldFamily(t, { missing = false, unknown = false } = {}) {
  const f = setup(t), message = text => ({ mes: text, is_user: false, extra: { Foreign: { keep: text } }, hash_sheets: { s: [[text]] } });
  const put = (name, parent, messages) => f.files.set(name, [{ user_name: "User", foreignHeader: [1, 2], chat_metadata: {
    ...(parent ? { main_chat: parent } : {}), integrity: name, sheets: [{ content: `memory-${name}` }], foreignMetadata: { name } } }, ...messages]);
  const first = message("起点"), second = message("分叉点");
  if (!unknown) second.extra.branches = ["child", "sibling"];
  if (!missing) put("main", null, [first, second, message("主线后续")]);
  const childMessages = [structuredClone(first), structuredClone(second), message("子线后续")];
  childMessages[2].extra.branches = ["grandchild"];
  put("child", "main", childMessages);
  put("sibling", "main", [structuredClone(first), structuredClone(second), message("旁线后续")]);
  put("grandchild", "child", [...structuredClone(childMessages), message("孙线后续")]);
  put("main - Branch #99", null, [message("名字像分支但没有关联")]);
  await f.ctx.openCharacterChat("child");
  return f;
}

test("old branches are discovered from a child without reading unrelated chats; adoption preserves foreign data", async t => {
  const f = await oldFamily(t);
  const before = structuredClone(f.files);
  const plan = await f.storage.discoverLegacyStory();
  assert.deepEqual(new Set(plan.rows.map(row => row.chatName)), new Set(["main", "child", "sibling", "grandchild"]));
  assert.equal(plan.rows.find(row => row.chatName === "child").floor, 2);
  assert.equal(plan.rows.find(row => row.chatName === "grandchild").floor, 3);
  assert.equal(f.calls.filter(call => call.path === "/api/chats/get").length, 4);
  assert.equal(f.calls.some(call => call.path === "/api/chats/save"), false);
  assert.deepEqual(f.files, before, "preview does not add grouping markers");
  const names = plan.rows.map(row => row.chatName);
  const result = await f.storage.adoptLegacyStory(plan, names);
  assert.equal(result.count, 4);
  for (const name of names) {
    const records = f.files.get(name), old = before.get(name);
    assert.deepEqual(records.map(record => record.mes), old.map(record => record.mes));
    assert.deepEqual(records.slice(1).map(message => message.hash_sheets), old.slice(1).map(message => message.hash_sheets));
    assert.deepEqual(records.slice(1).map(message => message.extra.Foreign), old.slice(1).map(message => message.extra.Foreign));
    assert.deepEqual(records[0].chat_metadata.sheets, old[0].chat_metadata.sheets);
    assert.deepEqual(records[0].foreignHeader, [1, 2]);
    assert.equal(records[0].chat_metadata[NATIVE_KEY].storyId, result.storyId);
  }
  const tree = f.storage.view();
  assert.equal(nativeRows(tree).length, 4);
  const child = Object.values(tree.branches).find(route => route.chatName === "child");
  const main = Object.values(tree.branches).find(route => route.chatName === "main");
  assert.equal(child.parentBranchId, main.id);
  assert.equal(child.forkMessageId, getStoryMessageId(f.files.get("main")[2]));
  assert.equal((await f.storage.listStories()).length, 2);
  const writes = f.calls.filter(call => call.path === "/api/chats/save").length;
  await f.storage.adoptLegacyStory(plan, names);
  assert.equal(f.calls.filter(call => call.path === "/api/chats/save").length, writes, "repeating the same confirmation is idempotent");
});

test("siblings sharing a missing parent group as separate existing roots, without inventing a main chat", async t => {
  const f = await oldFamily(t, { missing: true });
  const plan = await f.storage.discoverLegacyStory();
  assert.deepEqual(plan.missing, ["main"]);
  await f.storage.adoptLegacyStory(plan, plan.rows.map(row => row.chatName));
  const rows = nativeRows(f.storage.view());
  assert.equal(rows.filter(row => !row.parentBranchId).length, 2);
  assert.equal(rows.filter(row => row.legacyParentUnavailable).length, 2);
  assert.equal(f.files.has("main"), false);
});

test("missing fork links stay unknown and unselected relatives remain ordinary chats", async t => {
  const f = await oldFamily(t, { unknown: true });
  const plan = await f.storage.discoverLegacyStory();
  assert.equal(plan.rows.find(row => row.chatName === "child").floor, null);
  await f.storage.adoptLegacyStory(plan, ["main", "child"]);
  const child = nativeRows(f.storage.view()).find(row => row.chatName === "child");
  assert.equal(child.legacyForkUnknown, true);
  assert.ok(child.branchNumber.includes("?"));
  assert.equal(f.files.get("sibling")[0].chat_metadata[NATIVE_KEY], undefined);
});

test("cycles, single-chat stories and duplicate route owners cannot be silently claimed", async t => {
  const f = await oldFamily(t);
  f.files.get("main")[0].chat_metadata.main_chat = "sibling";
  const plan = await f.storage.discoverLegacyStory();
  assert.match(plan.rows.find(row => row.chatName === "main").blocked, /循环/);
  await assert.rejects(f.storage.adoptLegacyStory(plan, ["child", "main"]), /可用/);
  f.files.get("main")[0].chat_metadata.main_chat = undefined;
  f.files.get("sibling")[0].chat_metadata[MODE_KEY] = "single";
  const next = await f.storage.discoverLegacyStory();
  assert.match(next.rows.find(row => row.chatName === "sibling").blocked, /单聊天/);
});

test("preview cancellation, context changes and live edits cause no adoption writes", async t => {
  const f = await oldFamily(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.storage.discoverLegacyStory({ signal: controller.signal }), /取消/);
  const plan = await f.storage.discoverLegacyStory();
  f.ctx.chat[0].ForeignEdit = 1;
  await assert.rejects(f.storage.adoptLegacyStory(plan, plan.rows.map(row => row.chatName)), /改变/);
  const next = await f.storage.discoverLegacyStory();
  f.ctx.chatId = "unrelated";
  await assert.rejects(f.storage.adoptLegacyStory(next, next.rows.map(row => row.chatName)), /改变/);
  assert.equal(f.calls.filter(call => call.path === "/api/chats/save").length, 0);
});

test("partial writes can resume with the same identities or be rediscovered after reload", async t => {
  const f = await oldFamily(t);
  const plan = await f.storage.discoverLegacyStory();
  const write = f.storage.write.bind(f.storage);
  let fail = true;
  f.storage.write = async (...args) => { if (args[0] === "main" && fail) { fail = false; throw Error("模拟保存失败"); } return write(...args); };
  await assert.rejects(f.storage.adoptLegacyStory(plan, plan.rows.map(row => row.chatName)), /文件均保留/);
  const childId = f.files.get("child")[0].chat_metadata[NATIVE_KEY].route.id;
  await f.ctx.openCharacterChat("child");
  const recovered = await f.storage.discoverLegacyStory();
  await f.storage.adoptLegacyStory(recovered, recovered.rows.map(row => row.chatName));
  const child = f.files.get("child")[0].chat_metadata[NATIVE_KEY];
  const parent = f.files.get("main")[0].chat_metadata[NATIVE_KEY];
  assert.equal(child.route.id, childId);
  assert.equal(child.route.parentBranchId, parent.route.id);
  assert.equal(child.rootRouteId, parent.route.id);
  assert.equal(child.route.forkMessageId, getStoryMessageId(f.files.get("main")[2]));
  assert.equal(f.files.size, 5);
  assert.equal(nativeRows(f.storage.view()).length, 4);
});

test("same-preview retry survives a lost save acknowledgement without creating or overwriting extra files", async t => {
  const f = await oldFamily(t), plan = await f.storage.discoverLegacyStory();
  const write = f.storage.write.bind(f.storage);
  let fail = true;
  f.storage.write = async (...args) => { const result = await write(...args); if (fail) { fail = false; throw Error("保存响应丢失"); } return result; };
  const names = plan.rows.map(row => row.chatName);
  await assert.rejects(f.storage.adoptLegacyStory(plan, names), /文件均保留/);
  const savedId = f.files.get("child")[0].chat_metadata[NATIVE_KEY].route.id;
  await f.storage.adoptLegacyStory(plan, names);
  assert.equal(f.files.get("child")[0].chat_metadata[NATIVE_KEY].route.id, savedId);
  assert.equal(f.files.size, 5);
  assert.equal(nativeRows(f.storage.view()).length, 4);
});

test("preview preserves pending live data and confirmation saves it without losing existing header fields", async t => {
  const f = await oldFamily(t);
  f.ctx.chat.at(-1).mes = "尚未保存的当前正文";
  f.ctx.chatMetadata.sheets.push({ pending: "尚未保存的表格" });
  const oldDisk = structuredClone(f.files.get("child"));
  const plan = await f.storage.discoverLegacyStory();
  assert.deepEqual(f.files.get("child"), oldDisk);
  await f.storage.adoptLegacyStory(plan, plan.rows.map(row => row.chatName));
  assert.equal(f.files.get("child").at(-1).mes, "尚未保存的当前正文");
  assert.equal(f.files.get("child")[0].chat_metadata.sheets.at(-1).pending, "尚未保存的表格");
  assert.deepEqual(f.files.get("child")[0].foreignHeader, [1, 2]);
});

test("LAN HTTP installations can compare legacy snapshots without SubtleCrypto", async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
  t.after(() => Object.defineProperty(globalThis, "crypto", descriptor));
  assert.equal(await legacyDigest({ value: 1 }), await legacyDigest({ value: 1 }));
  assert.notEqual(await legacyDigest({ value: 1 }), await legacyDigest({ value: 2 }));
});

test("duplicate native identities and multiple existing stories remain explicit conflicts", async t => {
  const f = await oldFamily(t);
  const marker = id => ({ version: 1, storyId: id, rootRouteId: "root", route: { id: "duplicate", parentBranchId: null, endFloor: 3 } });
  f.files.get("sibling")[0].chat_metadata[NATIVE_KEY] = marker("one");
  f.files.get("grandchild")[0].chat_metadata[NATIVE_KEY] = marker("one");
  const plan = await f.storage.discoverLegacyStory();
  assert.match(plan.rows.find(row => row.chatName === "sibling").blocked, /重复/);
  assert.match(plan.rows.find(row => row.chatName === "grandchild").blocked, /重复/);
  f.files.get("grandchild")[0].chat_metadata[NATIVE_KEY].storyId = "two";
  await assert.rejects(f.storage.discoverLegacyStory(), /多个/);
  assert.equal(f.calls.filter(call => call.path === "/api/chats/save").length, 0);
});

test("a changed noncurrent file is preserved on partial failure and a cancelled in-flight scan never writes", async t => {
  const f = await oldFamily(t);
  const plan = await f.storage.discoverLegacyStory();
  f.files.get("main")[1].mes = "来自另一个窗口的修改";
  await assert.rejects(f.storage.adoptLegacyStory(plan, plan.rows.map(row => row.chatName)), /预览后已改变/);
  assert.equal(f.files.get("main")[1].mes, "来自另一个窗口的修改");
  assert.equal(f.files.get("main")[0].chat_metadata[NATIVE_KEY], undefined);
  const controller = new AbortController(), read = f.storage.read.bind(f.storage);
  f.storage.read = async (...args) => { const result = await read(...args); controller.abort(); return result; };
  const writes = f.calls.filter(call => call.path === "/api/chats/save").length;
  await assert.rejects(f.storage.discoverLegacyStory({ signal: controller.signal }), /取消/);
  assert.equal(f.calls.filter(call => call.path === "/api/chats/save").length, writes);
});

test("native initialization is fixed per story and does not embed a single-chat tree", async t => {
  const { ctx, storage, files } = setup(t);
  assert.equal(storyMode(ctx), null);
  await storage.initialize();
  assert.equal(storyMode(ctx), "native");
  assert.equal(ctx.chatMetadata.story_branch_tree, undefined);
  assert.equal(files.size, 1);
  assert.equal(nativeRows(storage.view()).length, 1);
  assert.equal(storage.view().branches[storage.view().activeBranchId].endFloor, 3);
  await assert.rejects(storage.initialize(), /不能混用/);
  ctx.chatMetadata[MODE_KEY] = "single";
  assert.throws(() => storyMode(ctx), /两种/);
});

test("existing single-chat stories never enter native storage", async t => {
  const { ctx, storage } = setup(t);
  ctx.chatMetadata.story_branch_tree = { version: 1 };
  assert.equal(storyMode(ctx), "single");
  await assert.rejects(storage.initialize(), /不能混用/);
  assert.deepEqual(ctx.chatMetadata.story_branch_tree, { version: 1 });
});

test("historical reply forks notify native swipe listeners in the child before completion", async t => {
  const { ctx, storage, files } = setup(t);
  const events = [];
  ctx.eventTypes = { MESSAGE_SWIPED: "message_swiped" };
  ctx.eventSource = { async emit(type, index) {
    await Promise.resolve();
    events.push({ type, index, chatId: ctx.chatId, text: ctx.chat[index].mes });
    ctx.chat[index].RebuiltMemory = ctx.chat[index].mes;
  } };
  storage.complete = async () => {
    assert.equal(ctx.chat[1].RebuiltMemory, "回复 B");
    await ctx.saveChat();
  };
  await storage.initialize();
  const root = storage.metadata().route.id;
  await storage.createBranch(1, 1);
  assert.deepEqual(events, [{ type: "message_swiped", index: 1, chatId: "branch-1", text: "回复 B" }]);
  assert.equal(files.get("branch-1")[2].RebuiltMemory, "回复 B");
  assert.equal(files.get("main")[2].RebuiltMemory, undefined);
  assert.equal(files.get("main")[2].mes, "回复 A");
  storage.complete = undefined;
  await storage.switchRoute(root);
  await storage.createBranch(1);
  assert.equal(events.length, 1, "ordinary forks and reopening routes are not swipe changes");
});

test("a chat change inside a swipe listener aborts completion and preserves both files", async t => {
  let completed = false;
  const { ctx, storage, files } = setup(t, { complete: async () => { completed = true; } });
  ctx.eventTypes = { MESSAGE_SWIPED: "message_swiped" };
  ctx.eventSource = { async emit() { await ctx.openCharacterChat("main"); } };
  await storage.initialize();
  await assert.rejects(storage.createBranch(1, 1), /目标路线已改变/);
  assert.equal(completed, false);
  assert.equal(files.size, 2);
  assert.equal(files.get("main")[2].mes, "回复 A");
  assert.equal(files.get("branch-1")[2].mes, "回复 B");
});

test("native fork uses core branching, repairs only the new file, and switches by real chat ID", async t => {
  const { ctx, storage, calls, files } = setup(t);
  await storage.initialize();
  const rootId = ctx.chatMetadata[NATIVE_KEY].route.id;
  const original = JSON.stringify(files.get("main").slice(1));
  const childId = await storage.createBranch(1);
  assert.notEqual(ctx.chatId, "main");
  assert.equal(ctx.chatMetadata[NATIVE_KEY].route.id, childId);
  assert.equal(ctx.chat.length, 2);
  assert.equal(JSON.stringify(files.get("main").slice(1)), original);
  assert.equal(calls.filter(call => call.path === "core:createBranch").length, 1);
  assert.equal(ctx.chatMetadata.story_branch_tree, undefined);
  await storage.switchRoute(rootId);
  assert.equal(ctx.chatId, "main");
  assert.equal(ctx.chat.at(-1).mes, "A 后续");
  const rows = nativeRows(storage.view());
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.id === childId).branchNumber, "1.2.1");
});

test("reply queries create no files and retain all matching continuations by stable variant identity", async t => {
  t.mock.method(Date, "now", () => 1700000000000);
  const { ctx, storage, files, calls } = setup(t);
  await storage.initialize();
  const rootId = ctx.chatMetadata[NATIVE_KEY].route.id;
  const originalText = ctx.chat[1].mes;
  const before = calls.length;
  assert.deepEqual(storage.replyRoutes(1, 1), []);
  assert.equal(calls.length, before);
  assert.equal(files.size, 1);
  assert.equal(ctx.chat[1].mes, originalText);
  const first = await storage.createBranch(1, 1);
  assert.equal(ctx.chat[1].mes, "回复 B");
  assert.equal(ctx.chat[1].swipe_id, 1);
  assert.equal(calls.find(call => call.path === "core:createBranch").options.swipeId, 1);
  await storage.switchRoute(rootId);
  const second = await storage.createBranch(1, 1);
  await storage.switchRoute(rootId);
  assert.deepEqual(new Set(storage.replyRoutes(1, 1).map(entry => entry.route.id)), new Set([first, second]));
  ctx.chat[1].swipes.reverse();
  ctx.chat[1].swipe_info.reverse();
  ctx.chat[1].swipe_id = 1;
  assert.deepEqual(new Set(storage.replyRoutes(1, 0).map(entry => entry.route.id)), new Set([first, second]));
  assert.equal(nativeRows(storage.view()).find(row => row.id === first).branchNumber, "1.R2.1");
});

test("ordinary sync saves only its own lightweight descriptor and reads no other files", async t => {
  const { ctx, storage, calls } = setup(t);
  await storage.initialize();
  await storage.createBranch(1, 1);
  const before = calls.length;
  ctx.chat.push({ mes: "分支续写", is_user: true });
  storage.syncCurrent();
  await ctx.saveChat();
  assert.equal(calls.length, before);
  assert.equal(ctx.chatMetadata[NATIVE_KEY].route.endFloor, 3);
  assert.ok(ctx.chatMetadata[NATIVE_KEY].route.replies[getStoryMessageId(ctx.chat[1])]);
  assert.equal(JSON.stringify(ctx.chatMetadata[NATIVE_KEY]).includes("分支续写"), true); // bounded ending excerpt
  assert.equal(ctx.chatMetadata[NATIVE_KEY].messages, undefined);
  assert.equal(ctx.chatMetadata[NATIVE_KEY].branches, undefined);
});

test("catalog groups files without requesting metadata; explicit rebuilding restores a lost index", async t => {
  const { ctx, storage, calls } = setup(t);
  await storage.initialize();
  await storage.createBranch(1, 1);
  const stories = await storage.listStories();
  assert.equal(stories.length, 1);
  assert.equal(stories[0].routes.length, 2);
  assert.equal(calls.at(-1).body.metadata, undefined);
  ctx.extensionSettings = {};
  assert.equal((await storage.listStories()).length, 2);
  const restored = await storage.listStories({ rebuild: true });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].routes.length, 2);
  assert.equal(calls.at(-1).body.metadata, true);
});

test("a renamed file is recovered by its descriptor; deleted files leave the derived index", async t => {
  const { storage, files } = setup(t);
  await storage.initialize();
  await storage.createBranch(1, 1);
  files.set("renamed", files.get("main"));
  files.delete("main");
  const stories = await storage.listStories({ rebuild: true });
  assert.equal(stories[0].routes.length, 2);
  assert.ok(stories[0].routes.some(route => route.chatName === "renamed"));
  files.delete("renamed");
  assert.equal((await storage.listStories())[0].routes.length, 1);
});

test("failed new-file repair keeps the source and newly created native file recoverable", async t => {
  const { ctx, storage, files } = setup(t);
  await storage.initialize();
  storage.write = async () => { throw Error("write-failed"); };
  await assert.rejects(storage.createBranch(1, 1), /write-failed.*已保留/);
  assert.equal(ctx.chatId, "main");
  assert.equal(ctx.chat.at(-1).mes, "A 后续");
  assert.equal(files.size, 2);
});

test("chat changes while preparing abort before core branch creation", async t => {
  const { ctx, storage, calls, files } = setup(t, { prepare: async () => { ctx.chatId = "another"; } });
  await storage.initialize();
  await assert.rejects(storage.createBranch(1, 1), /当前聊天已改变/);
  assert.equal(files.size, 1);
  assert.equal(calls.some(call => call.path === "core:createBranch"), false);
});

test("disabling during preparation cancels creation without completion callbacks", async t => {
  const { storage, files } = setup(t);
  await storage.initialize();
  let completed = false;
  storage.prepare = async () => { storage.epoch++; };
  storage.complete = async () => { completed = true; };
  await assert.rejects(storage.createBranch(1, 1), /已取消/);
  assert.equal(completed, false);
  assert.equal(files.size, 1);
});

test("disabling after a route read prevents a late metadata write", async t => {
  const { ctx, storage, files } = setup(t);
  await storage.initialize();
  const root = ctx.chatMetadata[NATIVE_KEY].route.id;
  const child = await storage.createBranch(1, 1);
  const childName = ctx.chatId;
  await storage.switchRoute(root);
  const read = storage.read.bind(storage);
  storage.read = async (...args) => { const records = await read(...args); storage.epoch++; return records; };
  await assert.rejects(storage.updateRoute(child, { title: "late-write" }), /已取消/);
  assert.notEqual(files.get(childName)[0].chat_metadata[NATIVE_KEY].route.title, "late-write");
});

test("registered preparation sees the selected reply and metadata applies only to the child", async t => {
  const { ctx, storage, files } = setup(t, { prepare: async (change, messages) => {
    assert.equal(change.fork.replyFloor, 2);
    assert.equal(messages.at(-1).mes, "回复 B");
    return { memory: { value: "B" } };
  } });
  await storage.initialize();
  await storage.createBranch(1, 1);
  assert.deepEqual(ctx.chatMetadata.memory, { value: "B" });
  assert.equal(files.get("main")[0].chat_metadata.memory, undefined);
});

test("whole-story export/import preserves messages and mints identities without overwriting files", async t => {
  const { ctx, storage, files } = setup(t);
  await storage.initialize();
  await storage.createBranch(1, 1);
  const originalRoot = ctx.chatMetadata[NATIVE_KEY].rootRouteId;
  const view = storage.view();
  view.layout = { [originalRoot]: { x: 5, y: 10 } };
  view.nodeNotes = { [`reply:${originalRoot}:${getStoryMessageId(ctx.chat[1])}`]: "节点备注" };
  storage.saveView(view);
  const bundle = await storage.exportStory();
  assert.equal(bundle.chats.length, 2);
  const originals = new Map([...files].map(([name, data]) => [name, JSON.stringify(data)]));
  const importedId = await storage.importStory(JSON.parse(JSON.stringify(bundle)));
  assert.notEqual(importedId, bundle.storyId);
  assert.equal(files.size, 4);
  for (const [name, text] of originals) assert.equal(JSON.stringify(files.get(name)), text);
  assert.equal(ctx.chatMetadata[NATIVE_KEY].storyId, importedId);
  const restored = await storage.exportStory();
  const importedRoot = ctx.chatMetadata[NATIVE_KEY].rootRouteId;
  assert.deepEqual(restored.view.layout[importedRoot], { x: 5, y: 10 });
  assert.equal(restored.view.layout[originalRoot], undefined);
  assert.equal(Object.values(restored.view.nodeNotes)[0], "节点备注");
  assert.deepEqual(restored.chats.map(entry => entry.records.slice(1)), bundle.chats.map(entry => entry.records.slice(1)));
  assert.equal((await storage.listStories()).length, 2);
});

test("invalid bundle is rejected before any file is written", async t => {
  const { storage, files } = setup(t);
  await storage.initialize();
  const bundle = await storage.exportStory();
  bundle.chats.push({ records: [{ chat_metadata: {} }] });
  const count = files.size;
  await assert.rejects(storage.importStory(bundle), /无效/);
  assert.equal(files.size, count);
});

test("missing or duplicate reply identities are repaired and remain attached when a reply is selected", () => {
  const messages = [{ mes: "B", swipes: ["A", "B"], swipe_id: 1, swipe_info: [null, { extra: { story_branch_tree_variant_id: "old" } }] }];
  ensureNativeIdentities(messages);
  const id = getStoryMessageId(messages[0]);
  assert.ok(id);
  assert.equal(messages[0].swipe_info[0].extra.story_branch_tree_message_id, id);
  assert.equal(messages[0].swipe_info[1].extra.story_branch_tree_variant_id, "old");
  assert.equal(messages[0].extra.story_branch_tree_variant_id, "old");
  assert.notEqual(messages[0].swipe_info[0].extra.story_branch_tree_variant_id, "old");
});

test("unsupported historical swipe selection stops before creating a native file", async t => {
  const { storage, files } = setup(t);
  await storage.initialize();
  storage.selectSwipe = () => false;
  await assert.rejects(storage.createBranch(1, 1), /更新酒馆/);
  assert.equal(files.size, 1);
});

test("last-floor swipes keep native behavior and update the association without new files", async t => {
  const { ctx, storage, files } = setup(t);
  await storage.initialize();
  await storage.createBranch(1, 1);
  const count = files.size;
  const message = ctx.chat.at(-1);
  message.mes = message.swipes[0];
  message.swipe_id = 0;
  storage.syncCurrent();
  assert.equal(files.size, count);
  assert.equal(ctx.chatMetadata[NATIVE_KEY].route.sourceSwipeIndex, 0);
  assert.equal(ctx.chatMetadata[NATIVE_KEY].route.title, "回复 1");
});

test("cyclic imported routes are rejected before writing files", async t => {
  const { storage, files } = setup(t);
  await storage.initialize();
  await storage.createBranch(1, 1);
  await storage.createBranch(1);
  const bundle = await storage.exportStory();
  const child = bundle.chats[1].records[0].chat_metadata[NATIVE_KEY].route;
  const nested = bundle.chats[2].records[0].chat_metadata[NATIVE_KEY].route;
  child.parentBranchId = nested.id;
  nested.parentBranchId = child.id;
  const count = files.size;
  await assert.rejects(storage.importStory(bundle), /关系不完整|循环/);
  assert.equal(files.size, count);
});

test("deleting a native child preserves the main file and removing a story leaves current first", async t => {
  const { ctx, storage, files } = setup(t);
  await storage.initialize();
  const storyId = ctx.chatMetadata[NATIVE_KEY].storyId;
  const child = await storage.createBranch(1, 1);
  await storage.removeRoutes([child]);
  assert.equal(files.size, 1);
  assert.equal(ctx.chatId, "main");
  await storage.removeStory(storyId, async () => { ctx.chatId = "fresh"; ctx.chatMetadata = {}; ctx.chat.splice(0); });
  assert.equal(files.size, 0);
  assert.equal(ctx.chatId, "fresh");
});
