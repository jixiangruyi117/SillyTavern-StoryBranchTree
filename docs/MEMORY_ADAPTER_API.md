# 记忆插件接入指南与 API 参考

本文面向记忆总结、表格、隐藏楼层及提示词注入插件的作者。**先选择接入范围，再阅读对应示例。**

- 文档核对基线：剧情分支树 **0.1.68**，API **version: 1**。
- 插件版本与 API 版本不是同一个概念；当前 API 没有 `pluginVersion` 属性。新增能力检查 `capabilities`，不能只检查 `version === 1`。
- 查询不会创建剧情树、生成摘要或请求模型。没有剧情树时，记忆插件继续自己的普通聊天流程。
- 本文代码自行编写；字段名和适配器 ID 都是示例，不对应任何具体第三方记忆插件。
- 各代码块是独立示例，不要合并后顺序执行。完整框架中的插件服务需由接入者实现；第二节的小示例可单独运行。

## 目录

- [1. 快速开始与接入范围](#quick-start)
- [2. 无需模型 API 的最小接入示例](#minimal-example)
- [3. 数据、字段与身份约定](#data-contract)
- [4. 切换生命周期与完整适配框架](#lifecycle)
- [5. 后台任务的安全写回](#memory-tasks)
- [6. 历史分叉与重说](#forks-and-swipes)
- [7. 逐方法 API 参考](#api-reference)
- [8. 事件、排错与性能](#events-and-troubleshooting)
- [9. 验收与发布](#acceptance)

<a id="quick-start"></a>

## 1. 快速开始与接入范围

### 只识别路线

适用于插件自行保存全部记忆，只需要知道当前在哪条路线：

1. 初始化时查询 `getActiveRoute()`；返回 `null` 时沿用普通聊天流程。
2. 使用 `cacheKey` 分区自己的缓存或外部存储。
3. 在成功切换事件中更新路线身份；普通聊天加载、新消息和编辑仍按插件原有事件处理。
4. 自行保护异步写回。

```js
const host = window; // 同源酒馆助手脚本改为 parent
const api = host.SillyTavernStoryBranchTree;
const route = api?.getActiveRoute() ?? null;

console.log(route?.cacheKey ?? "普通聊天");
const messages = api?.capabilities?.rangedMessages
  ? api.getRouteMessages(undefined, { from: 0, to: 6, fields: ["mes"] }) : null;
console.log(messages); // 无可用路线或所需能力时为 null
```

**仅监听切换事件，不会自动隔离插件的记忆、容器、隐藏规则或世界书注入。**

### 完整适配记忆

适用于希望记忆随路线及聊天文件保存、切换后恢复的插件：

1. 注册自己拥有的消息字段和聊天元数据字段。
2. 用可等待的钩子暂停处理、构造分叉记忆、重建缓存与注入。
3. 给后台任务创建路线凭证，实际写入前检查。
4. 在全部写入入口采集快照，并沿用原有持久化流程。
5. 停用时注销、移除监听并处理在途任务；重新启用时重新接入。

分支树负责路线身份、聊天投影、声明字段的快照与任务失效通知。接入方负责总结算法、历史完整性、模型请求、自己的缓存和外部存储、注入、任务等待/取消及错误界面。

### 加载顺序与宿主

API 位于 `window.SillyTavernStoryBranchTree`。同源酒馆助手脚本使用 `parent.SillyTavernStoryBranchTree`，事件也监听父页面；不要监听脚本 iframe 自己的 `window`。

先尝试读取已安装 API，再监听 `story-branch-tree:ready`。这个事件只表示 API 安装完成，不表示聊天加载完成、记忆恢复完成或每条消息更新。不用定时轮询。

<a id="minimal-example"></a>

## 2. 无需模型 API 的最小接入示例

这是可直接运行的消息字段示例，不依赖未实现的 `memory.*` 服务。**在酒馆已载入后的专用测试聊天中执行一次**，它只向当前末楼添加自己的测试字段。不要在正式插件中保留测试控制台输出。

```js
function installExampleMemory(host = window) {
  const id = "example-route-demo-v1";
  const field = "ExampleMessageMemory";
  let api = null;
  let unregister = null;
  const ctx = () => host.SillyTavern.getContext();

  function readLast() {
    const value = ctx().chat.at(-1)?.[field];
    return value === undefined ? null : structuredClone(value);
  }

  function showLast() {
    console.log("[路线记忆示例]", api?.getActiveRouteKey() ?? "普通聊天", readLast());
  }

  function connect() {
    const candidate = host.SillyTavernStoryBranchTree;
    if (candidate === api && unregister) return;
    unregister?.();
    unregister = null;
    api = null;
    if (!candidate?.capabilities?.memoryTasks
      || !candidate.capabilities.rangedMessages) return;

    unregister = candidate.registerRouteAdapter({
      id,
      messageFields: [field],
      snapshotMode: "automatic",
      afterSwitch() { showLast(); },
      onSwitchAborted() { showLast(); },
    });
    api = candidate;
    showLast();
  }

  function onReady() {
    try { connect(); } catch (error) { console.error(error); }
  }

  const eventSource = ctx().eventSource;
  const loadedEvent = ctx().eventTypes?.CHAT_LOADED;
  function onChatLoaded(event) {
    if (event?.detail?.storyBranchTree) return; // 分支恢复交给钩子
    showLast(); // 普通聊天加载只显示已有数据
  }

  host.addEventListener("story-branch-tree:ready", onReady);
  if (loadedEvent) eventSource?.on(loadedEvent, onChatLoaded);
  onReady();

  return {
    readLast,
    async saveLast(text) {
      const current = ctx();
      const index = current.chat.length - 1;
      if (index < 0) throw new Error("请先准备一条测试消息");
      const routed = api && api === host.SillyTavernStoryBranchTree
        && api.getActiveRouteKey();
      const task = routed ? api.beginMemoryTask(id, { from: index, to: index + 1 }) : null;
      try {
        task?.assertCurrent(); // 没有 await，检查后同步修改这一个字段
        current.chat[index][field] = { text: String(text) };
        if (task) api.notifyMemoryChanged(id, {
          from: index, to: index + 1, task, metadata: false,
        });
        await current.saveChat(); // 沿用酒馆保存，不额外建立聊天
        showLast();
      } finally {
        task?.finish();
      }
    },
    dispose() {
      host.removeEventListener("story-branch-tree:ready", onReady);
      if (loadedEvent) eventSource?.removeListener(loadedEvent, onChatLoaded);
      unregister?.();
      unregister = null;
      api = null;
    },
  };
}

const exampleMemory = installExampleMemory(window);
// 同源助手脚本使用 installExampleMemory(parent)
```

验证步骤：

1. 在测试聊天中执行 `await exampleMemory.saveLast("主线记忆")`。
2. 用分支树从末楼创建分支，执行 `await exampleMemory.saveLast("分支记忆")`。
3. 切回主线，再切回分支，执行 `exampleMemory.readLast()`，应分别读到各自的数据。
4. 刷新后重新运行示例，或 JSONL 导出再导入后接入，再查看已保存数据。
5. 完成后调用 `exampleMemory.dispose()`。它注销适配、释放任务和移除监听，不删除已保存的测试字段。

示例采用 `automatic` 模式，只展示“自有消息字段跟随路线”；它不实现历史长摘要筛选、回复级容器、模型请求或私有数据库事务。重复执行前先 dispose；正式适配不要与示例同时注册相同字段。保存请求与分叉操作仍应串行完成，任务凭证不会接管酒馆或外部存储内部的异步提交。

<a id="data-contract"></a>

## 3. 数据、字段与身份约定

### 读取字段和保存字段不同

- **读取**：`getRouteMessages(branchId, { fields })` 中的 `fields` 支持顶层字段及点路径，如 `"mes"`、`"extra.memory"`。
- **保存**：`messageFields` 只声明消息对象的自有**顶层**字段；`metadataFields` 只声明聊天元数据的自有**顶层**字段。
- **当前不支持把 `extra.xxx` 注册成嵌套保存路径**。点号不会被保存接口解释为路径；不能因读取支持点路径就认为保存也支持。也不能声明整个 `extra` 来绕过限制。

```js
// 按路径读取可以：
api.getRouteMessages(undefined, { fields: ["extra.MyMemory"] });

// 已实现的字段保存方式：
api.registerRouteAdapter({
  id: "example-memory-v1",
  messageFields: ["ExampleMessageMemory"],
  metadataFields: ["ExampleMemoryStore"],
});
```

如果原插件把数据存于 `extra` 内，应由作者评估自有顶层字段或显式桥接方案；不能仅更改声明字符串就认为完成适配。嵌套字段的原生快照支持不在当前契约内。

不要声明正文、原生重说结构、变量或整个 `extra`。聊天元数据不能声明 `variables`、`integrity`、`main_chat`、`tainted` 或剧情树本身。连接配置、密钥、DOM、函数和派生缓存不进入快照；数据应可安全复制，并可随 JSONL 序列化。

字段状态：

- 缺失：恢复时删除该字段。
- `null` 或空对象：作为真实数据保存，不等同于缺失。
- `getRouteMetadata()` 返回 `null`：没有该适配器的已保存容器快照，不代表历史记忆为空或完整。
- 已停用适配器的已有快照仍随路线恢复；这属于保存数据的恢复，不会因此调用停用插件的运行时。

### 身份、索引与数据完整性

`cacheKey` 是 `JSON.stringify([chatId, branchId])`。它用于路线分区；显示名称、路线编号和楼层号会改变或重复，不能作为主键。外部数据库跨角色、账号或宿主共享时，再加原有命名空间。

- 消息索引和 `sourceSwipeIndex` 为零基。
- `forkFloor`、`replyFloor` 以及树图显示的楼层为一基。
- `from` 包含，`to` 不包含。例如 `{ from: 5, to: 10 }` 读取第 6～10 楼。
- 稳定消息 ID 和回复版本 ID 用于确认“是哪条消息、哪个回复”；新消息尚未同步时 `messageIds` 中可以出现 `null`。
- **快照存在不等于历史完整**。分支树不判断摘要是否覆盖所有剧情，不提供 `coverage.complete` 或缺失楼层列表。接入者自行记录覆盖范围和可恢复程度。
- 外部数据库、向量索引或私有缓存不会自动进入聊天导出文件；这些数据的分区、导出和恢复由对应插件负责。
- 分支树不扫描、识别或调用特定记忆插件。只有插件主动注册适配器并声明自己负责的字段后，这些字段才会随路线快照与恢复；未接入的插件仍按原本的聊天级逻辑运行。

<a id="lifecycle"></a>

## 4. 切换生命周期与完整适配框架

### 钩子执行期间看到哪条路线

对一个适配器，新分支的顺序是：

`beforeSwitch → onFork → 投影/渲染/保存 → CHAT_LOADED → afterSwitch → 完成切换事件`

已有路线切换不调用 `onFork`。多个适配器按注册顺序准备：每个适配器的 `beforeSwitch` 成功后，才调用它的 `onFork`；不能假定全部适配器先完成 beforeSwitch 再一起 onFork。

- **beforeSwitch / onFork**：宿主上下文仍是切换前的路线；`change.getMessages()` 提供目标路线副本。在这里暂停原有自动处理并等待/取消真实任务。
- **投影阶段**：恢复目标消息字段、聊天级容器和变量，再渲染消息。渲染也可能触发插件自己的消息回调，因此暂停状态要覆盖到恢复结束。
- **带分支标记的 CHAT_LOADED**：消息已投影，但全部记忆恢复尚未完成；钩子接入者跳过重复恢复和自动总结。
- **afterSwitch**：读取目标上下文或 API 的当前路线，重建自己拥有的缓存、视图和注入；必须等待真实工作完成。
- **完成事件**：恢复成功、路线切换保护结束后通知 UI；在这里才可启动新的普通记忆任务。

`change.getMessages()` 只提供给准备钩子，不能在 afterSwitch 中假定存在。在整个切换钩子中不要启动 `beginMemoryTask()`。钩子本身应返回并等待真实 Promise；每个异步写入点也要核对宿主上下文，不能启动脱离钩子的后台任务就立即返回。

### 失败和停用

- beforeSwitch 自己失败：该适配器自行恢复已清理的状态；不保证收到 onSwitchAborted。此前已成功准备的适配器会收到回滚通知。
- onFork 准备失败：已准备的适配器收到 onSwitchAborted，清理提前建立的缓存。
- 投影尚未保存时失败：同一聊天下尝试恢复此前消息、变量及声明的容器；接入者恢复自己的缓存和注入。
- 投影已保存后恢复失败：目标路线可能已成为当前路线，不假定一定回退。失败会保留发送保护；在树中再次选择当前路线重试恢复。
- 异步期间更换聊天：停止旧投影，不在新聊天执行旧路线回滚；钩子自己的异步工作也须核对上下文，不假定一定收到回滚通知。
- 注销：旧任务失效、以后不再采集/执行该适配器钩子；若它拥有当前恢复失败锁，解除这一锁，不解除其他提供方或其他阶段的保护。已有快照保留。
- 注销不会强行终止插件内部请求，也不会自动撤销已经被投影流程取得的在途钩子。接入插件的停用流程仍须协调取消/等待和清理。

### 完整适配框架

下面的 `memory` 是**接入方自己的服务**，不是分支树提供的对象。它需要实现：

- `setRoute(route)`：设定路线身份，null 时使用普通聊天流程。
- `prepareSwitch(change)`：暂停自动生成/写入，等待或取消真实任务；失败自行清理。
- `snapshotAtFork({ fork, messages, store })`：从保留前文建立目标容器；重说示例未传入所选 AI 回复，未记录的回复记忆由 rebuild 在目标上下文中处理。
- `rebuild({ route, messages, store })`：重建派生缓存、视图和注入，完成后恢复处理；失败保留自身写入保护。
- `reportError(error)`：在原有错误界面报告，不吞掉字段冲突或恢复错误。

```js
function installBranchSupport(memory, host = window) {
  const id = "example-memory-v1";
  let api = null;
  let unregister = null;

  function connect() {
    const candidate = host.SillyTavernStoryBranchTree;
    if (candidate === api && unregister) return true;
    unregister?.();
    unregister = null;
    api = null;
    if (!candidate?.capabilities?.metadataSnapshots
      || !candidate.capabilities.memoryTasks
      || !candidate.capabilities.rangedMessages
      || !candidate.capabilities.forkHooks
      || !candidate.capabilities.explicitSnapshots) {
      memory.setRoute(null);
      return false;
    }

    unregister = candidate.registerRouteAdapter({
      id,
      messageFields: ["ExampleMessageMemory"],
      metadataFields: ["ExampleMemoryStore"],
      snapshotMode: "explicit",
      async beforeSwitch(change) {
        await memory.prepareSwitch(change);
      },
      async onFork(change) {
        const ctx = host.SillyTavern.getContext();
        const messages = change.getMessages({
          to: change.fork.inheritedMessageCount,
          fields: ["mes", "extra.story_branch_tree_message_id",
            "extra.story_branch_tree_variant_id", "ExampleMessageMemory"],
        });
        const store = await memory.snapshotAtFork({
          fork: change.fork, messages, store: ctx.chatMetadata.ExampleMemoryStore,
        });
        return { metadata: { ExampleMemoryStore: store } };
      },
      async afterSwitch(route) {
        const ctx = host.SillyTavern.getContext();
        await memory.rebuild({
          route, messages: ctx.chat, store: ctx.chatMetadata.ExampleMemoryStore,
        });
      },
      async onSwitchAborted(previousRoute) {
        const ctx = host.SillyTavern.getContext();
        await memory.rebuild({
          route: previousRoute, messages: ctx.chat,
          store: ctx.chatMetadata.ExampleMemoryStore,
        });
      },
    });
    api = candidate;
    memory.setRoute(api.getActiveRoute());
    return true;
  }

  function onReady() {
    try { connect(); } catch (error) { memory.reportError(error); }
  }
  host.addEventListener("story-branch-tree:ready", onReady);
  onReady();

  return () => {
    host.removeEventListener("story-branch-tree:ready", onReady);
    unregister?.();
    unregister = null;
    api = null;
    memory.setRoute(null);
  };
}
```

把返回的清理函数接入原插件的停用/卸载流程；重新启用时重新安装。普通聊天加载时，在原有加载入口重新查询 `getActiveRoute()` 并更新插件自己的路线状态。示例没有替代原插件的普通聊天初始化、新消息处理和持久化。

### 快照模式与恢复归属

`automatic` 是默认模式，沿用正常聊天同步时的采集。选择 `explicit` 后，必须覆盖手动编辑、自动总结、删除、清空、导入等全部写入入口并通知；漏发通知可能恢复旧值。新楼层仍在正常同步时首次采集；首次接入已有树时，缺少快照的存量路线各固定一次已有字段，不在每次切换时重新初始化所有路线。

认领字段或恢复能力不能冲突。完整负责某类运行时恢复的适配器可声明 `handles: ["database"]` 或 `handles: ["timeline"]`，关闭对应通用恢复入口；通用插件不必声明 handles。

**原有内置适配必须交接。** handles 不是所有内置适配的关闭开关。没有公开自动交接能力的适配，需要先协调恢复归属；不能换一个 id 绕过字段冲突。同时监听钩子和切换事件时，不重复恢复或生成。

<a id="memory-tasks"></a>

## 5. 后台任务的安全写回

下面沿用完整框架的 ID。`requestSummary`、`persistRoute` 和普通聊天总结流程仍由接入者实现。只有没有可用分支路线时才走原有流程；任务创建/校验失败后不能退回无保护写入。

```js
async function summarizeRange(memory, from, to, host = window) {
  const api = host.SillyTavernStoryBranchTree;
  if (!api?.capabilities?.memoryTasks || !api.getActiveRouteKey()) {
    return memory.summarizeWithoutBranches(from, to);
  }
  const task = api.beginMemoryTask("example-memory-v1", { from, to });
  try {
    const messages = api.getRouteMessages(undefined, { from, to, fields: ["mes"] });
    if (!messages.length) return;
    const summary = await memory.requestSummary(messages, { signal: task.signal });
    task.assertCurrent(); // 最后一次 await 后、实际写入前
    const ctx = host.SillyTavern.getContext();
    const last = from + messages.length - 1;
    ctx.chat[last].ExampleMessageMemory = summary;
    api.notifyMemoryChanged("example-memory-v1", {
      from: last, to: last + 1, task, metadata: false,
    });
    await memory.persistRoute(task.cacheKey, task);
  } finally {
    task.finish();
  }
}
```

`persistRoute()` 必须向给定路线键提交，在自己的异步事务提交点继续核对 task，不能写到“提交时碰巧打开的路线”。

- 凭证只检测并通知失效，不拦截第三方私有写回。
- signal 是协作取消，不保证请求停止。即使模型返回结果，检查失败也不能更新当前聊天、缓存、世界书或注入。
- A→B→A 返回原路线不会让旧凭证复活。
- 同一适配器通知记忆变更会使其他在途任务失效；通知携带的有效写入 task 会更新自身修订号，便于后续注入校验。
- 每个 await 后、实际写入前检查；事务内异步写入在提交点再检查。任务结束必须 finish / cancel。
- 需要保存失效任务的结果到原路线时，由接入者实现按原路线键的独立存储事务；当前 API 不提供向非当前路线提交的写入方法。

<a id="forks-and-swipes"></a>

## 6. 历史分叉与重说

### 普通历史分叉

从第 6 楼分叉可继承第 1～6 楼。覆盖第 5～30 楼的摘要不能整份继承，也不能裁剪摘要文本来还原早期剧情；应恢复可验证的历史快照，或由插件重新总结保留前文。

按稳定消息 ID、回复版本及覆盖范围检查。只有“楼层号小于 6”不足以证明记忆属于前文。共享前文分叉时，树结构父路线 `parent*` 和实际切换前路线 `source*` 可以不同。

### 从重说回复建立路线

例如用户在第 3 楼、AI 在第 4 楼：

- 普通分支保留分叉楼本身。
- 重说分支的 `inheritedMessageCount` 只有 3，**不包含所选 AI 回复**；先恢复第 1～3 楼，再处理所选第 4 楼。
- 主线用回复 3，从回复 1 建新路线，不应改变主线的回复及后续记忆。
- 新路线的起始消息有新消息 ID，所选回复成为新消息的第一个版本，`swipe_id = 0`；`sourceSwipeIndex` 仍描述原消息中的零基索引。
- 插件数据若内含原生 swipe 页码，接入方应在自己的恢复逻辑中处理目标页码与来源身份，不能把来源页码直接当作目标页码。
- 未记录的旧回复不能拿另一回复的记忆冒充。

消息字段快照不会自动记录所有重说。需要回复独立字段的插件，在自己的保存入口同步当前回复，例如：

```js
function recordSelectedReply(message, fields) {
  const key = "story_branch_tree_swipe_message_fields";
  const snapshot = Object.fromEntries(fields.map(field => [field,
    Object.hasOwn(message, field)
      ? { present: true, value: structuredClone(message[field]) }
      : { present: false },
  ]));
  message.extra ??= {};
  message.extra[key] = { ...message.extra[key], ...snapshot };
  const index = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
  if (Array.isArray(message.swipes) && index >= 0 && index < message.swipes.length) {
    message.swipe_info ??= [];
    message.swipe_info[index] ??= {};
    message.swipe_info[index].extra ??= {};
    const extra = message.swipe_info[index].extra;
    extra[key] = { ...extra[key], ...structuredClone(snapshot) };
  }
}
// 只传自己已声明的顶层字段；在 notifyMemoryChanged / 原有保存前调用。
// recordSelectedReply(message, ["ExampleMessageMemory"]);
```

保留其他插件及其他回复的记录。聊天级 metadataFields 不自动生成每个 swipe 的完整容器历史；需要时由插件在自有消息字段中保存历史引用或检查点。

<a id="api-reference"></a>

## 7. 逐方法 API 参考

### 属性和能力

```js
({
  version: 1,
  eventName: "story-branch-tree:changed",
  capabilities: {
    rangedMessages: true,     // from / to / fields 读取
    memoryTasks: true,        // 任务凭证及变更通知
    forkHooks: true,          // onFork 与分叉信息
    explicitSnapshots: true, // explicit 快照模式
    metadataSnapshots: true, // 聊天级容器快照
    routeList: true,          // 轻量路线列表
  },
})
```

检测自己需要的能力。API 对象被替换或停用后，旧引用不再有效：查询方法返回 null，任务/通知方法抛错；旧引用的 registerRouteAdapter 只返回无操作的清理函数。注册前确认仍使用宿主当前对象，不通过保留旧对象判断插件是否启用。

### 返回结构

以下 TypeScript 仅用于说明结构，不是已发布的类型包或新增运行时方法。

```ts
interface RouteInfo {
  version: 1;
  chatId: string | null;
  characterId: number | string | null;
  rootBranchId: string;
  branchId: string;
  parentBranchId: string | null;
  title: string;
  cacheKey: string;
  messageCount: number;
  messageIds: Array<string | null>;
}

interface ForkInfo {
  kind: "continuation" | "swipe";
  parentBranchId: string;
  parentCacheKey: string;
  sourceBranchId: string | null;
  sourceCacheKey: string | null;
  forkMessageId: string;
  forkFloor: number;              // 一基；重说时为前文末楼
  inheritedMessageCount: number;
  sourceMessageId: string;
  sourceVariantId: string | null;
  sourceSwipeIndex: number | null;
  replyFloor: number | null;      // 普通分支为 null；重说时为 AI 回复一基楼层
}

interface RouteChange extends RouteInfo {
  previousBranchId: string;
  reason: "route-switched" | "memory-retry";
  transitionId?: string;          // 恢复重试可缺失
  fork?: ForkInfo;                // 只在新分支准备/切换中出现
}

interface MemoryTask {
  adapterId: string;
  cacheKey: string;
  signal: AbortSignal;
  sources: ReadonlyArray<{
    index: number;                // 零基
    messageId: string;
    variantId: string | null;
    swipeId: number;
  }>;
  isCurrent(): boolean;
  assertCurrent(): void;
  finish(): void;
  cancel(): void;
}
```

RouteInfo 是查询时的副本；修改其名称或 ID 不修改剧情树。图中编号不是这些接口的存储 ID。准备钩子的 change 在 RouteChange 上额外提供 `getMessages(options?)`；方法不进入 DOM 完成事件。

### getActiveRoute()

- **用途**：查询当前路线详情。
- **参数**：无。
- **返回**：RouteInfo；没有剧情树、不支持的聊天或 API 停用时 null。
- **注意**：messageIds 包含一次消息标识遍历，频繁比对身份使用 getActiveRouteKey。查询期间存在目标投影时可返回目标路线，不代表已恢复完成。

```js
const route = api.getActiveRoute();
if (route) console.log(route.branchId, route.messageCount);
```

### getActiveRouteKey()

- **用途**：轻量获取当前 cacheKey，不复制消息或构造消息 ID 列表。
- **参数**：无。
- **返回**：字符串或 null，适用环境与当前路线查询相同。
- **注意**：字符串本身不是任务凭证，也不表达恢复是否完成；A→B→A 不能只靠字符串保护旧任务。

```js
const key = api.getActiveRouteKey();
```

### getRoutes()

- **用途**：列出轻量路线索引，不读取正文或记忆容器。
- **参数**：无。
- **返回**：`[{ branchId, parentBranchId, title }]`；无可用树、非单人聊天或 API 停用时 null。
- **注意**：不提供完整消息、层级显示编号或摘要，列表顺序不是排序承诺。

```js
const routes = api.capabilities.routeList ? api.getRoutes() : null;
```

### getRouteMessages(branchId?, options?)

- **用途**：读取一条路线的消息副本；省略/传 null 的 branchId 使用当前路线。
- **options**：`{ from = 0, to = 路线长度, fields = null }`。fields 为字符串数组，支持点路径；null 读取完整消息。
- **返回**：消息数组；无可用树、未知 branchId、不支持聊天或 API 停用时 null。有效空范围返回 []。
- **错误**：非整数/负数/逆序范围、非法 fields 或危险路径会抛错。上界超出末尾自动截断。
- **注意**：`fields: []` 返回对应数量的空对象；缺失字段不补占位值。不传范围/字段会复制整条路线。当前路线读取实时消息，其他路线读取已保存快照。

```js
const rows = api.getRouteMessages(undefined, {
  from: 5, to: 10, fields: ["mes", "extra.memory"],
});
```

### getRouteMetadata(id, branchId?)

- **用途**：读取某适配器已保存的聊天级容器快照，不是插件未保存的内存镜像。
- **参数**：已注册适配器 id；省略 branchId 使用当前路线。
- **返回**：容器字段对象的副本；快照/路线不存在、聊天不受支持或 API 停用时 null。
- **错误**：当前 API 上的 id 未注册会抛错。
- **注意**：返回 {} 与 null 不同；快照里的字段缺失表示其缺失状态，不用当前路线数据填补历史。

```js
const saved = api.getRouteMetadata("example-memory-v1", branchId);
```

### registerRouteAdapter(adapter)

- **用途**：声明快照字段并接入可等待的切换钩子。
- **参数**：`{ id, messageFields = [], metadataFields = [], snapshotMode = "automatic", handles = [], beforeSwitch?, onFork?, afterSwitch?, onSwitchAborted? }`。
- **返回**：注销函数；不会自行保存记忆插件的外部数据库或停止它的私有任务。
- **错误**：id 无效/重复、字段格式无效/受保护、字段或 handles 归属冲突、模式无效、钩子不是函数会抛错。快照复制失败也会拒绝注册。
- **注意**：字段使用第三节的顶层约定。普通插件不声明 handles；声明者必须完整负责相应恢复、注入和失败处理。

beforeSwitch / onFork 可返回 `{ metadata: { 已声明字段: 值 } }`。**这是目标容器的完整快照，不是局部补丁**：

- 返回的 metadata 缺少某个已声明字段，该字段恢复时删除。
- `metadata: {}` 清除全部已声明容器字段。
- 不返回 metadata 才沿用原有目标快照流程。
- 返回未声明字段或非对象 metadata 会拒绝切换。

### beginMemoryTask(id, options?)

- **用途**：创建只能用于当前就绪路线的任务凭证。
- **options**：`{ from?, to? }`；范围的零基、排他上界规则与消息读取相同，不使用 fields。
- **返回**：MemoryTask。sources 仅在传入 from/to 时记录来源 ID、版本及页码，不公开正文。
- **错误**：未注册、API 停用、路线切换中/恢复失败/无路线、范围无效或来源消息 ID 尚未同步时抛错。
- **注意**：不传范围只核对路线及消息数量，不遍历正文；传范围额外核对指定来源的 ID、版本、页码和正文，范围外新增楼层不使来源凭证失效。

```js
const task = api.beginMemoryTask("example-memory-v1", { from: 0, to: 6 });
try { task.assertCurrent(); } finally { task.finish(); }
```

finish 和 cancel 都释放在途登记并使凭证失效，signal 也会进入取消状态。凭证被冻结，但不是与外部异步事务绑定的原子锁。

### notifyMemoryChanged(id, options?)

- **用途**：更新当前路线已声明字段的快照并使同适配器的竞争任务失效。
- **options**：`{ from = 0, to = 当前消息数, task?, metadata = true }`。metadata 必须为布尔值，false 只采集消息字段。
- **返回**：undefined。空范围且无需采集容器时不操作。
- **错误**：未注册、API 停用、无可用路线、task 过期/属于其他适配器、范围或 metadata 参数无效时抛错；复制数据也可能失败。
- **注意**：没有 task 不代表隐式安全；异步写回应传有效 task。通知发生在自有字段修改之后，不代替接入者的聊天保存或数据库事务。

```js
api.notifyMemoryChanged("example-memory-v1", {
  from: 5, to: 6, task, metadata: false,
});
```

<a id="events-and-troubleshooting"></a>

## 8. 事件、排错与性能

### 事件与去重

- `story-branch-tree:ready`：宿主 window，detail 为 `{ version: 1 }`，用来接入 API。
- `CHAT_LOADED`：酒馆原生 eventSource。若 `event.detail.storyBranchTree` 存在，表示分支投影过程；该值是 RouteChange，不能在此重复恢复/生成。
- `story-branch-tree:changed`：宿主 window，detail 为 RouteChange，实际路线切换或成功恢复重试后发出。普通聊天加载和每条新消息不触发它。
- 同一次正常切换的 CHAT_LOADED 标记及完成事件具有相同 transitionId；双重接收时按它去重。memory-retry 可以没有 transitionId，不能无条件丢掉无 ID 的重试通知。

只识别路线的监听示例如下；完整钩子接入者用完成事件更新 UI，不在此重复恢复记忆：

```js
function listenRoutes(onRoute, host = window) {
  const ctx = host.SillyTavern.getContext();
  let lastTransitionId = null;
  const refresh = () => onRoute(host.SillyTavernStoryBranchTree?.getActiveRoute() ?? null);
  function onChanged(event) {
    const change = event.detail;
    if (change?.transitionId && change.transitionId === lastTransitionId) return;
    lastTransitionId = change?.transitionId ?? null;
    refresh();
  }
  function onLoaded(event) {
    if (event?.detail?.storyBranchTree) return; // 等待成功完成事件
    refresh();
  }
  host.addEventListener("story-branch-tree:ready", refresh);
  host.addEventListener("story-branch-tree:changed", onChanged);
  ctx.eventSource.on(ctx.eventTypes.CHAT_LOADED, onLoaded);
  refresh();
  return () => {
    host.removeEventListener("story-branch-tree:ready", refresh);
    host.removeEventListener("story-branch-tree:changed", onChanged);
    ctx.eventSource.removeListener(ctx.eventTypes.CHAT_LOADED, onLoaded);
  };
}
```

关闭插件时执行返回的清理函数，重新启用时重新查询并注册。无 API 专用停用事件；普通消息更新及停用后的回退由接入方原有生命周期负责。不要靠广播假的 CHAT_CHANGED 唤醒全部扩展。

### 常见问题

- **接口存在却不能建任务**：确认是否已有剧情树、已注册、当前恢复完成、来源 ID 已同步；不要用任务失败后的无保护回退掩盖问题。
- **切换后读到旧记忆**：检查 explicit 是否漏通知、是否把容器快照当作实时内存、是否只监听了 CHAT_CHANGED。
- **每次切换重复刷新/总结**：检查钩子、CHAT_LOADED、完成事件和消息渲染回调是否同时做恢复。
- **从回复 3 分叉后摘要失效**：检查目标消息的 ID 与 swipe_id 是否已改变，以及插件数据内部的页码归属。
- **注册字段冲突**：确认内置适配交接和字段负责方；换 id 不能解决同字段归属冲突。
- **容器少了字段**：检查钩子返回的 metadata 是否误当局部补丁。
- **任务被取消却仍有结果返回**：signal 只是协作通知；写入前仍必须 assertCurrent。
- **注销后仍有请求**：接入者须取消或等待自己的在途请求，注销不接管它们。
- **快照缺失**：区分未保存、字段缺失与空对象；不把当前完整后续容器复制到历史路线。

当前没有稳定的错误码枚举，不按中文错误字符串分支控制。预先校验能力及生命周期，捕获异常交给原插件错误界面；任务过期属于停止旧写入，恢复失败不能静默变成空记忆。

返回 null 的不支持环境与参数错误不同；部分查询在无可用路线时先返回 null，不会继续校验读取参数。不要把这种返回值当作参数已通过校验的证明。

### 保持轻量

按 from/to/fields 读取总结来源；身份比较用 getActiveRouteKey，不反复复制全聊天。大容器没变时通知 metadata: false；变化时才采集。getRouteMetadata 返回容器副本，不高频复制整个池。

恢复已有路线优先使用已保存数据和本地派生视图，不默认重新向模型总结全部历史。普通聊天不增加模型请求、历史扫描或第二套缓存；沿用原插件模板、连接配置和性能设置。

新机制没有轮询或全局请求包装。范围读取优化不表示整条聊天同步只处理几楼；正常同步仍处理当前聊天和已识别原生字段，切换仍有复制、历史筛选、原版视图重建及保存成本。本文不宣称大型聊天或手机整条加载速度已验收。

<a id="acceptance"></a>

## 9. 验收与发布

适配者至少验证：

- 未安装/停用分支树、没有剧情树、群聊时，原有普通聊天流程正常；接口后加载和替换可接入。
- 当前楼、历史楼、同点多分支、嵌套分叉分别保存和恢复；共享前文不覆盖其他路线的记忆。
- 回复 3 是主线，从回复 1 新开路线再回主线，回复、记忆、隐藏及注入正确；未记录回复不继承另一回复的记忆。
- A→B→A、连续切换、任务在途、取消请求、编辑/删除来源时，旧任务不修改新路线；手动操作也有保护。
- 手动编辑、删除、清空、导入后，保存、刷新、JSONL 导出再导入可恢复；外部数据的导出边界明确。
- 钩子准备失败与已投影恢复失败分别可见、可恢复；重试成功才释放保护，错误不变成空记忆。
- 同次切换只恢复一次；多个插件无字段、注入、监听及恢复归属冲突。
- 停用时处理在途任务、注销并清理；再次启用不会重复注册或遗留监听。

**仅使用接口不能保证第三方插件已兼容。** 内置兼容只覆盖核对的版本和入口，未接入的私有后台任务没有自动路线保护。接入方自己的缓存完整性、历史覆盖、外部存储和写回流程仍需验收。

提交问题时附插件/分支树版本、原生扩展或助手脚本运行方式、最短复现及脱敏数据结构。不要提交密钥或私人聊天。通过 [Issues](https://github.com/jixiangruyi117/SillyTavern-StoryBranchTree/issues) 讨论接口设计和接入方案，通过 [Pull Request](https://github.com/jixiangruyi117/SillyTavern-StoryBranchTree/pulls) 提交改进。作者自己的发布说明应链接本指南，注明实际验证版本和未测范围。
