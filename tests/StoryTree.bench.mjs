import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Session } from "node:inspector";
import { fileURLToPath, pathToFileURL } from "node:url";

// Separate processes keep baseline/candidate heaps and JIT state independent.
// Allocation samples are measured separately from wall time and working set.
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.env.STORY_TREE_BASELINE ?? "ba06b33b10458a73ff40f40e1f7f04fc0591c362";
const cases = {
  small: { rootCount: 1000, width: 12, suffixCount: 80, leafCount: 16, textLength: 512 },
  large: { rootCount: 4000, width: 24, suffixCount: 160, leafCount: 32, textLength: 1024 },
};
const mib = bytes => bytes / 1024 ** 2;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hashTree = tree => {
  // Hash records separately: serializing the whole fixture before measurement
  // would itself dominate the process high-water mark.
  const { messages, branches, ...metadata } = tree;
  const result = createHash("sha256").update(JSON.stringify(metadata));
  for (const [id, message] of Object.entries(messages)) result.update(id).update(hash(message));
  for (const [id, branch] of Object.entries(branches)) result.update(id).update(hash(branch));
  return result.digest("hex");
};
const sourceAt = path => execFileSync("git", ["show", `${baseline}:${path}`], { cwd: root, encoding: "utf8" });
const dataModule = source => "data:text/javascript;base64," + Buffer.from(source).toString("base64");

async function loadApi(version) {
  if (version === "candidate") return import(pathToFileURL(root + "modules/StoryTree.js").href);
  const memoryUrl = dataModule(sourceAt("modules/MemoryState.js"));
  const source = sourceAt("modules/StoryTree.js")
    .replace(/"\.\/MemoryState\.js(?:\?[^\"]*)?"/, JSON.stringify(memoryUrl));
  return import(dataModule(source));
}

function fixture(api, config) {
  let sequence = 0;
  const makeId = () => `fixture-${++sequence}`;
  const makeMessage = index => {
    const body = `${index}:` + "剧情片段与角色对话".repeat(Math.ceil(config.textLength / 9));
    // Flatten strings before measurement, so rope flattening is not an advantage.
    const mes = Buffer.from(body.slice(0, config.textLength)).toString("utf8");
    return { mes, is_user: index % 2 === 0, is_hidden: index % 11 === 0,
      PluginMemory: { events: [`event-${index}`], values: Array.from({ length: 16 }, (_, i) => index + i) },
      extra: { story_branch_tree_message_id: makeId() } };
  };
  const messages = Array.from({ length: config.rootCount }, (_, index) => makeMessage(index));
  const tree = api.createStoryTree(messages, makeId);
  const rootBranch = tree.branches[tree.rootBranchId];
  const paths = new Map([[rootBranch.id, messages]]);
  rootBranch.createdAt = 1;
  api.captureStoryBranchAdapterState(tree, rootBranch.id, messages, "benchmark-memory", ["PluginMemory"]);
  const addBranch = (parentId, forkIndex, count, ordinal) => {
    const parent = tree.branches[parentId];
    const parentMessages = paths.get(parentId);
    const prefix = parentMessages.slice(0, forkIndex + 1);
    const suffix = Array.from({ length: count }, (_, index) => makeMessage(100000 + ordinal * 1000 + index));
    const id = makeId();
    tree.branches[id] = {
      id, parentBranchId: parent.id, forkMessageId: api.getStoryMessageId(prefix.at(-1)),
      forkSwipeId: null, branchKind: "continuation", forkVariantId: null,
      forkSnapshot: structuredClone(prefix.at(-1)), title: `路线 ${ordinal}`, createdAt: ordinal + 1,
      messageIds: suffix.map(api.getStoryMessageId),
    };
    for (const message of suffix) tree.messages[api.getStoryMessageId(message)] = message;
    api.captureStoryBranchAdapterState(tree, id, [...prefix, ...suffix], "benchmark-memory", ["PluginMemory"]);
    paths.set(id, [...prefix, ...suffix]);
    return id;
  };
  for (let index = 0; index < config.width; index++) {
    const forkIndex = Math.floor(config.rootCount * 0.6) + index;
    const child = addBranch(rootBranch.id, forkIndex, config.suffixCount, index * 2 + 1);
    addBranch(child, forkIndex + Math.floor(config.suffixCount / 2), config.leafCount, index * 2 + 2);
  }
  api.validateStoryTree(tree);
  return tree;
}

