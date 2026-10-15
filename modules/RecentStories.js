const nameOf = value => String(value ?? "").replace(/\.jsonl$/i, "");
const keyOf = (avatar, file) => JSON.stringify([avatar, nameOf(file)]);

// Only explicit catalog ownership can fold a row. Similar names are not evidence.
export function recentStoryGroups(rows, characters = {}) {
  const owners = new Map();
  for (const [avatar, catalog] of Object.entries(characters ?? {})) for (const entry of Object.values(catalog?.routes ?? {})) {
    if (typeof entry?.storyId !== "string" || !entry.storyId || typeof entry.route?.id !== "string" || !entry.route.id
      || typeof entry.chatName !== "string" || !entry.chatName) continue;
    const key = keyOf(avatar, entry.chatName), previous = owners.get(key);
    if (owners.has(key) && (!previous || previous.storyId !== entry.storyId || previous.route.id !== entry.route.id)) owners.set(key, null);
    else owners.set(key, entry);
  }
  const groups = new Map();
  for (const row of rows) {
    if (row.group || !row.avatar || !row.file) continue;
    const entry = owners.get(keyOf(row.avatar, row.file));
    if (!entry) continue;
    const key = JSON.stringify([row.avatar, entry.storyId]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].filter(group => group.length > 1);
}

export function installRecentStories({ getContext, chat = globalThis.document?.getElementById("chat") }) {
  if (!chat || typeof globalThis.MutationObserver !== "function") return () => {};
  let restore = () => {};
  function refresh() {
    restore(); restore = () => {};
    const panel = chat.querySelector(":scope > .welcomePanel");
    if (!panel) return;
    const rows = [...panel.querySelectorAll(".recentChat")].map(node => ({ node,
      avatar: node.dataset.avatar, file: node.dataset.file, group: node.dataset.group }));
    const groups = recentStoryGroups(rows, getContext()?.extensionSettings?.storyBranchTreeCatalog?.characters);
    const title = panel.querySelector(".recentChatsTitle");
    if (!groups.length || !title) return;
    const cleanups = [], folded = [];
    for (const group of groups) {
      const representative = group.find(row => row.node.querySelector(".recentChatPinned") && !row.node.classList.contains("hidden"))
        ?? group.find(row => !row.node.classList.contains("hidden")) ?? group[0];
      folded.push(...group.filter(row => row !== representative).map(row => row.node));
      const badge = document.createElement("small");
      badge.className = "story-branch-tree__recent-badge";
      badge.textContent = `故事 · ${group.length} 条最近路线`;
      badge.title = "打开聊天后，通过剧情分支树切换路线。下方预览及原生操作对应当前显示的路线。";
      const container = representative.node.querySelector(".chatStats") ?? representative.node;
      container.append(badge);
      cleanups.push(() => badge.remove());
    }
    let expanded = false;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu_button story-branch-tree__recent-toggle";
    function apply() {
      for (const node of folded) node.classList.toggle("story-branch-tree__recent-folded", !expanded);
      button.textContent = expanded ? "按故事归组" : "显示各路线记录";
      button.setAttribute("aria-expanded", String(expanded));
    }
    const toggle = event => { event.stopPropagation(); expanded = !expanded; apply(); };
    button.addEventListener("click", toggle);
    title.append(button); apply();
    restore = () => {
      for (const node of folded) node.classList.remove("story-branch-tree__recent-folded");
      for (const cleanup of cleanups) cleanup();
      button.removeEventListener("click", toggle); button.remove();
    };
  }
  // Welcome has no refresh event for pin/settings changes. Watch only direct
  // #chat children; ordinary message content and tree mutations do not trigger work.
  const observer = new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node.classList?.contains("welcomePanel")))) refresh();
  });
  observer.observe(chat, { childList: true });
  refresh();
  return () => { observer.disconnect(); restore(); restore = () => {}; };
}
