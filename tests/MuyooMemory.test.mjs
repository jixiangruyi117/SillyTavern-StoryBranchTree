import test from "node:test";
import assert from "node:assert/strict";
import { captureMuyooReplies, createMuyooMemoryCompatibility, muyooSheetsAtMessages, pruneMuyooTaskLinks, mergeMuyooCellPools } from "../modules/MuyooMemory.js";

const sheets = () => [{ uid: "sheet", name: "memory", hashSheet: [["header"], ["future"]],
  cellHistory: [{ uid: "header", data: { value: "heading" } }, { uid: "past", data: { value: "past" } },
    { uid: "future", data: { value: "future" } }], content: [["future"]], sourceData: { future: true } }];

test("historical forks retain referenced past cells and discard future reconstruction data", () => {
  const source = sheets();
  const saved = JSON.stringify(source);
  const result = muyooSheetsAtMessages(source, [{ hash_sheets: { sheet: [["header"], ["past"]] } }]);
  assert.deepEqual(result[0].hashSheet, [["header"], ["past"]]);
  assert.deepEqual(result[0].cellHistory.map(cell => cell.uid), ["header", "past"]);
  assert.equal(result[0].content, undefined);
  assert.equal(result[0].sourceData, undefined);
  assert.equal(JSON.stringify(source), saved);
  assert.deepEqual(muyooSheetsAtMessages(source, []), []);
});

test("history pruning preserves all retained floors and fails on missing cells or sheets", () => {
  const messages = [{ hash_sheets: { sheet: [["header"], ["past"]] } },
    { hash_sheets: { sheet: [["header"], ["future"]] } }];
  assert.equal(muyooSheetsAtMessages(sheets(), messages)[0].cellHistory.length, 3);
  assert.throws(() => muyooSheetsAtMessages([], messages), /历史缺失/);
  assert.throws(() => muyooSheetsAtMessages(sheets(), [{ hash_sheets: { sheet: [["missing"]] } }]), /单元格缺失/);
  assert.throws(() => muyooSheetsAtMessages(sheets(), [{ hash_sheets: { sheet: [1] } }]), /索引损坏/);
  assert.throws(() => muyooSheetsAtMessages(sheets(), [{ dataTable: [{}] }]), /旧版/);
});

test("retired empty template IDs are ignored exactly as the native table reader does", () => {
  const messages = [{ hash_sheets: { retired: [["old-header"]], sheet: [["header"], ["past"]] } }];
  assert.equal(muyooSheetsAtMessages(sheets(), messages).length, 1);
  assert.throws(() => muyooSheetsAtMessages(sheets(), [{ hash_sheets: { retired: [["old-header"], ["fact"]] } }]), /历史缺失/);
});

test("legacy checkpoints recover missing referenced cells without inheriting future facts", () => {
  const original = sheets();
  const current = structuredClone(original);
  current[0].cellHistory = current[0].cellHistory.filter(cell => cell.uid !== "past");
  const pool = mergeMuyooCellPools(current, original);
  const retained = muyooSheetsAtMessages(pool, [{ hash_sheets: { sheet: [["header"], ["past"]] } }]);
  assert.deepEqual(retained[0].cellHistory.map(cell => cell.uid), ["header", "past"]);
  assert.equal(current[0].cellHistory.length, 2);
  assert.equal(original[0].cellHistory.length, 3);
});

test("future import bodies are not read and unsafe native cache IDs are rejected", () => {
  const source = sheets();
  Object.defineProperty(source[0], "content", { enumerable: true, get() { throw Error("future-body-read"); } });
  muyooSheetsAtMessages(source, [{ hash_sheets: { sheet: [["header"]] } }]);
  assert.throws(() => muyooSheetsAtMessages([{ uid: "__proto__", cellHistory: [] }], []), /损坏/);
  assert.throws(() => muyooSheetsAtMessages([], [{ hash_sheets: JSON.parse('{"constructor":[["head"]]}') }]), /损坏/);
});

test("reply snapshots preserve other providers and other replies", () => {
  const message = { mes: "reply3", swipe_id: 2, swipes: ["reply1", "reply2", "reply3"], hash_sheets: { sheet: [["past"]] },
    extra: { story_branch_tree_swipe_message_fields: { OtherMemory: { present: true, value: 7 } } },
    swipe_info: [{ extra: { story_branch_tree_swipe_message_fields: { hash_sheets: { present: true, value: "reply1" } } } }] };
  captureMuyooReplies([message]);
  assert.equal(message.swipe_info[0].extra.story_branch_tree_swipe_message_fields.hash_sheets.value, "reply1");
  assert.equal(message.extra.story_branch_tree_swipe_message_fields.OtherMemory.value, 7);
  assert.equal(message.swipe_info[2].extra.story_branch_tree_swipe_message_fields.two_step_links.present, false);
});

