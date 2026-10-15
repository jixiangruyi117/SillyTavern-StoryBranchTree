import { memoryValuesEqual } from "./MemoryState.js?v=0.1.74";

// Compatibility is deliberately limited to the inspected 2.2.19 storage contract.
export const MEMORY_ENHANCEMENT_ID = "st-memory-enhancement-2";
export const SCHEMA_FIELD = "story_branch_tree_memory_enhancement_schema";
export const SCHEMA_STORE = "story_branch_tree_memory_enhancement";
const FIELDS = ["hash_sheets", "tableEditMatches", SCHEMA_FIELD];
const SCHEMA_KEYS = ["uid", "name", "domain", "type", "enable", "required", "tochat", "triggerSend", "triggerSendDeep", "config", "template"];
const copy = value => structuredClone(value);

export function installMemoryEnhancementBridge({ api, getContext, BASE, USER, DERIVED, updateSheetsView,
  getStorageMode = () => api.getActiveRoute()?.storageMode ?? null, warn = () => {} }) {
  if (!api?.capabilities?.replyMemory || typeof BASE?.Sheet?.prototype?.save !== "function") throw Error("记忆增强桥接接口不完整。");
  let paused = false, disposed = false;
  const frames = [];
  const recentSchemas = new WeakMap();
  let batchDepth = 0;
  const pendingPieces = new Set();
  const originalSave = BASE.Sheet.prototype.save;
  const originalUserSave = USER.saveChat;
  const originalResave = BASE.reSaveAllChatSheets;
  const originalSaveAll = BASE.saveChatSheets;
  const enabled = () => !disposed && USER.tableBaseSetting.isExtensionAble !== false;
  const native = () => getStorageMode() === "native";
  const canRecord = (ctx, mode) => ctx.characterId != null && ctx.groupId == null && mode !== "single";
  const store = () => {
    const ctx = getContext();
    let value = ctx.chatMetadata[SCHEMA_STORE];
    if (value === undefined) ctx.chatMetadata[SCHEMA_STORE] = value = { version: 1, schemas: {}, retired: {} };
    if (value.version !== 1 || !value.schemas || !value.retired) throw Error("记忆增强表结构版本损坏。");
    return value;
  };
  function record(piece) {
    if (!enabled() || paused || !piece || piece.is_user || !piece.hash_sheets) return;
    if (batchDepth) { pendingPieces.add(piece); return; }
    const ctx = getContext(), mode = getStorageMode();
    if (!canRecord(ctx, mode)) return;
    const index = ctx.chat.at(-1) === piece ? ctx.chat.length - 1 : ctx.chat.indexOf(piece);
    if (index < 0) return;
    const schemas = (ctx.chatMetadata.sheets ?? []).map(sheet => Object.fromEntries(
      SCHEMA_KEYS.filter(key => Object.hasOwn(sheet, key)).map(key => [key, sheet[key]])));
    const catalog = store();
    // Keep only an ID per live catalog, without retaining a previously open chat.
    // Validate contents too: in-place edits/deletion cannot reuse a stale schema.
    let id = recentSchemas.get(catalog);
    if (!id || !memoryValuesEqual(catalog.schemas[id], schemas)) {
      id = Object.keys(catalog.schemas).find(key => memoryValuesEqual(catalog.schemas[key], schemas));
    }
    if (!id) {
      id = globalThis.crypto.randomUUID();
      catalog.schemas[id] = copy(schemas);
    }
    recentSchemas.set(catalog, id);
    piece[SCHEMA_FIELD] = id;
    api.captureReplyMemory(MEMORY_ENHANCEMENT_ID, index);
    if (mode === "native") api.notifyMemoryChanged(MEMORY_ENHANCEMENT_ID, { from: index, to: index + 1, metadata: false });
  }
  function flushRecords() {
    const depth = batchDepth, pieces = [...pendingPieces];
    pendingPieces.clear();
    batchDepth = 0;
    try { for (const piece of pieces) record(piece); }
    finally { batchDepth = depth; }
  }
  function batchSave(callback) {
    batchDepth++;
    try { return callback(); }
    finally { if (--batchDepth === 0) flushRecords(); }
  }
  function metadataFor(snapshot) {
    const ctx = getContext(), catalog = ctx.chatMetadata[SCHEMA_STORE];
    const schemas = catalog?.schemas?.[snapshot[SCHEMA_FIELD]];
    if (!Array.isArray(schemas)) throw Error("找不到这版回复的表结构，请检查记忆增强的历史记录。");
    const pools = new Map((ctx.chatMetadata.sheets ?? []).map(sheet => [sheet.uid, sheet]));
    const sheets = schemas.map(schema => {
      const pool = pools.get(schema.uid) ?? catalog.retired[schema.uid];
      if (!pool?.cellHistory) throw Error("找不到旧表格的单元格记录，已停止恢复。");
      const hashes = snapshot.hash_sheets?.[schema.uid] ?? [];
      const missing = new Set();
      for (const row of hashes) {
        if (!Array.isArray(row)) throw Error("旧表格的单元格记录不完整，已停止恢复。");
        for (const uid of row) missing.add(uid);
      }
      for (const cell of pool.cellHistory) {
        if (!missing.size) break;
        missing.delete(cell.uid);
      }
      if (missing.size) throw Error("旧表格的单元格记录不完整，已停止恢复。");
      return { ...copy(schema), hashSheet: copy(hashes), cellHistory: pool.cellHistory };
    });
    return { sheets, [SCHEMA_STORE]: catalog };
  }
  function restoreSchema(snapshot) {
    const ctx = getContext();
    ctx.updateChatMetadata(metadataFor(snapshot));
    DERIVED.any.chatSheetMap = {};
  }
  function wrappedSave(...args) {
    const frame = { piece: args[0] ?? USER.getChatPiece()?.piece, captured: false };
    frames.push(frame);
    try {
      const result = originalSave.apply(this, args);
      if (result !== false && !frame.captured) record(frame.piece);
      return result;
    } finally { frames.pop(); }
  }
  function wrappedUserSave(...args) {
    const frame = frames.at(-1);
    record(frame?.piece ?? USER.getChatPiece()?.piece);
    if (frame) frame.captured = true;
    // Native bulk saves are synchronous, but their USER.saveChat starts persistence.
    // Capture the completed table set before that write, never on a later timer.
    flushRecords();
    return originalUserSave.apply(this, args);
  }
  function wrappedResave(sheets, ...args) {
    if (enabled() && !paused && canRecord(getContext(), getStorageMode())) {
      const catalog = store(), keep = new Set(sheets.map(sheet => sheet.uid));
      for (const sheet of getContext().chatMetadata.sheets ?? []) if (!keep.has(sheet.uid)) catalog.retired[sheet.uid] = copy(sheet);
    }
    return batchSave(() => originalResave.call(this, sheets, ...args));
  }
  function wrappedSaveAll(...args) { return batchSave(() => originalSaveAll.apply(this, args)); }
  const unregister = api.registerRouteAdapter({
    id: MEMORY_ENHANCEMENT_ID, snapshotMode: "explicit", messageFields: FIELDS, metadataFields: ["sheets", SCHEMA_STORE],
    beforeSwitch(change) {
      if (!enabled() || change.storageMode !== "native") return;
      record(USER.getChatPiece()?.piece);
      paused = true;
    },
    onFork(change) {
      if (!enabled() || change.storageMode !== "native") return;
      const index = change.getMessages({ fields: ["is_user"] }).findLastIndex(message => !message.is_user);
      if (index < 0) return;
      const snapshot = change.getReplyMemory(index);
      if (snapshot === null) {
        warn("这版回复没有桥接历史记录，将沿用记忆增强原有的恢复方式。请在继续聊天前检查表格。");
        return;
      }
      return { metadata: metadataFor(snapshot) };
    },
    async afterSwitch(change) {
      try {
        if (!enabled() || change.storageMode !== "native") return;
        if (change.fork) {
          const index = getContext().chat.findLastIndex(message => !message.is_user);
          if (index < 0) return;
          const snapshot = api.getReplyMemory(MEMORY_ENHANCEMENT_ID, index);
          if (snapshot !== null) {
            restoreSchema(snapshot);
            api.restoreReplyMemory(MEMORY_ENHANCEMENT_ID, index);
          }
        }
        DERIVED.any.chatSheetMap = {};
        await updateSheetsView();
      } finally { paused = false; }
    },
    onSwitchAborted() { paused = false; },
  });
  async function onSwipe(index) {
    if (!enabled() || paused || !native()) return;
    const ctx = getContext(), piece = ctx.chat[index];
    if (!piece || piece.is_user) return;
    const snapshot = api.getReplyMemory(MEMORY_ENHANCEMENT_ID, index);
    if (snapshot !== null) {
      restoreSchema(snapshot);
      api.restoreReplyMemory(MEMORY_ENHANCEMENT_ID, index);
    } else {
      // The core changes extra, but leaves the previous reply's top-level table fields.
      delete piece.hash_sheets;
      delete piece.tableEditMatches;
      delete piece[SCHEMA_FIELD];
      for (let i = index - 1; i >= 0; i--) {
        if (ctx.chat[i].is_user) continue;
        const previous = api.getReplyMemory(MEMORY_ENHANCEMENT_ID, i);
        if (previous) { restoreSchema(previous); break; }
      }
    }
  }
  BASE.Sheet.prototype.save = wrappedSave;
  USER.saveChat = wrappedUserSave;
  if (originalResave) BASE.reSaveAllChatSheets = wrappedResave;
  if (originalSaveAll) BASE.saveChatSheets = wrappedSaveAll;
  const ctx = getContext(), event = ctx.eventTypes?.MESSAGE_SWIPED, source = ctx.eventSource;
  // Must run before the plugin reparses the body and overwrites a manually edited reply.
  if (event && source?.makeFirst) source.makeFirst(event, onSwipe);
  else { unregister(); BASE.Sheet.prototype.save = originalSave; USER.saveChat = originalUserSave; BASE.reSaveAllChatSheets = originalResave; BASE.saveChatSheets = originalSaveAll; throw Error("酒馆不支持回复记忆恢复所需的事件顺序。"); }
  return () => {
    disposed = true;
    pendingPieces.clear();
    source.removeListener(event, onSwipe);
    unregister();
    if (BASE.Sheet.prototype.save === wrappedSave) BASE.Sheet.prototype.save = originalSave;
    if (USER.saveChat === wrappedUserSave) USER.saveChat = originalUserSave;
    if (BASE.reSaveAllChatSheets === wrappedResave) BASE.reSaveAllChatSheets = originalResave;
    if (BASE.saveChatSheets === wrappedSaveAll) BASE.saveChatSheets = originalSaveAll;
  };
}
