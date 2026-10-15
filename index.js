import {
  TREE_METADATA_KEY,
  activateStoryBranch,
  copyStoryMessageIdentity,
  captureReplyMemory,
  readReplyMemory,
  restoreReplyMemory,
  captureStoryBranchAdapterState,
  adapterMetadataFieldNames,
  captureStoryBranchAdapterMetadata,
  restoreStoryBranchAdapterMetadata,
  createStoryBranch,
  createStoryBranchFromSwipe,
  createStoryTree,
  deleteStoryBranch,
  getStoryBranchRows as getSingleStoryRows,
  getStoryMessageId,
  copyMessageRange,
  messageReadOptions,
  readStoryBranchMessages,
  resolveStoryBranch,
  syncActiveStoryBranch,
  validateStoryTree as validateSingleStoryTree,
} from "./modules/StoryTree.js?v=0.1.74";
import { captureMemoryState } from "./modules/MemoryState.js?v=0.1.74";
import { installMemoryEnhancementBridge } from "./modules/MemoryEnhancementBridge.js?v=0.1.74";
import { createMuyooMemoryCompatibility, muyooSheetsAtMessages } from "./modules/MuyooMemory.js?v=0.1.74";
import { NativeStoryStorage, NATIVE_KEY, MODE_KEY, storyMode, nativeRows } from "./modules/NativeStory.js?v=0.1.74";
import { isGenerating, sendTextareaMessage, swipeState, updateSwipeCounter } from "../../../../script.js";
import { shouldSendOnEnter } from "../../../RossAscends-mods.js";

const EXTENSION_FOLDER = "third-party/SillyTavern-StoryBranchTree";
const BRANCH_CHANGED_EVENT = "story-branch-tree:changed";
const PUBLIC_API_KEY = "SillyTavernStoryBranchTree";
const API_READY_EVENT = "story-branch-tree:ready";
const routeAdapters = new Map();
const memoryTasks = new Set();
let memoryTaskEpoch = 0;
const state = { busy: false, routeSwitching: false };
const eventHandlers = [];
let panelClickHandler = null;
let chatClickHandler = null;
let pendingSendGuard = null;
let canvasPointerHandler = null;
let canvasWheelHandler = null;
let canvasKeyHandler = null;
let pendingNoteEditor = null;
let pendingConfirmation = null;
let renderedLayout = null;
let compactView = true;
let cardPointer = null;
const activeTouchPointers = new Map();
let pinchGesture = null;
let suppressForkClick = null;
let suppressEndClickBranchId = null;
let publicApi = null;
let activeProjection = null;
let adapterRecoveryKey = null;
let adapterRecoveryOwner = null;
let adapterPreparingOwner = null;
let memoryEnhancementDispose = null;
let memoryEnhancementAttempt = null;
let pendingModeAction = null;
let nativePreview = null;
let libraryEntries = [];
let legacySearch = null;
let legacyPlan = null;
let originalListOnce = false;
let nativePrepared = [];
let nativeChangeOwner = null;
let extensionEnabled = true;
const singleMemoryCompatibility = createMuyooMemoryCompatibility({ getContext: context, getApi: () => publicApi,
  getPlugin: () => storyMode(context()) === "single" && !context()?.extensionSettings?.disabledExtensions?.includes("third-party/st-memory-enhancement")
    ? globalThis.stMemoryEnhancement : null });
const nativeStorage = new NativeStoryStorage(context, {
  fork: async (index, options) => (await import("../../../bookmarks.js")).createBranch(index, options),
  selectSwipe: async (message, index) => (await import("../../../../script.js")).syncSwipeToMes?.(null, index, message) ?? false,
  prepare: prepareNativeChange,
  complete: completeNativeChange,
  aborted: abortNativeChange,
});
const view = { x: 48, y: 48, scale: 1, needsFit: true, dragging: false, pointerId: null, startX: 0, startY: 0, originX: 0, originY: 0 };

function context() {
  return globalThis.SillyTavern?.getContext?.();
}

async function connectMemoryEnhancement() {
  const api = publicApi, marker = globalThis.stMemoryEnhancement;
  if (!api || !extensionEnabled) return;
  if (storyMode(context()) === "single") {
    memoryEnhancementDispose?.();
    memoryEnhancementDispose = null;
    memoryEnhancementAttempt = null;
    await singleMemoryCompatibility.ensure();
    return;
  }
  // The two modes own the same table fields; release the single-chat owner first.
  await singleMemoryCompatibility.ensure();
  if (!marker || memoryEnhancementDispose || memoryEnhancementAttempt === api) return;
  if (context()?.extensionSettings?.disabledExtensions?.includes("third-party/st-memory-enhancement")) return;
  memoryEnhancementAttempt = api;
  if (marker.VERSION !== "2.2.19") {
    toast("warning", "记忆增强当前版本尚未验证，未启用专用桥接。原生聊天仍按原有方式运行。");
    return;
  }
  try {
    const root = "../st-memory-enhancement/";
    const manager = await import(root + "core/manager.js");
    const plugin = await import(root + "index.js");
    if (publicApi !== api || !extensionEnabled) return;
    memoryEnhancementDispose = installMemoryEnhancementBridge({ api, getContext: context, getStorageMode: () => storyMode(context()),
      ...manager, updateSheetsView: plugin.updateSheetsView, warn: message => toast("warning", message) });
  } catch (error) { console.error("[StoryBranchTree] Memory enhancement bridge failed", error); toast("warning", "记忆增强桥接未能启用，请检查插件安装位置和版本。"); }
}

function isSoloChat(ctx = context()) {
  return Boolean(ctx && ctx.characterId !== undefined && ctx.characterId !== null && (ctx.groupId === undefined || ctx.groupId === null));
}

async function ensureSingleMemory({ captureReplies = false } = {}) {
  await connectMemoryEnhancement();
  await singleMemoryCompatibility.ensure({ forBranch: true });
  if (captureReplies) singleMemoryCompatibility.captureReplies();
}

function toast(level, message) {
  globalThis.toastr?.[level]?.(message, "剧情分支树");
}

function graphFrom(ctx) {
  if (ctx?.chatMetadata?.[NATIVE_KEY]) {
    if (!isSoloChat(ctx)) return null;
    storyMode(ctx);
    return nativeStorage.view(ctx);
  }
  return ctx?.chatMetadata?.[TREE_METADATA_KEY] ?? null;
}

function getStoryBranchRows(tree) {
  return tree?.storageMode === "native" ? nativeRows(tree) : getSingleStoryRows(tree);
}

function validateStoryTree(tree) {
  return tree?.storageMode === "native" ? (nativeRows(tree), true) : validateSingleStoryTree(tree);
}

async function prepareNativeChange(change, messages, refreshTarget) {
  state.routeSwitching = true;
  invalidateMemoryTasks();
  nativePrepared = [];
  const ctx = context();
  nativeChangeOwner = { chat: ctx.chat, chatId: ctx.chatId, characterId: ctx.characterId };
  const assertOwner = () => { const current = context(); if (current.chat !== nativeChangeOwner.chat || current.chatId !== nativeChangeOwner.chatId || current.characterId !== nativeChangeOwner.characterId) throw Error("聊天已改变，停止旧路线的记忆准备。"); };
  const overrides = {};
  const accept = (adapter, result) => {
    if (result?.metadata === undefined) return;
    if (!result.metadata || typeof result.metadata !== "object" || Array.isArray(result.metadata)
      || Object.keys(result.metadata).some(key => !adapter.metadataFields.includes(key))) throw Error("记忆钩子返回了未声明的聊天元数据。");
    Object.assign(overrides, structuredClone(result.metadata));
  };
  for (const adapter of routeAdapters.values()) {
    let target = messages;
    const detail = { ...structuredClone(change), previousRoute: getActiveRouteInfo(),
      getMessages: options => copyMessageRange(target, options),
      getReplyMemory: index => readReplyMemory(target[index], adapter.messageFields) };
    adapterPreparingOwner = adapter.id;
    try { accept(adapter, await adapter.beforeSwitch?.(detail)); }
    finally { adapterPreparingOwner = null; }
    assertOwner();
    nativePrepared.push(adapter);
    if (change.fork && adapter.onFork) {
      if (refreshTarget) {
        const refreshed = await refreshTarget();
        target = refreshed;
        detail.getMessages = options => copyMessageRange(refreshed, options);
      }
      accept(adapter, await adapter.onFork(detail));
    }
    assertOwner();
  }
  return overrides;
}

async function completeNativeChange(change) {
  const ctx = context();
  const owner = { chat: ctx.chat, chatId: ctx.chatId, characterId: ctx.characterId };
  const assertOwner = () => { const current = context(); if (current.chat !== owner.chat || current.chatId !== owner.chatId || current.characterId !== owner.characterId) throw Error("聊天已改变，停止旧路线的记忆恢复。"); };
  for (const adapter of nativePrepared) {
    adapterRecoveryOwner = adapter.id;
    await adapter.afterSwitch?.(structuredClone(change));
    assertOwner();
  }
  nativePrepared = [];
  adapterRecoveryOwner = null;
  adapterRecoveryKey = null;
  // Hooks can persist their own data during restoration, as in ordinary chats.
  await context().saveChat();
  assertOwner();
  state.routeSwitching = false;
  emitBranchChanged(change);
}

async function abortNativeChange(change, opened) {
  if (opened) { if (getActiveRouteInfo()?.branchId === change.branchId) adapterRecoveryKey = getActiveRouteKey(); return; }
  const ctx = context();
  if (nativeChangeOwner && (ctx.chat !== nativeChangeOwner.chat || ctx.chatId !== nativeChangeOwner.chatId || ctx.characterId !== nativeChangeOwner.characterId)) { nativePrepared = []; return; }
  for (const adapter of nativePrepared.reverse()) {
    try { await adapter.onSwitchAborted?.(getActiveRouteInfo()); }
    catch (error) { console.error("[StoryBranchTree] Native switch recovery failed", error); }
  }
  nativePrepared = [];
}

async function runNative(action) {
  if (state.busy || isGenerating()) throw Error("请等待当前操作结束。");
  state.busy = true;
  state.routeSwitching = true;
  invalidateMemoryTasks();
  const epoch = nativeStorage.epoch;
  try {
    const result = await action();
    if (epoch !== nativeStorage.epoch) throw Error("剧情树已停用，已完成的文件操作可从原始记录查看。");
    return result;
  }
  finally { if (epoch === nativeStorage.epoch) { state.busy = false; state.routeSwitching = false; refreshUi(); } }
}

function graphForApi(ctx) {
  return activeProjection && activeProjection.chat === ctx?.chat && activeProjection.chatId === ctx?.chatId
    ? activeProjection.tree : graphFrom(ctx);
}

function routeInfo(ctx, tree, messages = ctx?.chat) {
  const branch = tree?.branches?.[tree.activeBranchId];
  if (!ctx || !tree || !branch || !isSoloChat(ctx) || !Array.isArray(messages)) return null;
  const chatId = ctx.chatId ?? null;
  return {
    version: 1,
    ...(tree.storageMode === "native" ? { storageMode: "native", storyId: tree.storyId } : {}),
    chatId,
    characterId: ctx.characterId ?? null,
    rootBranchId: tree.rootBranchId,
    branchId: branch.id,
    parentBranchId: branch.parentBranchId ?? null,
    title: branch.title ?? "",
    cacheKey: JSON.stringify([tree.storageMode === "native" ? tree.storyId : chatId, branch.id]),
    messageCount: messages.length,
    messageIds: messages.map((message) => getStoryMessageId(message) ?? null),
  };
}

function getActiveRouteInfo() {
  const ctx = context();
  return routeInfo(ctx, graphForApi(ctx));
}

function getActiveRouteKey() {
  const ctx = context();
  const tree = graphForApi(ctx);
  return isSoloChat(ctx) && Array.isArray(ctx.chat) && tree?.branches?.[tree.activeBranchId]
    ? JSON.stringify([tree.storageMode === "native" ? tree.storyId : ctx.chatId ?? null, tree.activeBranchId]) : null;
}

function getRouteMessages(branchId, options = {}) {
  const ctx = context();
  const tree = graphForApi(ctx);
  if (!isSoloChat(ctx) || !tree) return null;
  const targetBranchId = branchId ?? tree.activeBranchId;
  if (!tree.branches?.[targetBranchId]) return null;
  if (targetBranchId === tree.activeBranchId) return Array.isArray(ctx.chat) ? copyMessageRange(ctx.chat, options) : null;
  if (tree.storageMode === "native") return null;
  return readStoryBranchMessages(tree, targetBranchId, options);
}

function isMemoryBlocked(ctx = context()) {
  return adapterRecoveryKey !== null && adapterRecoveryKey === getActiveRouteKey();
}

function getRouteMetadata(adapterId, branchId) {
  const adapter = routeAdapters.get(adapterId);
  if (!adapter) throw new Error("记忆适配器未注册。");
  const ctx = context();
  if (!isSoloChat(ctx)) return null;
  const tree = graphForApi(ctx);
  if (tree?.storageMode === "native") {
    if (branchId && branchId !== tree.activeBranchId) return null;
    return structuredClone(Object.fromEntries(adapter.metadataFields.filter(key => Object.hasOwn(ctx.chatMetadata, key)).map(key => [key, ctx.chatMetadata[key]])));
  }
  const saved = tree?.branches?.[branchId ?? tree.activeBranchId]?.adapterStates?.[adapterId]?.metadata;
  return saved === undefined ? null : structuredClone(saved);
}

function captureAdapterMetadata(ctx, tree, branchId, adapter) {
  if (adapter.metadataFields.length) captureStoryBranchAdapterMetadata(tree, branchId, ctx.chatMetadata, adapter.id, adapter.metadataFields);
}

function captureActiveAdapterMetadata(ctx, tree) {
  for (const adapter of routeAdapters.values()) {
    if (adapter.snapshotMode !== "explicit" || !tree.branches[tree.activeBranchId].adapterStates?.[adapter.id]?.metadata) {
      captureAdapterMetadata(ctx, tree, tree.activeBranchId, adapter);
    }
  }
}

function invalidateMemoryTasks(adapterId) {
  if (adapterId === undefined) memoryTaskEpoch++;
  for (const task of [...memoryTasks]) if (adapterId === undefined || task.adapterId === adapterId) task.cancel();
}

function beginMemoryTask(adapterId, options = {}) {
  const adapter = routeAdapters.get(adapterId);
  if (!adapter) throw new Error("记忆适配器未注册。");
  const ctx = context();
  const key = getActiveRouteKey();
  if (!key || state.routeSwitching || isMemoryBlocked(ctx)) throw new Error("当前路线尚未就绪，不能启动记忆任务。");
  const read = messageReadOptions(options, ctx.chat.length);
  const scoped = Object.hasOwn(options, "from") || Object.hasOwn(options, "to");
  const controller = new AbortController();
  if (scoped && ctx.chat.slice(read.from, read.to).some(message => !getStoryMessageId(message))) throw new Error("楼层标识尚未同步，请在消息事件处理完成后启动记忆任务。");
  let scope = { chat: ctx.chat, characterId: ctx.characterId, key, epoch: memoryTaskEpoch,
    count: ctx.chat.length, memoryRevision: adapter.memoryRevision, sources: (scoped ? ctx.chat.slice(read.from, read.to) : []).map((message, offset) => ({
      index: read.from + offset, messageId: getStoryMessageId(message),
      variantId: message.extra?.story_branch_tree_variant_id ?? null,
      swipeId: message.swipe_id ?? 0, text: message.mes,
    })) };
  const entry = { adapterId, cancel() { controller.abort(); scope = null; memoryTasks.delete(entry); },
    advanceRevision() { if (scope) scope.memoryRevision = adapter.memoryRevision; } };
  const isCurrent = () => {
    if (!scope || controller.signal.aborted || !publicApi || state.routeSwitching || routeAdapters.get(adapterId) !== adapter) return false;
    const current = context();
    return current?.chat === scope.chat && current.characterId === scope.characterId
      && getActiveRouteKey() === scope.key && memoryTaskEpoch === scope.epoch
      && adapter.memoryRevision === scope.memoryRevision
      && (scoped || current.chat.length === scope.count)
      && scope.sources.every(source => {
        const message = current.chat[source.index];
        return message && getStoryMessageId(message) === source.messageId
          && (message.extra?.story_branch_tree_variant_id ?? null) === source.variantId
          && (message.swipe_id ?? 0) === source.swipeId && message.mes === source.text;
      });
  };
  memoryTasks.add(entry);
  const token = Object.freeze({ adapterId, cacheKey: key, signal: controller.signal,
    sources: Object.freeze(scope.sources.map(({ text, ...source }) => Object.freeze(source))),
    isCurrent, assertCurrent() { if (!isCurrent()) throw new Error("记忆任务已过期，禁止写入当前路线。"); },
    finish: entry.cancel, cancel: entry.cancel });
  entry.token = token;
  return token;
}

function notifyMemoryChanged(adapterId, options = {}) {
  const adapter = routeAdapters.get(adapterId);
  if (!adapter) throw new Error("记忆适配器未注册。");
  if (options.task && options.task.adapterId !== adapterId) throw new Error("任务与记忆适配器不匹配。");
  options.task?.assertCurrent();
  if (options.metadata !== undefined && typeof options.metadata !== "boolean") throw new Error("元数据采集选项必须是布尔值。");
  const ctx = context();
  const tree = graphForApi(ctx);
  if (!isSoloChat(ctx) || !tree) throw new Error("当前路线尚未就绪，不能保存记忆变更。");
  const read = messageReadOptions(options, ctx.chat.length);
  if (read.from === read.to && (!adapter.metadataFields.length || options.metadata === false)) return;
  if (tree.storageMode !== "native") {
    captureStoryBranchAdapterState(tree, tree.activeBranchId, ctx.chat.slice(read.from, read.to), adapterId, adapter.messageFields, { partial: true });
    if (options.metadata !== false) captureAdapterMetadata(ctx, tree, tree.activeBranchId, adapter);
  }
  adapter.memoryRevision++;
  for (const task of [...memoryTasks]) if (task.adapterId === adapterId) {
    if (task.token === options.task) task.advanceRevision();
    else task.cancel();
  }
  if (tree.storageMode !== "native") storeGraph(ctx, tree);
}

function installPublicApi() {
  if (globalThis[PUBLIC_API_KEY] && globalThis[PUBLIC_API_KEY] !== publicApi) {
    console.warn(`[StoryBranchTree] ${PUBLIC_API_KEY} is already defined; compatibility API was not installed.`);
    return;
  }
  const api = Object.freeze({
    version: 1,
    capabilities: Object.freeze({ rangedMessages: true, memoryTasks: true, forkHooks: true, explicitSnapshots: true, metadataSnapshots: true, routeList: true, nativeStorage: true, replyMemory: true }),
    eventName: BRANCH_CHANGED_EVENT,
    getActiveRoute: () => publicApi === api ? getActiveRouteInfo() : null,
    getActiveRouteKey: () => publicApi === api ? getActiveRouteKey() : null,
    getRoutes: () => {
      const ctx = context();
      const tree = graphForApi(ctx);
      return publicApi === api && isSoloChat(ctx) && tree ? Object.values(tree.branches).map(branch => ({
        branchId: branch.id, parentBranchId: branch.parentBranchId ?? null, title: branch.title ?? "",
      })) : null;
    },
    getRouteMessages: (branchId, options) => publicApi === api ? getRouteMessages(branchId, options) : null,
    getRouteMetadata: (id, branchId) => publicApi === api ? getRouteMetadata(id, branchId) : null,
    getReplyMemory: (id, index, options) => {
      if (publicApi !== api) return null;
      const adapter = routeAdapters.get(id);
      if (!adapter) throw Error("记忆适配器未注册。");
      return readReplyMemory(context()?.chat?.[index], adapter.messageFields, options);
    },
    captureReplyMemory: (id, index) => {
      if (publicApi !== api) throw Error("路线记忆接口已停用。");
      const adapter = routeAdapters.get(id), ctx = context();
      if (!adapter) throw Error("记忆适配器未注册。");
      if (!isSoloChat(ctx) || state.routeSwitching && adapterPreparingOwner !== id || isMemoryBlocked(ctx)) throw Error("当前聊天尚未就绪，不能保存回复记忆。");
      captureReplyMemory(ctx.chat[index], adapter.messageFields);
    },
    restoreReplyMemory: (id, index) => {
      if (publicApi !== api) throw Error("路线记忆接口已停用。");
      const adapter = routeAdapters.get(id), ctx = context();
      if (!adapter) throw Error("记忆适配器未注册。");
      if (!isSoloChat(ctx) || state.routeSwitching && adapterRecoveryOwner !== id) throw Error("当前聊天尚未就绪，不能恢复回复记忆。");
      return restoreReplyMemory(ctx.chat[index], adapter.messageFields);
    },
    registerRouteAdapter: (adapter) => publicApi === api ? registerRouteAdapter(adapter) : () => {},
    beginMemoryTask: (id, options) => { if (publicApi !== api) throw new Error("路线记忆接口已停用。"); return beginMemoryTask(id, options); },
    notifyMemoryChanged: (id, options) => { if (publicApi !== api) throw new Error("路线记忆接口已停用。"); return notifyMemoryChanged(id, options); },
  });
  publicApi = api;
  globalThis[PUBLIC_API_KEY] = publicApi;
  globalThis.dispatchEvent?.(new CustomEvent(API_READY_EVENT, { detail: { version: 1 } }));
}

