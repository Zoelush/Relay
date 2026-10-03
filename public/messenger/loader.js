/* Relay v2: dependency-free, asynchronous launcher. The full messenger loads on first open. */
(() => {
  "use strict";
  const pending = window.Relay?.q || [];
  let config, boot, host, root, button, badge, frame, channel, socket, custom;
  let generation = 0,
    opened = false,
    retry = 0,
    reconnect,
    lastFocus,
    sound = false,
    notifications = false,
    openRequested,
    lastUnread;
  const messages = {
    en: {
      open: "Open support",
      unread: "unread conversations",
      title: "Support messenger",
      alerts: "Browser reply alerts",
      prompt: "Allow this website to show alerts for support replies?",
      enable: "Enable browser alerts",
      dismiss: "Not now",
      reply: "You have a new support reply.",
    },
    ar: {
      open: "فتح الدعم",
      unread: "محادثات غير مقروءة",
      title: "مراسلة الدعم",
      alerts: "تنبيهات المتصفح للردود",
      prompt: "هل تسمح لهذا الموقع بإظهار تنبيهات ردود الدعم؟",
      enable: "تفعيل تنبيهات المتصفح",
      dismiss: "ليس الآن",
      reply: "لديك رد جديد من الدعم.",
    },
  };
  const text = (key) => {
    const locales = [
      boot?.locale,
      boot?.locale?.split("-")[0],
      boot?.brand.locale,
      boot?.brand.locale?.split("-")[0],
      "en",
    ];
    return messages[locales.find((x) => messages[x])][key];
  };
  const uid = () => crypto.randomUUID();
  const emit = (name, detail) =>
    window.dispatchEvent(new CustomEvent("relay:" + name, { detail }));
  const fail = (error) =>
    emit("error", {
      code: error.code || "NETWORK_ERROR",
      message: error.message,
    });
  const storageKey = () =>
    "relay:device:" + config.workspaceId + ":" + config.brandId;
  const device = () => {
    try {
      let v = localStorage.getItem(storageKey());
      if (!v) localStorage.setItem(storageKey(), (v = uid() + uid()));
      return v;
    } catch {
      return config.deviceToken || (config.deviceToken = uid() + uid());
    }
  };
  async function api(path, body, token, key = uid()) {
    const response = await fetch(config.api + "/v1/messenger/" + path, {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(
        new Error(data.error?.message || "Relay is unavailable."),
        { code: data.error?.code },
      );
    return data;
  }
  function post(type, data = {}) {
    if (frame?.contentWindow)
      frame.contentWindow.postMessage(
        { relay: channel, type, ...data },
        config.api,
      );
  }
  function connect(epoch) {
    clearTimeout(reconnect);
    socket?.close();
    if (!boot?.realtime || epoch !== generation) return;
    const url = new URL(boot.realtime.url);
    url.searchParams.set("workspace", config.workspaceId);
    const ws = (socket = new WebSocket(url));
    ws.onopen = () =>
      ws.send(
        JSON.stringify({ type: "authenticate", ticket: boot.realtime.ticket }),
      );
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === "ready") retry = 0;
      if (data.type === "reauthenticate") ws.close();
      if (data.type === "unread") {
        const n = data.unread_count;
        badge.textContent = n ? String(n) : "";
        button.setAttribute(
          "aria-label",
          text("open") + (n ? ", " + n + " " + text("unread") : ""),
        );
        if (
          lastUnread !== undefined &&
          n > lastUnread &&
          !opened &&
          notifications &&
          Notification.permission === "granted"
        )
          new Notification(boot.brand.name, {
            body: text("reply"),
            tag: "relay-support",
          });
        lastUnread = n;
        emit("unread", n);
      }
    };
    ws.onclose = (e) => {
      if (epoch !== generation || e.code === 4401) {
        if (e.code === 4401) emit("identityRequired", {});
        return;
      }
      reconnect = setTimeout(
        async () => {
          try {
            boot.realtime = await api("realtime-ticket", {}, boot.token);
            connect(epoch);
          } catch (e) {
            fail(e);
          }
        },
        Math.min(30000, 500 * 2 ** retry++) + Math.random() * 300,
      );
    };
  }
  async function initialize(options) {
    const epoch = ++generation;
    clearTimeout(reconnect);
    socket?.close();
    frame?.remove();
    host?.remove();
    custom?.removeEventListener("click", open);
    frame = undefined;
    button = undefined;
    boot = undefined;
    root = undefined;
    opened = false;
    lastUnread = undefined;
    if (document.readyState !== "complete")
      await new Promise((resolve) =>
        addEventListener("load", resolve, { once: true }),
      );
    // A resolved load listener resumes in a microtask, before loadEventEnd.
    // Keep cold Intl/storage/identity boot work out of the host's load task.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (epoch !== generation) return;
    config = { brandId: "default", ...options };
    const apiUrl = new URL(config.api);
    if (
      apiUrl.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(apiUrl.hostname)
    )
      throw new Error("Relay requires HTTPS.");
    config.api = apiUrl.origin;
    const result = await api("boot", {
      workspaceId: config.workspaceId,
      brandId: config.brandId,
      deviceToken: device(),
      user: config.user,
      pageUrl: location.href,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale:
        config.locale || document.documentElement.lang || navigator.language,
    });
    if (epoch !== generation) return;
    boot = result;
    host = document.createElement("relay-launcher");
    host.hidden = true;
    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = config.api + "/messenger/launcher.css";
    root.append(style);
    const theme = document.createElement("link");
    theme.rel = "stylesheet";
    theme.href =
      config.api +
      "/messenger/theme.css?workspace=" +
      encodeURIComponent(config.workspaceId) +
      "&brand=" +
      encodeURIComponent(config.brandId);
    root.append(theme);
    const stylesReady = Promise.all(
      [style, theme].map(
        (link) =>
          new Promise((resolve, reject) => {
            link.onload = resolve;
            link.onerror = () =>
              reject(new Error("Relay stylesheet could not load."));
          }),
      ),
    );
    document.body.append(host);
    await stylesReady;
    if (epoch !== generation) return;
    host.hidden = false;
    button = document.createElement("button");
    button.type = "button";
    // Messenger settings M2: a launcher logo instead of the ✦, and spacing from the edges. M5: an
    // uploaded logo is served by Relay itself; any other address must be https.
    const look = boot.brand.messenger3 && boot.brand.messenger3.look;
    const logoUrl = (look && look.launcherLogo) || "";
    if (/^https:\/\//.test(logoUrl) || logoUrl.startsWith(config.api + "/")) {
      const logo = document.createElement("img");
      logo.src = look.launcherLogo;
      logo.alt = "";
      button.append(logo);
    } else button.textContent = "✦";
    if (look && look.launcherSpacing) {
      host.style.setProperty("--relay-side", Number(look.launcherSpacing.side) + "px");
      host.style.setProperty("--relay-bottom", Number(look.launcherSpacing.bottom) + "px");
    }
    button.setAttribute("aria-label", text("open"));
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-haspopup", "dialog");
    button.dataset.position = boot.brand.position;
    button.dataset.shape = boot.brand.shape;
    badge = document.createElement("span");
    badge.className = "badge";
    badge.setAttribute("aria-hidden", "true");
    button.append(badge);
    button.addEventListener("click", () => (opened ? close() : open()));
    root.append(button);
    custom = config.launcherSelector
      ? document.querySelector(config.launcherSelector)
      : null;
    if (custom) {
      button.hidden = true;
      custom.addEventListener("click", open);
    } else button.hidden = !launcherShown();
    host.dataset.launcher = button.hidden ? "hidden" : "shown";
    host.dataset.ready = "true";
    connect(epoch);
    emit("ready", { brand: boot.brand.name, capabilities: boot.capabilities });
    if (openRequested) {
      const requested = openRequested;
      openRequested = undefined;
      open(requested);
    }
  }
  function open(space) {
    if (!boot || !root || !button) {
      openRequested = space || true;
      return;
    }
    lastFocus =
      document.activeElement === host ? button : document.activeElement;
    if (!frame) {
      channel = uid();
      frame = document.createElement("iframe");
      frame.title = text("title");
      frame.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox",
      );
      frame.referrerPolicy = "no-referrer";
      frame.dataset.position = boot.brand.position;
      const url = new URL(config.api + "/messenger/frame.html");
      url.searchParams.set("parent", location.origin);
      url.searchParams.set("channel", channel);
      url.searchParams.set("workspace", config.workspaceId);
      url.searchParams.set("brand", config.brandId);
      frame.src = url.href;
      root.append(frame);
    }
    frame.hidden = false;
    opened = true;
    button.setAttribute("aria-expanded", "true");
    frame.focus();
    post("open", { space: typeof space === "string" ? space : undefined });
    emit("open", {});
  }
  function close() {
    if (!frame) return;
    frame.hidden = true;
    opened = false;
    button.setAttribute("aria-expanded", "false");
    post("close");
    (lastFocus?.isConnected ? lastFocus : custom || button)?.focus();
    emit("close", {});
  }
  function notificationPrompt() {
    if (!("Notification" in window)) {
      post("notificationState", { permission: "unsupported" });
      return;
    }
    root.querySelector(".notification-prompt")?.remove();
    const panel = document.createElement("section");
    panel.className = "notification-prompt";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", text("alerts"));
    const description = document.createElement("p");
    description.textContent = text("prompt");
    const allow = document.createElement("button");
    allow.type = "button";
    allow.textContent = text("enable");
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = text("dismiss");
    allow.onclick = async () => {
      const permission = await Notification.requestPermission();
      notifications = permission === "granted";
      post("notificationState", { permission });
      panel.remove();
      frame?.focus();
    };
    dismiss.onclick = () => {
      panel.remove();
      frame?.focus();
    };
    panel.append(description, allow, dismiss);
    root.append(panel);
    allow.focus();
  }
  addEventListener("message", (event) => {
    if (
      !frame ||
      event.source !== frame.contentWindow ||
      event.origin !== config.api ||
      event.data?.relay !== channel
    )
      return;
    const data = event.data;
    if (data.type === "ready")
      post("initialize", { boot, api: config.api, open: opened });
    if (data.type === "close") close();
    if (data.type === "error") fail(data);
    if (data.type === "sound") sound = data.enabled;
    if (data.type === "requestNotifications") notificationPrompt();
    if (data.type === "newReply" && !opened && sound)
      emit("soundRequested", {});
    if (data.type === "identityRequired") emit("identityRequired", {});
  });
  /**
   * Messenger settings M1: whether this page shows the launcher, for this customer's audience
   * (visitors or verified users). Opening from the host page's own code still works when hidden.
   */
  function launcherShown() {
    const m3 = boot && boot.brand.messenger3;
    const audience =
      boot && boot.session && boot.session.verified ? "users" : "visitors";
    const launcher =
      m3 &&
      m3.audiences &&
      m3.audiences[audience] &&
      m3.audiences[audience].launcher;
    if (!launcher || launcher.show === "always") return true;
    if (launcher.show === "never") return false;
    const url = location.href.split("#")[0];
    const hit = (launcher.rules || []).some((r) =>
      r.op === "equals"
        ? url === r.value
        : r.op === "starts_with"
          ? url.startsWith(r.value)
          : url.includes(r.value),
    );
    return launcher.show === "only_matching" ? hit : !hit;
  }
  let navigationTimer;
  function context() {
    if (button && !custom && !opened) {
      button.hidden = !launcherShown();
      host.dataset.launcher = button.hidden ? "hidden" : "shown";
    }
    clearTimeout(navigationTimer);
    navigationTimer = setTimeout(() => {
      if (boot)
        api("context", { pageUrl: location.href }, boot.token).catch(fail);
    }, 100);
  }
  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    history[name] = function (...args) {
      const result = original.apply(this, args);
      context();
      return result;
    };
  }
  addEventListener("popstate", context);
  async function command(name, value) {
    if (name === "boot") return initialize(value);
    if (name === "open" || name === "showSpace") return open(value);
    if (name === "close") return close();
    if (name === "update") return context();
    if (name === "setUser") return initialize({ ...config, user: value });
    if (name === "enableNotifications") {
      if (!("Notification" in window)) return false;
      notifications = (await Notification.requestPermission()) === "granted";
      return notifications;
    }
    if (name === "logout") {
      if (boot)
        void api("logout", {}, boot.token)
          .then(() => emit("logout", { remoteRevoked: true }))
          .catch(() => emit("logout", { remoteRevoked: false }));
      try {
        localStorage.removeItem(storageKey());
      } catch {}
      return initialize({
        ...config,
        user: undefined,
        deviceToken: uid() + uid(),
      });
    }
    if (name === "destroy") {
      ++generation;
      clearTimeout(reconnect);
      socket?.close();
      frame?.remove();
      host?.remove();
      custom?.removeEventListener("click", open);
      boot = undefined;
      return;
    }
    throw new Error("Unknown Relay command: " + name);
  }
  window.Relay = (name, value) => command(name, value).catch(fail);
  for (const args of pending) window.Relay(...args);
})();
