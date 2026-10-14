const VISIBILITY_FIELDS = ["is_hidden", "is_system"];
const idOf = message => message?.extra?.story_branch_tree_message_id;
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function captureMemoryState(branch, messages) {
  const snapshots = Object.create(null);
  for (const message of messages) {
    if (!idOf(message)) continue;
    const fields = Object.create(null);
    for (const field of VISIBILITY_FIELDS) if (owns(message, field)) fields[field] = structuredClone(message[field]);
    snapshots[idOf(message)] = { fields };
  }
  branch.memoryState = snapshots;
}

export function restoreMemoryState(branch, messages, { copy = structuredClone, fields = null } = {}) {
  if (branch.memoryState === undefined) return messages;
  if (!branch.memoryState || typeof branch.memoryState !== "object" || Array.isArray(branch.memoryState)) {
    throw new Error("路线记忆状态损坏。");
  }
  for (const message of messages) {
    if (!owns(branch.memoryState, idOf(message))) continue;
    const state = branch.memoryState[idOf(message)];
    if (!state?.fields || typeof state.fields !== "object" || Array.isArray(state.fields)) throw new Error("路线楼层记忆状态损坏。");
    for (const field of VISIBILITY_FIELDS) {
      if (fields && !fields.has(field)) continue;
      if (owns(state.fields, field)) message[field] = copy(state.fields[field]);
      else delete message[field];
    }
  }
  return messages;
}