function registerRouteAdapter(adapter) {
  if (adapter?.messageFields !== undefined && !Array.isArray(adapter.messageFields)) throw new Error("记忆字段必须是数组。");
  if (adapter?.metadataFields !== undefined && !Array.isArray(adapter.metadataFields)) throw new Error("聊天元数据字段必须是数组。");
  const entry = { ...adapter, messageFields: [...(adapter?.messageFields ?? [])], metadataFields: adapterMetadataFieldNames(adapter?.metadataFields ?? []) };
  captureStoryBranchAdapterState({ branches: { validate: {} } }, "validate", [], entry.id, entry.messageFields);
  if (routeAdapters.has(entry.id)) throw new Error("这个路线记忆适配器已注册。");
  for (const key of ["beforeSwitch", "afterSwitch", "onSwitchAborted", "onFork"]) {
    if (entry[key] !== undefined && typeof entry[key] !== "function") throw new Error("记忆适配钩子必须是函数。");
  }
  if (entry.snapshotMode !== undefined && !["automatic", "explicit"].includes(entry.snapshotMode)) throw new Error("记忆快照模式无效。");
  if (entry.handles !== undefined && (!Array.isArray(entry.handles) || entry.handles.some(value => !["database", "timeline"].includes(value)))) throw new Error("记忆恢复能力无效。");
  entry.handles = [...new Set(entry.handles ?? [])];
  entry.memoryRevision = 0;
  for (const previous of routeAdapters.values()) {
    if (entry.handles.some(value => previous.handles.includes(value)) || entry.messageFields.some(field => previous.messageFields.includes(field))
      || entry.metadataFields.some(field => previous.metadataFields.includes(field))) {
      throw new Error("记忆字段或恢复能力已有适配器负责，不能重复注册。");
    }
  }
  routeAdapters.set(entry.id, entry);
  const ctx = context();
  const tree = graphForApi(ctx);
  const previousStates = new Map(Object.values(tree?.branches ?? {}).map(branch => [branch, {
    present: Object.hasOwn(branch, "adapterStates"), value: branch.adapterStates,
  }]));
  try {
    if (isSoloChat(ctx) && tree && tree.storageMode !== "native") {
      initializeRegisteredAdapterStates(tree, [entry]);
      captureStoryBranchAdapterState(tree, tree.activeBranchId, ctx.chat, entry.id, entry.messageFields);
      captureAdapterMetadata(ctx, tree, tree.activeBranchId, entry);
      if (!activeProjection) storeGraph(ctx, tree);
    }
  } catch (error) {
    for (const [branch, saved] of previousStates) {
      if (saved.present) branch.adapterStates = saved.value;
      else delete branch.adapterStates;
    }
    invalidateMemoryTasks(entry.id);
    routeAdapters.delete(entry.id);
    throw error;
  }
  return () => {
    if (routeAdapters.get(entry.id) !== entry) return;
    invalidateMemoryTasks(entry.id);
    routeAdapters.delete(entry.id);
    if (adapterRecoveryOwner === entry.id) { adapterRecoveryKey = null; adapterRecoveryOwner = null; }
  };
}

function initializeRegisteredAdapterStates(tree, entries = routeAdapters.values()) {
  if (tree.storageMode === "native") return;
  for (const entry of entries) {
    for (const branchId of Object.keys(tree.branches)) {
      if (branchId !== tree.activeBranchId && !tree.branches[branchId].adapterStates?.[entry.id]) {
        const messages = readStoryBranchMessages(tree, branchId, { fields: ["extra.story_branch_tree_message_id", ...entry.messageFields] });
        captureStoryBranchAdapterState(tree, branchId, messages, entry.id, entry.messageFields, { copy: value => value });
      }
    }
  }
}

function removePublicApi() {
  singleMemoryCompatibility.clear();
  memoryEnhancementDispose?.();
  memoryEnhancementDispose = null;
  memoryEnhancementAttempt = null;
  adapterPreparingOwner = null;
  invalidateMemoryTasks();
  if (publicApi && globalThis[PUBLIC_API_KEY] === publicApi) delete globalThis[PUBLIC_API_KEY];
  publicApi = null;
  routeAdapters.clear();
  adapterRecoveryKey = null;
  adapterRecoveryOwner = null;
}

