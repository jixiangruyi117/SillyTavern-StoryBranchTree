export const TREE_METADATA_KEY = "story_branch_tree";
const MESSAGE_ID_KEY = "story_branch_tree_message_id";
const VARIANT_ID_KEY = "story_branch_tree_variant_id";

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

function branchPath(tree, branchId, seen = new Set()) {
  if (seen.has(branchId)) throw new Error("剧情树包含循环引用，无法打开路线。");
  const branch = tree.branches?.[branchId];
  if (!branch) throw new Error("剧情路线不存在。");
  if (!branch.parentBranchId) {
    return branch.messageIds.map((id) => {
      const message = tree.messages?.[id];
      if (!message) throw new Error("剧情树缺少消息数据，请先恢复聊天备份。");
      return clone(message);
    });
  }

  const nextSeen = new Set(seen);
  nextSeen.add(branchId);
  const parent = branchPath(tree, branch.parentBranchId, nextSeen);
  const forkIndex = parent.findIndex((message) => messageId(message) === branch.forkMessageId);
  if (forkIndex < 0) throw new Error("找不到这条路线的分叉点，原聊天数据未被更改。");
  const forkMessage = branch.forkSnapshot;
  if (!forkMessage || messageId(forkMessage) !== branch.forkMessageId) {
    throw new Error("剧情树缺少分叉消息快照，请先恢复聊天备份。");
  }
  const prefix = parent.slice(0, forkIndex);
  const path = [
    ...prefix,
    clone(forkMessage),
    ...branch.messageIds.map((id) => {
      const message = tree.messages?.[id];
      if (!message) throw new Error("剧情树缺少消息数据，请先恢复聊天备份。");
      return clone(message);
    }),
  ];
  if (Object.hasOwn(branch, "horaeRootMeta") && path[0]) {
    if (branch.horaeRootMeta == null) delete path[0].horae_meta;
    else path[0].horae_meta = clone(branch.horaeRootMeta);
  }
  return path;
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
  return {
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
}

function validateTreeShape(tree) {
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
  branchPath(tree, tree.activeBranchId);
  return true;
}

export function resolveStoryBranch(tree, branchId = tree?.activeBranchId) {
  validateTreeShape(tree);
  if (branchId !== tree.activeBranchId) branchPath(tree, tree.activeBranchId);
  return branchPath(tree, branchId);
}

export function createStoryBranch(tree, forkMessageIdValue, title, idFactory = createId) {
  validateStoryTree(tree);
  const activePath = resolveStoryBranch(tree);
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
  const parentPath = resolveStoryBranch(tree, parentBranchId);
  if (!parentPath.some((message) => messageId(message) === forkMessageIdValue)) {
    throw new Error("找不到分叉消息所属的路线，原聊天数据未被更改。");
  }
  if (parentPath[forkIndex]?.mes !== forkMessage.mes
    || (swipeVariantId(parentPath[forkIndex]) && swipeVariantId(forkMessage)
      && swipeVariantId(parentPath[forkIndex]) !== swipeVariantId(forkMessage))) parentBranchId = tree.activeBranchId;
  const id = idFactory();
  const next = clone(tree);
  const siblingCount = getStoryBranchRows(tree).filter((branch) => branch.parentBranchId === parentBranchId && branch.forkMessageId === forkMessageIdValue).length;
  const customTitle = typeof title === "string" && title.trim();
  next.branches[id] = {
    id,
    parentBranchId,
    forkMessageId: forkMessageIdValue,
    forkSwipeId: Number.isInteger(forkMessage.swipe_id) ? forkMessage.swipe_id : null,
    branchKind: "continuation",
    forkVariantId: swipeVariantId(forkMessage),
    forkSnapshot: snapshotActiveSwipe(forkMessage),
    horaeRootMeta: clone(activePath[0]?.horae_meta ?? null),
    title: customTitle ? title.trim().slice(0, 80) : `分支 ${siblingCount + 1}`,
    autoTitle: !customTitle,
    titleCustomized: Boolean(customTitle),
    createdAt: Date.now(),
    messageIds: [],
  };
  next.activeBranchId = id;
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
  if (!isActiveSwipe) delete firstMessage.horae_meta;

  next.messages[newMessageId] = firstMessage;
  branch.messageIds = [newMessageId];
  branch.originSwipeIndex = Number.isInteger(reply.swipe_id) ? reply.swipe_id : 0;
  branch.sourceSwipeIndex = swipeIndex;
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
export function syncActiveStoryBranch(tree, liveMessages) {
  const expected = resolveStoryBranch(tree);
  const expectedIds = expected.map(messageId);
  const next = {
    ...tree,
    messages: { ...tree.messages },
    branches: { ...tree.branches },
  };
  next.branches[next.activeBranchId] = clone(tree.branches[tree.activeBranchId]);
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
      active.horaeRootMeta = clone(messages[index].horae_meta ?? null);
      const sharedRoot = next.messages[ids[index]];
      next.messages[ids[index]] = { ...messages[index] };
      if (sharedRoot?.horae_meta == null) delete next.messages[ids[index]].horae_meta;
      else next.messages[ids[index]].horae_meta = sharedRoot.horae_meta;
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
  const parentIndexes = new Map();
  const parentPaths = new Map();
  const parentPath = (branchId) => {
    if (!parentPaths.has(branchId)) parentPaths.set(branchId, branchPath(tree, branchId));
    return parentPaths.get(branchId);
  };
  const forkIndex = (branch) => {
    if (!branch.parentBranchId) return -1;
    if (!forkIndexes.has(branch.id)) {
      if (!parentIndexes.has(branch.parentBranchId)) {
        parentIndexes.set(branch.parentBranchId, new Map(parentPath(branch.parentBranchId)
          .map((message, index) => [messageId(message), index])));
      }
      forkIndexes.set(branch.id, parentIndexes.get(branch.parentBranchId).get(branch.forkMessageId) ?? -1);
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
      const sourceMessage = kind === "swipe" ? parentPath(branch.parentBranchId)[anchorIndex + 1] : null;
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
