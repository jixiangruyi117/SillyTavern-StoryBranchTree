import test from "node:test";
import assert from "node:assert/strict";
import { installMemoryEnhancementBridge, MEMORY_ENHANCEMENT_ID, SCHEMA_FIELD, SCHEMA_STORE } from "../modules/MemoryEnhancementBridge.js";
import { captureReplyMemory, readReplyMemory, restoreReplyMemory } from "../modules/StoryTree.js";

function setup(t, { onPersist = () => {} } = {}) {
  const ctx = { characterId: 0, groupId: null, chat: [{ mes: "A" }], chatMetadata: { sheets: [] },
    eventTypes: { MESSAGE_SWIPED: "swipe" }, updateChatMetadata(patch) { Object.assign(this.chatMetadata, patch); } };
  const handlers = new Map();
  ctx.eventSource = { makeFirst: (event, fn) => handlers.set(event, fn), removeListener: event => handlers.delete(event) };
  let adapter, saves = 0, refreshes = 0;
  const route = { storageMode: "native" };
  const api = { capabilities: { replyMemory: true }, getActiveRoute: () => route,
    registerRouteAdapter(a) { adapter = a; return () => { adapter = null; }; },
    captureReplyMemory(id, index) { assert.equal(id, MEMORY_ENHANCEMENT_ID); captureReplyMemory(ctx.chat[index], adapter.messageFields); },
    getReplyMemory(id, index) { return readReplyMemory(ctx.chat[index], adapter.messageFields); },
    restoreReplyMemory(id, index) { return restoreReplyMemory(ctx.chat[index], adapter.messageFields); }, notifyMemoryChanged() {},
  };
  const USER = { getChatPiece: () => ({ piece: ctx.chat.at(-1) }), tableBaseSetting: {}, saveChat() { onPersist(ctx, adapter); saves++; } };
  class Sheet {
    save(piece = USER.getChatPiece().piece, manual = false) {
      ctx.chatMetadata.sheets = [...ctx.chatMetadata.sheets.filter(sheet => sheet.uid !== this.data.uid), structuredClone(this.data)];
      piece.hash_sheets ??= {};
      piece.hash_sheets[this.data.uid] = structuredClone(this.data.hashSheet);
      if (!manual) USER.saveChat();
      return this;
    }
  }
  const BASE = { Sheet, reSaveAllChatSheets(sheets) { ctx.chatMetadata.sheets = []; sheets.forEach(sheet => sheet.save(undefined, true)); USER.saveChat(); } }, DERIVED = { any: { chatSheetMap: {} } }, warnings = [];
  const original = Sheet.prototype.save;
  const dispose = installMemoryEnhancementBridge({ api, getContext: () => ctx, BASE, USER, DERIVED,
    getStorageMode: () => route.storageMode, updateSheetsView: async () => { refreshes++; }, warn: message => warnings.push(message) });
  t.after(dispose);
  const sheet = new Sheet();
  sheet.data = { uid: "s", name: "物品", type: "free", enable: true,
    config: { toChat: true }, hashSheet: [["h"], ["a"]], cellHistory: [{ uid: "h", data: { value: "物品" } }, { uid: "a", data: { value: "A手改11" } }] };
  return { ctx, sheet, api, BASE, USER, DERIVED, handlers, dispose, warnings, original, route,
    adapter: () => adapter, counts: () => ({ saves, refreshes }) };
}

test("commits capture hash IDs and intern schema revisions without duplicating the cell pool", t => {
  const f = setup(t);
  f.sheet.save();
  assert.equal(f.counts().saves, 1);
  for (let i = 1; i < 300; i++) { f.ctx.chat.push({ mes: `floor ${i}` }); f.sheet.save(undefined, true); }
  assert.equal(Object.keys(f.ctx.chatMetadata[SCHEMA_STORE].schemas).length, 1);
  assert.equal(JSON.stringify(f.ctx.chat.map(m => m.extra)).includes("A手改11"), false);
  assert.equal(readReplyMemory(f.ctx.chat[0], f.adapter().messageFields).hash_sheets.s[1][0], "a");
});

