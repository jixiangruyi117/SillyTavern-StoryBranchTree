import { captureMemoryState, restoreMemoryState } from "./MemoryState.js?v=0.1.74";

export const TREE_METADATA_KEY = "story_branch_tree";
export const SWIPE_MESSAGE_FIELDS_KEY = "story_branch_tree_swipe_message_fields";
const MESSAGE_ID_KEY = "story_branch_tree_message_id";
const VARIANT_ID_KEY = "story_branch_tree_variant_id";
const CORE_MESSAGE_FIELDS = new Set(["__proto__", "constructor", "prototype", "extra", "mes", "name", "is_user", "is_system", "swipes", "swipe_info", "swipe_id", "variables", "send_date", "gen_started", "gen_finished"]);

function adapterFieldNames(fields) {
  if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string" || !field || CORE_MESSAGE_FIELDS.has(field))) {
    throw new Error("记忆适配器只能保存扩展自己的消息字段。");
  }
  return [...new Set(fields)];
}

function replySource(text) {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return `${text.length}:${a >>> 0}:${b >>> 0}`;
}

/** Capture only declared fields; cell pools and other chat metadata stay with their owner. */
export function captureReplyMemory(message, fields) {
  const names = adapterFieldNames(fields);
  if (!message || typeof message.mes !== "string" || message.is_user) throw Error("只能保存 AI 回复的记忆版本。");
  const source = replySource(message.mes);
  const values = { ...message.extra?.[SWIPE_MESSAGE_FIELDS_KEY] };
  for (const field of names) values[field] = Object.hasOwn(message, field)
    ? { present: true, value: clone(message[field]), source } : { present: false, source };
  message.extra ??= {};
  message.extra[SWIPE_MESSAGE_FIELDS_KEY] = values;
  const index = message.swipe_id ?? 0;
  if (Array.isArray(message.swipes) && typeof message.swipes[index] === "string") {
    message.swipe_info ??= [];
    const info = message.swipe_info[index] ?? {};
    message.swipe_info[index] = { ...info, extra: { ...info.extra, [SWIPE_MESSAGE_FIELDS_KEY]: values } };
  }
}

/** null means unrecorded or edited since recording, rather than an empty memory. */
export function readReplyMemory(message, fields, { swipeId = message?.swipe_id ?? 0 } = {}) {
  const names = adapterFieldNames(fields);
  if (!message || !Number.isInteger(swipeId) || swipeId < 0) throw Error("回复版本无效。");
  const active = swipeId === (message.swipe_id ?? 0);
  const text = active ? message.mes : message.swipes?.[swipeId];
  if (typeof text !== "string") throw Error("回复版本不存在。");
  const values = (active ? message.extra : message.swipe_info?.[swipeId]?.extra)?.[SWIPE_MESSAGE_FIELDS_KEY];
  if (!values || names.some(field => !Object.hasOwn(values, field))) return null;
  const source = replySource(text), result = Object.create(null);
  for (const field of names) {
    const value = values[field];
    if (!value || typeof value.present !== "boolean") throw Error("回复记忆版本损坏。");
    if (value.source !== undefined && value.source !== source) return null;
    if (value.present) result[field] = clone(value.value);
  }
  return result;
}

export function restoreReplyMemory(message, fields) {
  const values = readReplyMemory(message, fields);
  if (values === null) return false;
  for (const field of adapterFieldNames(fields)) {
    if (Object.hasOwn(values, field)) message[field] = values[field];
    else delete message[field];
  }
  return true;
}

/** Pin extension-owned fields independently of shared story text. */
export function captureStoryBranchAdapterState(tree, branchId, messages, namespace, fields, { partial = false, copy = clone } = {}) {
  const branch = tree.branches?.[branchId];
  if (!branch || typeof namespace !== "string" || !namespace || CORE_MESSAGE_FIELDS.has(namespace)) {
    throw new Error("记忆适配器或剧情路线无效。");
  }
  const names = adapterFieldNames(fields);
  const previous = branch.adapterStates?.[namespace];
  const snapshots = partial && previous ? Object.assign(Object.create(null), previous.messages) : Object.create(null);
  for (const message of messages) {
    const id = messageId(message);
    if (!id) continue;
    const values = Object.create(null);
    for (const field of names) {
      if (Object.hasOwn(message, field)) values[field] = copy(message[field]);
    }
    snapshots[id] = values;
  }
  branch.adapterStates = { ...branch.adapterStates, [namespace]: { ...previous, fields: names, messages: snapshots } };
}

export function adapterMetadataFieldNames(fields) {
  if (!Array.isArray(fields) || fields.some(field => typeof field !== "string" || !field
    || ["__proto__", "constructor", "prototype", "variables", "integrity", "main_chat", "tainted", TREE_METADATA_KEY].includes(field))) {
    throw new Error("记忆适配器只能保存扩展自己的聊天元数据字段。");
  }
  return [...new Set(fields)];
}

export function captureStoryBranchAdapterMetadata(tree, branchId, metadata, namespace, fields) {
  const branch = tree.branches?.[branchId];
  if (!branch) throw new Error("剧情路线无效。");
  const names = adapterMetadataFieldNames(fields);
  const values = Object.create(null);
  for (const field of names) if (Object.hasOwn(metadata ?? {}, field)) values[field] = clone(metadata[field]);
  branch.adapterStates = { ...branch.adapterStates, [namespace]: {
    ...branch.adapterStates?.[namespace], metadataFields: names, metadata: values,
  } };
}