function operate(api, operation, tree) {
  return operation === "fork"
    ? api.createStoryBranch(tree, tree.branches[tree.rootBranchId].messageIds[Math.floor(tree.branches[tree.rootBranchId].messageIds.length * 0.7)], "新增路线", () => "benchmark-new-route")
    : api.getStoryBranchRows(tree);
}

function digest(api, operation, result) {
  if (operation === "rows") return hash(result);
  // Check complete persisted data and every route after JSON export/import.
  const restored = JSON.parse(JSON.stringify(result));
  const routes = Object.keys(restored.branches).map(id => [id, hash(api.resolveStoryBranch(restored, id))]);
  return hash([hash(restored), routes]);
}

if (process.argv[2] === "--worker") {
  assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc");
  const [, , , version, operation, size] = process.argv;
  const api = await loadApi(version);
  const realNow = Date.now;
  Date.now = () => 1700000000000;
  // Same small warmup regardless of measured fixture size.
  const warm = fixture(api, { rootCount: 40, width: 2, suffixCount: 8, leafCount: 2, textLength: 64 });
  for (let index = 0; index < 3; index++) {
    api.getStoryBranchRows(warm);
    api.createStoryBranch(warm, warm.branches[warm.rootBranchId].messageIds[20], "warm", () => "warm");
  }
  const tree = fixture(api, cases[size]);
  const inputDigest = hashTree(tree);
  globalThis.gc();
  const before = process.memoryUsage();
  const start = performance.now();
  let result = operate(api, operation, tree);
  const elapsedMs = performance.now() - start;
  const after = process.memoryUsage();
  const processPeakMiB = process.resourceUsage().maxRSS / 1024;
  globalThis.gc();
  const retained = process.memoryUsage();
  const resultDigest = digest(api, operation, result);
  assert.equal(hashTree(tree), inputDigest, "Operation mutated its source tree");
  result = null;
  globalThis.gc();

  const session = new Session();
  session.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, response) => error ? reject(error) : resolve(response)));
  await post("HeapProfiler.startSampling", {
    samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  result = operate(api, operation, tree);
  const { profile } = await post("HeapProfiler.stopSampling");
  session.disconnect();
  const allocated = node => node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
  assert.equal(digest(api, operation, result), resultDigest);
  Date.now = realNow;
  process.stdout.write(JSON.stringify({ version, operation, size, elapsedMs, processPeakMiB,
    endHeapDeltaMiB: mib(after.heapUsed - before.heapUsed),
    retainedHeapDeltaMiB: mib(retained.heapUsed - before.heapUsed),
    sampledAllocatedMiB: mib(allocated(profile.head)), resultDigest,
    messages: Object.keys(tree.messages).length, routes: Object.keys(tree.branches).length,
  }));
} else {
  const samples = Number(process.env.STORY_TREE_BENCH_SAMPLES ?? 5);
  assert.ok(Number.isInteger(samples) && samples > 0);
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, baseline, samples,
    memoryNotes: "sampledAllocatedMiB estimates allocation volume (16 KiB sampling), not peak heap; processPeakMiB is whole-process peak working set including fixture setup; endHeapDeltaMiB is GC-sensitive; retainedHeapDeltaMiB keeps input and output alive" }));
  for (const size of Object.keys(cases)) for (const operation of ["fork", "rows"]) {
    const results = { baseline: [], candidate: [] };
    for (let index = 0; index < samples; index++) {
      // Alternate order to reduce systematic machine-load bias.
      for (const version of index % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
        const output = execFileSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--worker", version, operation, size],
          { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
        results[version].push(JSON.parse(output));
      }
    }
    assert.equal(new Set([...results.baseline, ...results.candidate].map(result => result.resultDigest)).size, 1,
      `${size}/${operation}: baseline and candidate outputs differ`);
    const summary = { size, operation, messages: results.baseline[0].messages, routes: results.baseline[0].routes, identicalOutputs: true };
    for (const metric of ["elapsedMs", "processPeakMiB", "sampledAllocatedMiB", "endHeapDeltaMiB", "retainedHeapDeltaMiB"]) {
      const before = median(results.baseline.map(result => result[metric]));
      const after = median(results.candidate.map(result => result[metric]));
      summary[metric] = { baseline: +before.toFixed(3), candidate: +after.toFixed(3), reductionPercent: +(100 * (before - after) / before).toFixed(1) };
    }
    console.log(JSON.stringify(summary));
  }
}