test("historical forks restore schema and manual data after the normal parser has overwritten the target", async t => {
  const f = setup(t);
  f.sheet.save(undefined, true);
  const old = structuredClone(f.ctx.chat[0]);
  f.ctx.chat.push({ mes: "future" });
  f.sheet.data.name = "后期名称";
  f.sheet.data.hashSheet = [["h", "h2"], ["a", "future"]];
  f.sheet.data.cellHistory.push({ uid: "h2", data: { value: "新列" } }, { uid: "future", data: { value: "未来" } });
  f.sheet.save(undefined, true);
  assert.equal(Object.keys(f.ctx.chatMetadata[SCHEMA_STORE].schemas).length, 2);
  const change = { storageMode: "native", fork: {}, messageCount: 1, getMessages: () => [old], getReplyMemory: () => readReplyMemory(old, f.adapter().messageFields) };
  f.adapter().beforeSwitch(change);
  const patch = f.adapter().onFork(change);
  f.ctx.chat = [old]; f.ctx.updateChatMetadata(structuredClone(patch.metadata));
  f.ctx.chat[0].hash_sheets = { s: [["h"], ["parserWrong"]] };
  await f.adapter().afterSwitch(change);
  assert.equal(f.ctx.chatMetadata.sheets[0].name, "物品");
  assert.deepEqual(f.ctx.chat[0].hash_sheets.s, [["h"], ["a"]]);
  assert.deepEqual(f.DERIVED.any.chatSheetMap, {});
});

test("native swipe restores a recorded manual table before the plugin parses, while missing versions stay unrecorded", async t => {
  const f = setup(t);
  f.ctx.chat[0].swipes = ["A", "B"]; f.ctx.chat[0].swipe_id = 0;
  f.sheet.save(undefined, true);
  const m = f.ctx.chat[0];
  m.mes = "B"; m.swipe_id = 1; m.extra = {};
  await f.handlers.get("swipe")(0);
  assert.equal(m.hash_sheets, undefined);
  m.mes = "A"; m.swipe_id = 0; m.extra = structuredClone(m.swipe_info[0].extra);
  await f.handlers.get("swipe")(0);
  assert.deepEqual(m.hash_sheets.s, [["h"], ["a"]]);
});

test("unknown old versions warn without claiming a complete restoration; disposal releases wrappers", t => {
  const f = setup(t);
  f.adapter().beforeSwitch({ storageMode: "native" });
  assert.equal(f.adapter().onFork({ storageMode: "native", messageCount: 1, getMessages: () => f.ctx.chat, getReplyMemory: () => null }), undefined);
  assert.equal(f.warnings.length, 1);
  f.adapter().onSwitchAborted();
  f.dispose();
  assert.equal(f.BASE.Sheet.prototype.save, f.original);
  assert.equal(f.handlers.size, 0);
});

test("forks at a user message use the preceding recorded AI reply, including removed sheets", async t => {
  const f = setup(t);
  f.sheet.save(undefined, true);
  const old = structuredClone(f.ctx.chat[0]);
  f.ctx.chat.push({ mes: "future" });
  f.BASE.reSaveAllChatSheets([]);
  assert.equal(f.ctx.chatMetadata.sheets.length, 0);
  assert.equal(f.ctx.chatMetadata[SCHEMA_STORE].retired.s.name, "物品");
  const messages = [old, { mes: "user floor", is_user: true }];
  const change = { storageMode: "native", fork: {}, messageCount: 2, getMessages: () => messages,
    getReplyMemory: index => readReplyMemory(messages[index], f.adapter().messageFields) };
  f.adapter().beforeSwitch(change);
  const patch = f.adapter().onFork(change);
  f.ctx.chat = messages;
  f.ctx.updateChatMetadata(structuredClone(patch.metadata));
  await f.adapter().afterSwitch(change);
  assert.equal(f.ctx.chatMetadata.sheets[0].name, "物品");
  assert.deepEqual(f.ctx.chat[0].hash_sheets.s, [["h"], ["a"]]);
});

