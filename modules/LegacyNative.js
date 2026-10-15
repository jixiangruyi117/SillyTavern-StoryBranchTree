// Old native branches reference filenames, not our story IDs. Never infer an edge from a title.
const nameOf = value => typeof value === "string" ? value.replace(/\.jsonl$/i, "") : "";

export function legacyComponent(files, currentName, nativeKey, validMetadata) {
  const byName = new Map(files.map(file => [nameOf(file.file_name), file]));
  const links = new Map(), stories = new Map();
  const link = (a, b) => {
    if (!a || !b || a === b) return;
    if (!links.has(a)) links.set(a, new Set());
    if (!links.has(b)) links.set(b, new Set());
    links.get(a).add(b); links.get(b).add(a);
  };
  for (const [name, file] of byName) {
    link(name, nameOf(file.chat_metadata?.main_chat));
    const native = file.chat_metadata?.[nativeKey];
    if (validMetadata(native)) {
      if (stories.has(native.storyId)) link(name, stories.get(native.storyId));
      else stories.set(native.storyId, name);
    }
  }
  const seen = new Set([currentName]), queue = [currentName];
  for (let i = 0; i < queue.length; i++) for (const next of links.get(queue[i]) ?? []) {
    if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  const cycle = new Set();
  const done = new Set();
  for (const start of seen) {
    const path = [], visited = new Map();
    for (let name = start; byName.has(name); name = nameOf(byName.get(name).chat_metadata?.main_chat)) {
      if (visited.has(name)) { path.slice(visited.get(name)).forEach(item => cycle.add(item)); break; }
      if (done.has(name)) break;
      visited.set(name, path.length); path.push(name);
    }
    path.forEach(name => done.add(name));
  }
  return { files: [...seen].filter(name => byName.has(name)).map(name => ({ name, file: byName.get(name), cycle: cycle.has(name) })),
    missing: [...seen].filter(name => !byName.has(name)) };
}

export async function legacyDigest(value) {
  const text = JSON.stringify(value);
  // LAN HTTP installations have no SubtleCrypto. This is a concurrency check, not a signature.
  if (!globalThis.crypto?.subtle) return `local:${replySignature({}, text)}`;
  const data = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function replySignature(message, text) {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `${Boolean(message.is_user)}:${text.length}:${a >>> 0}:${b >>> 0}`;
}

export function summarizeLegacy(records, getMessageId, makeId) {
  const messages = records.slice(1), ids = new Set();
  const identities = messages.map(message => {
    let id = getMessageId(message);
    if (!id || ids.has(id)) id = makeId();
    ids.add(id); return id;
  });
  const links = new Map(), checkpoints = new Set();
  messages.forEach((message, index) => {
    for (const target of Array.isArray(message.extra?.branches) ? message.extra.branches : []) {
      const name = nameOf(target);
      if (name) links.set(name, [...(links.get(name) ?? []), index + 1]);
    }
    if (typeof message.extra?.bookmark_link === "string") checkpoints.add(nameOf(message.extra.bookmark_link));
  });
  return { identities, knownIdentities: messages.map(getMessageId), links, checkpoints, messageCount: messages.length,
    endSummary: String(messages.at(-1)?.mes ?? "").slice(0, 150),
    signatures: messages.map(message => replySignature(message, message.mes)),
    variants: messages.map(message => new Set([message.mes, ...(message.swipes ?? [])].filter(text => typeof text === "string")
      .map(text => replySignature(message, text)))) };
}