function branchTransitionInfo(ctx, previousBranchId, tree, messages) {
  if (!previousBranchId || previousBranchId === tree?.activeBranchId) return null;
  const info = routeInfo(ctx, tree, messages);
  if (!info) return null;
  const transitionId = globalThis.crypto?.randomUUID?.()
    ?? `branch-change-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    ...info,
    previousBranchId,
    transitionId,
    reason: "route-switched",
    ...(!graphFrom(ctx)?.branches?.[tree.activeBranchId] ? { fork: forkBoundary(ctx, tree, messages) } : {}),
  };
}

function forkBoundary(ctx, tree, messages) {
  const branch = tree.branches[tree.activeBranchId];
  const inheritedMessageCount = messages.length - branch.messageIds.length;
  return { kind: branch.branchKind ?? "continuation", parentBranchId: branch.parentBranchId,
    parentCacheKey: JSON.stringify([ctx.chatId ?? null, branch.parentBranchId]),
    sourceBranchId: graphFrom(ctx)?.activeBranchId ?? null,
    sourceCacheKey: getActiveRouteKey(),
    forkMessageId: branch.forkMessageId, forkFloor: inheritedMessageCount, inheritedMessageCount,
    sourceMessageId: branch.sourceMessageId ?? branch.forkMessageId,
    sourceVariantId: branch.sourceVariantId ?? branch.forkVariantId ?? null,
    sourceSwipeIndex: branch.sourceSwipeIndex ?? branch.forkSwipeId ?? null,
    replyFloor: branch.branchKind === "swipe" ? inheritedMessageCount + 1 : null };
}

function emitBranchChanged(detail) {
  if (!detail || !publicApi) return;
  globalThis.dispatchEvent?.(new CustomEvent(BRANCH_CHANGED_EVENT, {
    detail,
  }));
}

function storeGraph(ctx, tree) {
  if (tree.storageMode === "native") { nativeStorage.saveView(tree); return; }
  ctx.updateChatMetadata({ [TREE_METADATA_KEY]: tree });
  ctx.saveMetadataDebounced?.();
}

function messageMvuVariables(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const variables = message?.variables?.[message.swipe_id ?? 0];
    if (variables && typeof variables === "object" && !Array.isArray(variables)
      && Object.hasOwn(variables, "stat_data")) return structuredClone(variables);
  }
  return null;
}

function captureActiveChatVariables(ctx, tree) {
  tree.branches[tree.activeBranchId].chatVariables = structuredClone(ctx.chatMetadata?.variables ?? {});
}

function restoreActiveChatVariables(ctx, tree, messages) {
  const branch = tree.branches[tree.activeBranchId];
  if (!Object.hasOwn(branch, "chatVariables")) {
    const parentVariables = tree.branches[branch.parentBranchId]?.chatVariables;
    const base = parentVariables ?? {};
    const mvuVariables = messageMvuVariables(messages);
    branch.chatVariables = { ...structuredClone(base), ...mvuVariables };
  }
  if (Object.hasOwn(branch, "chatVariables")) {
    ctx.updateChatMetadata({ variables: structuredClone(branch.chatVariables) });
  }
}

function replyVersionId(message, index) {
  return message?.swipe_info?.[index]?.extra?.story_branch_tree_variant_id ?? null;
}

function replySelectionKey(messageId, versionId, index) {
  return `${messageId}:${versionId ?? `index-${index}`}`;
}

function sourceMessageIdForBranch(tree, branch) {
  if (branch.sourceMessageId) return branch.sourceMessageId;
  if (!Number.isInteger(branch.sourceSwipeIndex) || !branch.parentBranchId) return null;
  const parent = readStoryBranchMessages(tree, branch.parentBranchId, { fields: ["extra.story_branch_tree_message_id"] });
  const anchorIndex = parent.findIndex((message) => getStoryMessageId(message) === branch.forkMessageId);
  return getStoryMessageId(parent[anchorIndex + 1]) ?? null;
}

function historicalReplySource(tree, floorIndex) {
  const visible = readRouteFloor(tree, tree.activeBranchId, floorIndex);
  const visibleId = getStoryMessageId(visible);
  if (!visible || !visibleId) return null;
  const ancestry = [];
  for (let branch = tree.branches[tree.activeBranchId]; branch; branch = tree.branches[branch.parentBranchId]) {
    ancestry.push(branch);
  }
  const alias = ancestry.find((branch) => (branch.branchKind === "swipe" || Number.isInteger(branch.sourceSwipeIndex))
    && branch.messageIds[0] === visibleId && sourceMessageIdForBranch(tree, branch));
  if (alias) {
    const sourceId = sourceMessageIdForBranch(tree, alias);
    const source = readRouteFloor(tree, alias.parentBranchId, floorIndex);
    if (getStoryMessageId(source) !== sourceId) return null;
    const versionIndex = alias.sourceVariantId
      ? source.swipe_info?.findIndex((info) => info?.extra?.story_branch_tree_variant_id === alias.sourceVariantId) : -1;
    return { source, sourceId, ownerId: alias.parentBranchId,
      currentIndex: versionIndex >= 0 ? versionIndex : alias.sourceSwipeIndex };
  }
  let ownerId = tree.activeBranchId;
  for (const branch of ancestry) {
    if (!branch.messageIds.includes(visibleId)) continue;
    const ownerMessage = readRouteFloor(tree, branch.id, floorIndex);
    if (ownerMessage?.mes === visible.mes
      && (!replyVersionId(ownerMessage, ownerMessage.swipe_id)
        || replyVersionId(ownerMessage, ownerMessage.swipe_id) === replyVersionId(visible, visible.swipe_id))) ownerId = branch.id;
  }
  return { source: visible, sourceId: visibleId, ownerId,
    currentIndex: Number.isInteger(visible.swipe_id) ? visible.swipe_id : 0 };
}

function routeUsesReply(tree, branchId, sourceId, floorIndex, versionId, versionIndex) {
  if (!tree.branches[branchId]) return false;
  const message = readRouteFloor(tree, branchId, floorIndex);
  if (!message) return false;
  if (getStoryMessageId(message) === sourceId) {
    return versionId ? replyVersionId(message, message.swipe_id) === versionId : message.swipe_id === versionIndex;
  }
  for (let branch = tree.branches[branchId]; branch; branch = tree.branches[branch.parentBranchId]) {
    if (sourceMessageIdForBranch(tree, branch) !== sourceId || branch.messageIds[0] !== getStoryMessageId(message)) continue;
    return branch.sourceVariantId && versionId
      ? branch.sourceVariantId === versionId : branch.sourceSwipeIndex === versionIndex;
  }
  return false;
}

function branchMessageIndex(tree, branch) {
  if (tree.storageMode === "native") return branch.legacyForkUnknown ? null : branch.forkFloor - 1;
  if (!branch.parentBranchId) return null;
  const parent = readStoryBranchMessages(tree, branch.parentBranchId, { fields: ["extra.story_branch_tree_message_id"] });
  return parent.findIndex((message) => getStoryMessageId(message) === branch.forkMessageId);
}

function groupForkPoints(branches) {
  const groups = new Map();
  for (const branch of branches) {
    if (!branch.parentBranchId || !branch.forkMessageId) continue;
    const key = branch.kind === "swipe"
      ? `reply:${branch.parentBranchId}:${branch.sourceMessageId}`
      : `floor:${branch.parentBranchId}:${branch.forkMessageId}:${branch.variantKey}`;
    if (!groups.has(key)) groups.set(key, {
      id: key,
      parentBranchId: branch.parentBranchId,
      forkMessageId: branch.forkMessageId,
      sourceMessageId: branch.sourceMessageId,
      nodeKey: branch.nodeKey,
      kind: branch.kind,
      unknown: Boolean(branch.legacyForkUnknown),
      forkIndex: branch.displayForkIndex,
      children: [],
      depth: branch.depth ?? 0,
    });
    groups.get(key).children.push(branch);
  }
  const normalCounts = new Map();
  for (const group of groups.values()) {
    if (group.kind !== "continuation") continue;
    const oldKey = `${group.parentBranchId}::${group.forkMessageId}`;
    normalCounts.set(oldKey, (normalCounts.get(oldKey) ?? 0) + 1);
  }
  for (const group of groups.values()) {
    if (group.kind !== "continuation") continue;
    const oldKey = `${group.parentBranchId}::${group.forkMessageId}`;
    if (normalCounts.get(oldKey) === 1) group.id = oldKey;
  }
  return [...groups.values()];
}

function sortForkPointsByFloor(groups) {
  return groups.sort((a, b) => a.forkIndex - b.forkIndex
    || (a.kind === "swipe" ? -1 : 1) - (b.kind === "swipe" ? -1 : 1)
    || Math.min(...a.children.map((branch) => branch.createdAt)) - Math.min(...b.children.map((branch) => branch.createdAt))
    || a.id.localeCompare(b.id));
}

function readRouteFloor(tree, branchId, index) {
  if (!Number.isSafeInteger(index) || index < 0) return undefined;
  if (tree.storageMode === "native") return branchId === tree.activeBranchId ? context().chat[index] : undefined;
  return readStoryBranchMessages(tree, branchId, { from: index, to: index + 1 })[0];
}

function forkPointMessage(tree, group) {
  if (tree.storageMode === "native") return group.children[0]?.forkSnapshot;
  if (group.kind === "swipe") return readRouteFloor(tree, group.parentBranchId, group.forkIndex)
    ?? tree.messages[group.sourceMessageId];
  return group.children[0]?.forkSnapshot ?? tree.messages[group.forkMessageId];
}

function forkPointText(tree, group) {
  const floor = group.unknown ? "?" : group.forkIndex + 1;
  const fallback = group.unknown ? "分叉位置未知" : `第 ${floor} 楼${group.kind === "swipe" ? "回复选择" : "分叉点"}`;
  const legacyKey = group.kind === "continuation" ? group.forkMessageId : null;
  const sourceMessage = forkPointMessage(tree, group);
  const replyIndex = sourceMessage?.swipe_id;
  const storedIndex = group.children[0]?.originSwipeIndex;
  return {
    floor,
    name: (tree.nodeNames?.[group.nodeKey] ?? tree.nodeNames?.[legacyKey])?.trim() || fallback,
    summary: (tree.nodeSummaries?.[group.nodeKey] ?? tree.nodeSummaries?.[legacyKey])?.trim() || messageExcerpt(sourceMessage)
      || (group.kind === "swipe" ? "原回复未保留" : "无摘要"),
    replyLabel: Number.isInteger(replyIndex) ? `回复${replyIndex + 1}`
      : Number.isInteger(storedIndex) ? `原回复${storedIndex + 1}` : "重说",
  };
}

function planTreeColumns(rootBranchId, groupsByParent, branchWidth, stemGap, siblingGap) {
  const halfWidth = branchWidth / 2;
  const groupsFor = (branchId) => sortForkPointsByFloor([...(groupsByParent.get(branchId) ?? [])]);
  const reaches = new Map();
  const groupExtents = new Map();
  const reach = (branchId, ancestors = new Set()) => {
    if (reaches.has(branchId)) return reaches.get(branchId);
    if (ancestors.has(branchId)) return halfWidth;
    const nextAncestors = new Set(ancestors).add(branchId);
    let outerEdge = halfWidth;
    for (const group of groupsFor(branchId)) {
      let offset = branchWidth + stemGap;
      let groupEdge = halfWidth;
      for (const child of group.children) {
        const childReach = reach(child.id, nextAncestors);
        groupEdge = Math.max(groupEdge, offset + childReach);
        offset += childReach + siblingGap + halfWidth;
      }
      groupExtents.set(group.id, groupEdge);
      outerEdge = Math.max(outerEdge, groupEdge);
    }
    reaches.set(branchId, outerEdge);
    return outerEdge;
  };
  const rootIds = Array.isArray(rootBranchId) ? rootBranchId : [rootBranchId];
  rootIds.forEach(id => reach(id));

  const offsets = new Map();
  let leftExtent = halfWidth;
  let rightExtent = halfWidth;
  const assign = (branchId, inheritedSide, ancestors = new Set()) => {
    if (ancestors.has(branchId)) return;
    const nextAncestors = new Set(ancestors).add(branchId);
    for (const group of groupsFor(branchId)) {
      const side = inheritedSide || (leftExtent <= rightExtent ? -1 : 1);
      if (!inheritedSide) {
        if (side < 0) leftExtent = Math.max(leftExtent, groupExtents.get(group.id) ?? halfWidth);
        else rightExtent = Math.max(rightExtent, groupExtents.get(group.id) ?? halfWidth);
      }
      let offset = branchWidth + stemGap;
      const orderedChildren = side < 0 ? [...group.children].reverse() : group.children;
      const childOffsets = new Map();
      for (const child of orderedChildren) {
        childOffsets.set(child.id, side * offset);
        offset += (reaches.get(child.id) ?? halfWidth) + siblingGap + halfWidth;
      }
      offsets.set(group.id, childOffsets);
      for (const child of group.children) assign(child.id, side, nextAncestors);
    }
  };
  rootIds.forEach(id => assign(id, 0));
  return {
    groupsFor,
    leftExtent,
    rightExtent,
    childAxis: (groupId, childId, parentAxis) => parentAxis + (offsets.get(groupId)?.get(childId) ?? 0),
  };
}

function edgeMarkup(groups, routePositions, hubPositions, endPositions, cardHeight, hubHeight) {
  const paths = [];
  const byParent = new Map();
  for (const group of groups) {
    if (!byParent.has(group.parentBranchId)) byParent.set(group.parentBranchId, []);
    byParent.get(group.parentBranchId).push(group);
  }
  for (const [branchId, routeGroups] of byParent) {
    const parent = routePositions.get(branchId);
    if (!parent) continue;
    const sorted = sortForkPointsByFloor([...routeGroups]).filter((group) => hubPositions.has(group.id));
    let spineX = parent.x + parent.width / 2;
    let previousY = parent.y + cardHeight;
    for (const group of sorted) {
      const hub = hubPositions.get(group.id);
      const hubX = hub.x + hub.width / 2;
      const hubTop = hub.y;
      const bend = Math.max(22, Math.min(72, (hubTop - previousY) * 0.4));
      paths.push(`<path class="story-branch-tree__edge story-branch-tree__edge--spine" d="M ${spineX} ${previousY} C ${spineX} ${previousY + bend}, ${hubX} ${hubTop - bend}, ${hubX} ${hubTop}" />`);
      previousY = hub.y + hubHeight;
      spineX = hubX;
    }
    const end = endPositions.get(branchId);
    if (end) paths.push(`<path class="story-branch-tree__edge story-branch-tree__edge--spine" d="M ${spineX} ${previousY} C ${spineX} ${previousY + 36}, ${end.x + end.width / 2} ${end.y - 36}, ${end.x + end.width / 2} ${end.y}" />`);
  }
  for (const group of groups) {
    const hub = hubPositions.get(group.id);
    if (!hub) continue;
    const hubX = hub.x + hub.width / 2;
    for (const branch of group.children) {
      const child = routePositions.get(branch.id);
      if (!child) continue;
      const childX = child.x + child.width / 2;
      const childY = child.y;
      const splitY = hub.y + hubHeight / 2;
      const direction = Math.sign(childX - hubX) || 1;
      const reach = Math.max(38, Math.abs(childX - hubX) * 0.48);
      paths.push(`<path class="story-branch-tree__edge story-branch-tree__edge--branch${branch.kind === "swipe" ? " story-branch-tree__edge--swipe" : ""}" d="M ${hubX} ${splitY} C ${hubX + direction * reach} ${splitY}, ${childX - direction * reach} ${childY}, ${childX} ${childY}" />`);
    }
  }
  for (const [branchId, end] of endPositions) {
    if (byParent.has(branchId)) continue;
    const card = routePositions.get(branchId);
    if (!card) continue;
    const x = card.x + card.width / 2;
    paths.push(`<path class="story-branch-tree__edge story-branch-tree__edge--spine" d="M ${x} ${card.y + cardHeight} V ${end.y}" />`);
  }
  return paths.join("");
}

function positionRouteEnds(layout) {
  const endElements = new Map([...layout.world.querySelectorAll(".story-branch-tree__ending")].map((node) => [node.dataset.branchId, node]));
  const occupied = [
    ...layout.positions.values().map(({ x, y, width }) => ({ x, y, width, height: layout.cardHeight })),
    ...layout.hubPositions.values().map(({ x, y, width }) => ({ x, y, width, height: layout.hubHeight })),
  ];
  for (const [branchId, { x, y }] of layout.manualEnds) {
    const card = layout.positions.get(branchId);
    if (card) occupied.push({ x, y, width: Math.min(280, Math.max(220, card.width - 10)), height: 104 });
  }
  layout.endPositions.clear();
  for (const branch of [...layout.branches].sort((a, b) => b.depth - a.depth)) {
    const card = layout.positions.get(branch.id);
    const groups = sortForkPointsByFloor(layout.groups.filter((group) => group.parentBranchId === branch.id));
    const lastHub = groups.length ? layout.hubPositions.get(groups.at(-1).id) : null;
    if (!card) continue;
    const width = Math.min(280, Math.max(220, card.width - 10));
    const axis = lastHub ? lastHub.x + lastHub.width / 2 : card.x + card.width / 2;
    const manual = layout.manualEnds.get(branch.id);
    const x = manual?.x ?? axis - width / 2;
    let y = manual?.y ?? (lastHub ? lastHub.y + layout.hubHeight + 78 : card.y + layout.cardHeight + 72);
    if (!manual) {
      while (true) {
        const conflicts = occupied.filter((node) => x < node.x + node.width + 18 && x + width + 18 > node.x
          && y < node.y + node.height + 18 && y + 104 + 18 > node.y);
        if (!conflicts.length) break;
        y = Math.max(...conflicts.map((node) => node.y + node.height + 24));
      }
    }
    const ending = { x, y, width, height: 104 };
    layout.endPositions.set(branch.id, ending);
    occupied.push(ending);
    const element = endElements.get(branch.id);
    if (element) {
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
      element.style.width = `${width}px`;
    }
  }
}

function updateLayoutBounds(layout) {
  positionRouteEnds(layout);
  const nodes = [...layout.positions.values(), ...layout.hubPositions.values(), ...layout.endPositions.values()];
  const left = Math.min(0, ...nodes.map(({ x }) => x));
  const top = Math.min(0, ...nodes.map(({ y }) => y));
  const right = Math.max(layout.canvasWidth, ...nodes.map(({ x, width }) => x + width)) + 32;
  const bottom = Math.max(layout.cardHeight + 32, ...layout.positions.values().map(({ y }) => y + layout.cardHeight + 32), ...layout.endPositions.values().map(({ y, height }) => y + height + 32));
  layout.minX = left;
  layout.minY = top;
  layout.maxX = right;
  layout.maxY = bottom;
  layout.world.style.width = `${right}px`;
  layout.world.style.height = `${bottom}px`;
  const svg = layout.world.querySelector(".story-branch-tree__edges");
  svg.setAttribute("width", String(right));
  svg.setAttribute("height", String(bottom));
  svg.innerHTML = edgeMarkup(layout.groups, layout.positions, layout.hubPositions, layout.endPositions, layout.cardHeight, layout.hubHeight);
}

function messageContent(message) {
  const source = typeof message === "string" ? message : message?.mes;
  if (typeof source !== "string" || !source.trim()) return "";
  const parsed = new DOMParser().parseFromString(source, "text/html");
  parsed.querySelectorAll("status_bottom, tableedit, script, style").forEach((element) => element.remove());
  return (parsed.body.textContent ?? source)
    .replace(/^(?:\s*【[^】]{1,60}】)+/u, "")
    .replace(/\[忽视此条变化[^\]]*\]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function messageExcerpt(message, limit = 150) {
  const text = messageContent(message).replace(/\s+/gu, " ").trim();
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : text;
}

function renderCompactTree(root, tree, branches, groups, groupsByParent, branchEnds) {
  const world = root.querySelector('[data-role="world"]');
  const empty = root.querySelector('[data-role="empty"]');
  const canvas = root.querySelector('[data-role="canvas"]');
  const points = new Map();
  const leaves = new Map();
  const routes = [];
  const branchById = new Map(branches.map((branch) => [branch.id, branch]));
  const narrow = canvas.clientWidth < 700;
  const rowGap = narrow ? 170 : 192;
  const pointSize = 56;
  const rootBranch = branches.find((branch) => branch.id === tree.rootBranchId);
  if (!rootBranch || !groups.length && branches.length === 1) {
    empty.hidden = false;
    empty.textContent = "当前剧情树还没有分叉点。";
    world.replaceChildren();
    renderedLayout = null;
    return;
  }
  const roots = branches.filter(branch => !branch.parentBranchId);
  const columns = planTreeColumns(roots.map(branch => branch.id), groupsByParent, 220, narrow ? 38 : 46, narrow ? 44 : 56);
  const sortedGroups = columns.groupsFor;
  const routeStarts = new Map();
  const layoutRoute = (branchId, axis, top, depth, seen = new Set()) => {
    if (seen.has(branchId)) return top;
    const nextSeen = new Set(seen).add(branchId);
    routeStarts.set(branchId, { x: axis, y: top });
    let cursor = top + (depth === 0 ? 124 : 110);
    let subtreeBottom = top + 120;
    let lastPointY = null;
    const routeGroups = sortedGroups(branchId);
    routeGroups.forEach((group) => {
      const savedPoint = tree.compactLayout?.points?.[group.id];
      const useSavedPoint = Number.isFinite(savedPoint?.x) && Number.isFinite(savedPoint?.y)
        && savedPoint.orientation === "vertical-spine-v3" && savedPoint.narrow === narrow;
      points.set(group.id, { x: useSavedPoint ? savedPoint.x : axis - pointSize / 2, y: useSavedPoint ? savedPoint.y : cursor });
      lastPointY = points.get(group.id).y;
      const childTop = cursor + rowGap;
      let childBottom = childTop;
      group.children.forEach((child) => {
        const childAxis = columns.childAxis(group.id, child.id, axis);
        childBottom = Math.max(childBottom, layoutRoute(child.id, childAxis, childTop, depth + 1, nextSeen));
        const childGroups = sortedGroups(child.id);
        routes.push({ from: group.id, to: childGroups[0]?.id, leafBranchId: childGroups.length ? undefined : child.id, branchId: child.id, kind: "branch" });
      });
      subtreeBottom = Math.max(subtreeBottom, childBottom);
      cursor = Math.max(cursor + rowGap + 70, childBottom + 78);
    });
    const savedLeaf = tree.compactLayout?.leaves?.[branchId];
    const useSavedLeaf = Number.isFinite(savedLeaf?.x) && Number.isFinite(savedLeaf?.y)
      && savedLeaf.orientation === "vertical-spine-v3" && savedLeaf.narrow === narrow;
    leaves.set(branchId, { x: useSavedLeaf ? savedLeaf.x : axis - pointSize / 2, y: useSavedLeaf ? savedLeaf.y : (lastPointY === null ? top + 92 : lastPointY + 138) });
    return Math.max(subtreeBottom, leaves.get(branchId).y + 120);
  };
  const rootAxis = Math.max(columns.leftExtent + 40, canvas.clientWidth / 2);
  roots.forEach((branch, index) => layoutRoute(branch.id, rootAxis + index * (columns.leftExtent + columns.rightExtent + 100), 44, 0));
  const routeLaneMarkup = () => {
    const lanes = [];
    for (const [branchId, branchGroups] of groupsByParent) {
      const laneGroups = sortForkPointsByFloor([...branchGroups]).filter((group) => points.has(group.id));
      const branch = branchById.get(branchId);
      const leaf = leaves.get(branchId);
      if (!branch || !leaf) continue;
      if (!branch.parentBranchId) {
        const start = routeStarts.get(branchId);
        lanes.push(`<g class="story-branch-tree__compact-terminal"><circle cx="${start.x}" cy="${start.y}" r="26" /><text x="${start.x}" y="${start.y}">${branch.legacyParentUnavailable ? "来源缺失" : "起点"}</text></g>`);
      }
      const spineNodes = laneGroups.map((group) => points.get(group.id));
      if (!branch.parentBranchId) spineNodes.unshift({ x: routeStarts.get(branchId).x - pointSize / 2, y: routeStarts.get(branchId).y - pointSize / 2 });
      spineNodes.push(leaf);
      for (let index = 1; index < spineNodes.length; index += 1) {
        const from = spineNodes[index - 1];
        const to = spineNodes[index];
        const x1 = from.x + pointSize / 2;
        const x2 = to.x + pointSize / 2;
        const y1 = from.y + pointSize / 2;
        const y2 = to.y + pointSize / 2;
        lanes.push(`<path class="story-branch-tree__compact-lane" d="M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}" />`);
        if (!branch.parentBranchId && index === Math.min(2, spineNodes.length - 1)) {
          const labelX = (x1 + x2) / 2 + 12;
          const labelY = (y1 + y2) / 2 - 12;
          const rootLabel = roots.length > 1 ? `路线 ${branch.branchNumber}` : "主线";
          lanes.push(`<g class="story-branch-tree__compact-label-button" data-action="confirm-branch-switch" data-branch-id="${escapeAttribute(branchId)}" role="button" tabindex="0" aria-current="${branchId === tree.activeBranchId}" aria-label="切换到${escapeAttribute(rootLabel)}"><rect class="story-branch-tree__compact-label-bg" x="${labelX}" y="${labelY}" width="70" height="24" rx="8" /><text class="story-branch-tree__compact-label" x="${labelX + 35}" y="${labelY + 12}">${escapeHtml(rootLabel)}</text><title>点击切换到${escapeHtml(rootLabel)}</title></g>`);
        }
      }
      const tail = branchEnds.get(branchId);
      const tailSummary = tail?.summary || "无摘要";
      const excerpt = Array.from(tailSummary);
      const tailText = excerpt.length > 38 ? `${excerpt.slice(0, 37).join("")}…` : tailSummary;
      const line1 = Array.from(tailText).slice(0, 19).join("");
      const line2 = Array.from(tailText).slice(19).join("");
      const centerX = leaf.x + pointSize / 2;
      const tailWidth = 220;
      const textX = centerX - tailWidth / 2 + 13;
      lanes.push(`<g class="story-branch-tree__compact-tail" data-action="show-end" data-branch-id="${escapeAttribute(branchId)}" role="button" tabindex="0" aria-label="查看第 ${tail?.floor ?? "—"} 楼终点内容"><circle cx="${centerX}" cy="${leaf.y + pointSize / 2}" r="5" /><rect x="${centerX - tailWidth / 2}" y="${leaf.y + 35}" width="${tailWidth}" height="70" rx="11" /><text x="${textX}" y="${leaf.y + 54}"><tspan class="story-branch-tree__compact-tail-floor">终点 · 第 ${tail?.floor ?? "—"} 楼</tspan><tspan class="story-branch-tree__compact-tail-summary" x="${textX}" dy="18">${escapeHtml(line1)}</tspan><tspan class="story-branch-tree__compact-tail-summary" x="${textX}" dy="16">${escapeHtml(line2)}</tspan></text><title>点击查看末楼内容，触屏长按拖动</title></g>`);
    }
    return lanes.join("");
  };
  const rebuildEdges = () => routeLaneMarkup() + routes.map((route) => {
    const from = points.get(route.from);
    const to = route.to ? points.get(route.to) : leaves.get(route.leafBranchId);
    const branch = branchById.get(route.branchId);
    if (!from || !to || !branch) return "";
    const startX = from.x + pointSize / 2;
    const startY = from.y + pointSize / 2;
    const endX = to.x + pointSize / 2;
    const endY = to.y + pointSize / 2;
    const direction = Math.sign(endX - startX) || 1;
    const reach = Math.max(42, Math.abs(endX - startX) * 0.45);
    const path = `M ${startX} ${startY} C ${startX + direction * reach} ${startY}, ${endX - direction * reach} ${endY}, ${endX} ${endY}`;
    const fullName = branch.kind === "swipe"
      ? `第 ${branch.displayForkIndex + 1} 楼${branch.sourceVariantPresent ? "回复" : "原回复"} ${Number.isInteger(branch.replyIndex) ? branch.replyIndex + 1 : "另一版"} · ${branch.title}`
      : branch.title;
    const label = Array.from(fullName).length > 14 ? `${Array.from(fullName).slice(0, 13).join("")}…` : fullName;
    const labelWidth = Math.min(150, Math.max(58, Array.from(label).length * 10 + 18));
    const labelX = (startX + endX) / 2 - labelWidth / 2;
    const labelCenterX = labelX + labelWidth / 2;
    const labelY = (startY + endY) / 2 - 12;
    const targetAttributes = route.to
      ? `data-target-fork-id="${escapeAttribute(route.to)}"`
      : `data-leaf-branch-id="${escapeAttribute(route.leafBranchId)}"`;
    return `<g class="story-branch-tree__compact-route" data-action="edit-branch-note" data-branch-id="${escapeAttribute(branch.id)}" data-kind="${branch.kind}" ${targetAttributes}>
      <path class="story-branch-tree__edge story-branch-tree__compact-edge" d="${path}" />
      <path class="story-branch-tree__compact-hit-area" d="${path}" vector-effect="non-scaling-stroke" />
      <g class="story-branch-tree__compact-label-button" data-action="confirm-branch-switch" data-branch-id="${escapeAttribute(branch.id)}" role="button" tabindex="0" aria-current="${branch.id === tree.activeBranchId}" aria-label="切换到路线 ${escapeAttribute(branch.branchNumber)}：${escapeAttribute(fullName)}"><rect class="story-branch-tree__compact-label-bg" x="${labelX}" y="${labelY}" width="${labelWidth}" height="24" rx="8" /><text class="story-branch-tree__compact-label" x="${labelCenterX}" y="${labelY + 12}">${escapeHtml(label)}</text></g>
      <title>${escapeHtml(`${fullName}；点击路线名可切换，点击线条查看详情，触屏长按线条拖动`)}</title>
    </g>`;
  }).join("");
  const allPoints = [...points.values(), ...leaves.values()];
  const minX = Math.min(0, ...points.values().map((point) => point.x), ...leaves.values().map((point) => point.x - 82));
  const minY = Math.min(0, ...allPoints.map((point) => point.y - pointSize / 2));
  const maxX = Math.max(canvas.clientWidth, ...[...points.values(), ...leaves.values()].map((point) => point.x + 220)) + 24;
  const maxY = Math.max(canvas.clientHeight, ...[...points.values()].map((point) => point.y + pointSize), ...[...leaves.values()].map((point) => point.y + 120)) + 24;
  const hubs = groups.map((group) => {
    const position = points.get(group.id);
    if (!position) return "";
    const { floor, name, replyLabel } = forkPointText(tree, group);
    const branchId = group.children[0]?.id;
    const disabled = state.busy || isGenerating();
    const glyph = group.kind === "swipe"
      ? `<span class="story-branch-tree__reply-glyph" aria-hidden="true"><strong>${floor}</strong><small>${escapeHtml(replyLabel)}</small></span>`
      : `<svg viewBox="0 0 48 48" aria-hidden="true"><text x="24" y="24">${floor}</text></svg>`;
    return `<div class="story-branch-tree__compact-point" data-fork-id="${escapeAttribute(group.id)}" data-kind="${group.kind}" style="left:${position.x}px;top:${position.y}px"><button class="story-branch-tree__fork-point" data-action="edit-node-note" data-branch-id="${escapeAttribute(branchId)}" type="button" ${disabled ? "disabled" : ""} aria-label="查看和编辑第 ${floor} 楼${group.kind === "swipe" ? "重说回复组" : "分叉点"}：${escapeAttribute(name)}" title="${escapeAttribute(`${name}；点击查看摘要和备注，长按拖动`)}">${glyph}</button></div>`;
  }).join("");
  world.style.width = `${maxX}px`;
  world.style.height = `${maxY}px`;
  world.innerHTML = `<svg class="story-branch-tree__edges is-compact" width="${maxX}" height="${maxY}" aria-label="剧情路线和终点">${rebuildEdges()}</svg>${hubs}`;
  const svg = world.querySelector(".story-branch-tree__edges");
  renderedLayout = { compact: true, branches, groups, hubPositions: points, positions: new Map(), leaves, routes, world, narrow, compactPointSize: pointSize, minX, minY, maxX, maxY, canvasWidth: canvas.clientWidth, updateCompactEdges: () => {
    const nodes = [...points.values(), ...leaves.values()];
    renderedLayout.minX = Math.min(0, ...points.values().map((point) => point.x), ...leaves.values().map((point) => point.x - 82));
    renderedLayout.minY = Math.min(0, ...nodes.map((point) => point.y - pointSize / 2));
    renderedLayout.maxX = Math.max(canvas.clientWidth, ...nodes.map((point) => point.x + 220)) + 24;
    renderedLayout.maxY = Math.max(canvas.clientHeight, ...points.values().map((point) => point.y + pointSize), ...leaves.values().map((point) => point.y + 120)) + 24;
    world.style.width = `${renderedLayout.maxX}px`;
    world.style.height = `${renderedLayout.maxY}px`;
    svg.setAttribute("width", String(renderedLayout.maxX));
    svg.setAttribute("height", String(renderedLayout.maxY));
    svg.innerHTML = rebuildEdges();
  } };
  empty.hidden = true;
  if (view.needsFit) fitView();
  else applyView();
}

function renderTree() {
  const root = document.getElementById("story-branch-tree");
  if (!root) return;
  const ctx = context();
  const focusButton = root.querySelector('[data-action="focus-current"]');
  if (focusButton) focusButton.disabled = !isSoloChat(ctx) || !graphFrom(ctx);
  const status = root.querySelector('[data-role="status"]');
  const world = root.querySelector('[data-role="world"]');
  const empty = root.querySelector('[data-role="empty"]');
  if (!isSoloChat(ctx)) {
    status.textContent = "仅支持单人角色聊天；群聊中不会修改消息或保存剧情树。";
    world.replaceChildren();
    empty.hidden = false;
    empty.textContent = status.textContent;
    return;
  }
  let tree = graphFrom(ctx);
  if (!tree) {
    status.textContent = "当前聊天还没有分支。点击任意消息旁的“分支”即可开始。";
    world.replaceChildren();
    empty.hidden = false;
    empty.textContent = status.textContent;
    return;
  }
  try {
    const branches = getStoryBranchRows(tree);
    const current = tree.branches[tree.activeBranchId];
    if (focusButton && current.pendingSwipe) focusButton.disabled = true;
    const branchNumbers = new Map(branches.map((branch) => [branch.id, branch.branchNumber]));
    const currentTitle = branches.find((branch) => branch.id === current.id)?.title ?? current.title;
    status.textContent = current.pendingSwipe
      ? `第 ${current.sourceSwipeIndex + 1} 个回复待续 · 发送下一楼后加入剧情树 · ${branches.length} 条路线`
      : `当前路线：${branchNumbers.get(current.id) ?? "1"} · ${currentTitle} · ${branches.length} 条路线`;
    if (tree.storageMode === "native") status.textContent = "原生分支 · " + status.textContent;
    const groups = groupForkPoints(branches);
    if (focusButton && compactView) focusButton.disabled = current.pendingSwipe || groups.length === 0;
    const branchEnds = new Map(branches.map((branch) => {
      if (tree.storageMode === "native") return [branch.id, { floor: branch.endFloor, summary: branch.endSummary ?? "" }];
      const lastId = branch.messageIds.at(-1);
      const last = lastId ? tree.messages[lastId] : branch.forkSnapshot;
      const floor = branch.parentBranchId ? branch.forkIndex + 1 + branch.messageIds.length : branch.messageIds.length;
      return [branch.id, { floor: floor || null, summary: messageExcerpt(last) }];
    }));
    const groupsByParent = new Map(branches.map((branch) => [branch.id, []]));
    for (const group of groups) groupsByParent.get(group.parentBranchId)?.push(group);
    if (compactView) {
      root.classList.add("is-compact");
      renderCompactTree(root, tree, branches, groups, groupsByParent, branchEnds);
      return;
    }
    root.classList.remove("is-compact");
    const positions = new Map();
    const hubPositions = new Map();
    const canvas = root.querySelector('[data-role="canvas"]');
    const narrow = canvas.clientWidth < 700;
    const cardWidth = narrow ? Math.max(220, Math.min(310, canvas.clientWidth - 24)) : 310;
    const cardHeight = 204;
    const hubHeight = 88;
    const rootBranch = branches.find((branch) => branch.id === tree.rootBranchId);
    if (!rootBranch) throw new Error("剧情树缺少主线。");
    const roots = branches.filter(branch => !branch.parentBranchId);
    const columns = planTreeColumns(roots.map(branch => branch.id), groupsByParent, cardWidth, narrow ? 72 : 108, narrow ? 72 : 108);
    const hubWidth = 76;
    const rootAxis = Math.max(columns.leftExtent + 40, canvas.clientWidth / 2);
    const placeRoute = (branch, axis, top, seen = new Set()) => {
      if (seen.has(branch.id)) return top + cardHeight;
      const nextSeen = new Set(seen).add(branch.id);
      positions.set(branch.id, { x: axis - cardWidth / 2, y: top, width: cardWidth });
      let cursor = top + cardHeight + 92;
      let subtreeBottom = top + cardHeight + 72 + 104;
      let lastHubY = null;
      const routeGroups = columns.groupsFor(branch.id);
      routeGroups.forEach((group) => {
        hubPositions.set(group.id, { x: axis - hubWidth / 2, y: cursor, width: hubWidth, hubHeight });
        lastHubY = cursor;
        const childTop = cursor + hubHeight + 112;
        let childBottom = childTop;
        group.children.forEach((child) => {
          const childAxis = columns.childAxis(group.id, child.id, axis);
          childBottom = Math.max(childBottom, placeRoute(child, childAxis, childTop, nextSeen));
        });
        subtreeBottom = Math.max(subtreeBottom, childBottom);
        cursor = Math.max(cursor + hubHeight + 178, childBottom + 90);
      });
      if (lastHubY !== null) subtreeBottom = Math.max(subtreeBottom, lastHubY + hubHeight + 78 + 104);
      return subtreeBottom;
    };
    roots.forEach((branch, index) => placeRoute(branch, rootAxis + index * (columns.leftExtent + columns.rightExtent + 100), 32));
    for (const branch of branches) {
      const saved = tree.layout?.[branch.id];
      const position = positions.get(branch.id);
      if (!narrow && position && saved?.layoutVersion === 4 && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        position.x = saved.x;
        position.y = saved.y;
      }
    }
    for (const group of groups) {
      const saved = tree.layout?.[group.id];
      const position = hubPositions.get(group.id);
      if (position && saved?.layoutVersion === 4 && saved.kind === "fork" && saved.narrow === narrow && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        position.x = saved.x;
        position.y = saved.y;
      }
    }
    const maxX = Math.max(canvas.clientWidth, ...[...positions.values(), ...hubPositions.values()].map(({ x, width }) => x + width)) + 50;
    const maxY = Math.max(canvas.clientHeight, ...[...positions.values()].map(({ y }) => y + cardHeight + 30), ...[...hubPositions.values()].map(({ y }) => y + hubHeight + 30));
    const cards = branches.map((branch) => {
      const position = positions.get(branch.id);
      const active = branch.id === tree.activeBranchId;
      const disabled = state.busy || isGenerating();
      const forkPointName = branch.parentBranchId
        ? (tree.nodeNames?.[branch.nodeKey] ?? tree.nodeNames?.[branch.kind === "continuation" ? branch.forkMessageId : null])?.trim()
          || (branch.legacyForkUnknown ? "分叉位置未知" : `第 ${branch.displayForkIndex + 1} 楼${branch.kind === "swipe" ? "回复选择" : "分叉点"}`)
        : branch.legacyParentUnavailable ? `来源未找到：${branch.legacyParentName}` : "剧情起点";
      const nextFloor = branch.parentBranchId && !branch.legacyForkUnknown && Number.isInteger(branch.forkIndex) ? branch.forkIndex + 2 : null;
      const summaryLabel = nextFloor === null ? branch.legacyParentUnavailable ? "现存路线" : branch.legacyForkUnknown ? "旧分支 · 位置未知" : "主线" : branch.kind === "swipe"
        ? `第 ${nextFloor} 楼 · ${branch.sourceVariantPresent ? "回复" : "原回复"} ${Number.isInteger(branch.replyIndex) ? branch.replyIndex + 1 : "另一版"}`
        : `第 ${nextFloor} 楼 · 分支摘要`;
      const nextMessage = branch.messageIds.length ? tree.messages[branch.messageIds[0]] : null;
      const summaryText = branch.parentBranchId
        ? branch.summary?.trim() || (tree.storageMode === "native" ? branch.endSummary : messageExcerpt(nextMessage)) || (branch.messageIds.length ? "无摘要" : "该楼层还未出现 · 无摘要")
        : branch.legacyParentUnavailable ? branch.endSummary || "现存路线" : "主线";
      return `<article class="story-branch-tree__card${narrow ? " is-narrow" : ""}" data-branch-id="${escapeAttribute(branch.id)}" data-kind="${branch.kind}" style="left:${position.x}px;top:${position.y}px;width:${position.width}px" aria-current="${active}">
        <div class="story-branch-tree__card-heading">
          <button class="story-branch-tree__route-button" data-action="confirm-branch-switch" data-branch-id="${escapeAttribute(branch.id)}" type="button" ${(active && !isMemoryBlocked(ctx)) || disabled ? "disabled" : ""} title="切换到路线 ${escapeAttribute(branch.branchNumber)}：${escapeAttribute(branch.title)}"><span class="story-branch-tree__route-number">${branch.kind === "swipe" ? "重说" : "路线"} ${escapeHtml(branch.branchNumber)}</span> ${escapeHtml(branch.title)}</button>
          ${branch.parentBranchId ? `<button class="story-branch-tree__note-button" data-action="edit-branch-note" data-branch-id="${escapeAttribute(branch.id)}" type="button" ${disabled ? "disabled" : ""}>分支详情</button>` : ""}
        </div>
        <div class="story-branch-tree__route-fork">${branch.kind === "swipe" ? "回复组" : "分叉点"}：${escapeHtml(forkPointName)}</div>
        <div class="story-branch-tree__route-summary"><strong>${escapeHtml(summaryLabel)}</strong><p>${escapeHtml(summaryText)}</p></div>
        ${branch.note ? `<p class="story-branch-tree__branch-note">备注：${escapeHtml(branch.note)}</p>` : ""}
      </article>`;
    }).join("");
    const hubs = groups.map((group) => {
      const position = hubPositions.get(group.id);
      const { floor: forkFloor, name: pointName, summary: pointSummary, replyLabel } = forkPointText(tree, group);
      const branchId = group.children[0]?.id;
      const disabled = state.busy || isGenerating();
      const glyph = group.kind === "swipe"
        ? `<span class="story-branch-tree__reply-glyph" aria-hidden="true"><strong>${forkFloor}</strong><small>${escapeHtml(replyLabel)}</small></span>`
        : `<svg viewBox="0 0 48 48" aria-hidden="true"><text x="24" y="24">${forkFloor}</text></svg>`;
      return `<article class="story-branch-tree__fork-hub" data-fork-id="${escapeAttribute(group.id)}" data-kind="${group.kind}" style="left:${position.x}px;top:${position.y}px;width:${position.width}px;height:${hubHeight}px">
        <button class="story-branch-tree__fork-point" data-action="edit-node-note" data-branch-id="${escapeAttribute(branchId)}" type="button" ${disabled ? "disabled" : ""} aria-label="查看和编辑第 ${forkFloor} 楼${group.kind === "swipe" ? "重说回复组" : "分叉点"}：${escapeAttribute(pointName)}" title="${escapeAttribute(`${pointName}：${pointSummary}；鼠标拖动，触屏长按后拖动，点击编辑`)}">
          ${glyph}
        </button>
        ${group.kind === "swipe" || group.unknown ? "" : `<button class="story-branch-tree__fork-create" data-action="return-to-node" data-branch-id="${escapeAttribute(branchId)}" type="button" ${disabled ? "disabled" : ""} aria-label="从第 ${forkFloor} 楼分叉点继续" title="从此处分支">＋</button>`}
      </article>`;
    }).join("");
    const endings = branches.map((branch) => {
      const tail = branchEnds.get(branch.id);
      const heading = `终点 · 第 ${tail?.floor ?? "—"} 楼`;
      return `<button class="story-branch-tree__ending" data-action="show-end" data-branch-id="${escapeAttribute(branch.id)}" type="button" style="left:0;top:0" aria-current="${branch.id === tree.activeBranchId}" aria-label="查看${escapeAttribute(heading)}的内容" title="点击查看末楼内容，触屏长按拖动">
        <span class="story-branch-tree__ending-heading"><span class="story-branch-tree__ending-mark" aria-hidden="true"></span>${escapeHtml(heading)}<small>${escapeHtml(branch.title)}</small></span>
        <span class="story-branch-tree__ending-content">${escapeHtml(tail?.summary || "无摘要")}</span>
      </button>`;
    }).join("");
    world.style.width = `${maxX}px`;
    world.style.height = `${maxY}px`;
    world.innerHTML = `<svg class="story-branch-tree__edges" width="${maxX}" height="${maxY}" aria-hidden="true"></svg>${cards}${hubs}${endings}`;
    const manualEnds = new Map(branches.flatMap((branch) => {
      const saved = tree.layout?.[`end:${branch.id}`];
      return saved?.kind === "end" && saved.layoutVersion === 4 && saved.narrow === narrow && Number.isFinite(saved.x) && Number.isFinite(saved.y)
        ? [[branch.id, { x: saved.x, y: saved.y }]] : [];
    }));
    renderedLayout = { branches, groups, positions, hubPositions, endPositions: new Map(), manualEnds, narrow, cardHeight, hubHeight, world, canvasWidth: canvas.clientWidth };
    updateLayoutBounds(renderedLayout);
    empty.hidden = true;
    if (view.needsFit) fitView();
    else applyView();
  } catch (error) {
    status.textContent = error.message;
    world.replaceChildren();
    empty.hidden = false;
    empty.textContent = error.message;
  }
}

function applyView() {
  const world = document.querySelector('#story-branch-tree [data-role="world"]');
  const level = document.querySelector('#story-branch-tree [data-role="zoom-level"]');
  if (world) world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  if (level) level.textContent = `${view.scale < 0.01 ? Number((view.scale * 100).toPrecision(2)) : Math.round(view.scale * 100)}%`;
}

function fitView() {
  const canvas = document.querySelector('#story-branch-tree [data-role="canvas"]');
  const world = document.querySelector('#story-branch-tree [data-role="world"]');
  if (!canvas || !world) return;
  const layout = renderedLayout;
  const minX = layout?.minX ?? 0;
  const minY = layout?.minY ?? 0;
  const worldRight = layout?.maxX || Number.parseFloat(world.style.width) || canvas.clientWidth;
  const worldWidth = Math.max(1, worldRight - minX);
  const worldBottom = layout?.maxY || Number.parseFloat(world.style.height) || canvas.clientHeight;
  const worldHeight = Math.max(1, worldBottom - minY);
  const heightFit = Math.max(1, canvas.clientHeight - 40) / worldHeight;
  if (canvas.clientWidth < 700) {
    view.scale = clampViewScale(Math.min(0.85, Math.max(1, canvas.clientWidth - 32) / worldWidth, heightFit));
    view.x = (canvas.clientWidth - worldWidth * view.scale) / 2 - minX * view.scale;
    view.y = 20 - minY * view.scale;
  } else {
    view.scale = clampViewScale(Math.min(1, Math.max(1, canvas.clientWidth - 64) / worldWidth, heightFit));
    view.x = (canvas.clientWidth - worldWidth * view.scale) / 2 - minX * view.scale;
    view.y = 24 - minY * view.scale;
  }
  view.needsFit = false;
  applyView();
}

function focusCurrentBranch() {
  const ctx = context();
  if (!isSoloChat(ctx)) throw new Error("只支持单人角色聊天。");
  const tree = graphFrom(ctx);
  if (!tree) throw new Error("当前聊天还没有剧情树。");
  validateStoryTree(tree);
  const canvas = document.querySelector('#story-branch-tree [data-role="canvas"]');
  const layout = renderedLayout;
  if (!canvas || !layout) throw new Error("当前视图没有可定位的路线。");
  const branchId = tree.activeBranchId;
  let centerX;
  let centerY;
  if (layout.compact) {
    const label = layout.world.querySelector(`.story-branch-tree__compact-label-button[data-branch-id="${CSS.escape(branchId)}"]`);
    if (label) {
      const bounds = label.getBBox();
      centerX = bounds.x + bounds.width / 2;
      centerY = bounds.y + bounds.height / 2;
    } else {
      const leaf = layout.leaves.get(branchId);
      if (!leaf) throw new Error("找不到当前路线的位置。");
      centerX = leaf.x + layout.compactPointSize / 2;
      centerY = leaf.y + layout.compactPointSize / 2;
    }
    view.scale = Math.min(1.25, Math.max(1, view.scale));
  } else {
    const card = layout.positions.get(branchId);
    if (!card) throw new Error("找不到当前路线的位置。");
    centerX = card.x + card.width / 2;
    centerY = card.y + layout.cardHeight / 2;
    view.scale = Math.min(1, Math.max(0.9, view.scale));
  }
  view.x = canvas.clientWidth / 2 - centerX * view.scale;
  view.y = canvas.clientHeight / 2 - centerY * view.scale;
  view.needsFit = false;
  applyView();
}

function clampViewScale(nextScale) {
  // Keep transforms finite; this range also fits trees far larger than the viewport.
  return Number.isFinite(nextScale) ? Math.max(0.000001, Math.min(64, nextScale)) : view.scale;
}

function zoomAt(nextScale, clientX, clientY) {
  const canvas = document.querySelector('#story-branch-tree [data-role="canvas"]');
  if (!canvas) return;
  const bounds = canvas.getBoundingClientRect();
  const px = clientX === undefined ? canvas.clientWidth / 2 : clientX - bounds.left;
  const py = clientY === undefined ? canvas.clientHeight / 2 : clientY - bounds.top;
  const worldX = (px - view.x) / view.scale;
  const worldY = (py - view.y) / view.scale;
  view.scale = clampViewScale(nextScale);
  view.x = px - worldX * view.scale;
  view.y = py - worldY * view.scale;
  applyView();
}

function startPinchGesture(canvas) {
  const points = [...activeTouchPointers.entries()].slice(0, 2);
  if (points.length < 2) return false;
  const [[firstId, first], [secondId, second]] = points;
  const bounds = canvas.getBoundingClientRect();
  const midpointX = (first.x + second.x) / 2 - bounds.left;
  const midpointY = (first.y + second.y) / 2 - bounds.top;
  pinchGesture = {
    pointerIds: [firstId, secondId],
    startDistance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    startScale: view.scale,
    worldX: (midpointX - view.x) / view.scale,
    worldY: (midpointY - view.y) / view.scale,
  };
  if (cardPointer) {
    clearTimeout(cardPointer.timer);
    cardPointer.moved = true;
    if (cardPointer.kind === "compact-tail" || cardPointer.kind === "ending") cardPointer.mode = "ending";
    else if (cardPointer.kind === "compact-route") cardPointer.mode = "compact-route";
    else if (cardPointer.kind === "fork" || cardPointer.kind === "compact-fork") cardPointer.mode = "fork";
    else cardPointer.mode = "card";
  }
  view.dragging = false;
  view.pointerId = null;
  canvas.classList.remove("is-dragging");
  return true;
}

function updatePinchGesture(canvas) {
  if (!pinchGesture) return;
  const [first, second] = pinchGesture.pointerIds.map((id) => activeTouchPointers.get(id));
  if (!first || !second) return;
  const bounds = canvas.getBoundingClientRect();
  const midpointX = (first.x + second.x) / 2 - bounds.left;
  const midpointY = (first.y + second.y) / 2 - bounds.top;
  const distance = Math.hypot(second.x - first.x, second.y - first.y);
  view.scale = clampViewScale(pinchGesture.startScale * distance / pinchGesture.startDistance);
  view.x = midpointX - pinchGesture.worldX * view.scale;
  view.y = midpointY - pinchGesture.worldY * view.scale;
  applyView();
}

function requestStoryMode(action) {
  const ctx = context();
  if (storyMode(ctx)) return false;
  pendingModeAction = { chat: ctx.chat, chatId: ctx.chatId, characterId: ctx.characterId, action };
  openTree();
  return true;
}

async function chooseStoryMode(mode) {
  const ctx = context();
  const owner = { chat: ctx.chat, chatId: ctx.chatId, characterId: ctx.characterId };
  const request = pendingModeAction;
  if (state.busy || isGenerating()) throw Error("请等待当前操作结束。");
  if (request && (ctx.chat !== request.chat || ctx.chatId !== request.chatId || ctx.characterId !== request.characterId)) throw Error("聊天已改变，请重新选择故事模式。");
  if (storyMode(ctx)) throw Error("当前故事的模式已经固定。");
  if (mode === "native") await runNative(() => nativeStorage.initialize());
  else {
    ctx.updateChatMetadata({ [MODE_KEY]: "single" });
    await ctx.saveChat();
  }
  const current = context();
  if (current.chat !== owner.chat || current.chatId !== owner.chatId || current.characterId !== owner.characterId) throw Error("聊天已改变，旧故事模式已保存，请重新打开当前故事。");
  pendingModeAction = null;
  await connectMemoryEnhancement();
  document.querySelector('#story-branch-tree [data-role="mode-picker"]').hidden = true;
  refreshUi();
  request?.action?.();
}

async function openStoryLibrary(rebuild = false) {
  if (state.busy || isGenerating()) throw Error("请等待当前操作结束。");
  const ctx = context();
  if (!isSoloChat(ctx)) throw Error("请先打开单人角色聊天。");
  legacySearch?.abort();
  legacyPlan = null;
  libraryEntries = await nativeStorage.listStories({ rebuild });
  openTree();
  const root = document.getElementById("story-branch-tree");
  root.classList.add("is-library");
  root.querySelector('[data-role="status"]').textContent = `故事与聊天 · ${libraryEntries.length} 项`;
  root.querySelector('[data-role="mode-picker"]').hidden = true;
  root.querySelector('[data-role="canvas"]').hidden = true;
  const library = root.querySelector('[data-role="story-library"]');
  library.hidden = false;
  library.innerHTML = `<p>同一原生故事归为一项。“查找整个故事”可从当前聊天找回旧原生分支；“重建分组”恢复已有故事标记的记录。</p><div class="story-branch-tree__library-tools">${storyMode(ctx) !== "single" ? '<button data-action="legacy-find">从当前聊天查找整个故事</button>' : ""}<button data-action="library-rebuild">重建分组</button><button data-action="library-original">查看原始记录</button><button data-action="import-story">导入故事</button>${storyMode(ctx) === "native" ? '<button data-action="export-route">导出当前路线</button>' : ""}</div>`
    + libraryEntries.map((entry, index) => `<article class="story-branch-tree__library-entry"><h3>${escapeHtml(entry.title)}</h3><p>${entry.routes.length} 条${entry.storyId ? "原生路线" : "聊天记录"}</p><div><button data-action="library-open" data-entry="${index}">继续</button>${entry.storyId ? `<button data-action="library-routes" data-entry="${index}">查看路线</button><button data-action="library-export" data-entry="${index}">导出故事</button><button data-action="library-delete" data-entry="${index}">删除故事</button>` : ""}</div><div data-role="library-routes" hidden>${entry.routes.map(route => `<button data-action="library-chat" data-chat-name="${escapeAttribute(route.chatName)}">${escapeHtml(route.title)}</button>`).join("")}</div></article>`).join("");
}

async function findLegacyStory() {
  await openStoryLibrary();
  const controller = legacySearch = new AbortController();
  const library = document.querySelector('#story-branch-tree [data-role="story-library"]');
  library.innerHTML = '<h3>查找整个故事</h3><p data-role="legacy-progress" aria-live="polite">正在查找…</p><button data-action="legacy-cancel">取消查找</button>';
  const progress = text => { const el = library.querySelector('[data-role="legacy-progress"]'); if (el) el.textContent = text; };
  try {
    const plan = await runNative(() => nativeStorage.discoverLegacyStory({ signal: controller.signal, onProgress: progress }));
    if (controller.signal.aborted) return;
    legacyPlan = plan;
    document.querySelector('#story-branch-tree [data-role="status"]').textContent = "旧原生分支 · 整理预览";
    const usable = plan.rows.filter(row => !row.blocked).length;
    const alreadyGrouped = !plan.rows.some(row => !row.blocked && !row.existing);
    library.innerHTML = `<h3>找到 ${usable} 条可整理记录</h3><p>故事：${escapeHtml(plan.title)}</p><p>核对后选择要归组的记录。各聊天文件和记忆仍分别保留；不会补回过去未保存的记忆。</p>`
      + (plan.missing.length ? `<p>未找到来源聊天：${plan.missing.map(escapeHtml).join("、")}。可以整理现存分支，无法恢复已删正文。</p>` : "")
      + plan.rows.map(row => `<label class="story-branch-tree__legacy-row"><input type="checkbox" data-role="legacy-choice" value="${escapeAttribute(row.chatName)}" ${!row.blocked && (!row.checkpoint || row.chatName === context().chatId || row.existing) ? "checked" : ""} ${row.blocked || row.existing || row.chatName === context().chatId ? "disabled" : ""}><span><strong>${escapeHtml(row.chatName)}</strong><small>${escapeHtml(row.blocked || `${row.messageCount} 楼 · ${row.existing ? "已归组" : row.checkpoint ? "原生检查点（可选）" : row.parentName ? `来源：${row.parentName} · ${row.floor ? `第 ${row.floor} 楼分叉` : "分叉位置未知"}` : "来源起点"}`)}</small></span></label>`).join("")
      + `<p data-role="legacy-progress" aria-live="polite">${usable < 2 ? "没有找到其他可归组记录。若文件改名或来源关联丢失，目前无法自动找全。" : alreadyGrouped ? "这些记录已归为同一故事，无需重复整理。" : "只按明确来源关联查找，不根据相似名称收录聊天。"}</p><div class="story-branch-tree__library-tools"><button data-action="legacy-accept" ${usable < 2 || alreadyGrouped ? "disabled" : ""}>整理所选记录</button><button data-action="legacy-cancel">返回列表</button></div>`;
  } catch (error) {
    if (!controller.signal.aborted) { progress(error.message); throw error; }
    progress("已取消查找，未整理任何记录。");
    const back = library.querySelector('[data-action="legacy-cancel"]'); if (back) back.textContent = "返回列表";
  } finally { if (legacySearch === controller) legacySearch = null; }
}

async function openLibraryChat(chatName) {
  const owner = { chatId: context().chatId, characterId: context().characterId };
  await runNative(async () => {
    if (storyMode(context()) === "native") {
      const target = Object.values(nativeStorage.view().branches).find(route => route.chatName === chatName);
      if (target) { await nativeStorage.switchRoute(target.id); return; }
    }
    await context().saveChat();
    if (context().chatId !== owner.chatId || context().characterId !== owner.characterId) throw Error("聊天已改变，请重新打开列表。");
    // Crossing stories is an ordinary chat load; its normal listeners may
    // start work once the host has loaded the target chat.
    state.routeSwitching = false;
    await context().openCharacterChat(chatName);
    if (context().chatMetadata[NATIVE_KEY]) nativeStorage.syncCurrent();
  });
  closeTree();
}

function downloadStory(data, filename, type = "application/json") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function exportNativeStory(all = true, storyId) {
  await runNative(async () => {
    const bundle = await nativeStorage.exportStory(all, storyId);
    const filename = String(bundle.title).replace(/[<>:"/\\|?*]/g, "_");
    const records = bundle.chats[0].records;
    if (!all) {
      delete records[0].chat_metadata[NATIVE_KEY];
      delete records[0].chat_metadata.main_chat;
    }
    downloadStory(all ? JSON.stringify(bundle) : records.map(record => JSON.stringify(record)).join("\n"),
      `${filename}${all ? ".story.json" : ".jsonl"}`, all ? "application/json" : "application/jsonl");
  });
}

function showNativeReply(index, swipeId) {
  const ctx = context();
  const message = ctx.chat[index];
  if (!canForkCurrentSwipe(message) || typeof message.swipes[swipeId] !== "string") throw Error("重说回复不存在。");
  nativePreview = { chat: ctx.chat, chatId: ctx.chatId, message, index, swipeId,
    variantId: replyVersionId(message, swipeId), text: swipeId === (message.swipe_id ?? 0) ? message.mes : message.swipes[swipeId] };
  const detail = document.querySelector('#story-branch-tree [data-role="floor-detail"]');
  openTree();
  detail.querySelector('[data-role="floor-title"]').textContent = `第 ${index + 1} 楼 · 回复 ${swipeId + 1}/${message.swipes.length}（预览）`;
  detail.querySelector('[data-role="floor-content"]').textContent = nativePreview.text;
  const routes = nativeStorage.replyRoutes(index, swipeId);
  detail.querySelector('[data-role="reply-actions"]').innerHTML = `<button data-action="reply-previous">上一回复</button><button data-action="reply-next">下一回复</button><button data-action="reply-create">新建路线并继续</button>`
    + routes.map(entry => `<button data-action="reply-existing" data-branch-id="${escapeAttribute(entry.route.id)}">继续：${escapeHtml(entry.route.title)}</button>`).join("");
  detail.hidden = false;
}

function checkedNativePreview() {
  const ctx = context();
  const preview = nativePreview;
  if (!preview || ctx.chat !== preview.chat || ctx.chatId !== preview.chatId || ctx.chat[preview.index] !== preview.message
    || replyVersionId(preview.message, preview.swipeId) !== preview.variantId
    || (preview.swipeId === (preview.message.swipe_id ?? 0) ? preview.message.mes : preview.message.swipes[preview.swipeId]) !== preview.text) throw Error("预览回复已改变，请重新打开。");
  return preview;
}

function closeFloorDetail() {
  const detail = document.querySelector('#story-branch-tree [data-role="floor-detail"]');
  if (detail) {
    detail.hidden = true;
    detail.querySelector('[data-role="floor-content"]').textContent = "";
    detail.querySelector('[data-role="reply-actions"]')?.replaceChildren();
  }
  nativePreview = null;
}

function openTree() {
  const panel = document.getElementById("story-branch-tree");
  if (!panel) return;
  panel.classList.remove("is-library");
  const toggle = panel.querySelector('[data-action="toggle-view"]');
  updateViewToggle(toggle);
  panel.hidden = false;
  panel.querySelector('[data-role="story-library"]')?.setAttribute("hidden", "");
  panel.querySelector('[data-role="canvas"]')?.removeAttribute("hidden");
  const picker = panel.querySelector('[data-role="mode-picker"]');
  if (picker) picker.hidden = Boolean(storyMode(context()));
  document.body.classList.add("story-branch-tree-open");
  view.needsFit = true;
  renderTree();
}

function updateViewToggle(button) {
  if (!button) return;
  const label = compactView ? "详细视图" : "简略视图";
  const text = button.querySelector('[data-role="view-label"]');
  if (text) text.textContent = label;
  const shortText = button.querySelector('[data-role="view-short"]');
  if (shortText) shortText.textContent = compactView ? "详细" : "简略";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.setAttribute("aria-pressed", String(compactView));
}

function closeTree() {
  legacySearch?.abort();
  legacyPlan = null;
  const panel = document.getElementById("story-branch-tree");
  if (!panel) return;
  closeConfirmation();
  closeFloorDetail();
  panel.hidden = true;
  document.body.classList.remove("story-branch-tree-open");
}

function closeConfirmation() {
  const dialog = document.getElementById("story-branch-tree-confirm");
  if (dialog) dialog.hidden = true;
  pendingConfirmation = null;
  document.body.classList.remove("story-branch-tree-confirm-open");
}

function openConfirmation(request, title, message, acceptLabel) {
  const dialog = document.getElementById("story-branch-tree-confirm");
  if (!dialog) throw new Error("确认弹窗未加载。");
  const ctx = context();
  pendingConfirmation = { ...request, chatId: ctx.chatId, characterId: ctx.characterId, groupId: ctx.groupId };
  dialog.querySelector('[data-role="confirm-title"]').textContent = title;
  dialog.querySelector('[data-role="confirm-message"]').textContent = message;
  dialog.querySelector('[data-action="confirm-accept"]').textContent = acceptLabel;
  dialog.hidden = false;
  document.body.classList.add("story-branch-tree-confirm-open");
  dialog.querySelector('[data-action="confirm-accept"]').focus();
}

function openBranchSwitchConfirm(branchId) {
  if (state.busy || isGenerating()) throw new Error("请等当前生成结束后再切换剧情路线。");
  const ctx = context();
  if (!isSoloChat(ctx)) throw new Error("只支持单人角色聊天。");
  const tree = graphFrom(ctx);
  if (!tree) throw new Error("当前聊天尚未建立剧情树。");
  validateStoryTree(tree);
  const branch = tree.branches[branchId];
  if (!branch) throw new Error("剧情路线不存在。");
  if (branchId === tree.activeBranchId && !isMemoryBlocked(ctx)) {
    toast("info", "当前就在这条路线。");
    return;
  }
  const row = getStoryBranchRows(tree).find((item) => item.id === branchId);
  const retry = branchId === tree.activeBranchId && isMemoryBlocked(ctx);
  openConfirmation({ kind: "switch", branchId }, retry ? "恢复当前路线记忆" : "切换剧情路线",
    retry ? "重新恢复当前路线的记忆和世界书注入吗？" : `要切换到路线 ${row?.branchNumber ?? "—"}「${row?.title ?? branch.title}」吗？`,
    retry ? "重试恢复" : "确认切换");
}

function openMessageForkConfirm(messageIndex) {
  if (state.busy || isGenerating()) throw new Error("请等当前生成结束后再创建剧情分支。");
  const ctx = context();
  if (!isSoloChat(ctx)) throw new Error("只支持单人角色聊天。");
  if (!Number.isInteger(messageIndex) || !ctx.chat[messageIndex]) throw new Error("分支消息不存在。");
  if (requestStoryMode(() => openMessageForkConfirm(messageIndex))) return;
  openConfirmation({ kind: "fork-message", messageIndex, messageRef: ctx.chat[messageIndex] }, "创建剧情分支", `从第 ${messageIndex + 1} 楼创建一条新路线吗？当前路线的后续会保留。`, "确认创建");
}

function canForkCurrentSwipe(message) {
  if (!message || message.is_user || message.is_system || message.extra?.isSmallSys || !Array.isArray(message.swipes) || message.swipes.length < 2) return false;
  const current = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
  return current >= 0 && current < message.swipes.length && typeof message.mes === "string" && !!message.mes.trim();
}

function openSwipeBranchConfirm(messageIndex) {
  if (state.busy || isGenerating()) throw new Error("请等当前生成结束后再创建剧情分支。");
  const ctx = context();
  if (!isSoloChat(ctx)) throw new Error("只支持单人角色聊天。");
  const message = ctx.chat[messageIndex];
  const anchor = ctx.chat[messageIndex - 1];
  if (!anchor || !canForkCurrentSwipe(message)) throw new Error("这条 AI 回复没有可用的当前重说版本。");
  if (requestStoryMode(() => openSwipeBranchConfirm(messageIndex))) return;
  const activeSwipeId = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
  openConfirmation({
    kind: "fork-swipe",
    messageIndex,
    messageRef: message,
    anchorRef: anchor,
    activeSwipeId,
    activeText: message.mes,
  }, "从重说创建分支", `将第 ${messageIndex + 1} 楼当前显示的回复 ${activeSwipeId + 1} 建为新路线吗？原路线和其他重说会保留。`, "创建并切换");
}

function openNodeForkConfirm(branchId) {
  if (state.busy || isGenerating()) throw new Error("请等当前生成结束后再创建剧情分支。");
  const ctx = context();
  if (!isSoloChat(ctx)) throw new Error("只支持单人角色聊天。");
  const tree = graphFrom(ctx);
  if (!tree) throw new Error("当前聊天尚未建立剧情树。");
  validateStoryTree(tree);
  const branch = tree.branches[branchId];
  if (!branch?.parentBranchId || !branch.forkMessageId) throw new Error("找不到这条路线的分叉节点。");
  const row = getStoryBranchRows(tree).find((item) => item.id === branchId);
  if (row?.kind === "swipe") throw new Error("重说回复组请从聊天楼层的重说版本创建新路线。");
  const forkIndex = branchMessageIndex(tree, branch);
  if (!Number.isInteger(forkIndex) || forkIndex < 0) throw new Error("这条旧分支没有保留准确分叉位置，请从聊天中的具体楼层开新分支。");
  const floor = forkIndex + 1;
  openConfirmation({ kind: "fork-node", branchId }, "从分叉点继续", `从第 ${floor} 楼“${tree.nodeNames?.[branch.forkMessageId] || "分叉点"}”创建新路线吗？原有路线会保留。`, "确认创建");
}

function openDeleteBranchConfirm(branchId) {
  if (state.busy || isGenerating()) throw new Error("请等当前生成结束后再删除剧情分支。");
  const ctx = context();
  if (!isSoloChat(ctx)) throw new Error("只支持单人角色聊天。");
  const tree = graphFrom(ctx);
  if (!tree) throw new Error("当前聊天尚未建立剧情树。");
  if (tree.storageMode === "native") {
    if (branchId === tree.rootBranchId) throw Error("请从故事列表删除整个故事。");
    const row = getStoryBranchRows(tree).find(route => route.id === branchId);
    openConfirmation({ kind: "delete", branchId }, "删除原生路线", `删除「${row?.title ?? branchId}」及其子路线对应的聊天文件吗？其他路线保留。`, "确认删除");
    return;
  }
  const next = deleteStoryBranch(tree, branchId);
  const descendants = Object.keys(tree.branches).length - Object.keys(next.branches).length - 1;
  const row = getStoryBranchRows(tree).find((item) => item.id === branchId);
  const children = descendants ? `，以及它下面的 ${descendants} 条子路线` : "";
  openConfirmation({ kind: "delete", branchId }, "删除剧情分支", `确定删除路线 ${row?.branchNumber ?? "—"}「${row?.title ?? tree.branches[branchId].title}」${children}吗？相关剧情内容和备注会从这条聊天记录中删除，无法撤销。`, "确认删除");
}

async function confirmPendingAction() {
  const request = pendingConfirmation;
  if (!request) return;
  closeConfirmation();
  const ctx = context();
  if (!ctx || ctx.chatId !== request.chatId || ctx.characterId !== request.characterId || ctx.groupId !== request.groupId) {
    throw new Error("当前聊天已改变，请重新选择操作。");
  }
  if (request.kind === "switch") {
    await activateBranch(request.branchId);
    closeTree();
  } else if (request.kind === "native-reply") {
    const preview = checkedNativePreview();
    await forkFromSwipe(preview.index, preview.swipeId);
    closeFloorDetail();
  } else if (request.kind === "adopt-legacy") {
    const result = await runNative(() => nativeStorage.adoptLegacyStory(request.plan, request.names, { onProgress: text => {
      const el = document.querySelector('#story-branch-tree [data-role="legacy-progress"]'); if (el) el.textContent = text;
    } }));
    pendingModeAction = null;
    await openStoryLibrary();
    toast("success", `已将 ${result.count} 条记录整理为一个故事。`);
  } else if (request.kind === "delete-story") {
    await runNative(() => nativeStorage.removeStory(request.storyId, async () => {
      const core = await import("../../../../script.js");
      if (typeof core.doNewChat !== "function") throw Error("当前酒馆无法安全离开故事，请先打开其他聊天再删除。");
      await core.doNewChat();
    }, request.files));
    await openStoryLibrary();
  } else if (request.kind === "fork-message") {
    if (ctx.chat[request.messageIndex] !== request.messageRef) throw new Error("这条消息已改变，请重新点击分支。");
    await forkFromMessage(request.messageIndex);
  } else if (request.kind === "fork-swipe") {
    const message = ctx.chat[request.messageIndex];
    if (message !== request.messageRef || ctx.chat[request.messageIndex - 1] !== request.anchorRef
      || (Number.isInteger(message?.swipe_id) ? message.swipe_id : 0) !== request.activeSwipeId
      || message.mes !== request.activeText || !canForkCurrentSwipe(message)) {
      throw new Error("当前重说回复已改变，请重新点击重说分支。");
    }
    await forkFromSwipe(request.messageIndex, request.activeSwipeId);
  } else if (request.kind === "send-pending") {
    const tree = syncLiveChat();
    const pending = tree?.branches[tree.activeBranchId];
    if (!pending?.pendingSwipe || pending.id !== request.branchId) throw new Error("待续回复已改变，请重新发送。");
    delete pending.pendingSwipe;
    storeGraph(ctx, tree);
    await sendTextareaMessage();
    if (context()?.chat?.length === request.floorCount) {
      const unchanged = graphFrom(context());
      if (unchanged?.branches[request.branchId]) {
        unchanged.branches[request.branchId].pendingSwipe = true;
        storeGraph(context(), unchanged);
      }
    }
    refreshUi();
  } else if (request.kind === "fork-node") {
    await returnToForkNode(request.branchId);
  } else if (request.kind === "delete") {
    await deleteBranch(request.branchId);
    pendingNoteEditor?.finish(null);
  }
}

async function showEndDetail(branchId) {
  const tree = graphFrom(context());
  const branch = tree?.branches?.[branchId];
  const panel = document.getElementById("story-branch-tree");
  const detail = panel?.querySelector('[data-role="floor-detail"]');
  if (!branch || !detail) throw new Error("找不到这条路线的终点。");
  const owner = context().chat;
  const chatId = context().chatId;
  const route = tree.storageMode === "native" ? await nativeStorage.readRoute(branchId) : resolveStoryBranch(tree, branchId);
  if (context().chat !== owner || context().chatId !== chatId) throw Error("聊天已改变，请重新打开详情。");
  closeFloorDetail();
  const title = getStoryBranchRows(tree).find((row) => row.id === branchId)?.title ?? branch.title;
  detail.querySelector('[data-role="floor-title"]').textContent = `${title} · 第 ${route.length || "—"} 楼`;
  detail.querySelector('[data-role="floor-content"]').textContent = messageContent(route.at(-1)) || "该楼层还没有内容。";
  detail.hidden = false;
  detail.querySelector('[data-action="close-floor-detail"]')?.focus();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/gu, "&#96;");
}

function editNote(title, values = {}, mode = "note") {
  const panel = document.getElementById("story-branch-tree");
  const editor = panel?.querySelector('[data-role="note-editor"]');
  const titleElement = editor?.querySelector('[data-role="note-title"]');
  const branchNameField = editor?.querySelector('[data-role="branch-name-field"]');
  const branchNameInput = editor?.querySelector('[data-role="branch-name"]');
  const pointNameField = editor?.querySelector('[data-role="point-name-field"]');
  const pointNameInput = editor?.querySelector('[data-role="point-name"]');
  const branchSummaryField = editor?.querySelector('[data-role="branch-summary-field"]');
  const branchSummaryInput = editor?.querySelector('[data-role="branch-summary"]');
  const pointSummaryField = editor?.querySelector('[data-role="point-summary-field"]');
  const pointSummaryInput = editor?.querySelector('[data-role="point-summary"]');
  const input = editor?.querySelector('[data-role="note-input"]');
  const deleteButton = editor?.querySelector('[data-action="delete-branch"]');
  if (!editor || !titleElement || !branchNameField || !branchNameInput || !pointNameField || !pointNameInput || !branchSummaryField || !branchSummaryInput || !pointSummaryField || !pointSummaryInput || !input || !deleteButton) throw new Error("备注编辑器未加载。");
  pendingNoteEditor?.finish(null);
  titleElement.textContent = title;
  branchNameField.hidden = mode !== "branch";
  pointNameField.hidden = mode !== "node";
  branchSummaryField.hidden = mode !== "branch";
  pointSummaryField.hidden = mode !== "node";
  pointNameField.querySelector("label").textContent = values.nodeKind === "swipe" ? "回复组名称" : "分叉点名称";
  pointSummaryField.querySelector("label").textContent = values.nodeKind === "swipe"
    ? "原路线回复摘要（留空时自动读取本楼）" : "分叉点摘要（留空时自动读取本楼）";
  deleteButton.hidden = mode !== "branch" || !values.branchId;
  if (values.branchId) editor.dataset.branchId = values.branchId;
  else delete editor.dataset.branchId;
  branchNameInput.value = values.title ?? "";
  pointNameInput.value = values.pointName ?? "";
  branchSummaryInput.value = values.summary ?? "";
  pointSummaryInput.value = values.summary ?? "";
  input.value = values.note ?? "";
  editor.hidden = false;
  const focusTarget = mode === "branch" ? branchNameInput : mode === "node" ? pointNameInput : input;
  focusTarget.focus();
  focusTarget.setSelectionRange(focusTarget.value.length, focusTarget.value.length);
  editor.dataset.mode = mode;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      editor.hidden = true;
      pendingNoteEditor = null;
      resolve(result);
    };
    pendingNoteEditor = { finish };
  });
}

function renderForkButtons() {
  const ctx = context();
  const chat = document.getElementById("chat");
  if (!chat) return;
  const enabled = isSoloChat(ctx);
  const tree = enabled ? graphFrom(ctx) : null;
  const replyAliases = new Map();
  if (tree && tree.storageMode !== "native") {
    for (let branch = tree.branches[tree.activeBranchId]; branch; branch = tree.branches[branch.parentBranchId]) {
      const sourceId = sourceMessageIdForBranch(tree, branch);
      if (!sourceId || !branch.messageIds[0]) continue;
      const ids = readStoryBranchMessages(tree, branch.parentBranchId, { fields: ["extra.story_branch_tree_message_id"] });
      const index = ids.findIndex(message => getStoryMessageId(message) === sourceId);
      const source = readRouteFloor(tree, branch.parentBranchId, index);
      if (source) replyAliases.set(branch.messageIds[0], { source, branch });
    }
  }
  for (const messageBlock of chat.querySelectorAll(".mes[mesid]")) {
    const buttonBar = messageBlock.querySelector(".mes_buttons");
    if (!buttonBar) continue;
    let button = buttonBar.querySelector(':scope > .story-branch-tree__fork-button[data-action="create-branch"]');
    let swipeButton = buttonBar.querySelector(':scope > .story-branch-tree__fork-button[data-action="create-swipe-branch"]');
    let historyButton = buttonBar.querySelector(':scope > .story-branch-tree__fork-button[data-action="view-swipe-history"]');
    if (!enabled) {
      button?.remove();
      swipeButton?.remove();
      historyButton?.remove();
      messageBlock.classList.remove("story-branch-tree__history-swipes");
      continue;
    }
    if (!button) {
      button = document.createElement("button");
      button.className = "story-branch-tree__fork-button";
      button.type = "button";
      button.dataset.action = "create-branch";
      button.innerHTML = '<i class="fa-solid fa-code-branch" aria-hidden="true"></i><span>分支</span>';
      button.title = "从这条消息的当前回复版本继续一条剧情路线";
      button.setAttribute("aria-label", "从此处分支");
      buttonBar.append(button);
    }
    const messageIndex = Number(messageBlock.getAttribute("mesid"));
    const message = ctx.chat[messageIndex];
    const alias = replyAliases.get(getStoryMessageId(message));
    const source = alias?.source ?? message;
    const available = messageIndex > 0 && source && !source.is_user && !source.is_system
      && !source.extra?.isSmallSys && source.extra?.swipeable !== false
      && Array.isArray(source.swipes) && source.swipes.filter((value) => typeof value === "string" && value.trim()).length > 1;
    const localSwipeIsSelected = alias && (message?.swipes?.length ?? 0) > 1 && (message.swipe_id ?? 0) > 0;
    const useHistoryArrows = available && !localSwipeIsSelected
      && (messageIndex < ctx.chat.length - 1 || Boolean(alias));
    messageBlock.classList.toggle("story-branch-tree__history-swipes", useHistoryArrows);
    if (useHistoryArrows) {
      const selected = alias?.branch.sourceVariantId
        ? source.swipe_info?.findIndex((info) => info?.extra?.story_branch_tree_variant_id === alias.branch.sourceVariantId)
        : message.swipe_id;
      const number = Number.isInteger(selected) && selected >= 0 ? selected : alias?.branch.sourceSwipeIndex ?? 0;
      const counter = messageBlock.querySelector(".swipes-counter");
      if (counter) {
        counter.hidden = false;
        counter.textContent = `${number + 1}/${source.swipes.length}`;
        counter.dataset.storySwipeCount = counter.textContent;
        counter.setAttribute("aria-label", `当前回复 ${number + 1}，共 ${source.swipes.length} 个回复`);
      }
    } else {
      const counter = messageBlock.querySelector(".swipes-counter");
      counter?.removeAttribute("data-story-swipe-count");
      counter?.removeAttribute("aria-label");
    }
    const hasSwipes = canForkCurrentSwipe(ctx.chat[messageIndex]);
    if (tree?.branches[tree.activeBranchId]?.pendingSwipe) {
      button?.remove();
      swipeButton?.remove();
      historyButton?.remove();
      continue;
    }
    if (messageIndex > 0 && hasSwipes) {
      if (!swipeButton) {
        swipeButton = document.createElement("button");
        swipeButton.className = "story-branch-tree__fork-button";
        swipeButton.type = "button";
        swipeButton.dataset.action = "create-swipe-branch";
        swipeButton.innerHTML = '<i class="fa-solid fa-clone" aria-hidden="true"></i><span>重说分支</span>';
        swipeButton.title = "将当前显示的重说回复建为新路线";
        swipeButton.setAttribute("aria-label", "将当前重说回复创建为分支");
        buttonBar.append(swipeButton);
      }
    } else {
      swipeButton?.remove();
    }
    historyButton?.remove();
  }
}

function refreshUi({ chatButtons = true } = {}) {
  if (!extensionEnabled) return;
  if (!document.getElementById("story-branch-tree")?.hidden) renderTree();
  if (chatButtons) renderForkButtons();
}

async function autoArrangeTree() {
  if (state.busy || isGenerating()) throw new Error("请等当前生成结束后再整理剧情树。");
  const ctx = context();
  if (!isSoloChat(ctx)) throw new Error("剧情分支树仅支持单人角色聊天。");
  const tree = graphFrom(ctx);
  if (!tree) throw new Error("当前聊天还没有剧情树。");
  delete tree.layout;
  delete tree.compactLayout;
  storeGraph(ctx, tree);
  if (tree.storageMode !== "native") await ctx.saveChat?.();
  view.needsFit = true;
  renderTree();
}

function soloTreeOrCreate(ctx) {
  if (!isSoloChat(ctx)) throw new Error("剧情分支树仅支持单人角色聊天。");
  const existing = graphFrom(ctx);
  if (existing) {
    validateStoryTree(existing);
    return existing;
  }
  const tree = createStoryTree(ctx.chat);
  const synced = syncActiveStoryBranch(tree, ctx.chat, { adapters: routeAdapters.values() });
  applySyncedMessageIds(ctx.chat, synced.messages);
  captureActiveChatVariables(ctx, synced.tree);
  captureActiveAdapterMetadata(ctx, synced.tree);
  storeGraph(ctx, synced.tree);
  return synced.tree;
}

function applySyncedMessageIds(liveMessages, syncedMessages) {
  for (let index = 0; index < liveMessages.length; index++) {
    copyStoryMessageIdentity(liveMessages[index], syncedMessages[index]);
  }
}

function syncLiveChat({ allowInitialize = false } = {}) {
  const ctx = context();
  if (!isSoloChat(ctx)) return null;
  if (storyMode(ctx) === "native") return nativeStorage.syncCurrent();
  let tree = graphFrom(ctx);
  if (!tree && !allowInitialize) return null;
  tree ??= createStoryTree(ctx.chat);
  initializeRegisteredAdapterStates(tree);
  const synced = syncActiveStoryBranch(tree, ctx.chat, { adapters: routeAdapters.values() });
  applySyncedMessageIds(ctx.chat, synced.messages);
  captureActiveChatVariables(ctx, synced.tree);
  captureActiveAdapterMetadata(ctx, synced.tree);
  storeGraph(ctx, synced.tree);
  return synced.tree;
}

async function replaceActiveProjection(ctx, tree) {
  await ensureSingleMemory();
  invalidateMemoryTasks();
  state.routeSwitching = true;
  let change;
  try { change = await projectRoute(ctx, tree); }
  finally { state.routeSwitching = false; }
  // Completed listeners may immediately begin tasks on the restored route.
  emitBranchChanged(change);
}

async function projectRoute(ctx, tree) {
  const chatScope = { chat: ctx.chat, chatId: ctx.chatId, characterId: ctx.characterId, groupId: ctx.groupId ?? null };
  const sameChat = () => {
    const current = context();
    return current?.chat === chatScope.chat && current.chatId === chatScope.chatId
      && current.characterId === chatScope.characterId && (current.groupId ?? null) === chatScope.groupId;
  };
  const assertChat = () => { if (!sameChat()) throw new Error("聊天已变化，已取消旧路线的切换。"); };
  const previousTree = graphFrom(ctx);
  const previousBranchId = previousTree?.activeBranchId;
  const messages = resolveStoryBranch(tree);
  const branchChange = branchTransitionInfo(ctx, previousBranchId, tree, messages)
    ?? (isMemoryBlocked(ctx) ? { ...routeInfo(ctx, tree, messages), previousBranchId, reason: "memory-retry" } : null);
  const adapters = branchChange ? [...routeAdapters.values()] : [];
  const activeMetadataFields = new Set([...routeAdapters.values()].flatMap(adapter => adapter.metadataFields));
  const inactiveMetadata = Object.entries(tree.branches[tree.activeBranchId].adapterStates ?? {})
    .filter(([id, saved]) => !routeAdapters.has(id) && saved.metadata
      && !adapterMetadataFieldNames(saved.metadataFields).some(field => activeMetadataFields.has(field)));
  const prepared = [];
  const metadataOverrides = new Map();
  const hookInfo = () => ({ ...structuredClone(branchChange), previousRoute: routeInfo(ctx, previousTree),
    getMessages: options => copyMessageRange(messages, options) });
  const acceptMetadata = (adapter, result) => {
    if (result?.metadata === undefined) return;
    if (!result.metadata || typeof result.metadata !== "object" || Array.isArray(result.metadata)
      || Object.keys(result.metadata).some(field => !adapter.metadataFields.includes(field))) throw new Error("记忆钩子返回了未声明的聊天元数据。");
    metadataOverrides.set(adapter.id, result.metadata);
  };
  try {
    for (const adapter of adapters) {
      const detail = { ...hookInfo(), getReplyMemory: index => readReplyMemory(messages[index], adapter.messageFields) };
      adapterPreparingOwner = adapter.id;
      try { acceptMetadata(adapter, await adapter.beforeSwitch?.(detail)); }
      finally { adapterPreparingOwner = null; }
      assertChat();
      prepared.push(adapter);
      if (branchChange.fork) {
        acceptMetadata(adapter, await adapter.onFork?.(detail));
        assertChat();
      }
    }
  } catch (error) {
    for (const adapter of sameChat() ? prepared.reverse() : []) {
      try { await adapter.onSwitchAborted?.(routeInfo(ctx, previousTree)); }
      catch (restoreError) { console.error("[StoryBranchTree] Memory adapter could not restore the previous route", restoreError); }
    }
    throw error;
  }
  const previousMessages = ctx.chat.slice();
  const previousVariables = ctx.chatMetadata?.variables;
  const previousMetadata = { branches: { previous: {} } };
  // Rendering hooks can query the API before the new tree is persisted.
  const projection = { chat: ctx.chat, chatId: ctx.chatId, tree };
  let stored = false;
  let recoveryOwner = null;
  try {
    assertChat();
    for (const adapter of adapters) {
      if (tree.branches[previousBranchId]) {
        captureStoryBranchAdapterState(tree, previousBranchId, ctx.chat, adapter.id, adapter.messageFields);
        captureAdapterMetadata(ctx, tree, previousBranchId, adapter);
        previousMetadata.branches.previous.adapterStates = { ...previousMetadata.branches.previous.adapterStates,
          [adapter.id]: tree.branches[previousBranchId].adapterStates[adapter.id] };
      } else {
        captureAdapterMetadata(ctx, previousMetadata, "previous", adapter);
      }
    }
    if (tree.branches[previousBranchId]) captureMemoryState(tree.branches[previousBranchId], ctx.chat);
    if (adapters.length && !previousTree?.branches?.[tree.activeBranchId]) {
      // Preparation may persist pending edits. Only a newly created route inherits them;
      // existing routes keep their own snapshots, and alternate replies keep their own fields.
      const liveById = new Map(ctx.chat.map(message => [getStoryMessageId(message), message]));
      const branch = tree.branches[tree.activeBranchId];
      for (const message of messages) {
        const source = liveById.get(getStoryMessageId(message))
          ?? (branch.branchKind === "swipe" && branch.messageIds[0] === getStoryMessageId(message)
            && branch.sourceSwipeIndex === branch.originSwipeIndex ? liveById.get(branch.sourceMessageId) : null);
        if (!source) continue;
        for (const adapter of adapters) {
          for (const field of adapter.messageFields) {
            if (Object.hasOwn(source, field)) message[field] = structuredClone(source[field]);
            else delete message[field];
          }
        }
      }
      for (const adapter of adapters) {
        captureStoryBranchAdapterState(tree, tree.activeBranchId, messages, adapter.id, adapter.messageFields);
      }
    }
    if (!previousTree?.branches?.[tree.activeBranchId]) {
      captureMemoryState(tree.branches[tree.activeBranchId], messages);
    }
    for (const [id, saved] of inactiveMetadata) {
      captureStoryBranchAdapterMetadata(previousMetadata, "previous", ctx.chatMetadata, id, saved.metadataFields);
      // Saved state still follows the route when its owning extension is disabled.
      if (id === "muyoo-memory-v1" && branchChange?.fork) captureStoryBranchAdapterMetadata(tree, tree.activeBranchId,
        { sheets: muyooSheetsAtMessages(saved.metadata.sheets ?? [], messages) }, id, ["sheets"]);
    }
    await ctx.clearChat();
    assertChat();
    ctx.chat.splice(0, ctx.chat.length, ...messages);
    activeProjection = projection;
    for (const [id] of inactiveMetadata) restoreStoryBranchAdapterMetadata(ctx.chatMetadata,
      tree.branches[tree.activeBranchId].adapterStates[id]);
    for (const adapter of adapters) {
      if (metadataOverrides.has(adapter.id)) captureStoryBranchAdapterMetadata(tree, tree.activeBranchId, metadataOverrides.get(adapter.id), adapter.id, adapter.metadataFields);
      restoreStoryBranchAdapterMetadata(ctx.chatMetadata, tree.branches[tree.activeBranchId].adapterStates?.[adapter.id]);
    }
    restoreActiveChatVariables(ctx, tree, messages);
    await ctx.printMessages();
    assertChat();
    storeGraph(context(), tree);
    stored = true;
    await context().saveChat();
    assertChat();
    if (ctx.eventSource && ctx.eventTypes?.CHAT_LOADED) {
      await ctx.eventSource.emit(ctx.eventTypes.CHAT_LOADED, {
        detail: {
          id: ctx.characterId,
          character: ctx.characters?.[ctx.characterId],
          ...(branchChange ? { storyBranchTree: structuredClone(branchChange) } : {}),
        },
      });
    }
    assertChat();
    for (const adapter of adapters) {
      recoveryOwner = adapter.id;
      await adapter.afterSwitch?.(structuredClone(branchChange));
      assertChat();
    }
    recoveryOwner = null;
    adapterRecoveryKey = null;
    adapterRecoveryOwner = null;
    if (adapters.some(adapter => adapter.metadataFields.length)) await context().saveChat();
    return branchChange;
  } catch (error) {
    if (!stored && sameChat()) {
      ctx.chat.splice(0, ctx.chat.length, ...previousMessages);
      ctx.updateChatMetadata({ variables: previousVariables });
      for (const saved of Object.values(previousMetadata.branches.previous.adapterStates ?? {})) restoreStoryBranchAdapterMetadata(ctx.chatMetadata, saved);
      if (activeProjection === projection) activeProjection = null;
      for (const adapter of adapters) {
        try { await adapter.onSwitchAborted?.(routeInfo(ctx, previousTree)); }
        catch (restoreError) { console.error("[StoryBranchTree] Previous route memory could not be restored", restoreError); }
      }
      try { await ctx.printMessages(); }
      catch (renderError) { console.error("[StoryBranchTree] Previous route could not be rendered", renderError); }
    }
    if (stored && sameChat()) {
      adapterRecoveryKey = getActiveRouteKey();
      adapterRecoveryOwner = recoveryOwner;
    }
    throw error;
  } finally {
    if (activeProjection === projection) activeProjection = null;
  }
}

async function switchHistoricalReply(messageIndex, direction) {
  if (storyMode(context()) === "native") {
    const message = context().chat[messageIndex];
    const count = message?.swipes?.length ?? 0;
    if (!count) throw Error("没有可预览的回复。");
    showNativeReply(messageIndex, ((message.swipe_id ?? 0) + direction + count) % count);
    return;
  }
  if (state.busy || isGenerating()) throw new Error("请等当前生成结束后再切换历史回复。");
  const ctx = context();
  if (!isSoloChat(ctx)) throw new Error("只支持单人角色聊天。");
  state.busy = true;
  try {
    await ensureSingleMemory({ captureReplies: true });
    let tree = syncLiveChat({ allowInitialize: true });
    const reply = historicalReplySource(tree, messageIndex);
    if (!reply || !Array.isArray(reply.source.swipes) || reply.source.swipes.length < 2) {
      throw new Error("这条消息没有可切换的历史回复。");
    }
    const count = reply.source.swipes.length;
    let nextIndex = reply.currentIndex;
    for (let step = 0; step < count; step++) {
      nextIndex = (nextIndex + direction + count) % count;
      if (typeof reply.source.swipes[nextIndex] === "string" && reply.source.swipes[nextIndex].trim()) break;
    }
    if (nextIndex === reply.currentIndex) return;
    tree = { ...tree, replyRouteSelections: { ...tree.replyRouteSelections } };
    const current = tree.branches[tree.activeBranchId];
    if (!current.pendingSwipe) {
      const key = replySelectionKey(reply.sourceId, replyVersionId(reply.source, reply.currentIndex), reply.currentIndex);
      tree.replyRouteSelections[key] = current.id;
    } else {
      tree = deleteStoryBranch(tree, current.id);
    }
    const versionId = replyVersionId(reply.source, nextIndex);
    const targetKey = replySelectionKey(reply.sourceId, versionId, nextIndex);
    let targetId = tree.replyRouteSelections[targetKey];
    if (!routeUsesReply(tree, targetId, reply.sourceId, messageIndex, versionId, nextIndex)) {
      targetId = Object.values(tree.branches)
        .filter((branch) => branch.parentBranchId === reply.ownerId && sourceMessageIdForBranch(tree, branch) === reply.sourceId
          && (branch.sourceVariantId && versionId
            ? branch.sourceVariantId === versionId : branch.sourceSwipeIndex === nextIndex))
        .sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
    }
    if (!targetId && routeUsesReply(tree, reply.ownerId, reply.sourceId, messageIndex, versionId, nextIndex)) {
      targetId = reply.ownerId;
    }
    if (targetId) {
      tree = activateStoryBranch(tree, targetId);
    } else {
      tree = createStoryBranchFromSwipe(activateStoryBranch(tree, reply.ownerId), reply.sourceId, nextIndex);
      tree.branches[tree.activeBranchId].pendingSwipe = true;
    }
    await replaceActiveProjection(context(), tree);
    toast("info", tree.branches[tree.activeBranchId].pendingSwipe
      ? `已切到第 ${messageIndex + 1} 楼回复 ${nextIndex + 1}；继续发送前会确认创建分支。`
      : `已恢复第 ${messageIndex + 1} 楼回复 ${nextIndex + 1} 的剧情路线。`);
  } finally {
    singleMemoryCompatibility.releaseIfUnused();
    state.busy = false;
    refreshUi();
  }
}

async function forkFromMessage(messageIndex) {
  if (storyMode(context()) === "native") return runNative(() => nativeStorage.createBranch(messageIndex));
  if (state.busy || isGenerating()) throw new Error("请等当前生成结束后再切换剧情路线。");
  const ctx = context();
  if (!isSoloChat(ctx)) throw new Error("只支持单人角色聊天。");
  if (!Number.isInteger(messageIndex) || !ctx.chat[messageIndex]) throw new Error("分支消息不存在。");
  state.busy = true;
  try {
    await ensureSingleMemory({ captureReplies: true });
    const synced = syncLiveChat({ allowInitialize: true });
    const current = context();
    const message = current.chat[messageIndex];
    const id = getStoryMessageId(message);
    const next = createStoryBranch(synced, id);
    const title = next.branches[next.activeBranchId].title;
    await replaceActiveProjection(current, next);
    toast("success", `已从第 ${messageIndex + 1} 条消息创建“${title}”。`);
  } finally {
    singleMemoryCompatibility.releaseIfUnused();
    state.busy = false;
    refreshUi();
  }
}

async function forkFromSwipe(messageIndex, swipeIndex) {
  if (storyMode(context()) === "native") return runNative(() => nativeStorage.createBranch(messageIndex, swipeIndex));
  if (state.busy || isGenerating()) throw new Error("请等当前生成结束后再切换剧情路线。");
  const ctx = context();
  if (!isSoloChat(ctx) || !ctx.chat[messageIndex] || !ctx.chat[messageIndex - 1]) throw new Error("重说回复或分叉楼层不存在。");
  state.busy = true;
  try {
    await ensureSingleMemory({ captureReplies: true });
    const synced = syncLiveChat({ allowInitialize: true });
    const current = context();
    const id = getStoryMessageId(current.chat[messageIndex]);
    const next = createStoryBranchFromSwipe(synced, id, swipeIndex);
    await replaceActiveProjection(current, next);
    toast("success", `已将消息 #${messageIndex} 的回复 ${swipeIndex + 1} 建为新分支。`);
  } finally {
    singleMemoryCompatibility.releaseIfUnused();
    state.busy = false;
    refreshUi();
  }
}