test("discarded future fill references do not mark a fork as already summarized", () => {
  const messages = [{ uid: "past", swipe_id: 2, two_step_links: { past_2: ["past_2", "future_0"] } }];
  pruneMuyooTaskLinks(messages);
  assert.deepEqual(messages[0].two_step_links, { past_2: ["past_2"] });
});

function setup({ refresh = async () => {}, branches = true, delayImport = async () => {} } = {}) {
  const callbacks = [];
  const ctx = { characterId: 0, groupId: null, extensionSettings: {}, chat: [{ mes: "first", is_user: false }, { mes: "ask", is_user: true },
    { mes: "last", is_user: false }], chatMetadata: { sheets: sheets() },
    eventTypes: { CHARACTER_MESSAGE_RENDERED: "rendered" }, eventSource: { events: { rendered: [] } } };
  if (branches) ctx.chatMetadata.story_branch_tree = { branches: { root: {}, child: {} } };
  let adapter;
  let complete;
  let refreshes = 0;
  let notices = 0;
  let originalCalls = 0;
  const manager = { BASE: { refreshContextView: async () => { refreshes++; await refresh(); } }, USER: {
    tableBaseSetting: { isExtensionAble: true, step_by_step: true }, saveChat: async () => {} },
    EDITOR: { tryBlock: (callback, _message, ...args) => callback(...args) }, DERIVED: { any: { chatSheetMap: { old: true } } } };
  function onMessageReceived() { const TableTwoStepSummary = 0; const handleEditStrInMessage = 0; originalCalls++; }
  ctx.eventSource.events.rendered.push(onMessageReceived);
  const native = { updateSheetsView: async () => {}, handleEditStrInMessage: () => {} };
  const rebuild = { getPromptAndRebuildTable: () => new Promise(resolve => { complete = resolve; }) };
  const step = { TableTwoStepSummary: () => new Promise(resolve => { complete = resolve; }) };
  const api = { registerRouteAdapter: value => { adapter = value; return () => callbacks.push("unregistered"); },
    getRouteMetadata: () => null, getActiveRouteKey: () => "route", notifyMemoryChanged: () => { notices++; } };
  const originals = { received: onMessageReceived, save: manager.USER.saveChat, tryBlock: manager.EDITOR.tryBlock };
  const bridge = createMuyooMemoryCompatibility({ getContext: () => ctx, getApi: () => api, getPlugin: () => ({ VERSION: "2.2.19" }),
    importModule: async path => { await delayImport(); return path.endsWith("manager.js") ? manager : path.endsWith("index.js") ? native : path.endsWith("absoluteRefresh.js") ? rebuild : step; } });
  return { ctx, manager, bridge, callbacks, originals, get adapter() { return adapter; }, get complete() { return complete; },
    get refreshes() { return refreshes; }, get notices() { return notices; }, get originalCalls() { return originalCalls; } };
}

test("auto fill holds a switch lease through its actual completion without blocking the event bus", async () => {
  const env = setup();
  await env.bridge.ensure();
  const returned = env.ctx.eventSource.events.rendered[0](2);
  assert.equal(returned, undefined);
  await assert.rejects(env.adapter.beforeSwitch({}), /正在填表/);
  env.complete();
  await new Promise(resolve => setImmediate(resolve));
  const change = { getMessages: () => [{ hash_sheets: { sheet: [["header"], ["past"]] } }] };
  const result = await env.adapter.beforeSwitch(change);
  assert.deepEqual(result.metadata.sheets[0].hashSheet, [["header"], ["past"]]);
  env.ctx.eventSource.events.rendered[0](2);
  await env.adapter.afterSwitch();
  assert.equal(env.originalCalls, 0);
  assert.deepEqual(env.manager.DERIVED.any.chatSheetMap, {});
  assert.ok(env.notices >= 1);
  env.bridge.clear();
  assert.equal(env.ctx.eventSource.events.rendered[0], env.originals.received);
  assert.equal(env.manager.USER.saveChat, env.originals.save);
});

test("clearing during module loading does not install obsolete callbacks or field ownership", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const env = setup({ delayImport: () => gate });
  const pending = env.bridge.ensure();
  env.bridge.clear();
  release(); await pending;
  assert.equal(env.adapter, undefined);
  assert.equal(env.ctx.eventSource.events.rendered[0], env.originals.received);
  assert.equal(env.manager.USER.saveChat, env.originals.save);
});

