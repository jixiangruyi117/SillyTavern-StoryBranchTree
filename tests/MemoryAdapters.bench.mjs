import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Session } from "node:inspector";
import { readFile } from "node:fs/promises";

// Copy the pre-change runtime modules to a temporary baseline directory before
// editing, then set MEMORY_ADAPTER_BASELINE_DIR to it. No network/model requests.
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.env.MEMORY_ADAPTER_BASELINE_DIR;
const cases = { small: { floors: 1000, tables: 3, versions: 40, routes: 41 },
  large: { floors: 4000, tables: 6, versions: 160, routes: 161 } };
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const mib = value => value / 1048576;
let fixtureSequence = 0;

async function workload(version, mode, size) {
  const dir = version === "baseline" ? resolve(baseline) : root;
  const load = name => import(pathToFileURL(resolve(dir, "modules", name + ".js")).href);
  const tree = await load("StoryTree");
  const config = cases[size];
  const matrix = table => Array.from({ length: 8 }, (_, row) => Array.from({ length: 6 }, (_, col) => `cell-${table}-${row}-${col}`));
  const chat = Array.from({ length: config.floors }, (_, i) => ({
    mes: `剧情${i}:` + "测试正文".repeat(100), is_user: false, swipe_id: 0, swipes: [`剧情${i}:` + "测试正文".repeat(100)],
    extra: { story_branch_tree_message_id: `m-${i}`, story_branch_tree_variant_id: `v-${i}` },
    swipe_info: [{ extra: { story_branch_tree_message_id: `m-${i}`, story_branch_tree_variant_id: `v-${i}` } }],
    hash_sheets: Object.fromEntries(Array.from({ length: config.tables }, (_, t) => [`s-${t}`, matrix(t)])),
    uid: `uid-${i}`, two_step_links: { [`uid-${i}_0`]: [`uid-${i}_0`] },
  }));
  if (mode === "single") {
    const fixtureId = ++fixtureSequence;
    const state = tree.createStoryTree(chat, () => "root");
    for (let i = 1; i < config.routes; i++) state.branches[`r-${i}`] = { id: `r-${i}`, title: `分支${i}`, createdAt: i,
      parentBranchId: "root", forkMessageId: "m-10", branchKind: "continuation", forkSnapshot: structuredClone(chat[10]), messageIds: [], memoryState: {} };
    const ctx = { characterId: 0, chatId: "benchmark", chat, chatMetadata: { story_branch_tree: state },
      updateChatMetadata(patch) { Object.assign(this.chatMetadata, patch); }, saveMetadataDebounced() {},
      eventTypes: { CHARACTER_MESSAGE_RENDERED: "rendered" }, eventSource: { events: { rendered: [] } } };
    function onMessageReceived() { const TableTwoStepSummary = 0, handleEditStrInMessage = 0; }
    ctx.eventSource.events.rendered.push(onMessageReceived);
    const manager = { BASE: { refreshContextView: async () => {} }, USER: { tableBaseSetting: {}, saveChat() {} },
      DERIVED: { any: {} }, EDITOR: { tryBlock: fn => fn() } };
    globalThis.__adapterBenchImport = async path => path.endsWith("manager.js") ? manager : path.endsWith("index.js")
      ? { handleEditStrInMessage() {} } : { TableTwoStepSummary: async () => {} };
    globalThis.SillyTavern = { getContext: () => ctx };
    globalThis.stMemoryEnhancement = { VERSION: "2.2.19" };
    const dataModule = source => "data:text/javascript;base64," + Buffer.from(source).toString("base64");
    const singleUrl = dataModule((await readFile(resolve(dir, "modules/MuyooMemory.js"), "utf8"))
      .replace('importModule = path => import(path)', 'importModule = globalThis.__adapterBenchImport') + `\n// fixture ${fixtureId}`);
    let source = await readFile(resolve(dir, "index.js"), "utf8");
    for (const name of ["StoryTree", "MemoryState", "NativeStory", "MemoryEnhancementBridge", "MuyooMemory"]) source = source.replace(
      new RegExp('"\\./modules/' + name + '\\.js(?:\\?[^" ]*)?"'), JSON.stringify(name === "MuyooMemory" ? singleUrl : pathToFileURL(resolve(dir, "modules", name + ".js")).href));
    source = source.replace('"../../../../script.js"', JSON.stringify(dataModule("export const swipeState='none'; export const isGenerating=()=>false; export const sendTextareaMessage=()=>{}; export const updateSwipeCounter=async()=>{};")))
      .replace('"../../../RossAscends-mods.js"', JSON.stringify(dataModule("export const shouldSendOnEnter=()=>false;")));
    const extension = await import(dataModule(source + '\nexport { installPublicApi, removePublicApi, syncLiveChat, singleMemoryCompatibility };' + `\n// fixture ${fixtureId}`));
    extension.installPublicApi(); await extension.singleMemoryCompatibility.ensure();
    const originalInactive = hash(Object.entries(ctx.chatMetadata.story_branch_tree.branches).filter(([id]) => id !== "root"));
    return {
      run() {
        chat.at(-1).hash_sheets["s-0"][1][1] = "changed";
        // One real plugin save, followed by the common receive/update/end syncs.
        manager.USER.saveChat();
        for (let i = 0; i < 3; i++) extension.syncLiveChat();
      },
      digest() {
        const savedTree = ctx.chatMetadata.story_branch_tree;
        assert.equal(hash(Object.entries(savedTree.branches).filter(([id]) => id !== "root")), originalInactive);
        assert.equal(savedTree.branches.root.adapterStates["muyoo-memory-v1"].messages[`m-${config.floors - 1}`].hash_sheets["s-0"][1][1], "changed");
        assert.equal(chat.at(-1).swipe_info[0].extra.story_branch_tree_swipe_message_fields.hash_sheets.value["s-0"][1][1], "changed");
        return hash([savedTree, chat]);
      }, counts: () => ({ floors: config.floors, routes: config.routes }),
      dispose: () => extension.removePublicApi(),
    };
  }
  const bridge = await load("MemoryEnhancementBridge");
  const schemas = Array.from({ length: config.tables }, (_, i) => ({ uid: `s-${i}`, name: `表${i}`, type: "dynamic", enable: true, config: { toChat: true } }));
  const metadata = { sheets: schemas.map((s, i) => ({ ...s, hashSheet: matrix(i), cellHistory: [] })),
    [bridge.SCHEMA_STORE]: { version: 1, retired: {}, schemas: Object.fromEntries(Array.from({ length: config.versions }, (_, i) =>
      [`v-${i}`, schemas.map(s => ({ ...structuredClone(s), name: i === config.versions - 1 ? s.name : `${s.name}-old-${i}` }))])) } };
  const ctx = { characterId: 0, groupId: null, chat, chatMetadata: metadata,
    eventTypes: { MESSAGE_SWIPED: "swipe" }, eventSource: { makeFirst() {}, removeListener() {} } };
  const calls = { routeReads: 0, captures: 0, notifications: 0, saves: 0 };
  let adapter;
  const api = { capabilities: { replyMemory: true },
    getActiveRoute() { calls.routeReads++; return { storageMode: "native", messageIds: chat.map(tree.getStoryMessageId) }; },
    registerRouteAdapter(a) { adapter = a; return () => {}; },
    captureReplyMemory(id, index) { calls.captures++; tree.captureReplyMemory(chat[index], adapter.messageFields); },
    notifyMemoryChanged() { calls.notifications++; },
  };
  const USER = { tableBaseSetting: {}, getChatPiece: () => ({ piece: chat.at(-1) }), saveChat() { calls.saves++; } };
  class Sheet { constructor(i) { this.i = i; }
    save(piece = chat.at(-1), manual = false) {
      piece.hash_sheets[`s-${this.i}`] = matrix(this.i);
      if (!manual) USER.saveChat();
      return this;
    }
  }
  const sheets = schemas.map((_, i) => new Sheet(i));
  const BASE = { Sheet, saveChatSheets() { for (const sheet of sheets) sheet.save(chat.at(-1), true); USER.saveChat(); } };
  const dispose = bridge.installMemoryEnhancementBridge({ api, getContext: () => ctx, getStorageMode: () => "native",
    BASE, USER, DERIVED: { any: {} }, updateSheetsView: async () => {} });
  USER.saveChat();
  Object.keys(calls).forEach(key => { calls[key] = 0; });
  return {
    run() { for (let i = 0; i < 10; i++) BASE.saveChatSheets(); },
    digest() {
      const saved = tree.readReplyMemory(chat.at(-1), adapter.messageFields);
      assert.deepEqual(saved.hash_sheets, chat.at(-1).hash_sheets);
      assert.equal(Object.keys(metadata[bridge.SCHEMA_STORE].schemas).length, config.versions);
      return hash([metadata, chat.at(-1)]);
    }, counts: () => ({ ...calls, floors: config.floors, routes: config.routes }), dispose,
  };
}