export function restoreStoryBranchAdapterMetadata(metadata, state) {
  if (!state?.metadata) return;
  for (const field of adapterMetadataFieldNames(state.metadataFields)) {
    if (Object.hasOwn(state.metadata, field)) metadata[field] = clone(state.metadata[field]);
    else delete metadata[field];
  }
}

function restoreAdapterFields(messages, branch, options = {}) {
  restoreMemoryState(branch, messages, options);
  const copy = options.copy ?? clone;
  for (const state of Object.values(branch.adapterStates ?? {})) {
    const fields = adapterFieldNames(state.fields);
    if (!state.messages || typeof state.messages !== "object" || Array.isArray(state.messages)) throw new Error("路线记忆快照损坏。");
    for (const message of messages) {
      if (!Object.hasOwn(state.messages, messageId(message))) continue;
      const values = state.messages[messageId(message)];
      if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("路线消息记忆快照损坏。");
      for (const field of fields) {
        if (options.fields && !options.fields.has(field)) continue;
        if (Object.hasOwn(values, field)) message[field] = copy(values[field]);
        else delete message[field];
      }
    }
  }
  return messages;
}

function inheritAdapterFields(tree, next, messages) {
  for (const [namespace, state] of Object.entries(tree.branches[tree.activeBranchId].adapterStates ?? {})) {
    captureStoryBranchAdapterState(next, next.activeBranchId, messages, namespace, state.fields);
    if (state.metadata) captureStoryBranchAdapterMetadata(next, next.activeBranchId, state.metadata, namespace, state.metadataFields);
  }
}

function restoreSelectedSwipeFields(reply, selectedExtra, target, registeredFields = []) {
  const current = reply.extra?.[SWIPE_MESSAGE_FIELDS_KEY];
  const selected = selectedExtra?.[SWIPE_MESSAGE_FIELDS_KEY];
  const fields = adapterFieldNames([...new Set([...registeredFields, ...Object.keys(current ?? {}), ...Object.keys(selected ?? {})])]);
  for (const field of fields) {
    const value = selected?.[field];
    if (value?.present === true) target[field] = clone(value.value);
    else delete target[field];
  }
}