async function activateBranch(branchId) {
  if (storyMode(context()) === "native") return runNative(() => nativeStorage.switchRoute(branchId));
  if (state.busy || isGenerating()) throw new Error("请等当前生成结束后再切换剧情路线。");
  state.busy = true;
  try {
    await ensureSingleMemory({ captureReplies: true });
    const ctx = context();
    if (!isSoloChat(ctx)) throw new Error("只支持单人角色聊天。");
    let tree = syncLiveChat();
    if (!tree) throw new Error("当前聊天尚未建立剧情树。");
    if (tree.branches[tree.activeBranchId].pendingSwipe) tree = deleteStoryBranch(tree, tree.activeBranchId);
    tree = activateStoryBranch(tree, branchId);
    await replaceActiveProjection(context(), tree);
    const title = getStoryBranchRows(tree).find((branch) => branch.id === branchId)?.title ?? tree.branches[branchId].title;
    toast("success", `已切换到“${title}”。`);
  } finally {
    singleMemoryCompatibility.releaseIfUnused();
    state.busy = false;
    refreshUi();
  }
}

function pruneDeletedBranchLayout(tree) {
  const branchIds = new Set(Object.keys(tree.branches));
  const forkIds = new Set(groupForkPoints(getStoryBranchRows(tree)).map((group) => group.id));
  for (const key of Object.keys(tree.layout ?? {})) {
    if (key.startsWith("end:")) {
      if (!branchIds.has(key.slice(4))) delete tree.layout[key];
    } else if (!branchIds.has(key) && !forkIds.has(key)) {
      delete tree.layout[key];
    }
  }
  for (const key of Object.keys(tree.compactLayout?.points ?? {})) {
    if (!forkIds.has(key)) delete tree.compactLayout.points[key];
  }
  for (const key of Object.keys(tree.compactLayout?.leaves ?? {})) {
    if (!branchIds.has(key)) delete tree.compactLayout.leaves[key];
  }
}

