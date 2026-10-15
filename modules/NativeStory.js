import { getStoryMessageId, setStoryMessageId, copyStoryMessageIdentity } from "./StoryTree.js?v=0.1.72";
import { legacyComponent, legacyDigest, summarizeLegacy } from "./LegacyNative.js?v=0.1.72";

export const NATIVE_KEY = "story_branch_tree_native";
export const MODE_KEY = "story_branch_tree_mode";
const SETTINGS_KEY = "storyBranchTreeCatalog";
const uuid = () => globalThis.crypto?.randomUUID?.() ?? `story-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const nameOf = value => String(value ?? "").replace(/\.jsonl$/i, "");
const excerpt = value => String(value ?? "").slice(0, 150);
const safeKey = value => typeof value === "string" && value && !["__proto__", "constructor", "prototype"].includes(value);

export function storyMode(ctx) {
  const metadata = ctx?.chatMetadata;
  if ((metadata?.story_branch_tree || metadata?.[MODE_KEY] === "single") && metadata?.[NATIVE_KEY]) throw Error("聊天同时含有两种剧情存档，请先恢复正确的存档。");
  if (metadata?.story_branch_tree || metadata?.[MODE_KEY] === "single") return "single";
  if (metadata?.[NATIVE_KEY]) return "native";
  return null;
}

function validMetadata(value) {
  return value?.version === 1 && safeKey(value.storyId) && safeKey(value.rootRouteId)
    && safeKey(value.route?.id) && Number.isSafeInteger(value.route?.endFloor) && value.route.endFloor >= 0;
}

export function ensureNativeIdentities(messages) {
  const seen = new Set();
  for (const message of messages) {
    let id = getStoryMessageId(message);
    if (!id || seen.has(id)) id = uuid();
    setStoryMessageId(message, id);
    seen.add(id);
    if (!Array.isArray(message.swipes)) continue;
    if (!Array.isArray(message.swipe_info)) message.swipe_info = [];
    const variants = new Set();
    for (let index = 0; index < message.swipes.length; index++) {
      const saved = message.swipe_info[index];
      const info = message.swipe_info[index] = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
      if (!info.extra || typeof info.extra !== "object" || Array.isArray(info.extra)) info.extra = {};
      let variant = info.extra.story_branch_tree_variant_id;
      if (typeof variant !== "string" || !variant || variants.has(variant)) variant = uuid();
      info.extra.story_branch_tree_variant_id = variant;
      variants.add(variant);
    }
    setStoryMessageId(message, id);
    const selected = message.swipe_info[message.swipe_id ?? 0]?.extra?.story_branch_tree_variant_id;
    if (selected) message.extra.story_branch_tree_variant_id = selected;
  }
}

export function nativeRows(tree) {
  const rows = [];
  const seen = new Set();
  const byParent = new Map();
  for (const route of Object.values(tree.branches)) {
    const siblings = byParent.get(route.parentBranchId) ?? [];
    siblings.push(route);
    byParent.set(route.parentBranchId, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => (a.forkFloor ?? 0) - (b.forkFloor ?? 0) || a.createdAt - b.createdAt
    || (a.createdOrder ?? 0) - (b.createdOrder ?? 0) || a.id.localeCompare(b.id));
  const visit = (parentId, depth, number) => {
    const children = byParent.get(parentId) ?? [];
    const counts = new Map();
    for (const [index, route] of children.entries()) {
      if (seen.has(route.id)) throw Error("故事路线包含循环关系。");
      seen.add(route.id);
      const kind = parentId === null ? "root" : route.branchKind ?? "continuation";
      const floor = route.forkFloor ?? 0;
      const key = `${kind}:${route.forkMessageId}:${route.sourceMessageId ?? ""}:${route.forkVariantId ?? ""}`;
      const ordinal = (counts.get(key) ?? 0) + 1;
      counts.set(key, ordinal);
      const branchNumber = parentId === null ? `${index + 1}` : `${number}.${kind === "swipe" ? "R" : ""}${route.legacyForkUnknown ? "?" : floor}.${ordinal}`;
      rows.push({ ...route, kind, depth, branchNumber,
        forkIndex: kind === "swipe" ? floor - 2 : floor - 1, displayForkIndex: floor - 1,
        variantKey: route.forkVariantId ?? "native", replyIndex: route.sourceSwipeIndex,
        nodeKey: kind === "swipe" ? `reply:${parentId}:${route.sourceMessageId}` : `fork:${parentId}:${route.forkMessageId}:${route.forkVariantId ?? "native"}`,
      });
      visit(route.id, depth + 1, branchNumber);
    }
  };
  visit(null, 0, "");
  if (rows.length !== Object.keys(tree.branches).length) throw Error("故事路线关系不完整，请重建分组或查看原始记录。");
  return rows;
}

/** Native chat files own route data. Settings contain only a rebuildable catalog. */
export class NativeStoryStorage {
  constructor(getContext, { fork, selectSwipe, prepare, complete, aborted } = {}) {
    this.context = getContext;
    this.forkCore = fork;
    this.selectSwipe = selectSwipe;
    this.prepare = prepare;
    this.complete = complete;
    this.aborted = aborted;
    this.revision = 0;
    this.epoch = 0;
    this.cachedView = null;
    this.legacyPlans = new WeakMap();
  }
  owner(ctx = this.context()) {
    const character = ctx?.characters?.[ctx.characterId];
    if (!character?.avatar || ctx.groupId != null || !ctx.chatId) throw Error("请先打开一条单人角色聊天。");
    return { avatar: character.avatar, name: character.name, chatName: nameOf(ctx.chatId), chat: ctx.chat, ctx, epoch: this.epoch };
  }
  assertOwner(owner) {
    if (owner.epoch !== this.epoch) throw Error("原生故事操作已取消。");
    const ctx = this.context();
    if (ctx?.chat !== owner.chat || nameOf(ctx.chatId) !== owner.chatName
      || ctx.characters?.[ctx.characterId]?.avatar !== owner.avatar || ctx.groupId != null) throw Error("当前聊天已改变，已停止旧故事操作。");
  }
  assertTarget(owner, chatName, routeId) {
    if (owner.epoch !== this.epoch || this.owner().avatar !== owner.avatar || nameOf(this.context().chatId) !== nameOf(chatName)
      || this.metadata()?.route.id !== routeId) throw Error("目标路线已改变，已停止旧操作。");
  }
  catalog(ctx = this.context()) {
    const settings = ctx.extensionSettings;
    if (!settings) throw Error("当前酒馆未提供扩展设置存储。");
    const all = settings[SETTINGS_KEY] ??= { version: 1, characters: {} };
    const avatar = this.owner(ctx).avatar;
    return all.characters[avatar] ??= { routes: {}, views: {} };
  }
  changed() {
    this.revision++;
    this.cachedView = null;
    this.context()?.saveSettingsDebounced?.();
  }
  metadata(ctx = this.context()) {
    const value = ctx?.chatMetadata?.[NATIVE_KEY];
    if (!value) return null;
    if (!validMetadata(value)) throw Error("原生路线描述无效，请查看原始聊天记录。");
    return value;
  }
  remember(metadata, chatName, ctx = this.context()) {
    if (!validMetadata(metadata)) throw Error("原生路线描述无效。");
    this.catalog(ctx).routes[metadata.route.id] = { ...structuredClone(metadata), chatName: nameOf(chatName) };
    this.changed();
  }
  async initialize() {
    const ctx = this.context();
    const owner = this.owner(ctx);
    if (storyMode(ctx)) throw Error("这个故事已经选定存储模式，不能混用。");
    ensureNativeIdentities(ctx.chat);
    const id = uuid();
    const metadata = { version: 1, storyId: uuid(), rootRouteId: id, storyTitle: owner.chatName,
      route: { id, parentBranchId: null, title: "主线", createdAt: Date.now(), createdOrder: 0, endFloor: ctx.chat.length, endSummary: excerpt(ctx.chat.at(-1)?.mes), replies: {} } };
    ctx.updateChatMetadata({ [NATIVE_KEY]: metadata });
    await ctx.saveChat();
    this.assertOwner(owner);
    this.remember(metadata, owner.chatName);
    return this.view();
  }
  syncCurrent() {
    const ctx = this.context();
    const value = this.metadata(ctx);
    if (!value) return null;
    ensureNativeIdentities(ctx.chat);
    const tracked = new Set(Object.values(this.catalog(ctx).routes).filter(entry => entry.storyId === value.storyId)
      .flatMap(entry => [entry.route.sourceMessageId, ...Object.keys(entry.route.replies ?? {})]).filter(Boolean));
    for (const id of Object.keys(value.route.replies ?? {})) tracked.add(id);
    const replies = Object.create(null);
    for (const message of ctx.chat) if (tracked.has(getStoryMessageId(message))) {
      replies[getStoryMessageId(message)] = message.swipe_info?.[message.swipe_id ?? 0]?.extra?.story_branch_tree_variant_id ?? null;
    }
    const route = { ...value.route, endFloor: ctx.chat.length, endSummary: excerpt(ctx.chat.at(-1)?.mes), replies };
    const last = ctx.chat.at(-1);
    if (route.branchKind === "swipe" && route.forkFloor === ctx.chat.length && route.sourceMessageId === getStoryMessageId(last)) {
      route.sourceSwipeIndex = last.swipe_id ?? 0;
      route.sourceVariantId = last.swipe_info?.[route.sourceSwipeIndex]?.extra?.story_branch_tree_variant_id ?? route.sourceVariantId;
      route.forkSummary = excerpt(last.mes);
      if (route.autoTitle) route.title = `回复 ${route.sourceSwipeIndex + 1}`;
    }
    const metadata = { ...value, route };
    ctx.updateChatMetadata({ [NATIVE_KEY]: metadata });
    this.remember(metadata, ctx.chatId);
    return this.view();
  }
  view(ctx = this.context()) {
    const metadata = this.metadata(ctx);
    if (!metadata) return null;
    if (this.cachedView?.metadata === metadata && this.cachedView.revision === this.revision) return this.cachedView.tree;
    const entries = Object.values(this.catalog(ctx).routes).filter(entry => entry.storyId === metadata.storyId);
    const currentName = nameOf(ctx.chatId);
    const current = { ...metadata, chatName: currentName };
    const byId = new Map(entries.map(entry => [entry.route.id, entry]));
    byId.set(metadata.route.id, current);
    const branches = Object.fromEntries([...byId].map(([id, entry]) => [id, {
      ...entry.route, chatName: entry.chatName, messageIds: [],
      forkSnapshot: entry.route.parentBranchId ? { mes: entry.route.forkSummary ?? "", swipe_id: entry.route.sourceSwipeIndex } : undefined,
    }]));
    // A copied/imported child must remain usable even before its parent is recovered.
    for (const route of Object.values(branches)) if (route.parentBranchId && !branches[route.parentBranchId]) route.parentBranchId = null;
    const tree = { version: 1, storageMode: "native", storyId: metadata.storyId, rootBranchId: branches[metadata.rootRouteId] ? metadata.rootRouteId : metadata.route.id,
      activeBranchId: metadata.route.id, messages: {}, branches, ...this.catalog(ctx).views[metadata.storyId] };
    this.cachedView = { metadata, revision: this.revision, tree };
    return tree;
  }
  saveView(tree) {
    const metadata = this.metadata();
    const value = {};
    for (const key of ["layout", "compactLayout", "nodeNames", "nodeSummaries", "nodeNotes"]) if (tree[key]) value[key] = structuredClone(tree[key]);
    this.catalog().views[metadata.storyId] = value;
    this.changed();
  }
  async request(path, body, owner = this.owner()) {
    if (owner.epoch !== this.epoch) throw Error("原生故事操作已取消。");
    const response = await fetch(path, { method: "POST", headers: owner.ctx.getRequestHeaders(), body: JSON.stringify(body) });
    if (!response.ok) throw Error(`酒馆请求失败（${response.status}）。`);
    const data = await response.json();
    if (data?.error) throw Error(`酒馆请求失败：${String(data.error)}`);
    return data;
  }
  async read(chatName, owner = this.owner()) {
    const data = await this.request("/api/chats/get", { ch_name: owner.name, avatar_url: owner.avatar, file_name: nameOf(chatName) }, owner);
    if (!Array.isArray(data) || !data.length || !data[0]?.chat_metadata) throw Error(`无法读取聊天「${chatName}」。`);
    return data;
  }
  async write(chatName, data, owner = this.owner()) {
    return this.request("/api/chats/save", { ch_name: owner.name, avatar_url: owner.avatar, file_name: nameOf(chatName), chat: data }, owner);
  }
  async readRoute(id) {
    const tree = this.view();
    const route = tree?.branches[id];
    if (!route) throw Error("找不到这条路线。");
    if (id === tree.activeBranchId) return structuredClone(this.context().chat);
    const records = await this.read(route.chatName);
    if (records[0].chat_metadata[NATIVE_KEY]?.route?.id !== id) throw Error("路线文件身份已改变，请重建分组。");
    return records.slice(1);
  }
  routeChange(target, reason = "route-switched") {
    const ctx = this.context();
    const metadata = this.metadata();
    return { version: 1, storageMode: "native", storyId: metadata.storyId, transitionId: uuid(), chatId: target.chatName ?? null, characterId: ctx.characterId,
      rootBranchId: metadata.rootRouteId, branchId: target.id, previousBranchId: metadata.route.id,
      parentBranchId: target.parentBranchId, title: target.title, cacheKey: JSON.stringify([metadata.storyId, target.id]), reason };
  }
  async createBranch(index, swipeId = null) {
    const ctx = this.context();
    const owner = this.owner();
    const metadata = this.metadata();
    if (!metadata || storyMode(ctx) !== "native") throw Error("当前不是原生分支故事。");
    if (!Number.isInteger(index) || !ctx.chat[index]) throw Error("分叉楼层不存在。");
    if (swipeId !== null && (index < 1 || ctx.chat[index].is_user || !Number.isInteger(swipeId)
      || typeof ctx.chat[index].swipes?.[swipeId] !== "string")) throw Error("重说回复不存在。");
    ensureNativeIdentities(ctx.chat);
    const message = ctx.chat[index];
    const variantId = message.swipe_info?.[swipeId ?? message.swipe_id ?? 0]?.extra?.story_branch_tree_variant_id ?? null;
    const sourceVariant = message.swipe_info?.[message.swipe_id ?? 0]?.extra?.story_branch_tree_variant_id ?? null;
    const refreshTarget = async () => {
      this.assertOwner(owner);
      const messages = structuredClone(ctx.chat.slice(0, index + 1));
      if (swipeId !== null && !await this.selectSwipe(messages[index], swipeId)) throw Error("当前酒馆无法创建指定重说版本的分支，请更新酒馆。");
      this.assertOwner(owner);
      return messages;
    };
    const targetMessages = await refreshTarget();
    const route = { id: uuid(), parentBranchId: metadata.route.id, title: swipeId === null ? "新分支" : `回复 ${swipeId + 1}`,
      createdAt: Date.now(), autoTitle: true, branchKind: swipeId === null ? "continuation" : "swipe", forkFloor: index + 1,
      createdOrder: Object.values(this.catalog().routes).filter(entry => entry.storyId === metadata.storyId)
        .reduce((max, entry) => Math.max(max, entry.route.createdOrder ?? 0), 0) + 1,
      forkMessageId: getStoryMessageId(ctx.chat[swipeId === null ? index : index - 1]),
      forkVariantId: swipeId === null ? variantId : null,
      sourceMessageId: swipeId === null ? null : getStoryMessageId(message), sourceVariantId: swipeId === null ? null : variantId,
      sourceSwipeIndex: swipeId, originSwipeIndex: message.swipe_id ?? 0,
      forkSummary: excerpt(swipeId === null ? message.mes : message.swipes[swipeId]),
      endFloor: index + 1, endSummary: excerpt(targetMessages.at(-1)?.mes), replies: { ...metadata.route.replies } };
    if (variantId) route.replies = { ...route.replies, [getStoryMessageId(message)]: variantId };
    const change = this.routeChange(route);
    change.messageCount = targetMessages.length;
    change.messageIds = targetMessages.map(getStoryMessageId);
    change.fork = { kind: route.branchKind, parentBranchId: route.parentBranchId, sourceBranchId: route.parentBranchId,
      forkMessageId: route.forkMessageId, forkFloor: swipeId === null ? index + 1 : index,
      inheritedMessageCount: swipeId === null ? index + 1 : index, replyFloor: swipeId === null ? null : index + 1,
      sourceMessageId: getStoryMessageId(message), sourceVariantId: variantId, sourceSwipeIndex: swipeId,
      parentCacheKey: JSON.stringify([metadata.storyId, metadata.route.id]), sourceCacheKey: JSON.stringify([metadata.storyId, metadata.route.id]) };
    let created;
    let opened = false;
    try {
      const overrides = await this.prepare?.(change, targetMessages, refreshTarget) ?? {};
      this.assertOwner(owner);
      if (sourceVariant) metadata.route.replies = { ...metadata.route.replies, [getStoryMessageId(message)]: sourceVariant };
      this.syncCurrent();
      await ctx.saveChat();
      this.assertOwner(owner);
      created = await this.forkCore(index, swipeId === null ? {} : { swipeId });
      if (!created) throw Error("酒馆未返回新分支名称。");
      this.assertOwner(owner);
      const records = await this.read(created, owner);
      this.assertOwner(owner);
      if (records.length !== index + 2 || records[index + 1]?.mes !== targetMessages[index].mes
        || (swipeId !== null && records[index + 1]?.swipe_id !== swipeId)) throw Error("当前酒馆没有正确保存指定的分叉回复，请更新酒馆后重试。");
      const childMetadata = records[0].chat_metadata;
      if (childMetadata.story_branch_tree) throw Error("新分支意外携带单聊天存档，已停止操作。");
      childMetadata[NATIVE_KEY] = { version: 1, storyId: metadata.storyId, rootRouteId: metadata.rootRouteId, storyTitle: metadata.storyTitle, route };
      Object.assign(childMetadata, overrides);
      delete childMetadata[MODE_KEY];
      await this.write(created, records, owner);
      this.assertOwner(owner);
      this.remember(childMetadata[NATIVE_KEY], created);
      change.chatId = created;
      await ctx.openCharacterChat(created);
      opened = true;
      this.assertTarget(owner, created, route.id);
      this.syncCurrent();
      // Core branching selects the reply in a file snapshot, so plugins have
      // seen CHAT_CHANGED but not the swipe event that rebuilds reply metadata.
      if (swipeId !== null && ctx.eventTypes?.MESSAGE_SWIPED && ctx.eventSource?.emit) {
        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_SWIPED, index);
        this.assertTarget(owner, created, route.id);
      }
      await this.complete?.(change);
      return route.id;
    } catch (error) {
      if (owner.epoch === this.epoch) await this.aborted?.(change, opened);
      if (created && !opened) throw Error(`${error.message} 新聊天「${created}」已保留，可从原始记录查看。`);
      throw error;
    }
  }
  async switchRoute(id) {
    const owner = this.owner();
    const tree = this.syncCurrent();
    const target = tree?.branches[id];
    if (!target) throw Error("路线不存在。");
    const change = this.routeChange(target, id === tree.activeBranchId ? "memory-retry" : "route-switched");
    let opened = false;
    try {
      const messages = await this.readRoute(id);
      change.messageCount = messages.length;
      change.messageIds = messages.map(getStoryMessageId);
      this.assertOwner(owner);
      const overrides = await this.prepare?.(change, messages) ?? {};
      this.assertOwner(owner);
      if (id !== tree.activeBranchId) {
        await owner.ctx.saveChat();
        this.assertOwner(owner);
        await owner.ctx.openCharacterChat(target.chatName);
      }
      opened = true;
      this.assertTarget(owner, target.chatName, id);
      this.context().updateChatMetadata(overrides);
      this.syncCurrent();
      await this.complete?.(change);
    } catch (error) { if (owner.epoch === this.epoch) await this.aborted?.(change, opened); throw error; }
  }
  replyRoutes(index, swipeId) {
    const ctx = this.context();
    const metadata = this.metadata();
    const message = ctx.chat[index];
    const id = getStoryMessageId(message);
    const variant = message?.swipe_info?.[swipeId]?.extra?.story_branch_tree_variant_id;
    if (!variant) return [];
    return Object.values(this.catalog().routes).filter(entry => entry.storyId === metadata.storyId
      && entry.route.endFloor >= index + 1 && (entry.route.replies?.[id] === variant
        || (entry.route.id === metadata.route.id && (message.swipe_id ?? 0) === swipeId)));
  }
  async updateRoute(id, patch) {
    const owner = this.owner();
    const current = this.metadata();
    const route = this.view().branches[id];
    if (!route) throw Error("路线不存在。");
    if (id === current.route.id) {
      const next = { ...current, route: { ...current.route, ...patch } };
      owner.ctx.updateChatMetadata({ [NATIVE_KEY]: next });
      await owner.ctx.saveChat();
      this.assertOwner(owner);
      this.remember(next, owner.chatName);
    } else {
      const data = await this.read(route.chatName, owner);
      this.assertOwner(owner);
      const next = data[0].chat_metadata[NATIVE_KEY];
      if (next?.route.id !== id || next.storyId !== current.storyId) throw Error("路线文件身份已改变。");
      next.route = { ...next.route, ...patch };
      await this.write(route.chatName, data, owner);
      this.assertOwner(owner);
      this.remember(next, route.chatName);
    }
  }
  async listStories({ rebuild = false } = {}) {
    const owner = this.owner();
    const data = await this.request("/api/characters/chats", { avatar_url: owner.avatar, ...(rebuild ? { metadata: true } : {}) }, owner);
    this.assertOwner(owner);
    const files = Object.values(data ?? {}).filter(file => typeof file.file_name === "string");
    const catalog = this.catalog();
    if (rebuild) {
      const candidates = new Map();
      for (const file of files) {
        const metadata = file.chat_metadata?.[NATIVE_KEY];
        if (!validMetadata(metadata) || file.chat_metadata?.story_branch_tree) continue;
        const group = candidates.get(metadata.route.id) ?? [];
        group.push({ ...structuredClone(metadata), chatName: nameOf(file.file_name) });
        candidates.set(metadata.route.id, group);
      }
      for (const [id, group] of candidates) {
        // Copied files may share an identity. Keep a known owner, otherwise
        // leave conflicts as ordinary visible records instead of hiding one.
        const selected = group.length === 1 ? group[0] : group.find(entry => entry.chatName === catalog.routes[id]?.chatName);
        if (selected) catalog.routes[id] = selected;
      }
      this.changed();
    }
    const available = new Set(files.map(file => nameOf(file.file_name)));
    for (const [id, entry] of Object.entries(catalog.routes)) if (!available.has(entry.chatName)) delete catalog.routes[id];
    const byFile = new Map(Object.values(catalog.routes).map(entry => [entry.chatName, entry]));
    const stories = new Map();
    for (const file of files) {
      const chatName = nameOf(file.file_name);
      const entry = byFile.get(chatName);
      const key = entry ? `story:${entry.storyId}` : `chat:${chatName}`;
      if (!stories.has(key)) stories.set(key, { key, storyId: entry?.storyId, title: entry?.storyTitle ?? chatName, routes: [] });
      stories.get(key).routes.push({ chatName, id: entry?.route.id, title: entry?.route.title ?? chatName,
        updated: Number(file.last_mes ?? 0) || Date.parse(file.last_mes_date ?? file.last_mes ?? "") || 0 });
    }
    return [...stories.values()];
  }
  async discoverLegacyStory({ signal, onProgress = () => {} } = {}) {
    const owner = this.owner();
    const check = () => { this.assertOwner(owner); if (signal?.aborted) throw Error("已取消查找，未整理聊天。"); };
    if (storyMode(owner.ctx) === "single") throw Error("单聊天故事不能混入原生分支，请打开一条旧原生聊天。");
    check();
    const liveDigest = await legacyDigest({ chat: owner.ctx.chat, metadata: owner.ctx.chatMetadata }); check();
    onProgress("正在查找当前角色的来源关联…");
    const files = Object.values(await this.request("/api/characters/chats", { avatar_url: owner.avatar, metadata: true }, owner));
    check();
    const component = legacyComponent(files, owner.chatName, NATIVE_KEY, validMetadata);
    if (!component.files.some(item => item.name === owner.chatName)) throw Error("当前聊天不在列表中，请保存后重新查找。");
    const existingStories = new Set(component.files.map(item => item.file.chat_metadata?.[NATIVE_KEY])
      .filter(validMetadata).map(value => value.storyId));
    if (existingStories.size > 1) throw Error("这些来源关联涉及多个已归组故事，不能自动合并。原文件均保留。");
    const rows = [], details = new Map(), routeIds = new Map();
    for (let start = 0; start < component.files.length; start += 4) {
      check();
      const batch = component.files.slice(start, start + 4);
      const results = await Promise.allSettled(batch.map(async item => {
        const metadata = item.file.chat_metadata ?? {}, native = metadata[NATIVE_KEY];
        const blocked = item.cycle ? "来源关联存在循环"
          : metadata.story_branch_tree || metadata[MODE_KEY] === "single" ? "已使用单聊天模式"
          : native && !validMetadata(native) ? "故事标记损坏" : "";
        if (blocked) return { item, blocked };
        const records = await this.read(item.name, owner); check();
        if (records.slice(1).some(message => typeof message?.mes !== "string")) throw Error("消息格式无效");
        if (["main_chat", NATIVE_KEY, MODE_KEY, "story_branch_tree"].some(key => JSON.stringify(metadata[key]) !== JSON.stringify(records[0].chat_metadata[key]))) throw Error("来源关联在查找期间已改变，请重新查找");
        return { item, digest: await legacyDigest(records), summary: summarizeLegacy(item.name === owner.chatName ? [records[0], ...owner.ctx.chat] : records, getStoryMessageId, uuid) };
      }));
      check();
      results.forEach((result, index) => {
        const item = batch[index], metadata = item.file.chat_metadata ?? {};
        const row = { chatName: item.name, parentName: nameOf(metadata.main_chat), existing: validMetadata(metadata[NATIVE_KEY]),
          blocked: result.status === "rejected" ? `读取失败：${result.reason.message}` : result.value.blocked ?? "" };
        if (!row.blocked) {
          const { digest, summary } = result.value;
          // Retain association metadata only, not a second copy of every plugin's cell pool.
          details.set(row.chatName, { digest, summary, metadata: { [NATIVE_KEY]: metadata[NATIVE_KEY] }, expectedWrite: null });
          row.messageCount = summary.messageCount;
          if (row.existing) {
            const id = metadata[NATIVE_KEY].route.id;
            if (routeIds.has(id)) { row.blocked = "与另一文件的路线身份重复"; routeIds.get(id).blocked = row.blocked; }
            else routeIds.set(id, row);
          }
        }
        rows.push(row);
      });
      onProgress(`已检查 ${Math.min(start + 4, component.files.length)} / ${component.files.length} 条相关聊天`);
    }
    for (const row of rows) {
      const parent = details.get(row.parentName)?.summary, child = details.get(row.chatName)?.summary;
      const floors = parent?.links.get(row.chatName) ?? [];
      row.floor = floors.length === 1 && parent.variants[floors[0] - 1]?.has(child?.signatures[floors[0] - 1]) ? floors[0] : null;
      row.checkpoint = Boolean(parent?.checkpoints.has(row.chatName) && !floors.length);
      row.missingParent = Boolean(row.parentName && !details.has(row.parentName));
    }
    if (rows.find(row => row.chatName === owner.chatName)?.blocked) throw Error("当前聊天的来源或数据有冲突，不能整理。请查看原始记录。");
    const native = [...details.values()].map(item => item.metadata[NATIVE_KEY]).find(validMetadata);
    const plan = Object.freeze({ rows: Object.freeze(rows.map(row => Object.freeze(row))), missing: Object.freeze(component.missing),
      title: native?.storyTitle ?? component.missing[0] ?? rows.find(row => !row.parentName)?.chatName ?? owner.chatName });
    check();
    if (await legacyDigest({ chat: owner.ctx.chat, metadata: owner.ctx.chatMetadata }) !== liveDigest) throw Error("当前聊天在查找期间已改变，请重新查找。");
    this.legacyPlans.set(plan, { owner, details, storyId: native?.storyId ?? uuid(), rootRouteId: native?.rootRouteId,
      liveDigest, descriptors: null });
    check();
    return plan;
  }
  async adoptLegacyStory(plan, selectedNames, { onProgress = () => {} } = {}) {
    const task = this.legacyPlans.get(plan);
    if (!task) throw Error("整理预览已失效，请重新查找。");
    const { owner, details } = task;
    this.assertOwner(owner);
    if (await legacyDigest({ chat: owner.ctx.chat, metadata: owner.ctx.chatMetadata }) !== task.liveDigest) throw Error("当前聊天在预览后已改变，请重新查找。");
    const names = new Set(selectedNames), rows = plan.rows.filter(row => names.has(row.chatName));
    if (!names.has(owner.chatName) || names.size !== rows.length || rows.some(row => row.blocked) || rows.length < 2) throw Error("至少选择两条可用记录，并保留当前聊天。");
    if (task.descriptors && ([...task.descriptors.keys()].some(name => !names.has(name)) || task.descriptors.size !== names.size)) throw Error("已开始整理，请保持原选择继续，或重新查找。");
    if (!task.descriptors) {
      const ids = new Map(rows.filter(row => row.existing).map(row => [row.chatName, details.get(row.chatName).metadata[NATIVE_KEY].route.id]));
      const reserve = (name, id) => {
        if (!names.has(name) || !safeKey(id)) return;
        if (ids.has(name) && ids.get(name) !== id) throw Error("已保存的路线关联有冲突，未开始整理。");
        ids.set(name, id);
      };
      for (const row of rows.filter(row => row.existing)) {
        const metadata = details.get(row.chatName).metadata[NATIVE_KEY];
        reserve(metadata.route.legacyParentName, metadata.route.parentBranchId);
        reserve(metadata.legacyRootName, metadata.rootRouteId);
        const parent = details.get(metadata.route.legacyParentName), floor = metadata.route.forkFloor;
        if (parent && !parent.metadata[NATIVE_KEY] && Number.isInteger(floor) && floor > 0 && floor <= parent.summary.messageCount
          && !parent.summary.knownIdentities[floor - 1] && safeKey(metadata.route.forkMessageId)) parent.summary.identities[floor - 1] = metadata.route.forkMessageId;
      }
      rows.forEach(row => { if (!ids.has(row.chatName)) ids.set(row.chatName, uuid()); });
      const roots = rows.filter(row => !names.has(row.parentName));
      const rootRouteId = task.rootRouteId ?? ids.get(roots.find(row => !row.parentName)?.chatName ?? roots[0]?.chatName);
      const rootName = rows.find(row => ids.get(row.chatName) === rootRouteId)?.chatName;
      if (!rootRouteId) throw Error("来源关联有循环，未开始整理。");
      task.descriptors = new Map(rows.map((row, index) => {
        const detail = details.get(row.chatName), parent = names.has(row.parentName) ? details.get(row.parentName) : null;
        const route = detail.metadata[NATIVE_KEY]?.route ?? { id: ids.get(row.chatName), parentBranchId: parent ? ids.get(row.parentName) : null,
          title: row.parentName ? row.chatName : "主线", createdAt: 0, createdOrder: index,
          branchKind: "continuation", forkFloor: parent ? row.floor : null,
          forkMessageId: parent ? row.floor ? parent.summary.identities[row.floor - 1] : `legacy:${ids.get(row.chatName)}` : null,
          legacyForkUnknown: Boolean(parent && !row.floor), legacyParentName: row.parentName,
          legacyParentUnavailable: Boolean(row.parentName && !parent),
          forkSummary: parent && row.floor ? "原生分支历史关联" : "原分叉位置未保留",
          endFloor: detail.summary.messageCount, endSummary: detail.summary.endSummary, replies: {} };
        return [row.chatName, { ...detail.metadata[NATIVE_KEY], version: 1, storyId: task.storyId, rootRouteId, legacyRootName: rootName, storyTitle: plan.title, route }];
      }));
      nativeRows({ branches: Object.fromEntries([...task.descriptors.values()].map(value => [value.route.id, value.route])) });
    }
    let completed = 0;
    try {
      for (const row of rows) {
        this.assertOwner(owner);
        onProgress(`正在整理 ${completed + 1} / ${rows.length}：${row.chatName}`);
        const detail = details.get(row.chatName), records = await this.read(row.chatName, owner);
        this.assertOwner(owner);
        const digest = await legacyDigest(records);
        if (digest !== detail.digest && digest !== detail.expectedWrite) throw Error(`「${row.chatName}」在预览后已改变，请重新查找`);
        const descriptor = task.descriptors.get(row.chatName);
        if (digest !== detail.expectedWrite && !row.existing) {
          if (row.chatName === owner.chatName) {
            records[0].chat_metadata = structuredClone(owner.ctx.chatMetadata);
            records.splice(1, records.length - 1, ...structuredClone(owner.ctx.chat));
          }
          records[0].chat_metadata[NATIVE_KEY] = descriptor;
          records.slice(1).forEach((message, index) => setStoryMessageId(message, detail.summary.identities[index]));
          ensureNativeIdentities(records.slice(1));
          detail.expectedWrite = await legacyDigest(records);
          this.assertOwner(owner);
        }
        if (row.chatName === owner.chatName && !row.existing) {
          owner.ctx.updateChatMetadata({ [NATIVE_KEY]: descriptor });
          // Apply only our identities; do not reload plugins or replace their live memory.
          owner.ctx.chat.forEach((message, index) => copyStoryMessageIdentity(message, records[index + 1]));
          task.liveDigest = await legacyDigest({ chat: owner.ctx.chat, metadata: owner.ctx.chatMetadata });
        }
        this.assertOwner(owner);
        if (!row.existing && digest !== detail.expectedWrite) {
          await this.write(row.chatName, records, owner);
          this.assertOwner(owner);
          if (await legacyDigest(await this.read(row.chatName, owner)) !== detail.expectedWrite) throw Error(`「${row.chatName}」保存后的核对失败`);
          this.assertOwner(owner);
        }
        this.remember(descriptor, row.chatName);
        completed++;
      }
    } catch (error) {
      throw Error(`${error.message}。已核对 ${completed}/${rows.length} 条；文件均保留，可保持选择继续整理，或重新查找。`);
    }
    return { storyId: task.storyId, count: completed };
  }
  async removeRoutes(ids) {
    const owner = this.owner();
    const tree = this.view();
    const metadata = this.metadata();
    const selected = new Set(ids);
    for (const id of selected) if (!tree?.branches[id]) throw Error("路线不存在。");
    // Leave descendants usable when deleting one route: attach them to its parent.
    for (const route of Object.values(tree.branches)) if (!selected.has(route.id) && selected.has(route.parentBranchId)) {
      let parent = tree.branches[route.parentBranchId];
      while (parent && selected.has(parent.id)) parent = tree.branches[parent.parentBranchId];
      await this.updateRoute(route.id, { parentBranchId: parent?.id ?? null });
    }
    if (selected.has(metadata.route.id)) {
      const survivor = Object.values(tree.branches).find(route => !selected.has(route.id));
      if (!survivor) throw Error("请从故事列表删除整个故事。");
      await this.switchRoute(survivor.id);
    }
    for (const id of selected) {
      if (this.owner().avatar !== owner.avatar || selected.has(this.metadata()?.route.id)) throw Error("当前聊天已改变，已停止删除。");
      const data = await this.read(tree.branches[id].chatName, owner);
      if (data[0].chat_metadata[NATIVE_KEY]?.route.id !== id) throw Error("路线文件身份已改变，未删除。");
      await this.request("/api/chats/delete", { avatar_url: owner.avatar, chatfile: tree.branches[id].chatName + ".jsonl" }, owner);
      delete this.catalog().routes[id];
      this.changed();
    }
  }
  async exportStory(all = true, storyId = this.metadata()?.storyId) {
    const owner = this.owner();
    const metadata = this.metadata();
    if (metadata?.storyId === storyId) await owner.ctx.saveChat();
    this.assertOwner(owner);
    if (all) await this.listStories({ rebuild: true });
    const selected = Object.values(this.catalog().routes).filter(entry => entry.storyId === storyId
      && (all || entry.route.id === metadata?.route.id));
    if (!selected.length) throw Error("找不到可导出的故事路线。");
    const chats = [];
    for (const entry of selected) {
      const records = await this.read(entry.chatName, owner);
      this.assertOwner(owner);
      if (records[0].chat_metadata[NATIVE_KEY]?.route.id !== entry.route.id) throw Error("路线文件身份已改变，导出停止。");
      chats.push({ name: entry.chatName, records });
    }
    return { format: "story-branch-tree-native", version: 1, storyId, title: selected[0].storyTitle,
      view: structuredClone(this.catalog().views[storyId] ?? {}), chats };
  }
  async removeStory(storyId, leaveCurrent, expectedFiles = null) {
    const owner = this.owner();
    const stories = await this.listStories({ rebuild: true });
    const story = stories.find(item => item.storyId === storyId);
    if (!story) throw Error("故事不存在。");
    if (expectedFiles && (expectedFiles.length !== story.routes.length
      || story.routes.some(route => !expectedFiles.includes(route.chatName)))) throw Error("故事路线列表已变化，请重建分组后重新确认删除。");
    for (const route of story.routes) {
      const records = await this.read(route.chatName, owner);
      this.assertOwner(owner);
      if (records[0].chat_metadata[NATIVE_KEY]?.storyId !== storyId) throw Error("故事文件身份已改变，未开始删除。");
    }
    if (this.metadata()?.storyId === storyId) {
      await leaveCurrent();
      if (this.metadata()?.storyId === storyId) throw Error("未能离开当前故事，未开始删除。");
    }
    for (const route of story.routes) {
      if (this.owner().avatar !== owner.avatar) throw Error("当前角色已改变，已停止删除。");
      await this.request("/api/chats/delete", { avatar_url: owner.avatar, chatfile: route.chatName + ".jsonl" }, owner);
      delete this.catalog().routes[route.id];
      this.changed();
    }
    delete this.catalog().views[storyId];
    this.changed();
  }
  async importStory(bundle, beforeOpen = () => {}) {
    const owner = this.owner();
    if (bundle?.format !== "story-branch-tree-native" || bundle.version !== 1 || !Array.isArray(bundle.chats) || !bundle.chats.length) throw Error("请选择剧情分支树导出的原生故事文件。");
    const ids = new Map();
    for (const entry of bundle.chats) {
      const metadata = entry?.records?.[0]?.chat_metadata;
      if (!Array.isArray(entry?.records) || !validMetadata(metadata?.[NATIVE_KEY]) || metadata.story_branch_tree || metadata[MODE_KEY] === "single"
        || metadata[NATIVE_KEY].storyId !== bundle.storyId || entry.records.slice(1).some(message => typeof message?.mes !== "string")) throw Error("故事存档中的路线数据无效。");
      const id = metadata[NATIVE_KEY].route.id;
      if (ids.has(id)) throw Error("故事存档有重复路线身份。");
      ids.set(id, uuid());
    }
    const storyId = uuid();
    const originalRoot = bundle.chats[0].records[0].chat_metadata[NATIVE_KEY].rootRouteId;
    const rootId = ids.get(originalRoot) ?? ids.values().next().value;
    const importedBranches = Object.fromEntries(bundle.chats.map(entry => {
      const route = entry.records[0].chat_metadata[NATIVE_KEY].route;
      const id = ids.get(route.id);
      return [id, { ...route, id, parentBranchId: id === rootId ? null : ids.get(route.parentBranchId) ?? null }];
    }));
    nativeRows({ branches: importedBranches });
    await owner.ctx.saveChat();
    this.assertOwner(owner);
    const created = [];
    // Validate the complete input before creating any files. Always mint fresh
    // names/identities; importing the same story cannot overwrite an existing one.
    for (const entry of bundle.chats) {
      this.assertOwner(owner);
      const records = structuredClone(entry.records);
      const value = records[0].chat_metadata[NATIVE_KEY];
      const id = ids.get(value.route.id);
      value.storyId = storyId;
      value.rootRouteId = rootId;
      value.route.id = id;
      value.route.parentBranchId = ids.get(value.route.parentBranchId) ?? null;
      if (id === rootId) value.route.parentBranchId = null;
      value.storyTitle = String(bundle.title ?? "导入的故事").slice(0, 120);
      records[0].chat_metadata.integrity = uuid();
      delete records[0].chat_metadata.main_chat;
      const chatName = `Story-${uuid()}`;
      await this.write(chatName, records, owner);
      this.remember(value, chatName);
      created.push({ id, chatName });
    }
    this.assertOwner(owner);
    const root = created.find(entry => entry.id === rootId);
    const mapKey = key => {
      for (const [oldId, newId] of [...ids].sort((a, b) => b[0].length - a[0].length)) {
        const escaped = oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        key = key.replace(new RegExp(`(^|:)${escaped}(?=:|$)`, "g"), (_, prefix) => prefix + newId);
      }
      return key;
    };
    const remap = values => Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [mapKey(key), structuredClone(value)]));
    const view = {};
    for (const key of ["layout", "nodeNames", "nodeSummaries", "nodeNotes"]) if (bundle.view?.[key]) view[key] = remap(bundle.view[key]);
    if (bundle.view?.compactLayout) view.compactLayout = { points: remap(bundle.view.compactLayout.points), leaves: remap(bundle.view.compactLayout.leaves) };
    this.catalog().views[storyId] = view;
    this.changed();
    beforeOpen();
    await owner.ctx.openCharacterChat(root.chatName);
    this.assertTarget(owner, root.chatName, root.id);
    return storyId;
  }
}
