const ADAPTER_ID = "muyoo-memory-v1";
const REPLY_FIELDS_KEY = "story_branch_tree_swipe_message_fields";
const MESSAGE_FIELDS = ["hash_sheets", "dataTable", "tableEditMatches", "two_step_links", "two_step_waiting", "uid"];
const ROOT = "/scripts/extensions/third-party/st-memory-enhancement";
const UNSAFE_CACHE_IDS = new Set(["__proto__", "constructor", "prototype"]);

/** Retain the cells referenced by this route, never the discarded future's cells. */
export function muyooSheetsAtMessages(sheets, messages) {
  if (!Array.isArray(sheets) || sheets.some(sheet => !sheet || typeof sheet.uid !== "string"
    || UNSAFE_CACHE_IDS.has(sheet.uid) || !Array.isArray(sheet.cellHistory))) {
    throw new Error("记忆增强的表格历史尚未就绪或已损坏。");
  }
  const references = new Map();
  for (const message of messages) {
    if (message.dataTable && !message.hash_sheets) throw new Error("旧版记忆表格尚未转换，请先在原插件中打开该聊天。");
    for (const [uid, matrix] of Object.entries(message.hash_sheets ?? {})) {
      if (UNSAFE_CACHE_IDS.has(uid) || !Array.isArray(matrix) || matrix.some(row => !Array.isArray(row) || row.some(cell => typeof cell !== "string"))) {
        throw new Error("记忆增强的楼层表格索引损坏，未切换路线。");
      }
      const ref = references.get(uid) ?? { cells: new Set(), matrix, hasBody: false };
      for (const row of matrix) for (const cell of row) ref.cells.add(cell);
      ref.matrix = matrix;
      ref.hasBody ||= matrix.length > 1;
      references.set(uid, ref);
    }
  }
  const pool = new Map(sheets.map(sheet => [sheet.uid, sheet]));
  return [...references].flatMap(([uid, ref]) => {
    const source = pool.get(uid);
    // Native new-chat template initialization may leave retired header-only IDs on
    // the first message. Native hashSheetsToSheets ignores these absent templates.
    if (!source && !ref.hasBody) return [];
    if (!source || !Array.isArray(source.cellHistory)) throw new Error("该路线引用的记忆表格历史缺失，未借用其他路线的数据。");
    const missing = new Set(ref.cells);
    const cellHistory = source.cellHistory.filter(cell => {
      if (!ref.cells.has(cell.uid)) return false;
      missing.delete(cell.uid);
      return true;
    });
    if (missing.size) throw new Error("该路线引用的记忆单元格缺失，不能安全恢复。");
    const data = { hashSheet: ref.matrix, cellHistory };
    // Native Sheet.save persists these definitions. Optional content/sourceData imports
    // can reconstruct a later table inside loadJson; do not read or clone them here.
    for (const field of ["uid", "name", "domain", "type", "enable", "required", "tochat", "triggerSend", "triggerSendDeep", "config"]) {
      if (Object.hasOwn(source, field)) data[field] = source[field];
    }
    return [structuredClone(data)];
  });
}

export function captureMuyooReplies(messages) {
  for (const message of messages) {
    const index = message.swipe_id ?? 0;
    if (!Array.isArray(message.swipes) || message.swipes[index] !== message.mes) continue;
    message.extra ??= {};
    const values = { ...message.extra[REPLY_FIELDS_KEY] };
    for (const field of MESSAGE_FIELDS) values[field] = Object.hasOwn(message, field)
      ? { present: true, value: structuredClone(message[field]) } : { present: false };
    message.extra[REPLY_FIELDS_KEY] = values;
    message.swipe_info ??= [];
    message.swipe_info[index] ??= {};
    message.swipe_info[index].extra ??= {};
    message.swipe_info[index].extra[REPLY_FIELDS_KEY] = values;
  }
}

export function pruneMuyooTaskLinks(messages) {
  const retained = new Set(messages.filter(message => message.uid).map(message => `${message.uid}_${message.swipe_id}`));
  for (const message of messages) {
    for (const [reply, targets] of Object.entries(message.two_step_links ?? {})) {
      if (Array.isArray(targets)) message.two_step_links[reply] = targets.filter(target => retained.has(target));
    }
  }
}