async function deleteBranch(branchId) {
  if (storyMode(context()) === "native") {
    const tree = nativeStorage.view();
    const selected = new Set([branchId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const route of Object.values(tree.branches)) if (selected.has(route.parentBranchId) && !selected.has(route.id)) { selected.add(route.id); changed = true; }
    }
    return runNative(async () => {
      await nativeStorage.removeRoutes([...selected]);
      const view = nativeStorage.view();
      pruneDeletedBranchLayout(view);
      const nodeKeys = new Set(getStoryBranchRows(view).map(route => route.nodeKey).filter(Boolean));
      for (const key of ["nodeNotes", "nodeNames", "nodeSummaries"]) for (const id of Object.keys(view[key] ?? {})) {
        if (!nodeKeys.has(id)) delete view[key][id];
      }
      storeGraph(context(), view);
    });
  }
  if (state.busy || isGenerating()) throw new Error("请等当前生成结束后再删除剧情分支。");
  state.busy = true;
  try {
    const ctx = context();
    if (!isSoloChat(ctx)) throw new Error("只支持单人角色聊天。");
    const tree = syncLiveChat();
    if (!tree) throw new Error("当前聊天尚未建立剧情树。");
    const next = deleteStoryBranch(tree, branchId);
    pruneDeletedBranchLayout(next);
    view.needsFit = true;
    if (next.activeBranchId !== tree.activeBranchId) {
      await replaceActiveProjection(ctx, next);
    } else {
      storeGraph(ctx, next);
      await ctx.saveChat?.();
    }
    toast("success", "分支已删除。");
  } finally {
    state.busy = false;
    refreshUi();
  }
}

