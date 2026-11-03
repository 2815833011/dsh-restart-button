/**
 * Browser half of dsh-restart-button.
 *
 * The Windows caption menubar ("应用 | 编辑") is created by the Desktop preload
 * inside an `{ mode: "open" }` shadow root, so this module appends one more
 * button to that same menubar instead of drawing its own bar. Clicking it asks
 * the Host half to stop and start the whole desktop application.
 *
 * Everything degrades to a no-op outside the Desktop window: with no
 * `[data-windows-menu]` host in the document there is nothing to extend, and a
 * plain browser tab has no application to restart.
 */

window.__ModuleLoader__.load({
  id: "dsh-restart-button",
  factory: (require) => {
    const NS = "dsh-restart-button";
    const ROUTE = "/dsh-restart-button/restart";
    const HEADERS = { "x-dsh-restart-button": "1", "content-type": "application/json" };

    /** Poll interval while waiting for the preload menubar, in milliseconds. */
    const FIND_MS = 250;
    /** Upper bound on that wait, in milliseconds. */
    const FIND_TIMEOUT_MS = 60_000;

    const DICT = {
      zh: {
        label: "重启",
        busy: "重启中…",
        title: "重启 DSH（关闭并重新启动整个应用）",
        busyTitle: "正在重启，窗口即将关闭…",
        failed: "重启失败：",
      },
      en: {
        label: "Restart",
        busy: "Restarting…",
        title: "Restart DSH (closes and starts the whole application again)",
        busyTitle: "Restarting; the window is about to close…",
        failed: "Restart failed: ",
      },
    };

    /** Current interface language, following the document that carries the menubar. */
    function language() {
      const tag = typeof document === "undefined" ? "" : document.documentElement.lang;
      return typeof tag === "string" && tag.toLowerCase().startsWith("zh") ? "zh" : "en";
    }

    /** One localised string. */
    function tr(key) {
      const table = DICT[language()];
      return table[key] ?? DICT.en[key] ?? key;
    }

    /** Absolute URL for this plugin's route, matching the document's own origin. */
    function routeUrl() {
      const boot = typeof window === "undefined" ? undefined : window.__DSH_BOOT__;
      const origin =
        typeof location !== "undefined" && typeof location.origin === "string" && location.origin.startsWith("http")
          ? location.origin
          : typeof boot === "object" && boot !== null && typeof boot.origin === "string" && boot.origin.startsWith("http")
            ? boot.origin
            : undefined;
      return origin === undefined ? ROUTE : `${origin.replace(/\/+$/, "")}${ROUTE}`;
    }

    /**
     * Ask the Host to restart the application.
     * @returns {Promise<string|null>} null on success, otherwise a short reason.
     */
    async function requestRestart() {
      let response;
      try {
        response = await fetch(routeUrl(), { method: "POST", headers: HEADERS, body: "{}", cache: "no-store" });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (response.ok && payload !== null && payload.ok === true) return null;
      const reason = payload === null ? undefined : payload.error;
      return typeof reason === "string" && reason !== "" ? reason : `HTTP ${String(response.status)}`;
    }

    /**
     * Locate the preload menubar's shadow root.
     * @returns {ShadowRoot|null} the open shadow root, when the Desktop provides it.
     */
    function menuShadow() {
      const host = document.querySelector("[data-windows-menu]");
      return host === null ? null : host.shadowRoot;
    }

    /** Build the restart button and wire it to the Host route. */
    function mount() {
      const shadow = menuShadow();
      if (shadow === null) return false;
      const bar = shadow.querySelector('[role="menubar"]');
      if (bar === null) return false;
      if (shadow.querySelector("[data-dsh-restart-button]") !== null) return true;

      const button = document.createElement("button");
      button.type = "button";
      button.tabIndex = -1;
      button.dataset.dshRestartButton = "";
      button.textContent = tr("label");
      button.title = tr("title");
      // Keep focus in the editor: the menubar's other buttons do the same.
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
      });
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        button.textContent = tr("busy");
        button.title = tr("busyTitle");
        button.style.opacity = "0.6";
        const error = await requestRestart();
        if (error === null) return;
        button.disabled = false;
        button.textContent = tr("label");
        button.title = `${tr("failed")}${error}`;
        button.style.opacity = "";
        console.error("dsh-restart-button:", error);
      });
      bar.append(button);
      return true;
    }

    /** Keep the caption in step with the application language. */
    function relabel() {
      const shadow = menuShadow();
      const button = shadow === null ? null : shadow.querySelector("[data-dsh-restart-button]");
      if (button === null || button.disabled) return;
      button.textContent = tr("label");
      if (button.title.startsWith(tr("failed")) === false) button.title = tr("title");
    }

    /** Wait for the preload menubar, then append the button. */
    function start() {
      if (mount()) return;
      const deadline = Date.now() + FIND_TIMEOUT_MS;
      const timer = setInterval(() => {
        if (mount() || Date.now() > deadline) clearInterval(timer);
      }, FIND_MS);
    }

    /** Register the button; nothing else in the client tree depends on us. */
    function apply(ctx) {
      if (typeof document === "undefined") return;
      start();
      const observer = new MutationObserver(() => {
        relabel();
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
      if (typeof ctx.effect === "function") {
        ctx.effect(() => () => {
          observer.disconnect();
          const shadow = menuShadow();
          const button = shadow === null ? null : shadow.querySelector("[data-dsh-restart-button]");
          if (button !== null) button.remove();
        });
      }
    }

    return { name: NS, apply };
  },
});