test("single mode and groups do not acquire bridge records or retired cell pools", t => {
  const f = setup(t);
  for (const group of [false, true]) {
    f.route.storageMode = group ? "native" : "single";
    f.ctx.groupId = group ? "group" : null;
    f.sheet.save(undefined, true);
    f.BASE.reSaveAllChatSheets([]);
    assert.equal(f.ctx.chatMetadata[SCHEMA_STORE], undefined);
    assert.equal(f.ctx.chat[0][SCHEMA_FIELD], undefined);
  }
});

test("recent schema reuse validates in-place edits, deleted entries and replacement catalogs", t => {
  const f = setup(t);
  f.sheet.save(undefined, true);
  const firstId = f.ctx.chat[0][SCHEMA_FIELD];
  f.ctx.chatMetadata[SCHEMA_STORE].schemas[firstId][0].name = "changed outside bridge";
  f.sheet.save(undefined, true);
  assert.notEqual(f.ctx.chat[0][SCHEMA_FIELD], firstId);
  const secondId = f.ctx.chat[0][SCHEMA_FIELD];
  delete f.ctx.chatMetadata[SCHEMA_STORE].schemas[secondId];
  f.sheet.save(undefined, true);
  assert.notEqual(f.ctx.chat[0][SCHEMA_FIELD], secondId);
  f.ctx.chatMetadata[SCHEMA_STORE] = { version: 1, schemas: {}, retired: {} };
  f.sheet.save(undefined, true);
  assert.equal(Object.keys(f.ctx.chatMetadata[SCHEMA_STORE].schemas).length, 1);
  assert.equal(f.ctx.chatMetadata[SCHEMA_STORE].schemas[f.ctx.chat[0][SCHEMA_FIELD]][0].name, "物品");
});

test("mode checks during commits do not request the full route message ID list", t => {
  const f = setup(t);
  f.api.getActiveRoute = () => { throw Error("full route query"); };
  f.sheet.save();
  assert.ok(f.ctx.chat[0][SCHEMA_FIELD]);
  assert.equal(f.counts().saves, 1);
});

test("bulk saves capture once before persistence and release the batch after errors", t => {
  const f = setup(t, { onPersist(ctx, adapter) {
    assert.deepEqual(readReplyMemory(ctx.chat[0], adapter.messageFields).hash_sheets, ctx.chat[0].hash_sheets);
  } });
  let captured = 0, persisted = 0;
  const capture = f.api.captureReplyMemory;
  f.api.captureReplyMemory = (...args) => { captured++; return capture(...args); };
  const other = new f.BASE.Sheet(); other.data = { ...structuredClone(f.sheet.data), uid: "other" };
  // Use the real bulk-call ordering and verify the snapshot at the write boundary.
  f.BASE.reSaveAllChatSheets([f.sheet, other]);
  assert.equal(captured, 1);
  assert.equal(f.ctx.chat[0][SCHEMA_FIELD], Object.keys(f.ctx.chatMetadata[SCHEMA_STORE].schemas)[0]);
  assert.deepEqual(Object.keys(readReplyMemory(f.ctx.chat[0], f.adapter().messageFields).hash_sheets), ["s", "other"]);
  persisted = f.counts().saves;
  const throwing = { save() { throw Error("bulk-error"); } };
  assert.throws(() => f.BASE.reSaveAllChatSheets([f.sheet, throwing]), /bulk-error/);
  assert.equal(f.counts().saves, persisted);
  const afterError = captured;
  f.sheet.save();
  assert.equal(captured, afterError + 1);
});

test("native restoration still rejects missing cells after optimizing history validation", t => {
  const f = setup(t);
  f.sheet.save(undefined, true);
  const piece = structuredClone(f.ctx.chat[0]);
  f.ctx.chatMetadata.sheets[0].cellHistory.pop();
  assert.throws(() => f.adapter().onFork({ storageMode: "native", getMessages: () => [piece],
    getReplyMemory: () => readReplyMemory(piece, f.adapter().messageFields) }), /不完整/);
});