async function editBranchNote(branchId) {
  const ctx = context();
  const tree = syncLiveChat();
  const branch = tree?.branches[branchId];
  if (!branch) throw new Error("剧情路线不存在。");
  const displayTitle = getStoryBranchRows(tree).find((row) => row.id === branchId)?.title ?? branch.title;
  const autoSummary = branch.messageIds.length ? messageExcerpt(tree.messages[branch.messageIds[0]]) : "";
  const details = await editNote("查看和编辑分支摘要", { branchId, title: displayTitle, summary: branch.summary ?? autoSummary, note: branch.note }, "branch");
  if (details === null) return;
  if (tree.storageMode === "native") {
    await runNative(() => nativeStorage.updateRoute(branchId, { title: details.title.trim().slice(0, 80) || branch.title, autoTitle: false,
      summary: details.summary.trim().slice(0, 1000), note: details.note.trim().slice(0, 1000) }));
    return;
  }
  const editedTitle = details.title.trim().slice(0, 80);
  if (editedTitle && editedTitle !== displayTitle) {
    branch.title = editedTitle;
    branch.autoTitle = false;
    branch.titleCustomized = true;
  }
  const summary = details.summary.trim().slice(0, 1000);
  if (!summary || (!branch.summary && summary === autoSummary)) delete branch.summary;
  else branch.summary = summary;
  branch.note = details.note.trim().slice(0, 1000);
  if (!branch.note) delete branch.note;
  storeGraph(ctx, tree);
  if (tree.storageMode !== "native") await ctx.saveChat?.();
  refreshUi({ chatButtons: false });
}

