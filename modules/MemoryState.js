const VISIBILITY_FIELDS = ["is_hidden", "is_system"];
const idOf = message => message?.extra?.story_branch_tree_message_id;
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Compare JSON-shaped schema definitions before interning. Exotic values do not
// match; never assume an unchanged definition object is immutable.
export function memoryValuesEqual(left, right, parents = [], peers = []) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const plain = value => Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
  if (!plain(left) || !plain(right) || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && left.length !== right.length) return false;
  const cycle = parents.indexOf(left);
  if (cycle >= 0) return peers[cycle] === right;
  parents.push(left); peers.push(right);
  try {
    let count = 0;
    for (const key in left) if (owns(left, key)) {
      count++;
      if (!owns(right, key) || !memoryValuesEqual(left[key], right[key], parents, peers)) return false;
    }
    for (const key in right) if (owns(right, key)) count--;
    return count === 0;
  } finally { parents.pop(); peers.pop(); }
}

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