export function mergeMuyooCellPools(current, checkpoint) {
  const pools = new Map(current.map(sheet => [sheet.uid, { ...sheet, cellHistory: [...sheet.cellHistory] }]));
  for (const sheet of checkpoint ?? []) {
    const pool = pools.get(sheet.uid);
    if (!pool) { pools.set(sheet.uid, sheet); continue; }
    const known = new Set(pool.cellHistory.map(cell => cell.uid));
    for (const cell of sheet.cellHistory) if (!known.has(cell.uid)) { pool.cellHistory.push(cell); known.add(cell.uid); }
  }
  return [...pools.values()];
}

/** All wrappers are confined to this plugin's objects and identified event callbacks. */
export function createMuyooMemoryCompatibility({ getContext, getApi, importModule = path => import(path),
  getPlugin = () => globalThis.stMemoryEnhancement, report = error => console.error("[StoryBranchTree] Muyoo memory", error) }) {
  let instance = null;
  let loading = null;
  let lifecycle = 0;
  const hasBranches = () => Object.keys(getContext()?.chatMetadata?.story_branch_tree?.branches ?? {}).length > 1;
  const solo = () => {
    const ctx = getContext();
    return ctx?.characterId !== undefined && ctx.characterId !== null && ctx.groupId == null;
  };
  const enabled = () => {
    const ctx = getContext();
    const configured = ctx?.powerUserSettings?.muyoo_dataTable?.isExtensionAble
      ?? ctx?.extensionSettings?.muyoo_dataTable?.isExtensionAble;
    return Boolean(getPlugin()) && configured !== false && instance?.isEnabled() !== false;
  };
  const load = async () => {
    if (!enabled() || instance) return;
    const api = getApi(), epoch = lifecycle;
    if (!api) return;
    if (getPlugin().VERSION !== "2.2.19") throw new Error("记忆增强插件版本不在已核对范围内，请先完成该版本的适配验证。");
    const [manager, native, step, rebuild] = await Promise.all([
      importModule(`${ROOT}/core/manager.js`), importModule(`${ROOT}/index.js`),
      importModule(`${ROOT}/scripts/runtime/separateTableUpdate.js`),
      importModule(`${ROOT}/scripts/runtime/absoluteRefresh.js`),
    ]);
    if (epoch !== lifecycle || getApi() !== api || !enabled()) return;
    const { BASE, USER, DERIVED, EDITOR } = manager;
    if (USER.tableBaseSetting.isExtensionAble === false) return;
    const ctx = getContext();
    const source = ctx.eventSource;
    const event = ctx.eventTypes?.CHARACTER_MESSAGE_RENDERED;
    const handlers = source?.events?.[event];
    const candidates = handlers?.filter(fn => fn.name === "onMessageReceived"
      && /TableTwoStepSummary/.test(Function.prototype.toString.call(fn))
      && /handleEditStrInMessage/.test(Function.prototype.toString.call(fn))) ?? [];
    if (candidates.length !== 1 || !BASE?.refreshContextView || !USER?.saveChat || !EDITOR?.tryBlock
      || !native?.handleEditStrInMessage || !step?.TableTwoStepSummary) throw new Error("记忆增强尚未完成初始化，暂不能安全切换路线。");
    const cleanup = [];
    const operations = new Set();
    const views = new Set();
    let suspended = false;
    let disposed = false;
    let unregister = null;
    let lastMetadata = ctx.chatMetadata?.sheets;
    const scope = () => {
      const current = getContext();
      return { chat: current.chat, chatId: current.chatId, characterId: current.characterId };
    };
    const assertScope = captured => {
      const current = getContext();
      if (current.chat !== captured.chat || current.chatId !== captured.chatId || current.characterId !== captured.characterId) {
        throw new Error("聊天已变化，已取消旧路线的表格恢复。");
      }
    };
    const notify = index => {
      if (disposed || !unregister || !hasBranches()) return;
      const current = getContext();
      if (!solo()) return;
      const scoped = Number.isInteger(index) && index >= 0 && index < current.chat.length;
      captureMuyooReplies(scoped ? [current.chat[index]] : current.chat ?? []);
      const metadata = current.chatMetadata?.sheets !== lastMetadata;
      if (api.getActiveRouteKey()) api.notifyMemoryChanged(ADAPTER_ID,
        { ...(scoped ? { from: index, to: index + 1 } : {}), metadata });
      lastMetadata = current.chatMetadata?.sheets;
    };
    const track = (callback, collection) => {
      const marker = {};
      collection.add(marker);
      try {
        const result = callback();
        if (!result?.then) { collection.delete(marker); return result; }
        marker.promise = Promise.resolve(result).finally(() => collection.delete(marker));
        return marker.promise;
      } catch (error) { collection.delete(marker); throw error; }
    };
    const wrap = (object, key, create) => {
      const original = object[key];
      const replacement = create(original);
      object[key] = replacement;
      cleanup.push(() => { if (object[key] === replacement) object[key] = original; });
    };
    const restore = async () => {
      const captured = scope();
      DERIVED.any.chatSheetMap = {};
      const current = getContext();
      pruneMuyooTaskLinks(current.chat);
      const tail = current.chat.at(-1);
      // A previously unrecorded alternate reply is parsed from its own tableEdit text.
      if (tail && !tail.is_user && !tail.hash_sheets && current.chat.length > 1) {
        native.handleEditStrInMessage(tail, current.chat.length - 1, true);
      }
      await BASE.refreshContextView();
      assertScope(captured);
      notify();
    };
    try {
      const adapter = { id: ADAPTER_ID, messageFields: MESSAGE_FIELDS,
        metadataFields: ["sheets"], snapshotMode: "explicit",
        async beforeSwitch(change) {
          if (operations.size) throw new Error("记忆增强正在填表或处理表格，请等该操作结束后再切换路线。");
          suspended = true;
          const captured = scope();
          try {
            await Promise.all([...views].map(job => job.promise));
            assertScope(captured);
            if (operations.size) throw new Error("记忆增强仍有未完成的表格操作。");
            const saved = change.fork ? null : api.getRouteMetadata(ADAPTER_ID, change.branchId);
            const sheets = saved === null ? getContext().chatMetadata?.sheets ?? [] : saved.sheets ?? [];
            const messages = change.getMessages({ fields: ["hash_sheets", "dataTable"] });
            let pool = sheets;
            try { return { metadata: { sheets: muyooSheetsAtMessages(pool, messages) } }; }
            catch (error) {
              if (saved !== null) throw error;
              // Legacy routes have no pinned container yet. Recover only referenced
              // immutable cells from this provider's existing checkpoints, then prune.
              for (const route of api.getRoutes?.() ?? []) {
                if (route.branchId === change.branchId) continue;
                const checkpoint = api.getRouteMetadata(ADAPTER_ID, route.branchId)?.sheets;
                if (!checkpoint) continue;
                pool = mergeMuyooCellPools(pool, checkpoint);
                try { return { metadata: { sheets: muyooSheetsAtMessages(pool, messages) } }; }
                catch { /* Continue only this one-time legacy recovery search. */ }
              }
              throw error;
            }
          } catch (error) { suspended = false; throw error; }
        },
        async afterSwitch() { try { await restore(); } finally { suspended = false; } },
        async onSwitchAborted() { try { await restore(); } finally { suspended = false; } },
      };
      cleanup.push(() => unregister?.());
      wrap(BASE, "refreshContextView", original => function (...args) {
        return track(() => original.apply(this, args), views);
      });
      wrap(USER, "saveChat", original => function (...args) { notify(); return original.apply(this, args); });
      if (typeof EDITOR.Popup === "function" && typeof rebuild.getPromptAndRebuildTable === "function") {
        wrap(EDITOR, "Popup", Original => class extends Original {
          constructor(content, ...args) {
            super(content, ...args);
            this.routeRebuildControls = { template: content?.querySelector?.("#rebuild_template_selector"),
              prompt: content?.querySelector?.("#rebuild_additional_prompt") };
          }
          async show(...args) {
            const { template, prompt } = this.routeRebuildControls;
            if (!solo() || !template || !prompt) return super.show(...args);
            if (suspended) throw new Error("正在恢复剧情路线的表格，请稍候。");
            return track(async () => {
              const result = await super.show(...args);
              if (this.result) {
                USER.tableBaseSetting.lastSelectedTemplate = template.value;
                DERIVED.any.additionalPrompt = prompt.value;
                // Native rebuildSheets detaches this exact child job. Await it here and
                // consume its confirmation so the native caller cannot start a second job.
                this.result = false;
                await rebuild.getPromptAndRebuildTable();
                notify();
              }
              return result;
            }, operations);
          }
        });
      }
      wrap(EDITOR, "tryBlock", original => function (callback, message, ...args) {
        if (!solo()) return original.call(this, callback, message, ...args);
        if (suspended) throw new Error("正在恢复剧情路线的表格，请稍候。");
        return original.call(this, (...values) => track(() => {
          const result = callback(...values);
          if (result?.then) return Promise.resolve(result).then(value => { notify(); return value; });
          notify();
          return result;
        }, operations), message, ...args);
      });
      const original = candidates[0];
      const replacement = function (index) {
        if (!solo()) return original.call(this, index);
        if (suspended || USER.tableBaseSetting.isExtensionAble === false) return;
        if (USER.tableBaseSetting.step_by_step === true && getContext().chat.length > 2) {
          // Native code deliberately does not await this job on the host event bus.
          void Promise.resolve(track(() => step.TableTwoStepSummary("auto"), operations)).then(notify).catch(report);
          void native.updateSheetsView();
          return;
        }
        return Promise.resolve(original.call(this, index)).then(() => notify(index));
      };
      handlers[handlers.indexOf(original)] = replacement;
      cleanup.push(() => {
        const current = source.events?.[event];
        const index = current?.indexOf(replacement) ?? -1;
        if (index >= 0) current[index] = original;
      });
      const manualButton = globalThis.document?.getElementById("trigger_step_by_step_button");
      if (manualButton) {
        const manualClick = event => {
          if (!solo()) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          if (suspended) { report(new Error("正在恢复剧情路线的表格，请稍候。")); return; }
          void Promise.resolve(track(() => step.TableTwoStepSummary("manual"), operations)).then(notify).catch(report);
        };
        manualButton.addEventListener("click", manualClick, true);
        cleanup.push(() => manualButton.removeEventListener("click", manualClick, true));
      }
      instance = {
        activate() {
          if (operations.size) throw new Error("记忆增强正在填表或处理表格，请等该操作结束后再切换路线。");
          if (unregister) return;
          captureMuyooReplies(getContext()?.chat ?? []);
          unregister = api.registerRouteAdapter(adapter);
        },
        releaseIfUnused() { if (!hasBranches()) { unregister?.(); unregister = null; } },
        captureReplies: () => { if (unregister && hasBranches()) captureMuyooReplies(getContext()?.chat ?? []); },
        isBusy: () => operations.size > 0 || views.size > 0,
        isEnabled: () => USER.tableBaseSetting.isExtensionAble !== false,
        dispose() { disposed = true; for (const dispose of cleanup.reverse()) dispose(); } };
    } catch (error) { disposed = true; for (const dispose of cleanup.reverse()) dispose(); throw error; }
  };
  return {
    async ensure({ forBranch = false } = {}) {
      if (!solo()) return;
      if (!enabled()) {
        if (instance?.isBusy()) throw new Error("记忆增强仍有未完成的操作，请结束后再切换路线。");
        instance?.dispose(); instance = null; return;
      }
      if (!forBranch && !hasBranches() && getPlugin().VERSION !== "2.2.19") return;
      loading ??= load().finally(() => { loading = null; });
      await loading;
      if (forBranch || hasBranches()) instance?.activate();
      else instance?.releaseIfUnused();
    },
    captureReplies() { if (enabled() && solo()) instance?.captureReplies(); },
    releaseIfUnused() { instance?.releaseIfUnused(); },
    clear() { lifecycle++; instance?.dispose(); instance = null; },
  };
}