async function editNodeNote(branchId) {
  const ctx = context();
  const tree = syncLiveChat();
  const row = tree && getStoryBranchRows(tree).find((item) => item.id === branchId);
  if (!row?.forkMessageId) throw new Error("这条路线没有分叉节点。");
  const nodeKey = row.nodeKey;
  const legacyKey = row.kind === "continuation" ? row.forkMessageId : null;
  const pointMessage = row.kind === "swipe"
    ? readRouteFloor(tree, row.parentBranchId, row.displayForkIndex)
    : row.forkSnapshot ?? tree.messages[row.forkMessageId];
  const autoSummary = messageExcerpt(pointMessage);
  tree.nodeNotes ??= {};
  tree.nodeNames ??= {};
  tree.nodeSummaries ??= {};
  const details = await editNote(row.kind === "swipe" ? "查看和编辑回复组" : "查看和编辑分叉点", {
    nodeKind: row.kind,
    pointName: tree.nodeNames[nodeKey] ?? tree.nodeNames[legacyKey] ?? (row.legacyForkUnknown ? "分叉位置未知" : `第 ${row.displayForkIndex + 1} 楼${row.kind === "swipe" ? "回复选择" : "分叉点"}`),
    summary: tree.nodeSummaries[nodeKey] ?? tree.nodeSummaries[legacyKey] ?? autoSummary,
    note: tree.nodeNotes[nodeKey] ?? tree.nodeNotes[legacyKey] ?? "",
  }, "node");
  if (details === null) return;
  const pointName = details.pointName.trim().slice(0, 80);
  if (pointName) tree.nodeNames[nodeKey] = pointName;
  else delete tree.nodeNames[nodeKey];
  const summary = details.summary.trim().slice(0, 1000);
  if (summary && (tree.nodeSummaries[nodeKey] || summary !== autoSummary)) tree.nodeSummaries[nodeKey] = summary;
  else delete tree.nodeSummaries[nodeKey];
  const value = details.note.trim().slice(0, 1000);
  if (value) tree.nodeNotes[nodeKey] = value;
  else delete tree.nodeNotes[nodeKey];
  storeGraph(ctx, tree);
  if (tree.storageMode !== "native") await ctx.saveChat?.();
  refreshUi({ chatButtons: false });
}

async function returnToForkNode(branchId) {
  if (storyMode(context()) === "native") {
    const branch = nativeStorage.view().branches[branchId];
    if (!branch?.parentBranchId) throw Error("找不到父路线。");
    return runNative(async () => {
      await nativeStorage.switchRoute(branch.parentBranchId);
      const index = context().chat.findIndex(message => getStoryMessageId(message) === branch.forkMessageId);
      if (index < 0) throw Error("父路线中的分叉楼层已改变。");
      await nativeStorage.createBranch(index);
    });
  }
  if (state.busy || isGenerating()) throw new Error("请等当前生成结束后再切换剧情路线。");
  const current = context();
  if (!isSoloChat(current)) throw new Error("只支持单人角色聊天。");
  const synced = syncLiveChat();
  const branch = synced?.branches[branchId];
  if (!branch?.parentBranchId || !branch.forkMessageId) throw new Error("找不到这条路线的分叉节点。");
  state.busy = true;
  try {
    let tree = activateStoryBranch(synced, branch.parentBranchId);
    tree = createStoryBranch(tree, branch.forkMessageId);
    const title = tree.branches[tree.activeBranchId].title;
    await replaceActiveProjection(context(), tree);
    toast("success", `已回到分叉节点，并创建“${title}”。`);
  } finally {
    state.busy = false;
    refreshUi();
  }
}

async function saveCardPosition(branchId, position) {
  const ctx = context();
  const tree = isSoloChat(ctx) ? graphFrom(ctx) : null;
  if (!tree?.branches[branchId]) throw new Error("保存分支位置失败：路线已不存在。");
  tree.layout ??= {};
  tree.layout[branchId] = { x: position.x, y: position.y, layoutVersion: 4 };
  storeGraph(ctx, tree);
  if (tree.storageMode !== "native") await ctx.saveChat?.();
}

async function saveForkPosition(forkId, position, narrow) {
  const ctx = context();
  const tree = isSoloChat(ctx) ? graphFrom(ctx) : null;
  if (!tree) throw new Error("保存分叉点位置失败：剧情树已不存在。");
  tree.layout ??= {};
  tree.layout[forkId] = { x: position.x, y: position.y, kind: "fork", narrow, layoutVersion: 4 };
  storeGraph(ctx, tree);
  if (tree.storageMode !== "native") await ctx.saveChat?.();
}

async function saveCompactPosition(kind, id, position, narrow) {
  const ctx = context();
  const tree = isSoloChat(ctx) ? graphFrom(ctx) : null;
  if (!tree) throw new Error("保存简略视图位置失败：剧情树已不存在。");
  tree.compactLayout ??= { points: {}, leaves: {} };
  tree.compactLayout[kind] ??= {};
  tree.compactLayout[kind][id] = { x: position.x, y: position.y, narrow, orientation: "vertical-spine-v3" };
  storeGraph(ctx, tree);
  if (tree.storageMode !== "native") await ctx.saveChat?.();
}

async function saveEndingPosition(branchId, position, narrow) {
  const ctx = context();
  const tree = isSoloChat(ctx) ? graphFrom(ctx) : null;
  if (!tree?.branches[branchId]) throw new Error("保存终点位置失败：路线已不存在。");
  tree.layout ??= {};
  tree.layout[`end:${branchId}`] = { x: position.x, y: position.y, kind: "end", narrow, layoutVersion: 4 };
  storeGraph(ctx, tree);
  if (tree.storageMode !== "native") await ctx.saveChat?.();
}

function restoreProtectedProjection(error) {
  if (isGenerating()) return;
  const current = context();
  const tree = graphFrom(current);
  if (!tree || !isSoloChat(current)) {
    toast("warning", error.message);
    return;
  }
  state.busy = true;
  replaceActiveProjection(current, tree)
    .then(() => toast("warning", error.message))
    .catch((restoreError) => toast("error", restoreError.message))
    .finally(() => { state.busy = false; refreshUi(); });
}

function handleMessageChanged() {
  const ctx = context();
  if (state.busy || swipeState !== "none" || !isSoloChat(ctx)) return;
  if (!graphFrom(ctx)) {
    renderForkButtons();
    return;
  }
  try {
    const tree = syncLiveChat();
    const active = tree.branches[tree.activeBranchId];
    if (active.pendingSwipe && active.messageIds.length > 1) {
      delete active.pendingSwipe;
      storeGraph(ctx, tree);
      toast("info", "新楼层已加入重说分支。");
    }
    refreshUi();
  } catch (error) {
    if (error.code === "STORY_BRANCH_PROTECTED_CHANGE") restoreProtectedProjection(error);
    else toast("warning", error.message);
  }
}

function repairCompletedSwipeIndices(messages) {
  const repaired = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.is_user || !Array.isArray(message?.swipes) || !message.swipes.length
      || !Number.isInteger(message.swipe_id) || message.swipe_id < 0 || message.swipe_id < message.swipes.length) continue;
    const matches = message.swipes.flatMap((text, swipeIndex) => text === message.mes ? [swipeIndex] : []);
    if (matches.length !== 1) continue;
    message.swipe_id = matches[0];
    repaired.push(index);
  }
  return repaired;
}

async function handleChatLoaded() {
  if (!state.routeSwitching) invalidateMemoryTasks();
  if (state.busy || swipeState !== "none" || isGenerating()) return;
  await connectMemoryEnhancement();
  const ctx = context();
  if (isSoloChat(ctx) && graphFrom(ctx)) {
    try {
      const repaired = repairCompletedSwipeIndices(ctx.chat);
      syncLiveChat();
      if (repaired.length) {
        await Promise.all(repaired.map((index) => updateSwipeCounter(index)));
        await ctx.saveChat?.();
      }
    } catch (error) {
      toast("warning", error.message);
    }
  }
  refreshUi();
}

function bindEvent(eventSource, eventName, handler) {
  if (!eventName) return;
  eventSource.on(eventName, handler);
  eventHandlers.push([eventSource, eventName, handler]);
}

function installEvents(ctx) {
  const eventSource = ctx.eventSource;
  const types = ctx.eventTypes ?? ctx.event_types ?? {};
  if (!eventSource) return;
  bindEvent(eventSource, types.APP_READY, async () => {
    try { await connectMemoryEnhancement(); } catch (error) { toast("warning", error.message); }
  });
  for (const key of ["MESSAGE_SENT", "MESSAGE_RECEIVED", "MESSAGE_SWIPED", "MESSAGE_EDITED", "MESSAGE_UPDATED", "MESSAGE_SWIPE_DELETED"]) {
    bindEvent(eventSource, types[key], (...args) => {
      if (["MESSAGE_SWIPED", "MESSAGE_EDITED", "MESSAGE_SWIPE_DELETED"].includes(key)) invalidateMemoryTasks();
      handleMessageChanged(...args);
    });
  }
  bindEvent(eventSource, types.MESSAGE_DELETED, () => {
    invalidateMemoryTasks();
    if (state.busy || isGenerating()) return;
    try {
      syncLiveChat();
    } catch (error) {
      if (error.code === "STORY_BRANCH_PROTECTED_CHANGE") restoreProtectedProjection(error);
      else toast("warning", error.message);
      return;
    }
    refreshUi();
  });
  bindEvent(eventSource, types.CHAT_CHANGED, handleChatLoaded);
  bindEvent(eventSource, types.CHAT_LOADED, handleChatLoaded);
  bindEvent(eventSource, types.MORE_MESSAGES_LOADED, () => { if (!state.busy) renderForkButtons(); });
  bindEvent(eventSource, types.GENERATION_ENDED, handleMessageChanged);
  bindEvent(eventSource, types.GENERATION_STOPPED, handleMessageChanged);
}

