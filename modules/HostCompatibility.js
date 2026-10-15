// The official 1.14–1.16 host predates manifest lifecycle hooks and snapshot
// swipe selection. Keep these differences here; never select a live source reply.
export function createHostCompatibility(core) {
  const version = () => String(core.CLIENT_VERSION ?? "").match(/(?:^|:)SillyTavern:(\d+)\.(\d+)\.(\d+)(?=:|$)/)?.slice(1).map(Number) ?? null;
  const legacy = () => {
    const value = version();
    return value?.[0] === 1 && value[1] >= 14 && value[1] < 17;
  };
  return {
    legacy,
    isGenerating: () => typeof core.isGenerating === "function" ? core.isGenerating() : Boolean(core.is_send_press),
    isSwiping: () => core.swipeState !== undefined ? core.swipeState !== "none" : core.isSwipingAllowed === false,
    async createLegacyBranch(index, routeId, ctx) {
      // Old createBranch names only by floor and second, so two quick forks
      // can overwrite each other. Use the same core serializer with a route ID.
      if (!legacy() || !Number.isInteger(index) || !ctx.chat[index]
        || typeof routeId !== "string" || !/^[\w-]+$/.test(routeId)) throw Error("旧版原生分支参数无效。");
      const name = `Branch - ${routeId}`;
      await core.saveChat({ chatName: name, withMetadata: { main_chat: ctx.chatId }, mesId: index });
      return name;
    },
    selectSwipe(message, index) {
      if (!Number.isInteger(index) || typeof message?.swipes?.[index] !== "string") return false;
      if (!legacy() && version() && typeof core.syncSwipeToMes === "function") return core.syncSwipeToMes(null, index, message);
      if (!Array.isArray(message.swipe_info)) message.swipe_info = message.swipes.map(() => ({ send_date: message.send_date, extra: {} }));
      const info = message.swipe_info[index];
      message.swipe_id = index;
      message.mes = message.swipes[index];
      message.send_date = info?.send_date;
      message.gen_started = info?.gen_started;
      message.gen_finished = info?.gen_finished;
      message.extra = structuredClone(info?.extra) ?? {};
      return true;
    },
  };
}