test("native rebuild confirmation awaits its detached child once and holds the switch lease", async () => {
  const env = setup();
  class NativePopup { constructor() { this.result = true; } async show() { return true; } }
  env.manager.EDITOR.Popup = NativePopup;
  await env.bridge.ensure();
  const controls = { template: { value: "test-template" }, prompt: { value: "test-prompt" } };
  const popup = new env.manager.EDITOR.Popup({ querySelector: selector => selector === "#rebuild_template_selector" ? controls.template : controls.prompt });
  const job = popup.show();
  await Promise.resolve();
  await assert.rejects(env.adapter.beforeSwitch({}), /正在填表/);
  env.complete();
  await job;
  assert.equal(popup.result, false);
  assert.equal(env.manager.USER.tableBaseSetting.lastSelectedTemplate, "test-template");
  assert.equal(env.manager.DERIVED.any.additionalPrompt, "test-prompt");
  await env.adapter.beforeSwitch({ getMessages: () => [] });
  await env.adapter.onSwitchAborted();
  env.bridge.clear();
  assert.equal(env.manager.EDITOR.Popup, NativePopup);
});

test("pending UI operations and rejected operations release correctly, leaving unrelated wrappers intact", async () => {
  const env = setup();
  await env.bridge.ensure();
  const job = env.manager.EDITOR.tryBlock(() => new Promise(resolve => { env.release = resolve; }), "manual");
  await assert.rejects(env.adapter.beforeSwitch({}), /正在填表/);
  env.release();
  await job;
  await assert.rejects(env.manager.EDITOR.tryBlock(async () => { throw Error("operation-error"); }), /operation-error/);
  await env.adapter.beforeSwitch({ getMessages: () => [] });
  await env.adapter.onSwitchAborted();
  const otherWrapper = () => {};
  env.manager.USER.saveChat = otherWrapper;
  env.bridge.clear();
  assert.equal(env.manager.USER.saveChat, otherWrapper);
  assert.equal(env.manager.EDITOR.tryBlock, env.originals.tryBlock);
});

test("changing chats while a view refresh is pending cancels preparation and releases suppression", async () => {
  let release;
  const env = setup({ refresh: () => new Promise(resolve => { release = resolve; }) });
  await env.bridge.ensure();
  const view = env.manager.BASE.refreshContextView();
  const preparation = env.adapter.beforeSwitch({ getMessages: () => [] });
  env.ctx.chatId = "other-chat";
  release();
  await view;
  await assert.rejects(preparation, /聊天已变化/);
  env.manager.USER.tableBaseSetting.step_by_step = false;
  await env.ctx.eventSource.events.rendered[0](2);
  assert.equal(env.originalCalls, 1);
  env.bridge.clear();
});

test("disabling the memory plugin cannot release an unfinished fill's switch protection", async () => {
  const env = setup();
  await env.bridge.ensure();
  env.ctx.eventSource.events.rendered[0](2);
  env.manager.USER.tableBaseSetting.isExtensionAble = false;
  await assert.rejects(env.bridge.ensure(), /未完成的操作/);
  env.complete();
  await new Promise(resolve => setImmediate(resolve));
  await env.bridge.ensure();
  assert.equal(env.manager.USER.saveChat, env.originals.save);
});

test("group messages continue through native callbacks without route snapshots", async () => {
  const env = setup();
  await env.bridge.ensure();
  env.ctx.groupId = "test-group";
  env.ctx.eventSource.events.rendered[0](2);
  await env.manager.USER.saveChat();
  assert.equal(env.originalCalls, 1);
  assert.equal(env.notices, 0);
  env.bridge.clear();
});

test("unbranched chats retain native data without reply snapshots or adapter registration", async () => {
  const env = setup({ branches: false });
  env.ctx.chat[2].swipes = ["last", "other"];
  env.ctx.chat[2].swipe_id = 0;
  const before = JSON.stringify({ chat: env.ctx.chat, metadata: env.ctx.chatMetadata });
  await env.bridge.ensure();
  env.bridge.captureReplies();
  await env.manager.USER.saveChat();
  assert.equal(env.adapter, undefined);
  assert.equal(env.notices, 0);
  assert.equal(JSON.stringify({ chat: env.ctx.chat, metadata: env.ctx.chatMetadata }), before);
  env.ctx.eventSource.events.rendered[0](2);
  await assert.rejects(env.bridge.ensure({ forBranch: true }), /正在填表/);
  assert.equal(env.adapter, undefined);
  env.complete();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify({ chat: env.ctx.chat, metadata: env.ctx.chatMetadata }), before);
  await env.bridge.ensure({ forBranch: true });
  assert.ok(env.adapter);
  assert.ok(env.ctx.chat[2].extra.story_branch_tree_swipe_message_fields);
  env.bridge.releaseIfUnused();
  assert.deepEqual(env.callbacks, ["unregistered"]);
  env.bridge.clear();
});

test("root-only chats also skip automatic snapshots until a confirmed branch action", async () => {
  const env = setup({ branches: false });
  env.ctx.chatMetadata.story_branch_tree = { branches: { root: {} } };
  await env.bridge.ensure();
  await env.manager.USER.saveChat();
  assert.equal(env.adapter, undefined);
  assert.equal(env.ctx.chat[2].extra, undefined);
  env.bridge.clear();
});