function installUi(menu, markup) {
  const template = document.createElement("div");
  template.innerHTML = markup;
  const launcher = template.querySelector("#story-branch-tree-launcher");
  const panel = document.getElementById("story-branch-tree");
  const newPanel = template.querySelector("#story-branch-tree");
  const confirmDialog = template.querySelector("#story-branch-tree-confirm");
  if (!panel && newPanel) document.body.append(newPanel);
  if (confirmDialog) document.body.append(confirmDialog);
  const treePanel = panel ?? newPanel;
  if (launcher) menu.append(launcher);
  if (!treePanel || !launcher) return;
  panelClickHandler = async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    if (button.dataset.action === "show-end" && suppressEndClickBranchId === button.dataset.branchId) {
      suppressEndClickBranchId = null;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (suppressForkClick && (suppressForkClick === button || suppressForkClick.contains(button))) {
      suppressForkClick = null;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    try {
      if (button.dataset.action === "back-to-tree") openTree();
      if (button.dataset.action === "mode-single") await chooseStoryMode("single");
      if (button.dataset.action === "mode-native") await chooseStoryMode("native");
      if (button.dataset.action === "story-library") await openStoryLibrary();
      if (button.dataset.action === "library-rebuild") await openStoryLibrary(true);
      if (button.dataset.action === "legacy-find") await findLegacyStory();
      if (button.dataset.action === "legacy-cancel") {
        if (legacySearch) legacySearch.abort();
        else await openStoryLibrary();
      }
      if (button.dataset.action === "legacy-accept") {
        if (!legacyPlan || state.busy || isGenerating()) throw Error("请先完成查找。");
        const names = [...treePanel.querySelectorAll('[data-role="legacy-choice"]:checked')].map(input => input.value);
        if (names.length < 2) throw Error("至少选择两条可用记录。");
        openConfirmation({ kind: "adopt-legacy", plan: legacyPlan, names }, "整理已有原生分支",
          `将所选 ${names.length} 条记录整理为一个故事吗？各文件、正文和记忆分别保留。整理期间请勿在其他设备编辑这些聊天。`, "确认整理");
      }
      if (button.dataset.action === "library-original") {
        originalListOnce = true;
        closeTree();
        document.getElementById("option_select_chat")?.click();
      }
      if (button.dataset.action === "library-open") {
        const entry = libraryEntries[Number(button.dataset.entry)];
        if (!entry) throw Error("列表已改变，请重新打开。");
        const current = entry.routes.find(route => route.chatName === context().chatId);
        const route = current ?? [...entry.routes].sort((a, b) => b.updated - a.updated)[0];
        await openLibraryChat(route.chatName);
      }
      if (button.dataset.action === "library-chat") await openLibraryChat(button.dataset.chatName);
      if (button.dataset.action === "library-routes") {
        const list = button.closest("article").querySelector('[data-role="library-routes"]');
        list.hidden = !list.hidden;
      }
      if (button.dataset.action === "library-export") {
        const entry = libraryEntries[Number(button.dataset.entry)];
        if (entry?.storyId) await exportNativeStory(true, entry.storyId);
      }
      if (button.dataset.action === "library-delete") {
        const entry = libraryEntries[Number(button.dataset.entry)];
        if (entry?.storyId) openConfirmation({ kind: "delete-story", storyId: entry.storyId, files: entry.routes.map(route => route.chatName) }, "删除整个故事",
          `删除「${entry.title}」的全部 ${entry.routes.length} 条路线及聊天文件吗？此操作无法撤销。`, "删除整个故事");
      }
      if (button.dataset.action === "export-route") await exportNativeStory(false);
      if (button.dataset.action === "import-story") treePanel.querySelector('[data-role="story-import"]').click();
      if (button.dataset.action === "reply-next" || button.dataset.action === "reply-previous") {
        const preview = checkedNativePreview();
        const count = preview.message.swipes.length;
        showNativeReply(preview.index, (preview.swipeId + (button.dataset.action === "reply-next" ? 1 : -1) + count) % count);
      }
      if (button.dataset.action === "reply-create") {
        const preview = checkedNativePreview();
        openConfirmation({ kind: "native-reply" }, "从预览回复继续", `从第 ${preview.index + 1} 楼回复 ${preview.swipeId + 1} 创建新的原生路线吗？原路线后续保留。`, "创建并继续");
      }
      if (button.dataset.action === "reply-existing") {
        const preview = checkedNativePreview();
        if (!nativeStorage.replyRoutes(preview.index, preview.swipeId).some(entry => entry.route.id === button.dataset.branchId)) throw Error("对应路线已改变，请重新预览。");
        await activateBranch(button.dataset.branchId);
        closeFloorDetail();
        closeTree();
      }
      if (button.dataset.action === "close-tree") closeTree();
      if (button.dataset.action === "zoom-in") zoomAt(view.scale * 1.2);
      if (button.dataset.action === "zoom-out") zoomAt(view.scale / 1.2);
      if (button.dataset.action === "zoom-reset") fitView();
      if (button.dataset.action === "focus-current") focusCurrentBranch();
      if (button.dataset.action === "auto-arrange") await autoArrangeTree();
      if (button.dataset.action === "toggle-view") {
        compactView = !compactView;
        updateViewToggle(button);
        view.needsFit = true;
        renderTree();
      }
      if (button.dataset.action === "note-save") {
        const editor = treePanel.querySelector('[data-role="note-editor"]');
        const titleInput = editor.querySelector('[data-role="branch-name"]');
        const pointNameInput = editor.querySelector('[data-role="point-name"]');
        const branchSummaryInput = editor.querySelector('[data-role="branch-summary"]');
        const pointSummaryInput = editor.querySelector('[data-role="point-summary"]');
        const noteInput = editor.querySelector('[data-role="note-input"]');
        const mode = editor.dataset.mode;
        if (mode === "branch") pendingNoteEditor?.finish({ title: titleInput.value, summary: branchSummaryInput.value, note: noteInput.value });
        else if (mode === "node") pendingNoteEditor?.finish({ pointName: pointNameInput.value, summary: pointSummaryInput.value, note: noteInput.value });
        else pendingNoteEditor?.finish(noteInput.value);
      }
      if (button.dataset.action === "note-cancel") pendingNoteEditor?.finish(null);
      if (button.dataset.action === "delete-branch") {
        const branchId = treePanel.querySelector('[data-role="note-editor"]')?.dataset.branchId;
        if (branchId) openDeleteBranchConfirm(branchId);
      }
      if (button.dataset.action === "show-end") await showEndDetail(button.dataset.branchId);
      if (button.dataset.action === "close-floor-detail") closeFloorDetail();
      if (button.dataset.action === "confirm-branch-switch") openBranchSwitchConfirm(button.dataset.branchId);
      if (button.dataset.action === "confirm-cancel") closeConfirmation();
      if (button.dataset.action === "confirm-accept") await confirmPendingAction();
      if (button.dataset.action === "edit-branch-note") await editBranchNote(button.dataset.branchId);
      if (button.dataset.action === "edit-node-note") await editNodeNote(button.dataset.branchId);
      if (button.dataset.action === "return-to-node") openNodeForkConfirm(button.dataset.branchId);
    } catch (error) {
      toast("warning", error.message);
    }
  };
  treePanel.querySelector('[data-role="note-editor"]')?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) pendingNoteEditor?.finish(null);
  });
  treePanel.querySelector('[data-role="floor-detail"]')?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeFloorDetail();
  });
  confirmDialog?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeConfirmation();
  });
  treePanel.addEventListener("click", panelClickHandler);
  treePanel.querySelector('[data-role="story-import"]')?.addEventListener("change", async event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const owner = context().chatId;
      const characterId = context().characterId;
      const bundle = JSON.parse(await file.text());
      if (context().chatId !== owner || context().characterId !== characterId) throw Error("聊天已改变，请重新选择导入文件。");
      await runNative(() => nativeStorage.importStory(bundle, () => { state.routeSwitching = false; }));
      openTree();
    } catch (error) { toast("error", error.message); }
  });
  confirmDialog?.addEventListener("click", panelClickHandler);
  treePanel.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches('.story-branch-tree__compact-tail, .story-branch-tree__compact-label-button')) {
      event.preventDefault();
      event.target.click();
    }
  });
  launcher.addEventListener("click", openTree);
  launcher.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openTree(); }
  });
  const canvas = treePanel.querySelector('[data-role="canvas"]');
  canvasPointerHandler = (event) => {
    if (event.pointerType === "touch") {
      if (event.type === "pointerdown") {
        activeTouchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (activeTouchPointers.size >= 2) {
          if (!pinchGesture && activeTouchPointers.size === 2) startPinchGesture(canvas);
          if (pinchGesture) {
            event.preventDefault();
            try { canvas.setPointerCapture(event.pointerId); } catch {}
            return;
          }
        }
      } else if (event.type === "pointermove") {
        if (activeTouchPointers.has(event.pointerId)) activeTouchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pinchGesture?.pointerIds.includes(event.pointerId)) {
          event.preventDefault();
          updatePinchGesture(canvas);
          return;
        }
      } else if (event.type === "pointerup" || event.type === "pointercancel") {
        activeTouchPointers.delete(event.pointerId);
        if (pinchGesture?.pointerIds.includes(event.pointerId)) {
          const isDraggedPointer = cardPointer?.pointerId === event.pointerId;
          pinchGesture = null;
          if (!isDraggedPointer) {
            view.dragging = false;
            canvas.classList.remove("is-dragging");
            if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
            return;
          }
        }
      }
    }
    if (event.type === "pointerdown") {
      const ending = event.target.closest(".story-branch-tree__compact-tail, .story-branch-tree__ending");
      if (ending) {
        const branchId = ending.dataset.branchId;
        const position = renderedLayout?.compact
          ? renderedLayout.leaves.get(branchId)
          : renderedLayout?.endPositions.get(branchId);
        if (!position) return;
        event.preventDefault();
        cardPointer = {
          kind: renderedLayout.compact ? "compact-tail" : "ending",
          branchId,
          mode: event.pointerType === "touch" ? "pending-end" : "ending",
          startX: event.clientX,
          startY: event.clientY,
          originX: position.x,
          originY: position.y,
          hadManualEnd: !renderedLayout.compact && renderedLayout.manualEnds.has(branchId),
          moved: false,
          pointerId: event.pointerId,
          timer: null,
        };
        canvas.setPointerCapture(event.pointerId);
        if (cardPointer.mode === "pending-end") {
          const pointer = cardPointer;
          pointer.timer = window.setTimeout(() => {
            if (cardPointer !== pointer || pointer.mode !== "pending-end") return;
            pointer.mode = "ending";
            canvas.classList.add("is-dragging");
          }, 420);
        } else {
          canvas.classList.add("is-dragging");
        }
        return;
      }
      const compactLabel = event.target.closest(".story-branch-tree__compact-label-button");
      if (compactLabel && !compactLabel.closest(".story-branch-tree__compact-route")) return;
      const compactRoute = event.target.closest(".story-branch-tree__compact-route");
      if (compactRoute && renderedLayout?.compact) {
        event.preventDefault();
        const targetForkId = compactRoute.dataset.targetForkId;
        const leafBranchId = compactRoute.dataset.leafBranchId;
        const position = targetForkId
          ? renderedLayout.hubPositions.get(targetForkId)
          : renderedLayout.leaves.get(leafBranchId);
        if (!position) return;
        cardPointer = {
          kind: "compact-route",
          routeElement: compactRoute,
          branchId: compactRoute.dataset.branchId,
          labelBranchId: compactLabel?.dataset.branchId,
          targetForkId,
          leafBranchId,
          mode: event.pointerType === "touch" || compactLabel ? "pending-route" : "compact-route",
          startX: event.clientX,
          startY: event.clientY,
          originX: position.x,
          originY: position.y,
          moved: false,
          pointerId: event.pointerId,
          timer: null,
        };
        canvas.setPointerCapture(event.pointerId);
        if (cardPointer.mode === "pending-route") {
          const pointer = cardPointer;
          pointer.timer = window.setTimeout(() => {
            if (cardPointer !== pointer || pointer.mode !== "pending-route") return;
            pointer.mode = "compact-route";
            canvas.classList.add("is-dragging");
          }, 420);
        }
        return;
      }
      const pointButton = event.target.closest(".story-branch-tree__fork-point");
      if (pointButton) {
        event.preventDefault();
        const compactPoint = renderedLayout?.compact ? pointButton.closest(".story-branch-tree__compact-point") : null;
        const hub = compactPoint ?? pointButton.closest(".story-branch-tree__fork-hub");
        const forkId = hub?.dataset.forkId;
        const position = renderedLayout?.hubPositions.get(forkId);
        if (!hub || !forkId || !position) return;
        cardPointer = {
          kind: compactPoint ? "compact-fork" : "fork",
          forkId,
          element: hub,
          pointButton,
          mode: event.pointerType === "touch" ? "pending" : "fork",
          startX: event.clientX,
          startY: event.clientY,
          originX: position.x,
          originY: position.y,
          moved: false,
          pointerId: event.pointerId,
          timer: null,
        };
        canvas.setPointerCapture(event.pointerId);
        if (cardPointer.mode === "pending") {
          const pointer = cardPointer;
          pointer.timer = window.setTimeout(() => {
            if (cardPointer !== pointer || pointer.mode !== "pending") return;
            pointer.mode = "fork";
            canvas.classList.add("is-dragging");
          }, 420);
        } else {
          canvas.classList.add("is-dragging");
        }
        return;
      }
      if (event.target.closest("button")) return;
      const card = event.target.closest(".story-branch-tree__card");
      if (card) {
        event.preventDefault();
        const branchId = card.dataset.branchId;
        const position = renderedLayout?.positions.get(branchId);
        if (!position) return;
        cardPointer = {
          kind: "card",
          branchId,
          element: card,
          mode: event.pointerType === "touch" ? "pending-card" : "card",
          startX: event.clientX,
          startY: event.clientY,
          originX: position.x,
          originY: position.y,
          moved: false,
          pointerId: event.pointerId,
          timer: null,
        };
        canvas.setPointerCapture(event.pointerId);
        if (cardPointer.mode === "pending-card") {
          const pointer = cardPointer;
          pointer.timer = window.setTimeout(() => {
            if (cardPointer !== pointer || pointer.mode !== "pending-card") return;
            pointer.mode = "card";
            canvas.classList.add("is-dragging");
          }, 420);
        } else {
          canvas.classList.add("is-dragging");
        }
        return;
      }
      view.dragging = true;
      view.pointerId = event.pointerId;
      view.startX = event.clientX;
      view.startY = event.clientY;
      view.originX = view.x;
      view.originY = view.y;
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add("is-dragging");
    } else if (event.type === "pointermove" && cardPointer && event.pointerId === cardPointer.pointerId) {
      if (cardPointer.mode === "pending-card" || cardPointer.mode === "pending" || cardPointer.mode === "pending-route" || cardPointer.mode === "pending-end") {
        if (Math.hypot(event.clientX - cardPointer.startX, event.clientY - cardPointer.startY) > 12) {
          clearTimeout(cardPointer.timer);
          const dragMode = {
            "pending-card": "card",
            pending: "fork",
            "pending-route": "compact-route",
            "pending-end": "ending",
          }[cardPointer.mode];
          if (dragMode) {
            cardPointer.mode = dragMode;
            cardPointer.moved = true;
            canvas.classList.add("is-dragging");
          } else {
            cardPointer.mode = "pan";
            cardPointer.moved = true;
            view.dragging = true;
            view.pointerId = event.pointerId;
            view.startX = cardPointer.startX;
            view.startY = cardPointer.startY;
            view.originX = view.x;
            view.originY = view.y;
          }
        }
      }
      if (cardPointer.mode === "ending") {
        const layout = renderedLayout;
        const position = cardPointer.kind === "compact-tail"
          ? layout?.leaves.get(cardPointer.branchId)
          : layout?.endPositions.get(cardPointer.branchId);
        if (position && Math.hypot(event.clientX - cardPointer.startX, event.clientY - cardPointer.startY) > 4) {
          position.x = cardPointer.originX + (event.clientX - cardPointer.startX) / view.scale;
          position.y = cardPointer.originY + (event.clientY - cardPointer.startY) / view.scale;
          if (layout.compact) layout.updateCompactEdges();
          else {
            layout.manualEnds.set(cardPointer.branchId, { x: position.x, y: position.y });
            updateLayoutBounds(layout);
          }
          cardPointer.moved = true;
        }
      } else if (cardPointer.mode === "card" || cardPointer.mode === "fork" || cardPointer.mode === "compact-route") {
        const layout = renderedLayout;
        const position = cardPointer.kind === "fork" || cardPointer.kind === "compact-fork"
          ? layout?.hubPositions.get(cardPointer.forkId)
          : cardPointer.kind === "compact-route"
            ? cardPointer.targetForkId
              ? layout?.hubPositions.get(cardPointer.targetForkId)
              : layout?.leaves.get(cardPointer.leafBranchId)
            : layout?.positions.get(cardPointer.branchId);
        if (position) {
          position.x = cardPointer.originX + (event.clientX - cardPointer.startX) / view.scale;
          position.y = cardPointer.originY + (event.clientY - cardPointer.startY) / view.scale;
          if (layout?.compact) {
            const forkId = cardPointer.kind === "compact-fork" ? cardPointer.forkId : cardPointer.targetForkId;
            if (forkId) {
              const point = layout.world.querySelector(`[data-fork-id="${CSS.escape(forkId)}"]`);
              if (point) {
                point.style.left = `${position.x}px`;
                point.style.top = `${position.y}px`;
              }
            }
            layout.updateCompactEdges();
          } else {
            cardPointer.element.style.left = `${position.x}px`;
            cardPointer.element.style.top = `${position.y}px`;
            updateLayoutBounds(layout);
          }
          cardPointer.moved ||= Math.hypot(event.clientX - cardPointer.startX, event.clientY - cardPointer.startY) > 4;
        }
      } else if (cardPointer.mode === "pan") {
        view.x = view.originX + event.clientX - view.startX;
        view.y = view.originY + event.clientY - view.startY;
        applyView();
      }
    } else if (event.type === "pointermove" && view.dragging && event.pointerId === view.pointerId) {
      view.x = view.originX + event.clientX - view.startX;
      view.y = view.originY + event.clientY - view.startY;
      applyView();
    } else if (event.type === "pointerup" || event.type === "pointercancel") {
      if (cardPointer && event.pointerId === cardPointer.pointerId) {
        const pointer = cardPointer;
        clearTimeout(pointer.timer);
        cardPointer = null;
        if (pointer.kind === "compact-tail" || pointer.kind === "ending") {
          if (pointer.mode === "ending" && pointer.moved && event.type === "pointerup") {
            const position = pointer.kind === "compact-tail"
              ? renderedLayout?.leaves.get(pointer.branchId)
              : renderedLayout?.endPositions.get(pointer.branchId);
            if (position) {
              const save = pointer.kind === "compact-tail"
                ? saveCompactPosition("leaves", pointer.branchId, position, renderedLayout.narrow)
                : saveEndingPosition(pointer.branchId, position, renderedLayout.narrow);
              save.catch((error) => toast("warning", error.message));
            }
          } else if (pointer.mode === "ending" && pointer.moved && event.type === "pointercancel") {
            if (pointer.kind === "compact-tail") {
              const position = renderedLayout?.leaves.get(pointer.branchId);
              if (position) {
                position.x = pointer.originX;
                position.y = pointer.originY;
                renderedLayout.updateCompactEdges();
              }
            } else if (renderedLayout) {
              if (pointer.hadManualEnd) renderedLayout.manualEnds.set(pointer.branchId, { x: pointer.originX, y: pointer.originY });
              else renderedLayout.manualEnds.delete(pointer.branchId);
              updateLayoutBounds(renderedLayout);
            }
          } else if (!pointer.moved && event.type === "pointerup") {
            showEndDetail(pointer.branchId).catch(error => toast("warning", error.message));
          }
          suppressEndClickBranchId = pointer.branchId;
          window.setTimeout(() => { if (suppressEndClickBranchId === pointer.branchId) suppressEndClickBranchId = null; }, 0);
        } else if ((pointer.mode === "card" || pointer.mode === "fork" || pointer.mode === "compact-route") && pointer.moved) {
          if (pointer.kind === "compact-fork") {
            const position = renderedLayout?.hubPositions.get(pointer.forkId);
            if (position) saveCompactPosition("points", pointer.forkId, position, renderedLayout.narrow).catch((error) => toast("warning", error.message));
            suppressForkClick = pointer.pointButton;
            window.setTimeout(() => { if (suppressForkClick === pointer.pointButton) suppressForkClick = null; }, 0);
          } else if (pointer.kind === "compact-route") {
            const kind = pointer.targetForkId ? "points" : "leaves";
            const id = pointer.targetForkId ?? pointer.leafBranchId;
            const position = pointer.targetForkId
              ? renderedLayout?.hubPositions.get(id)
              : renderedLayout?.leaves.get(id);
            if (position) saveCompactPosition(kind, id, position, renderedLayout.narrow).catch((error) => toast("warning", error.message));
            suppressForkClick = pointer.routeElement;
            window.setTimeout(() => { if (suppressForkClick === pointer.routeElement) suppressForkClick = null; }, 0);
          } else if (pointer.kind === "fork") {
            const position = renderedLayout?.hubPositions.get(pointer.forkId);
            if (position) saveForkPosition(pointer.forkId, position, renderedLayout.narrow).catch((error) => toast("warning", error.message));
            suppressForkClick = pointer.pointButton;
            window.setTimeout(() => { if (suppressForkClick === pointer.pointButton) suppressForkClick = null; }, 0);
          } else {
            const position = renderedLayout?.positions.get(pointer.branchId);
            if (position) saveCardPosition(pointer.branchId, position).catch((error) => toast("warning", error.message));
          }
        } else if (pointer.kind === "compact-route" && !pointer.moved && event.type === "pointerup") {
          // Pointer capture targets the canvas on release, so the SVG label cannot
          // rely on the browser's subsequent click to reach its route action.
          if (pointer.labelBranchId) {
            try { openBranchSwitchConfirm(pointer.labelBranchId); }
            catch (error) { toast("warning", error.message); }
          }
          else editBranchNote(pointer.branchId).catch((error) => toast("warning", error.message));
          suppressForkClick = pointer.routeElement;
          window.setTimeout(() => { if (suppressForkClick === pointer.routeElement) suppressForkClick = null; }, 0);
        } else if ((pointer.kind === "fork" || pointer.kind === "compact-fork") && !pointer.moved && event.type === "pointerup") {
          editNodeNote(pointer.pointButton.dataset.branchId).catch((error) => toast("warning", error.message));
          suppressForkClick = pointer.pointButton;
          window.setTimeout(() => { if (suppressForkClick === pointer.pointButton) suppressForkClick = null; }, 0);
        } else if (pointer.kind === "compact-route" && pointer.mode === "pan" && pointer.moved) {
          suppressForkClick = pointer.routeElement;
          window.setTimeout(() => { if (suppressForkClick === pointer.routeElement) suppressForkClick = null; }, 0);
        }
        if (pointer.mode === "card" || pointer.mode === "fork" || pointer.mode === "compact-route" || pointer.mode === "ending") canvas.classList.remove("is-dragging");
      }
      if (view.dragging && event.pointerId === view.pointerId) {
        view.dragging = false;
        canvas.classList.remove("is-dragging");
      }
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    }
  };
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) canvas.addEventListener(type, canvasPointerHandler);
  canvasWheelHandler = (event) => {
    event.preventDefault();
    zoomAt(view.scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX, event.clientY);
  };
  canvas.addEventListener("wheel", canvasWheelHandler, { passive: false });
  canvasKeyHandler = (event) => {
    if (event.key !== "Escape") return;
    if (confirmDialog && !confirmDialog.hidden) closeConfirmation();
    else if (treePanel.hidden) return;
    else if (pendingNoteEditor) pendingNoteEditor.finish(null);
    else if (!treePanel.querySelector('[data-role="floor-detail"]').hidden) closeFloorDetail();
    else closeTree();
  };
  document.addEventListener("keydown", canvasKeyHandler);
  chatClickHandler = (event) => {
    if (event.target.closest("#option_select_chat")) {
      if (originalListOnce) { originalListOnce = false; return; }
      const ctx = context();
      const avatar = ctx?.characters?.[ctx.characterId]?.avatar;
      const entries = ctx?.extensionSettings?.storyBranchTreeCatalog?.characters?.[avatar]?.routes;
      if (isSoloChat(ctx) && entries && Object.keys(entries).length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openStoryLibrary().catch(error => toast("warning", error.message));
        return;
      }
    }
    const arrow = event.target.closest(".swipe_left, .swipe_right");
    const historicalRow = arrow?.closest(".mes.story-branch-tree__history-swipes");
    if (historicalRow) {
      const messageIndex = Number(historicalRow.getAttribute("mesid"));
      if (storyMode(context()) === "native") {
        event.preventDefault();
        event.stopImmediatePropagation();
        switchHistoricalReply(messageIndex, arrow.classList.contains("swipe_right") ? 1 : -1).catch(error => toast("warning", error.message));
        return;
      }
      const tree = graphFrom(context());
      const reply = tree && historicalReplySource(tree, messageIndex);
      if (historicalRow.classList.contains("last_mes") && arrow.classList.contains("swipe_right")
        && reply && reply.currentIndex === reply.source.swipes.length - 1) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      switchHistoricalReply(messageIndex, arrow.classList.contains("swipe_right") ? 1 : -1)
        .catch((error) => toast("warning", error.message));
      return;
    }
    const button = event.target.closest(".story-branch-tree__fork-button");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const messageId = button.closest(".mes")?.getAttribute("mesid");
      const messageIndex = messageId === null || messageId === undefined ? NaN : Number(messageId);
      if (button.dataset.action === "create-swipe-branch") openSwipeBranchConfirm(messageIndex);
      else openMessageForkConfirm(messageIndex);
    } catch (error) {
      toast("warning", error.message);
    }
  };
  document.addEventListener("click", chatClickHandler, true);
  pendingSendGuard = handlePendingSend;
  document.addEventListener("click", pendingSendGuard, true);
  document.addEventListener("keydown", pendingSendGuard, true);
}

function handlePendingSend(event) {
    const ctx = context();
    const branch = graphFrom(ctx)?.branches?.[graphFrom(ctx)?.activeBranchId];
    if (!isSoloChat(ctx)) return;
    const clickSend = event.type === "click" && event.target.closest?.("#send_but");
    const keySend = event.type === "keydown" && event.target.id === "send_textarea"
      && event.key === "Enter" && !event.isComposing && !event.shiftKey && !event.altKey
      && (!event.ctrlKey || Boolean(event.target.value)) && shouldSendOnEnter();
    if (!clickSend && !keySend) return;
    if (state.routeSwitching) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toast("info", "正在切换剧情路线并恢复记忆，请稍候再发送。");
      return;
    }
    if (isMemoryBlocked(ctx)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toast("warning", "当前路线记忆恢复失败，请在剧情树中再次选择当前路线重试。");
      return;
    }
    if (!branch?.pendingSwipe || state.busy) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      openConfirmation({ kind: "send-pending", branchId: branch.id, floorCount: ctx.chat.length },
        "从当前回复继续", `发送下一楼后，将从第 ${ctx.chat.length} 楼的回复 ${branch.sourceSwipeIndex + 1} 创建新分支。原路线会保留，是否继续发送？`, "创建分支并发送");
    } catch (error) {
      toast("warning", error.message);
    }
}

export async function activate() {
  extensionEnabled = true;
  const ctx = context();
  if (!ctx) return;
  const menu = document.getElementById("extensionsMenu");
  if (!menu || document.getElementById("story-branch-tree")) return;
  try {
    const markup = await ctx.renderExtensionTemplateAsync(EXTENSION_FOLDER, "settings", {});
    installUi(menu, markup);
  } catch (error) {
    console.error("[StoryBranchTree] Could not load settings panel", error);
    return;
  }
  installEvents(ctx);
  installPublicApi();
  await handleChatLoaded();
  console.info("[StoryBranchTree] Ready");
}

export function disable() {
  extensionEnabled = false;
  nativeStorage.epoch++;
  for (const [source, eventName, handler] of eventHandlers.splice(0)) {
    source.removeListener(eventName, handler);
  }
  const panel = document.getElementById("story-branch-tree");
  const confirmDialog = document.getElementById("story-branch-tree-confirm");
  if (panel && panelClickHandler) panel.removeEventListener("click", panelClickHandler);
  if (confirmDialog && panelClickHandler) confirmDialog.removeEventListener("click", panelClickHandler);
  if (panel && canvasPointerHandler) {
    const canvas = panel.querySelector('[data-role="canvas"]');
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) canvas?.removeEventListener(type, canvasPointerHandler);
    if (canvas && canvasWheelHandler) canvas.removeEventListener("wheel", canvasWheelHandler);
  }
  if (canvasKeyHandler) document.removeEventListener("keydown", canvasKeyHandler);
  if (chatClickHandler) document.removeEventListener("click", chatClickHandler, true);
  if (pendingSendGuard) {
    document.removeEventListener("click", pendingSendGuard, true);
    document.removeEventListener("keydown", pendingSendGuard, true);
  }
  panelClickHandler = null;
  chatClickHandler = null;
  pendingSendGuard = null;
  canvasPointerHandler = null;
  canvasWheelHandler = null;
  canvasKeyHandler = null;
  clearTimeout(cardPointer?.timer);
  cardPointer = null;
  activeTouchPointers.clear();
  pinchGesture = null;
  suppressEndClickBranchId = null;
  renderedLayout = null;
  pendingModeAction = null;
  nativePreview = null;
  libraryEntries = [];
  legacySearch?.abort();
  legacySearch = null;
  legacyPlan = null;
  originalListOnce = false;
  nativePrepared = [];
  nativeChangeOwner = null;
  nativeStorage.cachedView = null;
  removePublicApi();
  pendingNoteEditor?.finish(null);
  pendingNoteEditor = null;
  pendingConfirmation = null;
  state.busy = false;
  state.routeSwitching = false;
  panel?.remove();
  confirmDialog?.remove();
  document.getElementById("story-branch-tree-launcher")?.remove();
  document.body.classList.remove("story-branch-tree-open");
  document.body.classList.remove("story-branch-tree-confirm-open");
  document.querySelectorAll(".story-branch-tree__fork-button").forEach((button) => button.remove());
  document.querySelectorAll(".mes.story-branch-tree__history-swipes").forEach(row => {
    row.classList.remove("story-branch-tree__history-swipes");
    row.querySelector(".swipes-counter")?.removeAttribute("data-story-swipe-count");
  });
}