if (process.argv[2] === "--worker") {
  Date.now = () => 1700000000000;
  const [, , , version, mode, size] = process.argv;
  assert.equal(typeof globalThis.gc, "function", "Use --expose-gc");
  const warm = await workload(version, mode, "small"); warm.run(); warm.dispose?.();
  const job = await workload(version, mode, size);
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  let clones = 0;
  const originalClone = globalThis.structuredClone;
  globalThis.structuredClone = value => { clones++; return originalClone(value); };
  const started = performance.now(); job.run(); const elapsedMs = performance.now() - started;
  globalThis.structuredClone = originalClone;
  const endHeapMiB = mib(process.memoryUsage().heapUsed - before);
  const peakMiB = process.resourceUsage().maxRSS / 1024;
  const digest = job.digest(), counts = job.counts(); job.dispose?.();
  // Measure allocation separately so profiling does not distort elapsed time.
  const sampled = await workload(version, mode, size);
  const session = new Session(); session.connect();
  const post = (method, params = {}) => new Promise((res, rej) => session.post(method, params, (error, value) => error ? rej(error) : res(value)));
  await post("HeapProfiler.startSampling", { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  sampled.run();
  const { profile } = await post("HeapProfiler.stopSampling"); session.disconnect();
  const sum = node => node.selfSize + node.children.reduce((s, child) => s + sum(child), 0);
  assert.equal(sampled.digest(), digest); sampled.dispose?.();
  process.stdout.write(JSON.stringify({ version, mode, size, elapsedMs, clones, endHeapMiB, peakMiB, allocatedMiB: mib(sum(profile.head)), digest, counts }));
} else {
  assert.ok(baseline, "Set MEMORY_ADAPTER_BASELINE_DIR to the pre-change runtime directory");
  const modes = (process.env.MEMORY_ADAPTER_MODES ?? "single,native").split(",");
  assert.ok(modes.every(mode => ["single", "native"].includes(mode)), "Invalid MEMORY_ADAPTER_MODES");
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  for (const size of Object.keys(cases)) for (const mode of modes) {
    const results = { baseline: [], candidate: [] };
    for (let round = 0; round < 5; round++) for (const version of round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
      results[version].push(JSON.parse(execFileSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--worker", version, mode, size], { cwd: root, encoding: "utf8", maxBuffer: 1048576 })));
    }
    const expected = results.baseline[0].digest;
    for (const result of Object.values(results).flat()) assert.equal(result.digest, expected, "Baseline/candidate persisted data differ");
    const summary = Object.fromEntries(Object.entries(results).map(([version, rows]) => [version, Object.fromEntries(
      ["elapsedMs", "clones", "endHeapMiB", "peakMiB", "allocatedMiB"].map(key => [key, median(rows.map(row => row[key]))]).concat([["counts", rows[0].counts]]))]));
    process.stdout.write(JSON.stringify({ mode, size, config: cases[size], ...summary }) + "\n");
  }
}