function clone(value) {
  return structuredClone(value);
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `story-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function setStoryMessageId(message, id) {
  if (!message.extra || typeof message.extra !== "object" || Array.isArray(message.extra)) {
    message.extra = {};
  }
  message.extra[MESSAGE_ID_KEY] = id;
  for (const info of Array.isArray(message.swipe_info) ? message.swipe_info : []) {
    if (!info || typeof info !== "object") continue;
    if (!info.extra || typeof info.extra !== "object" || Array.isArray(info.extra)) info.extra = {};
    info.extra[MESSAGE_ID_KEY] = id;
  }
}

function ensureSwipeVariantIds(message) {
  if (!Array.isArray(message.swipes) || !message.swipes.length) return;
  if (!Array.isArray(message.swipe_info)) message.swipe_info = [];
  const selected = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
  const used = new Set();
  for (let index = 0; index < message.swipes.length; index++) {
    if (typeof message.swipes[index] !== "string") continue;
    const info = message.swipe_info[index] && typeof message.swipe_info[index] === "object"
      ? message.swipe_info[index] : { send_date: message.send_date, extra: {} };
    if (!info.extra || typeof info.extra !== "object" || Array.isArray(info.extra)) info.extra = {};
    let id = info.extra[VARIANT_ID_KEY];
    if (typeof id !== "string" || !id || used.has(id)) {
      const activeId = index === selected ? message.extra?.[VARIANT_ID_KEY] : null;
      id = typeof activeId === "string" && activeId && !used.has(activeId) ? activeId : createId();
      info.extra[VARIANT_ID_KEY] = id;
    }
    used.add(id);
    message.swipe_info[index] = info;
    if (index === selected) message.extra[VARIANT_ID_KEY] = id;
  }
}

function inheritSwipeVariantIds(message, saved) {
  if (!Array.isArray(message.swipes) || !Array.isArray(saved?.swipes) || !Array.isArray(saved.swipe_info)) return;
  if (!Array.isArray(message.swipe_info)) message.swipe_info = [];
  const matched = new Set();
  for (const info of message.swipe_info) {
    const existingId = info?.extra?.[VARIANT_ID_KEY];
    if (typeof existingId !== "string" || !existingId) continue;
    const savedIndex = saved.swipe_info.findIndex((savedInfo) => savedInfo?.extra?.[VARIANT_ID_KEY] === existingId);
    if (savedIndex >= 0) matched.add(savedIndex);
  }
  for (let index = 0; index < message.swipes.length; index++) {
    if (typeof message.swipes[index] !== "string" || message.swipe_info[index]?.extra?.[VARIANT_ID_KEY]) continue;
    let savedIndex = saved.swipes.findIndex((text, candidate) => candidate === index && text === message.swipes[index] && !matched.has(candidate));
    if (savedIndex < 0) savedIndex = saved.swipes.findIndex((text, candidate) => text === message.swipes[index] && !matched.has(candidate));
    if (savedIndex < 0 && message.swipes.length === saved.swipes.length && !matched.has(index)) savedIndex = index;
    const id = saved.swipe_info[savedIndex]?.extra?.[VARIANT_ID_KEY];
    if (typeof id !== "string" || !id) continue;
    matched.add(savedIndex);
    const info = message.swipe_info[index] && typeof message.swipe_info[index] === "object"
      ? message.swipe_info[index] : { send_date: message.send_date, extra: {} };
    if (!info.extra || typeof info.extra !== "object" || Array.isArray(info.extra)) info.extra = {};
    info.extra[VARIANT_ID_KEY] = id;
    message.swipe_info[index] = info;
  }
}

export function copyStoryMessageIdentity(target, source) {
  setStoryMessageId(target, messageId(source));
  for (let index = 0; index < (source.swipe_info?.length ?? 0); index++) {
    const id = source.swipe_info[index]?.extra?.[VARIANT_ID_KEY];
    if (typeof id !== "string" || !id) continue;
    if (!Array.isArray(target.swipe_info)) target.swipe_info = [];
    if (!target.swipe_info[index] || typeof target.swipe_info[index] !== "object") {
      target.swipe_info[index] = { send_date: target.send_date, extra: {} };
    }
    if (!target.swipe_info[index].extra || typeof target.swipe_info[index].extra !== "object") target.swipe_info[index].extra = {};
    target.swipe_info[index].extra[VARIANT_ID_KEY] = id;
  }
  const selectedId = source.extra?.[VARIANT_ID_KEY];
  if (typeof selectedId === "string" && selectedId) target.extra[VARIANT_ID_KEY] = selectedId;
}

function swipeVariantId(message, index = message?.swipe_id) {
  return message?.swipe_info?.[index]?.extra?.[VARIANT_ID_KEY] ?? null;
}

function messageId(message) {
  return message?.extra?.[MESSAGE_ID_KEY];
}

function legacyVariantKey(branch) {
  const text = branch.forkSnapshot?.mes ?? "";
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `legacy:${branch.forkSwipeId ?? 0}:${(hash >>> 0).toString(36)}:${text.length}`;
}

function snapshotActiveSwipe(message) {
  const snapshot = clone(message);
  const swipeId = snapshot.swipe_id;
  if (!Array.isArray(snapshot.swipes) || !Number.isInteger(swipeId) || swipeId < 0 || swipeId >= snapshot.swipes.length) {
    return snapshot;
  }

  // The displayed message is authoritative; swipe arrays can lag behind live edits or memory updates.
  snapshot.swipes[swipeId] = snapshot.mes;
  snapshot.swipe_info ??= [];
  snapshot.swipe_info[swipeId] = {
    ...snapshot.swipe_info[swipeId],
    send_date: snapshot.send_date ?? snapshot.swipe_info[swipeId]?.send_date,
    gen_started: snapshot.gen_started ?? snapshot.swipe_info[swipeId]?.gen_started,
    gen_finished: snapshot.gen_finished ?? snapshot.swipe_info[swipeId]?.gen_finished,
    extra: clone(snapshot.extra),
  };
  return snapshot;
}

function routeSegments(tree, branchId) {
  const chain = [];
  const seen = new Set();
  for (let id = branchId; id; id = tree.branches[id].parentBranchId) {
    if (seen.has(id)) throw new Error("剧情树包含循环引用，无法打开路线。");
    const branch = tree.branches?.[id];
    if (!branch) throw new Error("剧情路线不存在。");
    seen.add(id);
    if (!Array.isArray(branch.messageIds) || typeof branch.title !== "string") throw new Error("剧情树路线数据无效。");
    chain.push(branch);
  }
  chain.reverse();
  let segments = [];
  for (const branch of chain) {
    if (branch.parentBranchId) {
      const retained = [];
      let found = false;
      for (const segment of segments) {
        const index = segment.snapshot ? (messageId(segment.snapshot) === branch.forkMessageId ? 0 : -1)
          : segment.ids.indexOf(branch.forkMessageId, segment.start);
        if (index >= segment.start && index < segment.end) {
          if (index > segment.start) retained.push({ ...segment, end: index });
          found = true;
          break;
        }
        retained.push(segment);
      }
      if (!found) throw new Error("找不到这条路线的分叉点，原聊天数据未被更改。");
      if (!branch.forkSnapshot || messageId(branch.forkSnapshot) !== branch.forkMessageId) {
        throw new Error("剧情树缺少分叉消息快照，请先恢复聊天备份。");
      }
      segments = [...retained, { snapshot: branch.forkSnapshot, owner: branch, start: 0, end: 1 }];
    }
    if (branch.messageIds.length) segments.push({ ids: branch.messageIds, start: 0, end: branch.messageIds.length });
  }
  return { chain, segments, length: segments.reduce((total, segment) => total + segment.end - segment.start, 0) };
}

export function messageReadOptions(options = {}, length) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("消息读取范围无效。");
  const { from = 0, to = length, fields = null } = options;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new Error("消息读取范围无效。");
  if (fields !== null && (!Array.isArray(fields) || fields.some(field => typeof field !== "string" || !field
    || field.split(".").some(part => !part || ["__proto__", "prototype", "constructor"].includes(part))))) throw new Error("消息读取字段无效。");
  return { from: Math.min(from, length), to: Math.min(to, length), fields,
    roots: fields === null ? null : new Set(fields.map(field => field.split(".")[0])) };
}

function selectedFields(message, fields) {
  if (fields === null) return message;
  const result = {};
  // A selected parent already includes its children, independent of caller order.
  for (const field of fields.filter(field => !fields.some(parent => parent !== field && field.startsWith(parent + ".")))) {
    const parts = field.split(".");
    let source = message;
    let present = true;
    for (const part of parts) {
      if (source == null || !Object.hasOwn(source, part)) { present = false; break; }
      source = source[part];
    }
    if (!present) continue;
    let target = result;
    let container = message;
    for (const part of parts.slice(0, -1)) {
      container = container[part];
      target = target[part] ??= Array.isArray(container) ? [] : {};
    }
    target[parts.at(-1)] = source;
  }
  return result;
}

export function copyMessageRange(messages, options = {}) {
  const read = messageReadOptions(options, messages.length);
  return clone(messages.slice(read.from, read.to).map(message => selectedFields(message, read.fields)));
}

function branchPath(tree, branchId, options = {}, copyOutput = true) {
  const route = routeSegments(tree, branchId);
  const read = messageReadOptions(options, route.length);
  const messages = [];
  let floor = 0;
  for (const segment of route.segments) {
    const size = segment.end - segment.start;
    const start = Math.max(0, read.from - floor);
    const end = Math.min(size, read.to - floor);
    for (let offset = start; offset < end; offset++) {
      const raw = segment.snapshot ?? tree.messages?.[segment.ids[segment.start + offset]];
      if (!raw) throw new Error("剧情树缺少消息数据，请先恢复聊天备份。");
      const id = messageId(raw);
      const draft = read.roots ? Object.fromEntries([...read.roots].filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]])) : { ...raw };
      if (!read.roots || read.roots.has("extra")) draft.extra = { ...raw.extra };
      // Restoration reads stable IDs even when the caller did not request extra.
      const identity = { ...draft, extra: { ...draft.extra, [MESSAGE_ID_KEY]: id } };
      // A fork snapshot replaces the ancestor anchor after its memory restoration.
      const layers = segment.owner ? route.chain.slice(route.chain.indexOf(segment.owner)) : route.chain;
      for (const branch of layers) {
        restoreAdapterFields([identity], branch, { copy: value => value, fields: read.roots });
      }
      if (read.roots && !read.roots.has("extra")) delete identity.extra;
      messages.push(selectedFields(identity, read.fields));
    }
    floor += size;
    if (floor >= read.to) break;
  }
  // Ancestor suffixes never reach this clone; each selected result is copied once.
  return copyOutput ? clone(messages) : messages;
}

export function readStoryBranchMessages(tree, branchId = tree?.activeBranchId, options = {}) {
  validateTreeShape(tree, { headerOnly: true });
  return branchPath(tree, branchId, options);
}

export function createStoryTree(messages, idFactory = createId) {
  const usedIds = new Set();
  const ids = messages.map((message) => {
    if (!message || typeof message !== "object") throw new Error("聊天中包含无效消息，无法创建剧情分支。");
    if (!message.extra || typeof message.extra !== "object" || Array.isArray(message.extra)) message.extra = {};
    const id = message.extra[MESSAGE_ID_KEY];
    const uniqueId = typeof id === "string" && id && !usedIds.has(id) ? id : idFactory();
    setStoryMessageId(message, uniqueId);
    ensureSwipeVariantIds(message);
    usedIds.add(uniqueId);
    return uniqueId;
  });
  const snapshot = clone(messages);
  const rootId = idFactory();
  const tree = {
    version: 1,
    rootBranchId: rootId,
    activeBranchId: rootId,
    messages: Object.fromEntries(ids.map((id, index) => [id, snapshot[index]])),
    branches: {
      [rootId]: {
        id: rootId,
        parentBranchId: null,
        forkMessageId: null,
        forkSwipeId: null,
        title: "主线",
        createdAt: Date.now(),
        messageIds: ids,
      },
    },
  };
  captureMemoryState(tree.branches[rootId], snapshot);
  return tree;
}

function validateTreeShape(tree, { headerOnly = false } = {}) {
  if (
    !tree || tree.version !== 1 ||
    typeof tree.rootBranchId !== "string" ||
    typeof tree.activeBranchId !== "string" ||
    !tree.branches || typeof tree.branches !== "object" ||
    !tree.messages || typeof tree.messages !== "object"
  ) throw new Error("剧情树数据格式无效。");
  if (!tree.branches[tree.rootBranchId] || !tree.branches[tree.activeBranchId]) {
    throw new Error("剧情树缺少主线或当前路线。");
  }
  if (headerOnly) return;
  for (const branch of Object.values(tree.branches)) {
    if (!Array.isArray(branch.messageIds) || typeof branch.title !== "string") {
      throw new Error("剧情树路线数据无效。");
    }
    for (const id of branch.messageIds) {
      if (!tree.messages[id]) throw new Error("剧情树引用了不存在的消息。");
    }
  }
}

export function validateStoryTree(tree) {
  validateTreeShape(tree);
  branchPath(tree, tree.activeBranchId, {}, false);
  return true;
}

export function resolveStoryBranch(tree, branchId = tree?.activeBranchId) {
  validateTreeShape(tree);
  if (branchId !== tree.activeBranchId) branchPath(tree, tree.activeBranchId, {}, false);
  return branchPath(tree, branchId);
}

export function createStoryBranch(tree, forkMessageIdValue, title, idFactory = createId) {
  validateStoryTree(tree);
  // The projection is read-only; only the fork anchor and inherited state need copies.
  const activePath = branchPath(tree, tree.activeBranchId, {}, false);
  const forkIndex = activePath.findIndex((message) => messageId(message) === forkMessageIdValue);
  if (forkIndex < 0) throw new Error("请选择当前路线中的一条消息作为分叉点。");
  const forkMessage = activePath[forkIndex];
  let parentBranchId = tree.activeBranchId;
  for (let current = tree.branches[parentBranchId]; current; current = current.parentBranchId ? tree.branches[current.parentBranchId] : null) {
    if (current.messageIds.includes(forkMessageIdValue)) {
      parentBranchId = current.id;
      break;
    }
  }
  const parentPath = parentBranchId === tree.activeBranchId ? activePath : branchPath(tree, parentBranchId, {}, false);
  if (!parentPath.some((message) => messageId(message) === forkMessageIdValue)) {
    throw new Error("找不到分叉消息所属的路线，原聊天数据未被更改。");
  }
  if (parentPath[forkIndex]?.mes !== forkMessage.mes
    || (swipeVariantId(parentPath[forkIndex]) && swipeVariantId(forkMessage)
      && swipeVariantId(parentPath[forkIndex]) !== swipeVariantId(forkMessage))) parentBranchId = tree.activeBranchId;
  const id = idFactory();
  // Saved messages/snapshots are replaced by sync, never edited in place. Detach
  // branch records because projection preparation captures state on the old route.
  const { messages, branches, ...metadata } = tree;
  const next = {
    ...clone(metadata),
    messages: { ...messages },
    branches: Object.fromEntries(Object.entries(branches).map(([key, branch]) => [key, { ...branch }])),
  };
  const prefix = activePath.slice(0, forkIndex + 1);
  const siblingCount = getStoryBranchRows(tree).filter((branch) => branch.parentBranchId === parentBranchId && branch.forkMessageId === forkMessageIdValue).length;
  const customTitle = typeof title === "string" && title.trim();
  next.branches[id] = {
    id,
    parentBranchId,
    forkMessageId: forkMessageIdValue,
    forkSwipeId: Number.isInteger(forkMessage.swipe_id) ? forkMessage.swipe_id : null,
    branchKind: "continuation",
    forkVariantId: swipeVariantId(forkMessage),
    forkSnapshot: snapshotActiveSwipe(prefix[forkIndex]),
    title: customTitle ? title.trim().slice(0, 80) : `分支 ${siblingCount + 1}`,
    autoTitle: !customTitle,
    titleCustomized: Boolean(customTitle),
    createdAt: Date.now(),
    messageIds: [],
  };
  next.activeBranchId = id;
  inheritAdapterFields(tree, next, prefix);
  captureMemoryState(next.branches[id], prefix);
  return next;
}

/** Copy one reply version into the first message of a new route. */
export function createStoryBranchFromSwipe(tree, replyMessageId, swipeIndex, title, idFactory = createId) {
  validateStoryTree(tree);
  const route = resolveStoryBranch(tree);
  const replyIndex = route.findIndex((message) => messageId(message) === replyMessageId);
  if (replyIndex < 1) throw new Error("这条回复之前没有可用的分叉楼层。");
  const reply = route[replyIndex];
  if (reply.is_user || reply.is_system || reply.extra?.isSmallSys || !Array.isArray(reply.swipes) || reply.swipes.length < 2) {
    throw new Error("请选择有多个重说版本的 AI 回复。");
  }
  const isActiveSwipe = swipeIndex === (Number.isInteger(reply.swipe_id) ? reply.swipe_id : 0);
  const selectedText = isActiveSwipe ? reply.mes : reply.swipes[swipeIndex];
  if (!Number.isInteger(swipeIndex) || typeof selectedText !== "string" || !selectedText.trim()) {
    throw new Error("所选重说版本没有可用的回复内容。");
  }
  const anchorId = messageId(route[replyIndex - 1]);
  const next = createStoryBranch(tree, anchorId, title, idFactory);
  const branch = next.branches[next.activeBranchId];
  branch.parentBranchId = tree.activeBranchId;
  branch.branchKind = "swipe";
  branch.sourceMessageId = replyMessageId;
  branch.sourceVariantId = swipeVariantId(reply, swipeIndex);
  const newMessageId = idFactory();
  if (typeof newMessageId !== "string" || !newMessageId || next.messages[newMessageId] || next.branches[newMessageId]) {
    throw new Error("无法为重说分支分配唯一的消息标识。");
  }

  const firstMessage = clone(reply);
  const info = reply.swipe_info?.[swipeIndex];
  const sourceExtra = isActiveSwipe ? reply.extra : info?.extra;
  const variantExtra = sourceExtra && typeof sourceExtra === "object" && !Array.isArray(sourceExtra) ? clone(sourceExtra) : {};
  variantExtra[MESSAGE_ID_KEY] = newMessageId;
  firstMessage.mes = selectedText;
  firstMessage.swipes = [selectedText];
  firstMessage.swipe_id = 0;
  if (reply.variables && typeof reply.variables === "object") {
    // MVU stores each reply's state at the matching swipe index.
    firstMessage.variables = [clone(reply.variables[swipeIndex] ?? {})];
  }
  firstMessage.extra = variantExtra;
  if (!isActiveSwipe) restoreSelectedSwipeFields(reply, variantExtra, firstMessage,
    Object.values(tree.branches[tree.activeBranchId].adapterStates ?? {}).flatMap(state => state.fields));
  firstMessage.swipe_info = [{
    send_date: isActiveSwipe ? reply.send_date : info?.send_date ?? reply.send_date,
    gen_started: isActiveSwipe ? reply.gen_started : info?.gen_started,
    gen_finished: isActiveSwipe ? reply.gen_finished : info?.gen_finished,
    extra: clone(variantExtra),
  }];
  for (const key of ["send_date", "gen_started", "gen_finished"]) {
    if (!isActiveSwipe && info && Object.hasOwn(info, key)) firstMessage[key] = info[key];
  }
  // A different swipe cannot inherit metadata from the currently displayed reply.

  next.messages[newMessageId] = firstMessage;
  branch.messageIds = [newMessageId];
  branch.originSwipeIndex = Number.isInteger(reply.swipe_id) ? reply.swipe_id : 0;
  branch.sourceSwipeIndex = swipeIndex;
  const projection = resolveStoryBranch(next);
  inheritAdapterFields(tree, next, projection);
  captureMemoryState(branch, projection);
  if (!String(title ?? "").trim()) {
    const siblings = getStoryBranchRows(tree).filter((item) => item.parentBranchId === branch.parentBranchId
      && item.kind === "swipe" && item.sourceMessageId === replyMessageId).length;
    branch.title = `重说 ${siblings + 1}`;
  }
  validateStoryTree(next);
  return next;
}

export function activateStoryBranch(tree, branchId) {
  validateStoryTree(tree);
  if (!tree.branches[branchId]) throw new Error("剧情路线不存在。");
  branchPath(tree, branchId);
  return { ...tree, activeBranchId: branchId };
}

export function deleteStoryBranch(tree, branchId) {
  validateStoryTree(tree);
  const branch = tree.branches[branchId];
  if (!branch) throw new Error("剧情路线不存在。");
  if (branchId === tree.rootBranchId) throw new Error("主线不能删除。");

  const removed = new Set([branchId]);
  let changed;
  do {
    changed = false;
    for (const candidate of Object.values(tree.branches)) {
      if (candidate.parentBranchId && removed.has(candidate.parentBranchId) && !removed.has(candidate.id)) {
        removed.add(candidate.id);
        changed = true;
      }
    }
  } while (changed);

  const next = clone(tree);
  if (removed.has(next.activeBranchId)) next.activeBranchId = branch.parentBranchId;
  for (const id of removed) delete next.branches[id];
  for (const [key, selectedId] of Object.entries(next.replyRouteSelections ?? {})) {
    if (removed.has(selectedId)) delete next.replyRouteSelections[key];
  }

  const retainedMessages = new Set(Object.values(next.branches).flatMap((item) => item.messageIds));
  for (const id of Object.keys(next.messages)) {
    if (!retainedMessages.has(id)) delete next.messages[id];
  }
  const retainedForks = new Set(getStoryBranchRows(next)
    .flatMap((item) => [item.nodeKey, item.kind === "continuation" ? item.forkMessageId : null]).filter(Boolean));
  for (const key of ["nodeNames", "nodeSummaries", "nodeNotes"]) {
    for (const id of Object.keys(next[key] ?? {})) {
      if (!retainedForks.has(id)) delete next[key][id];
    }
  }

  validateStoryTree(next);
  return next;
}

/** Reconcile the active linear chat projection into its graph without losing other routes. */
export function syncActiveStoryBranch(tree, liveMessages, { adapters = [] } = {}) {
  validateTreeShape(tree);
  // This projection is only read for identity matching; clone the live input once.
  const expected = branchPath(tree, tree.activeBranchId, {}, false);
  const expectedIds = expected.map(messageId);
  const next = {
    ...tree,
    messages: { ...tree.messages },
    branches: { ...tree.branches },
  };
  next.branches[next.activeBranchId] = { ...tree.branches[tree.activeBranchId], adapterStates: { ...tree.branches[tree.activeBranchId].adapterStates } };
  for (const branchId of Object.keys(next.branches)) {
    if (next.branches[branchId].memoryState !== undefined) continue;
    if (branchId !== next.activeBranchId) next.branches[branchId] = { ...next.branches[branchId] };
    captureMemoryState(next.branches[branchId], resolveStoryBranch(tree, branchId));
  }
  const messages = clone(liveMessages);
  const suppliedIds = new Set(messages.map(messageId).filter((id) => typeof id === "string" && id));
  const usedIds = new Set();
  const ids = messages.map((message, index) => {
    if (!message.extra || typeof message.extra !== "object" || Array.isArray(message.extra)) message.extra = {};
    let id = message.extra[MESSAGE_ID_KEY];
    if (typeof id !== "string" || !id || usedIds.has(id)) {
      const prior = expected[index];
      const previousUnchanged = index > 0 && messageId(liveMessages[index - 1]) === expectedIds[index - 1];
      const nextUnchanged = index + 1 < messages.length && messageId(liveMessages[index + 1]) === expectedIds[index + 1];
      const swipeId = Array.isArray(message.swipe_info)
        && message.swipe_info.some((info) => info?.extra?.[MESSAGE_ID_KEY] === expectedIds[index]);
      const sameSwipeSet = expected.length === 1 && Array.isArray(message.swipes) && message.swipes.length > 1
        && message.swipes.length === prior?.swipes?.length && message.swipes.every((value, swipeIndex) => value === prior.swipes[swipeIndex]);
      const sameFloor = messages.length === expected.length && (swipeId || previousUnchanged || nextUnchanged || sameSwipeSet)
        && prior && !suppliedIds.has(expectedIds[index]) && !usedIds.has(expectedIds[index])
        && message.is_user === prior.is_user && message.is_system === prior.is_system && message.name === prior.name;
      id = sameFloor ? expectedIds[index] : createId();
    }
    setStoryMessageId(message, id);
    if (id === expectedIds[index]) inheritSwipeVariantIds(message, expected[index]);
    ensureSwipeVariantIds(message);
    usedIds.add(id);
    return id;
  });

  const actualIds = new Set(ids);
  const missingIds = expectedIds.filter((id) => !actualIds.has(id));
  if (missingIds.length) {
    const activeMessageIds = new Set(next.branches[next.activeBranchId].messageIds);
    const protectedIds = new Set(Object.values(tree.branches).filter((branch) => branch.id !== tree.activeBranchId)
      .flatMap((branch) => [...branch.messageIds, branch.forkMessageId].filter(Boolean)));
    if (missingIds.some((id) => !activeMessageIds.has(id) || protectedIds.has(id))) {
      const error = new Error("检测到共用楼层或分叉点被删除。为保护已有剧情分支，当前改动未合并到分支树。");
      error.code = "STORY_BRANCH_PROTECTED_CHANGE";
      throw error;
    }
    for (const id of missingIds) delete next.messages[id];
    for (const key of ["nodeNames", "nodeSummaries", "nodeNotes"]) {
      if (!tree[key]) continue;
      next[key] = { ...tree[key] };
      for (const id of missingIds) delete next[key][id];
    }
  }
  const active = next.branches[next.activeBranchId];
  for (let index = 0; index < messages.length; index++) {
    if (active.parentBranchId && index === 0) {
      // Some extensions keep chat-wide state on the first message. Snapshot it per route.
      const sharedRoot = next.messages[ids[index]];
      next.messages[ids[index]] = { ...messages[index] };
      if (ids[index] === active.forkMessageId) active.forkSnapshot = clone(messages[index]);
    } else if (active.parentBranchId && ids[index] === active.forkMessageId) {
      // The fork anchor is a route-local snapshot. Swiping/editing it in this
      // route must not silently change the shared parent or sibling routes.
      active.forkSnapshot = clone(messages[index]);
    } else {
      next.messages[ids[index]] = messages[index];
    }
  }

  if (!active.parentBranchId) {
    active.messageIds = ids;
  } else {
    const forkIndex = expected.findIndex((message) => messageId(message) === active.forkMessageId);
    if (forkIndex < 0 || ids[forkIndex] !== active.forkMessageId) {
      throw new Error("当前聊天与分叉点不一致，未覆盖剧情树数据。");
    }
    active.messageIds = ids.slice(forkIndex + 1);
  }
  if (missingIds.length) validateStoryTree(next);
  const specifications = new Map(Object.entries(active.adapterStates ?? {}).map(([id, state]) => [id, { id, messageFields: state.fields }]));
  for (const adapter of adapters) specifications.set(adapter.id, adapter);
  for (const adapter of specifications.values()) {
    const previous = active.adapterStates?.[adapter.id];
    const explicit = adapter.snapshotMode === "explicit" && previous;
    const selected = explicit ? messages.filter(message => !Object.hasOwn(previous.messages, messageId(message))) : messages;
    if (selected.length || !previous) captureStoryBranchAdapterState(next, active.id, selected, adapter.id, adapter.messageFields, { partial: Boolean(explicit) });
  }
  captureMemoryState(active, messages);
  return { tree: next, messages };
}

export function getStoryBranchRows(tree) {
  validateStoryTree(tree);
  const rows = [];
  const children = new Map();
  const insertionOrder = new Map(Object.keys(tree.branches).map((id, index) => [id, index]));
  const ownedMessageIds = new Map(Object.values(tree.branches).map((branch) => [branch.id, new Set(branch.messageIds)]));
  const displayParent = (branch) => {
    if (!branch.parentBranchId) return null;
    const ownerMessage = tree.messages[branch.forkMessageId];
    if (branch.branchKind === "swipe" || Number.isInteger(branch.sourceSwipeIndex)
      || ownerMessage?.mes !== branch.forkSnapshot?.mes
      || (swipeVariantId(ownerMessage) && swipeVariantId(branch.forkSnapshot)
        && swipeVariantId(ownerMessage) !== swipeVariantId(branch.forkSnapshot))) return branch.parentBranchId;
    for (let parent = tree.branches[branch.parentBranchId]; parent; parent = parent.parentBranchId ? tree.branches[parent.parentBranchId] : null) {
      if (ownedMessageIds.get(parent.id)?.has(branch.forkMessageId)) return parent.id;
    }
    return branch.parentBranchId;
  };
  for (const branch of Object.values(tree.branches)) {
    const parentId = displayParent(branch) ?? "";
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push({ ...branch, parentBranchId: parentId || null });
  }
  const forkIndexes = new Map();
  const parentRoutes = new Map();
  const parentRoute = (branchId) => {
    if (!parentRoutes.has(branchId)) parentRoutes.set(branchId, routeSegments(tree, branchId));
    return parentRoutes.get(branchId);
  };
  const forkIndex = (branch) => {
    if (!branch.parentBranchId) return -1;
    if (!forkIndexes.has(branch.id)) {
      let floor = 0;
      let found = -1;
      for (const segment of parentRoute(branch.parentBranchId).segments) {
        const index = segment.snapshot ? (messageId(segment.snapshot) === branch.forkMessageId ? 0 : -1)
          : segment.ids.indexOf(branch.forkMessageId, segment.start);
        if (index >= segment.start && index < segment.end) {
          found = floor + index - segment.start;
          break;
        }
        floor += segment.end - segment.start;
      }
      forkIndexes.set(branch.id, found);
    }
    return forkIndexes.get(branch.id);
  };
  for (const list of children.values()) {
    list.sort((a, b) => forkIndex(a) - forkIndex(b) || a.createdAt - b.createdAt || insertionOrder.get(a.id) - insertionOrder.get(b.id));
  }
  const visit = (parentId, depth, parentNumber = "") => {
    const list = children.get(parentId) ?? [];
    const forkCounts = new Map();
    for (const [index, branch] of list.entries()) {
      if (branch.pendingSwipe) continue;
      const anchorIndex = forkIndex(branch);
      const kind = !branch.parentBranchId ? "root"
        : branch.branchKind === "swipe" || Number.isInteger(branch.sourceSwipeIndex) ? "swipe" : "continuation";
      // Reply identity lives on the saved message/anchor; no route memory or
      // unrelated message bodies need restoring just to label this node.
      let sourceMessage = null;
      if (kind === "swipe") {
        let index = anchorIndex + 1;
        for (const segment of parentRoute(branch.parentBranchId).segments) {
          const size = segment.end - segment.start;
          if (index < size) {
            sourceMessage = segment.snapshot ?? tree.messages[segment.ids[segment.start + index]];
            break;
          }
          index -= size;
        }
      }
      const sourceMessageId = kind === "swipe"
        ? branch.sourceMessageId ?? messageId(sourceMessage) ?? `after:${branch.forkMessageId}`
        : null;
      const matchedReplyIndex = kind === "swipe" && branch.sourceVariantId && Array.isArray(sourceMessage?.swipe_info)
        ? sourceMessage.swipe_info.findIndex((info) => info?.extra?.[VARIANT_ID_KEY] === branch.sourceVariantId) : -1;
      const replyIndex = matchedReplyIndex >= 0 ? matchedReplyIndex : branch.sourceSwipeIndex;
      const displayForkIndex = kind === "swipe" ? anchorIndex + 1 : anchorIndex;
      const variantKey = branch.forkVariantId ?? legacyVariantKey(branch);
      const countKey = kind === "swipe" ? `swipe:${sourceMessageId}` : `floor:${branch.forkMessageId}:${variantKey}`;
      const siblingNumber = (forkCounts.get(countKey) ?? 0) + 1;
      forkCounts.set(countKey, siblingNumber);
      const floor = displayForkIndex + 1;
      const branchNumber = branch.parentBranchId
        ? kind === "swipe" ? `${parentNumber}.R${floor}.${siblingNumber}` : `${parentNumber}.${floor}.${siblingNumber}`
        : `${index + 1}`;
      const legacyAutoTitle = /^分支 \d+$/u.test(branch.title) || /^从“.+”节点继续$/u.test(branch.title);
      const title = branch.parentBranchId && (branch.autoTitle || (!branch.titleCustomized && legacyAutoTitle))
        ? `${kind === "swipe" ? "重说" : "分支"} ${siblingNumber}` : branch.title;
      const nodeKey = kind === "swipe" ? `reply:${branch.parentBranchId}:${sourceMessageId}`
        : kind === "continuation" ? `fork:${branch.parentBranchId}:${branch.forkMessageId}:${variantKey}` : null;
      rows.push({ ...branch, title, depth, branchNumber, forkIndex: anchorIndex, displayForkIndex,
        kind, sourceMessageId, nodeKey, variantKey, replyIndex, sourceVariantPresent: matchedReplyIndex >= 0 });
      visit(branch.id, depth + 1, branchNumber);
    }
  };
  visit("", 0);
  return rows;
}

export function getStoryMessageId(message) {
  return messageId(message);
}
