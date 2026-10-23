// Keep presentation outside the themed body; custom properties still inherit
// from the document root, where SillyTavern stores its theme and font settings.
export function createUiSurface(stylesheetUrl, doc = document) {
  const host = doc.createElement("div");
  host.id = "story-branch-tree-ui-host";
  const layout = {
    all: "initial", display: "none", position: "fixed", inset: "0",
    width: "100%", height: "100%", "max-width": "none", "max-height": "none",
    margin: "0", padding: "0", border: "0", outline: "none",
    background: "transparent", "box-shadow": "none", overflow: "visible",
    "pointer-events": "none", "z-index": "10000", "box-sizing": "border-box",
    "font-family": "var(--mainFontFamily, system-ui), sans-serif",
    "font-size": "var(--mainFontSize, 16px)", "line-height": "1.5",
    color: "var(--SmartThemeBodyColor, #eee)",
  };
  for (const [property, value] of Object.entries(layout)) host.style.setProperty(property, value, "important");
  const root = host.attachShadow({ mode: "open" });
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = stylesheetUrl;
  let settled = false, disposed = false, visible = false, returnFocus = null;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  function finish(error) {
    if (settled) return;
    settled = true;
    link.removeEventListener("load", loaded);
    link.removeEventListener("error", failed);
    if (error) rejectReady(error);
    else resolveReady();
  }
  const loaded = () => finish();
  const failed = () => finish(Error("剧情分支树界面样式加载失败。"));
  link.addEventListener("load", loaded);
  link.addEventListener("error", failed);
  root.append(link);
  doc.documentElement.append(host);

  function sync() {
    if (disposed) return;
    const open = [...root.children].some(node => node.getAttribute("role") === "dialog" && !node.hidden);
    if (open) {
      if (!visible) returnFocus = doc.activeElement;
      host.style.setProperty("display", "block", "important");
      if (typeof host.showPopover === "function" && !host.matches(":popover-open")) {
        host.setAttribute("popover", "manual");
        try { host.showPopover(); }
        catch { host.removeAttribute("popover"); }
      }
    } else {
      const focused = doc.activeElement === host;
      if (host.hasAttribute("popover") && host.matches(":popover-open")) host.hidePopover();
      host.style.setProperty("display", "none", "important");
      if (visible && focused && returnFocus?.isConnected) returnFocus.focus();
      returnFocus = null;
    }
    visible = open;
  }
  function dispose() {
    if (disposed) return;
    const focused = doc.activeElement === host;
    if (host.hasAttribute("popover") && host.matches(":popover-open")) host.hidePopover();
    host.remove();
    if (focused && returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
    disposed = true;
    finish(Error("剧情分支树界面加载已取消。"));
  }
  return { host, root, ready, sync, dispose };
}
