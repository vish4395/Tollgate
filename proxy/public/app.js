// Claude gateway dashboard. Plain JavaScript, no build step, no outside files.
"use strict";

/* =========================================================================
   Helpers
   ========================================================================= */
const $ = (s, r = document) => r.querySelector(s);
// replaceChildren that skips null/false, so pages can write `cond ? el : null`.
{
  const rc = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...kids) {
    rc.call(this, ...kids.flat(Infinity).filter((k) => k != null && k !== false));
  };
}
/** Chart width in pixels, so labels keep their size. `half` for charts in two-column grids. */
const chartWidth = (half) => {
  const w = document.getElementById("main")?.clientWidth ?? 900;
  return Math.max(260, Math.round((half && w > 1000 ? w / 2 : w) - 90));
};
const SVGNS = "http://www.w3.org/2000/svg";

/** Creates an element. Props: class, style (object or string), on* handlers, attributes. */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style")
      typeof v === "string" ? (e.style.cssText = v) : Object.assign(e.style, v);
    else if (k.startsWith("on") && typeof v === "function")
      e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    else if (k === "checked") e.checked = !!v;
    else if (k === "selected") e.selected = !!v;
    else if (k === "ref") v(e);
    else e.setAttribute(k, v === true ? "" : v);
  }
  append(e, kids);
  return e;
}
function append(e, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return e;
}
function s(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs))
    if (v != null) e.setAttribute(k, v);
  for (const k of kids.flat())
    if (k != null)
      e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

// Icons (24px stroke paths).
const ICONS = {
  overview: "M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  projects: "M3 7h7l2 2h9v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  accounts:
    "M16 20v-1a4 4 0 0 0-8 0v1M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6M20 20v-1a3 3 0 0 0-2-2.8M17 4.2a3 3 0 0 1 0 5.6",
  models: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  usage: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  requests: "M4 6h16M4 12h16M4 18h10",
  monitoring: "M3 12h4l3-8 4 16 3-8h4",
  alerts: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0",
  activity: "M12 8v4l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18",
  playground: "M8 5l11 7-11 7z",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  up: "M12 19V5M5 12l7-7 7 7",
  down: "M12 5v14M19 12l-7 7-7-7",
  x: "M18 6L6 18M6 6l12 12",
  refresh: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
  plus: "M12 5v14M5 12h14",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  pause: "M8 5v14M16 5v14",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
};
const icon = (name) =>
  s(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    },
    s("path", { d: ICONS[name] ?? "" }),
  );

const nf = new Intl.NumberFormat();
const fmt = (n) => (n == null ? "–" : nf.format(Math.round(n)));
function short(n) {
  if (n == null) return "–";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1e4) return (n / 1e3).toFixed(0) + "k";
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(n));
}
const money = (n) =>
  n == null
    ? "–"
    : n < 0.01 && n > 0
      ? "<$0.01"
      : "$" + n.toFixed(n < 10 ? 2 : 0);
const ms = (n) =>
  n == null
    ? "–"
    : n < 1000
      ? `${Math.round(n)} ms`
      : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} s`;
function ago(t) {
  if (!t) return "never";
  const d =
    (Date.now() - Date.parse(t.includes("T") ? t : t.replace(" ", "T") + "Z")) /
    1000;
  if (d < 0) return "just now";
  if (d < 60) return `${Math.round(d)}s ago`;
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
}
function until(t) {
  if (!t) return "";
  const d = (Number(t) - Date.now()) / 1000;
  if (d <= 0) return "now";
  if (d < 3600) return `in ${Math.ceil(d / 60)} min`;
  if (d < 86400) return `in ${(d / 3600).toFixed(1).replace(/\.0$/, "")} h`;
  return `in ${Math.round(d / 86400)} d`;
}
const when = (t) =>
  t
    ? new Date(
        t.includes?.("T") || typeof t === "number"
          ? t
          : t.replace(" ", "T") + "Z",
      ).toLocaleString()
    : "–";
const time = (t) =>
  t
    ? new Date(t).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "–";
const debounce = (fn, wait = 300) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), wait);
  };
};
const announce = (msg) => {
  $("#announce").textContent = "";
  setTimeout(() => ($("#announce").textContent = msg), 50);
};
async function copyText(text, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    // Older browsers and plain http on another device: select it so the person can copy.
    const t = h("textarea", { class: "sr-only" });
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
    toast(label);
  }
}
const store = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem("cgw." + k)) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("cgw." + k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

/* =========================================================================
   API, toasts, dialogs
   ========================================================================= */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
async function api(path, opts = {}) {
  const init = {
    method: opts.method ?? "GET",
    headers: { "x-cgw": "1" },
    credentials: "same-origin",
    signal: opts.signal,
  };
  if (opts.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  let r;
  try {
    r = await fetch(path, init);
  } catch {
    throw new ApiError(0, "Can't reach the gateway. Check that it's running.");
  }
  if (r.status === 401 && !path.endsWith("/login")) {
    showLogin();
    throw new ApiError(401, "Signed out.");
  }
  const ct = r.headers.get("content-type") ?? "";
  const data = ct.includes("json")
    ? await r.json().catch(() => ({}))
    : await r.text();
  if (!r.ok)
    throw new ApiError(
      r.status,
      data?.error?.message ??
        data?.error ??
        `The gateway answered ${r.status}.`,
    );
  return data;
}

/** Short message. Errors stay until closed; others fade. `action` adds a button (e.g. Undo). */
function toast(msg, opts = {}) {
  const el = h(
    "div",
    {
      class: "toast" + (opts.error ? " error" : ""),
      role: opts.error ? "alert" : "status",
    },
    h("div", { style: "flex:1" }, msg),
    opts.action
      ? h(
          "button",
          { type: "button", onclick: () => (opts.action.fn(), el.remove()) },
          opts.action.label,
        )
      : null,
    h(
      "button",
      { type: "button", "aria-label": "Close", onclick: () => el.remove() },
      "✕",
    ),
  );
  $("#toasts").append(el);
  if (!opts.error) setTimeout(() => el.remove(), opts.action ? 7000 : 2600);
}
const fail = (e) =>
  e?.status !== 401 && toast(e?.message ?? String(e), { error: true });

/** Runs an action with a busy button and an error toast. Returns the result or undefined. */
async function act(btn, fn, okMsg) {
  if (btn) btn.setAttribute("aria-busy", "true");
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r ?? true;
  } catch (e) {
    fail(e);
  } finally {
    if (btn) btn.removeAttribute("aria-busy");
  }
}

function dialog({ title, body, actions, cls = "", onclose }) {
  const dlg = h("dialog", { class: cls, "aria-label": title });
  const close = () => dlg.close();
  append(dlg, [
    h(
      "div",
      { class: "dlg-body" },
      h(
        "div",
        { class: "spread" },
        h("h2", { style: "margin:0" }, title),
        h(
          "button",
          {
            class: "btn ghost icon-btn",
            type: "button",
            "aria-label": "Close",
            onclick: close,
          },
          icon("x"),
        ),
      ),
      h("div", { class: "mt-s" }, body),
    ),
    actions ? h("div", { class: "dlg-actions" }, actions(close)) : null,
  ]);
  dlg.addEventListener("close", () => {
    onclose?.();
    dlg.remove();
  });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
function confirmDlg({ title, body, ok = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    dialog({
      title,
      body: typeof body === "string" ? h("p", {}, body) : body,
      onclose: () => resolve(answer),
      actions: (close) => [
        h("button", { class: "btn", type: "button", onclick: close }, "Cancel"),
        h(
          "button",
          {
            class: "btn " + (danger ? "danger solid" : "primary"),
            type: "button",
            autofocus: true,
            onclick: () => ((answer = true), close()),
          },
          ok,
        ),
      ],
    });
  });
}
/** A small form in a dialog. fields: [{ name, label, value, type, help, required }]. Resolves values or null. */
function formDlg({ title, intro, fields, ok = "Save" }) {
  return new Promise((resolve) => {
    let answer = null;
    const inputs = {};
    const form = h(
      "form",
      { class: "form wide" },
      intro
        ? h("p", { class: "muted span", style: "grid-column:1/-1" }, intro)
        : null,
      fields.map((f) =>
        h(
          "label",
          { class: "field span" },
          f.label,
          (inputs[f.name] = h(f.type === "textarea" ? "textarea" : "input", {
            type: f.type ?? "text",
            value: f.value ?? "",
            required: f.required,
            placeholder: f.placeholder,
            autocomplete: f.autocomplete ?? "off",
            minlength: f.minlength,
          })),
          f.help ? h("span", { class: "help" }, f.help) : null,
        ),
      ),
      h("button", { type: "submit", class: "hidden" }),
    );
    const submit = (close) => {
      if (!form.reportValidity()) return;
      answer = Object.fromEntries(
        Object.entries(inputs).map(([k, el]) => [k, el.value]),
      );
      close();
    };
    const dlg = dialog({
      title,
      body: form,
      onclose: () => resolve(answer),
      actions: (close) => [
        h("button", { class: "btn", type: "button", onclick: close }, "Cancel"),
        h(
          "button",
          {
            class: "btn primary",
            type: "button",
            onclick: () => submit(close),
          },
          ok,
        ),
      ],
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submit(() => dlg.close());
    });
  });
}
function drawer(title, body) {
  return dialog({ title, body, cls: "drawer" });
}
/** Shows a new key once, with copy buttons. */
function showKey(name, key) {
  const base =
    S.status?.connection?.publicUrl ||
    S.status?.connection?.lanUrl ||
    location.origin;
  dialog({
    title: `Key for ${name}`,
    body: h(
      "div",
      {},
      h(
        "p",
        {},
        "Copy it now. For safety the gateway keeps only a fingerprint of it, so it can't show it again.",
      ),
      h("div", { class: "keybox mono wrap-any mt-s" }, key),
      h(
        "div",
        { class: "row mt-s" },
        h(
          "button",
          {
            class: "btn primary",
            type: "button",
            onclick: () => copyText(key, "Key copied"),
          },
          icon("copy"),
          "Copy key",
        ),
        h(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () =>
              copyText(
                `ANTHROPIC_BASE_URL=${base}\nANTHROPIC_API_KEY=${key}`,
                "Settings copied",
              ),
          },
          "Copy as .env",
        ),
      ),
    ),
    actions: (close) => [
      h(
        "button",
        { class: "btn primary", type: "button", onclick: close },
        "I've saved it",
      ),
    ],
  });
}
const copyBlock = (text) =>
  h(
    "div",
    { class: "copy" },
    h("pre", {}, text),
    h(
      "button",
      { class: "btn sm", type: "button", onclick: () => copyText(text) },
      icon("copy"),
      "Copy",
    ),
  );
function sw(checked, onchange, label) {
  return h(
    "label",
    { class: "switch", title: label },
    h("input", {
      type: "checkbox",
      role: "switch",
      checked,
      "aria-label": label,
      onchange: (e) => onchange(e.target.checked, e.target),
    }),
    h("span"),
  );
}
const pill = (text, kind = "") => h("span", { class: "pill " + kind }, text);
const meter = (p, warnAt = 80, badAt = 95) =>
  h(
    "div",
    {
      class: "meter",
      role: "meter",
      "aria-valuenow": Math.round(p ?? 0),
      "aria-valuemin": 0,
      "aria-valuemax": 100,
    },
    h("i", {
      class: p >= badAt ? "bad" : p >= warnAt ? "warn" : "",
      style: { width: Math.min(100, Math.max(0, p ?? 0)) + "%" },
    }),
  );
const field = (label, input, help) =>
  h(
    "label",
    { class: "field" },
    label,
    input,
    help ? h("span", { class: "help" }, help) : null,
  );
const skeleton = (rows = 3) =>
  h(
    "div",
    {},
    Array.from({ length: rows }, (_, i) =>
      h("div", {
        class: "skeleton",
        style: {
          height: i ? "90px" : "28px",
          width: i ? "100%" : "40%",
          marginTop: i ? "14px" : 0,
        },
      }),
    ),
  );
const empty = (title, text, button) =>
  h("div", { class: "empty" }, h("h2", {}, title), h("p", {}, text), button);
function table(cols, rows, opts = {}) {
  if (!rows.length)
    return opts.empty ?? h("p", { class: "muted" }, "Nothing yet.");
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      {},
      opts.caption ? h("caption", { class: "sr-only" }, opts.caption) : null,
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          cols.map((c) =>
            h("th", { class: c.num ? "num" : "", scope: "col" }, c.label),
          ),
        ),
      ),
      h(
        "tbody",
        {},
        rows.map((r) => {
          const tr = h(
            "tr",
            {},
            cols.map((c) =>
              h(
                "td",
                { class: (c.num ? "num " : "") + (c.cls?.(r) ?? "") },
                c.value(r),
              ),
            ),
          );
          if (opts.onRow) {
            tr.className = "link";
            tr.tabIndex = 0;
            tr.addEventListener("click", () => opts.onRow(r));
            tr.addEventListener(
              "keydown",
              (e) =>
                (e.key === "Enter" || e.key === " ") &&
                (e.preventDefault(), opts.onRow(r)),
            );
          }
          return tr;
        }),
      ),
    ),
  );
}
const COLORS = [
  "--c1",
  "--c2",
  "--c3",
  "--c4",
  "--c5",
  "--c6",
  "--c7",
  "--c8",
  "--c9",
  "--c10",
];
const color = (i) => `var(${COLORS[i % COLORS.length]})`;
// Past ten series, a dash pattern keeps lines apart.
const dash = (i) => (i >= COLORS.length ? "5 3" : null);

/* =========================================================================
   Charts (inline SVG)
   ========================================================================= */
/** Line chart. series: [{ label, values: number[] }]; labels: string[] for x. */
function lineChart({ labels, series, height = 160, yFmt = short, max, title, half = true }) {
  const W = chartWidth(half);
  const H = height;
  const pad = { l: 40, r: 8, t: 8, b: 20 };
  const all = series.flatMap((x) => x.values).filter((v) => v != null);
  const top = max ?? Math.max(1, ...all) * 1.1;
  const x = (i) =>
    pad.l +
    (labels.length <= 1 ? 0 : (i / (labels.length - 1)) * (W - pad.l - pad.r));
  const y = (v) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const svg = s("svg", {
    class: "chart",
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": title ?? series.map((x) => x.label).join(", "),
  });
  for (let k = 0; k <= 3; k++) {
    const v = (top / 3) * k;
    svg.append(
      s("line", {
        class: "grid-line",
        x1: pad.l,
        x2: W - pad.r,
        y1: y(v),
        y2: y(v),
      }),
      s("text", { x: pad.l - 6, y: y(v) + 3, "text-anchor": "end" }, yFmt(v)),
    );
  }
  const step = Math.max(1, Math.ceil(labels.length / 6));
  labels.forEach(
    (l, i) =>
      i % step === 0 &&
      svg.append(s("text", { x: x(i), y: H - 4, "text-anchor": "middle" }, l)),
  );
  series.forEach((ser, si) => {
    let d = "";
    ser.values.forEach((v, i) => {
      if (v == null) return;
      d +=
        (d && ser.values[i - 1] != null ? "L" : "M") +
        x(i).toFixed(1) +
        " " +
        y(v).toFixed(1);
    });
    svg.append(
      s("path", {
        d,
        fill: "none",
        stroke: ser.color ?? color(si),
        "stroke-width": 2,
        "stroke-dasharray": dash(si),
        "vector-effect": "non-scaling-stroke",
      }),
    );
  });
  return h(
    "div",
    {},
    svg,
    series.length > 1
      ? h(
          "div",
          { class: "legend" },
          series.map((ser, i) =>
            h(
              "span",
              {},
              h("i", { style: { background: ser.color ?? color(i) } }),
              ser.label,
            ),
          ),
        )
      : null,
  );
}
/** Stacked bars. groups: [{ label, parts: { key: value } }], keys in legend order. */
function barChart({ groups, keys, height = 170, yFmt = short, title, half = false }) {
  const W = chartWidth(half);
  const H = height;
  const pad = { l: 40, r: 6, t: 8, b: 20 };
  const totals = groups.map((g) =>
    keys.reduce((s2, k) => s2 + (g.parts[k] ?? 0), 0),
  );
  const top = Math.max(1, ...totals) * 1.1;
  const bw = (W - pad.l - pad.r) / Math.max(1, groups.length);
  const y = (v) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const svg = s("svg", {
    class: "chart",
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": title ?? "Bar chart",
  });
  for (let k = 0; k <= 3; k++) {
    const v = (top / 3) * k;
    svg.append(
      s("line", {
        class: "grid-line",
        x1: pad.l,
        x2: W - pad.r,
        y1: y(v),
        y2: y(v),
      }),
      s("text", { x: pad.l - 6, y: y(v) + 3, "text-anchor": "end" }, yFmt(v)),
    );
  }
  const step = Math.max(1, Math.ceil(groups.length / 8));
  groups.forEach((g, i) => {
    let acc = 0;
    keys.forEach((k, ki) => {
      const v = g.parts[k] ?? 0;
      if (!v) return;
      const r = s("rect", {
        x: pad.l + i * bw + bw * 0.15,
        width: Math.max(1, bw * 0.7),
        y: y(acc + v),
        height: Math.max(0, y(acc) - y(acc + v)),
        fill: color(ki),
        rx: 2,
      });
      r.append(s("title", {}, `${g.label} · ${k}: ${fmt(v)}`));
      svg.append(r);
      acc += v;
    });
    if (i % step === 0)
      svg.append(
        s(
          "text",
          { x: pad.l + i * bw + bw / 2, y: H - 4, "text-anchor": "middle" },
          g.label,
        ),
      );
  });
  return h(
    "div",
    {},
    svg,
    keys.length > 1
      ? h(
          "div",
          { class: "legend" },
          keys.map((k, i) =>
            h("span", {}, h("i", { style: { background: color(i) } }), k),
          ),
        )
      : null,
  );
}
/** Same data as a table, for screen readers and exact numbers. */
const dataToggle = (chart, tbl) => {
  const wrap = h("div", {}, chart);
  let showing = false;
  const btn = h(
    "button",
    {
      class: "btn ghost sm",
      type: "button",
      onclick: () => {
        showing = !showing;
        wrap.replaceChildren(showing ? tbl() : chart);
        btn.textContent = showing ? "Show chart" : "Show as table";
      },
    },
    "Show as table",
  );
  return { wrap, btn };
};

/* =========================================================================
   App shell and router
   ========================================================================= */
const S = { status: null, page: null, timer: null, live: true };
const NAV = [
  ["overview", "Overview"],
  ["projects", "Projects"],
  ["accounts", "Accounts"],
  ["models", "Models"],
  ["usage", "Usage"],
  ["requests", "Requests"],
  ["monitoring", "Monitoring"],
  ["alerts", "Alerts"],
  ["activity", "Activity"],
  ["playground", "Playground"],
  ["settings", "Settings"],
];
const MOBILE = ["overview", "projects", "requests", "alerts"];

function applyTheme(t = store.get("theme", "auto")) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}
applyTheme();

function showLogin(msg) {
  clearInterval(S.timer);
  const pw = h("input", {
    type: "password",
    autocomplete: "current-password",
    required: true,
    id: "pw",
  });
  const err = h("p", { class: "bad-t small", role: "alert" }, msg ?? "");
  const btn = h("button", { class: "btn primary", type: "submit" }, "Sign in");
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.setAttribute("aria-busy", "true");
        err.textContent = "";
        try {
          await api("/admin/login", {
            method: "POST",
            body: { password: pw.value },
          });
          boot();
        } catch (x) {
          err.textContent = x.message;
          pw.select();
        } finally {
          btn.removeAttribute("aria-busy");
        }
      },
    },
    h("label", { class: "field", for: "pw" }, "Dashboard password", pw),
    err,
    h("div", { class: "row mt-s" }, btn),
  );
  $("#root").replaceChildren(
    h(
      "div",
      { class: "login-wrap" },
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "brand", style: "padding:0 0 12px" },
          h("span", { class: "dot ok" }),
          "Claude Gateway",
        ),
        form,
        h(
          "p",
          { class: "muted small mt" },
          "The first password is in ADMIN_PASSWORD.txt in the gateway folder. Reset it with: node proxy/cli.mjs set-password <new>",
        ),
      ),
    ),
  );
  pw.focus();
}

function navLink(id, label, extra = {}) {
  const count = id === "alerts" ? (S.status?.alerts?.length ?? 0) : 0;
  return h(
    "a",
    {
      class: "nav",
      href: "#" + id,
      "aria-current": S.page === id ? "page" : null,
      ...extra,
    },
    icon(id),
    h("span", {}, label),
    count
      ? h("span", { class: "count", "aria-label": `${count} open` }, count)
      : null,
  );
}
function renderShell() {
  const st = S.status;
  const ok = st?.upstream?.ok;
  const side = h(
    "nav",
    { class: "side", "aria-label": "Main" },
    h(
      "div",
      { class: "brand" },
      h("span", {
        class: "dot " + (ok ? "ok" : st ? "bad" : ""),
        title: ok ? "Backend healthy" : "Backend not healthy",
      }),
      "Claude Gateway",
    ),
    NAV.map(([id, label]) => navLink(id, label)),
    h("div", { class: "grow" }),
    h(
      "div",
      { class: "foot" },
      h(
        "button",
        {
          class: "nav btn ghost",
          style: "width:100%;justify-content:flex-start",
          type: "button",
          onclick: () => {
            const order = ["auto", "light", "dark"];
            const next =
              order[(order.indexOf(store.get("theme", "auto")) + 1) % 3];
            store.set("theme", next);
            applyTheme(next);
            toast(`Theme: ${next === "auto" ? "same as the system" : next}`);
          },
        },
        icon("sun"),
        "Theme",
      ),
      h(
        "button",
        {
          class: "nav btn ghost",
          style: "width:100%;justify-content:flex-start",
          type: "button",
          onclick: async () => {
            await api("/admin/logout", { method: "POST" }).catch(() => {});
            showLogin();
          },
        },
        icon("logout"),
        "Sign out",
      ),
      h(
        "div",
        { class: "muted small", style: "padding:6px 10px" },
        st ? `v${st.version}` : "",
      ),
    ),
  );
  const mobile = h(
    "nav",
    { class: "mobile-bar", "aria-label": "Main" },
    MOBILE.map((id) => {
      const count = id === "alerts" ? (st?.alerts?.length ?? 0) : 0;
      return h(
        "a",
        { href: "#" + id, "aria-current": S.page === id ? "page" : null },
        icon(id),
        NAV.find((n) => n[0] === id)[1],
        count ? h("span", { class: "count" }, count) : null,
      );
    }),
    h(
      "button",
      {
        type: "button",
        "aria-current": MOBILE.includes(S.page) ? null : "page",
        onclick: () => {
          const sheet = h(
            "div",
            { class: "sheet-nav", role: "dialog", "aria-label": "More pages" },
            NAV.filter(([id]) => !MOBILE.includes(id)).map(([id, label]) =>
              navLink(id, label, { onclick: () => sheet.remove() }),
            ),
          );
          const off = (e) => {
            if (!sheet.contains(e.target)) {
              sheet.remove();
              document.removeEventListener("pointerdown", off, true);
            }
          };
          document.body.append(sheet);
          setTimeout(() => document.addEventListener("pointerdown", off, true));
          sheet.querySelector("a")?.focus();
        },
      },
      icon("more"),
      "More",
    ),
  );
  const main = h("main", { id: "main", tabindex: "-1" });
  $("#root").replaceChildren(h("div", { class: "layout" }, side, main), mobile);
  return main;
}

const PAGES = {};
/** Each page: { title, render(main, args) -> optional refresh fn, every: seconds or 0 }. */
async function route() {
  clearInterval(S.timer);
  const [path, qs] = (location.hash.slice(1) || "overview").split("?");
  const query = new URLSearchParams(qs ?? "");
  const [page, ...args] = path.split("/");
  const def = PAGES[page] ? page : "overview";
  S.page = def;
  try {
    S.status = await api("/admin/api/status");
  } catch (e) {
    if (e.status === 401) return;
    S.status = null;
  }
  const main = renderShell();
  document.title = `${NAV.find((n) => n[0] === def)?.[1] ?? "Gateway"} · Claude Gateway`;
  main.append(skeleton());
  let refresh = null;
  try {
    refresh = await PAGES[def].render(main, args.map(decodeURIComponent), query);
  } catch (e) {
    if (e.status === 401) return;
    main.replaceChildren(
      h(
        "div",
        { class: "banner critical" },
        h(
          "div",
          { class: "body" },
          h("strong", {}, "This page couldn't load. "),
          e.message,
          " ",
          h(
            "button",
            { class: "btn sm", type: "button", onclick: route },
            "Try again",
          ),
        ),
      ),
    );
  }
  main.focus({ preventScroll: true });
  const every = PAGES[def].every;
  if (every && typeof refresh === "function")
    S.timer = setInterval(async () => {
      if (document.hidden || document.querySelector("dialog[open]")) return;
      try {
        S.status = await api("/admin/api/status");
        updateNavBadges();
        await refresh();
      } catch (e) {
        if (e.status === 401) clearInterval(S.timer);
      }
    }, every * 1000);
}
function updateNavBadges() {
  const n = S.status?.alerts?.length ?? 0;
  for (const a of document.querySelectorAll('a[href="#alerts"]')) {
    a.querySelector(".count")?.remove();
    if (n) a.append(h("span", { class: "count" }, n));
  }
  const dot = $(".side .brand .dot");
  if (dot) dot.className = "dot " + (S.status?.upstream?.ok ? "ok" : "bad");
}
function pageHead(title, sub, ...actions) {
  return h(
    "div",
    { class: "head" },
    h(
      "div",
      {},
      h("h1", {}, title),
      sub ? h("div", { class: "sub" }, sub) : null,
    ),
    actions.length ? h("div", { class: "actions" }, actions) : null,
  );
}
window.addEventListener("hashchange", route);
async function boot() {
  try {
    await api("/admin/api/status");
    route();
  } catch (e) {
    if (e.status !== 401) showLogin(e.message);
  }
}

/* =========================================================================
   Shared bits for pages
   ========================================================================= */
const baseUrl = () =>
  S.status?.connection?.publicUrl ||
  S.status?.connection?.lanUrl ||
  location.origin;
const stateKind = {
  ok: "ok",
  limited: "warn",
  signed_out: "bad",
  error: "bad",
};
const stateLabel = {
  ok: "Ready",
  limited: "Paused (limit)",
  signed_out: "Signed out",
  error: "Error",
};
function alertBanner(a) {
  return h(
    "div",
    {
      class:
        "banner " +
        (a.severity === "critical"
          ? "critical"
          : a.severity === "warning"
            ? "warning"
            : "info"),
      role: a.severity === "critical" ? "alert" : null,
    },
    h(
      "div",
      { class: "body" },
      h("strong", {}, a.title),
      a.subject ? h("span", { class: "muted" }, ` · ${a.subject}`) : null,
      h("div", { class: "small" }, a.message),
      h("div", { class: "muted small" }, `Since ${ago(a.opened_at)}`),
    ),
    h("a", { class: "btn sm", href: "#alerts" }, "View"),
  );
}
function quotaRows(q) {
  if (!q) return h("p", { class: "muted small" }, "Quota not read yet.");
  return h(
    "div",
    { style: "display:grid;gap:6px" },
    [
      ["5-hour", q.fiveHour, q.fiveResets],
      ["7-day", q.weekly, q.weeklyResets],
    ].map(([label, p, resets]) =>
      h(
        "div",
        { class: "meter-row" },
        h("span", { class: "muted" }, label),
        meter(p ?? 0),
        h(
          "span",
          { class: "nowrap" },
          p == null ? "–" : `${p}%`,
          resets
            ? h("span", { class: "muted" }, ` · resets ${until(resets)}`)
            : null,
        ),
      ),
    ),
    q.stale
      ? h(
          "p",
          { class: "muted small" },
          "Last known values; the backend couldn't refresh them.",
        )
      : null,
  );
}
async function projectsList() {
  return api("/admin/api/projects");
}
async function modelList() {
  return api("/admin/api/models").catch(() => []);
}

/* =========================================================================
   Overview
   ========================================================================= */
PAGES.overview = {
  every: 10,
  async render(main) {
    const body = h("div");
    const draw = async () => {
      const st = S.status;
      if (!st) {
        body.replaceChildren(h("div", { class: "banner critical" }, h("div", { class: "body" }, "Can't read the gateway's status.")));
        return;
      }
      const usage = await api("/admin/api/usage?days=14").catch(() => null);
      const recent = await api("/admin/api/requests?errors=1&limit=6").catch(() => []);
      const sorted = [...st.alerts].sort((a, b) => (b.severity === "critical") - (a.severity === "critical"));
      const setup = st.setup;
      const steps = [
        [setup.signedIn, "A Claude account is signed in", h("a", { href: "#accounts" }, "Accounts")],
        [setup.hasProject, "Create a project key for your first app", h("a", { href: "#projects" }, "Projects")],
        [setup.firstCall, "Make a first call", h("a", { href: "#projects" }, "See the connection details")],
        [setup.alertsSet, "Choose where alerts go (webhook, Telegram or email)", h("a", { href: "#alerts/channels" }, "Alerts")],
        [setup.passwordChanged, "Replace the generated dashboard password", h("a", { href: "#settings" }, "Settings")],
      ];
      const left = steps.filter((x) => !x[0]).length;
      const up = st.upstream;
      const busy = `${st.active} running · ${st.queued} waiting`;
      body.replaceChildren(
        ...sorted.slice(0, 4).map(alertBanner),
        sorted.length > 4 ? h("p", { class: "small" }, h("a", { href: "#alerts" }, `${sorted.length - 4} more open alerts`)) : null,
        !up.ok ? h("div", { class: "banner critical", role: "alert" }, h("div", { class: "body" }, h("strong", {}, "The Claude backend is not healthy. "), up.error ?? up.status, ". The gateway restarts it by itself; if this stays, see Settings → Backend.")) : null,
        left
          ? h(
              "div",
              { class: "card" },
              h("div", { class: "spread" }, h("h2", { style: "margin:0" }, "Get set up"), h("span", { class: "muted small" }, `${steps.length - left} of ${steps.length} done`)),
              h(
                "ol",
                { class: "steps mt-s" },
                steps.map(([done, what, link]) => h("li", { class: done ? "done" : "" }, h("span", { class: "tick", "aria-hidden": "true" }, done ? "✓" : ""), h("span", { class: "what" }, what, done ? h("span", { class: "sr-only" }, " (done)") : null), done ? null : h("span", { class: "push small" }, link))),
              ),
            )
          : null,
        h(
          "div",
          { class: "grid stats mt" },
          stat("Requests today", fmt(st.today.n), st.today.err ? h("span", { class: "bad-t" }, `${fmt(st.today.err)} failed`) : "none failed"),
          stat("Tokens today", short(st.today.tok), `≈ ${money(st.today.cost)} at API prices`),
          stat("Speed", st.telemetry?.ttfb?.p50 ? ms(st.telemetry.ttfb.p50) : "–", "typical time to first token"),
          stat("Load", busy, `limit ${st.maxConcurrent} at once`),
          stat("Memory", st.memory ? `${st.memory.proxyMb + st.memory.meridianMb} MB` : "–", st.memory ? `gateway ${st.memory.proxyMb} · backend ${st.memory.meridianMb}` : ""),
        ),
        h(
          "div",
          { class: "grid two mt" },
          h(
            "div",
            { class: "card" },
            h("div", { class: "spread" }, h("h2", { style: "margin:0" }, "Claude accounts"), h("a", { class: "small", href: "#accounts" }, "Manage")),
            st.accounts.length
              ? st.accounts.map((a) =>
                  h(
                    "div",
                    { class: "mt" },
                    h("div", { class: "row" }, h("strong", {}, a.label || a.id), pill(a.enabled ? stateLabel[a.state] : "Off", a.enabled ? stateKind[a.state] : ""), a.cooldownUntil && a.state === "limited" ? h("span", { class: "muted small" }, `back ${until(a.cooldownUntil)}`) : null),
                    h("div", { class: "mt-s" }, quotaRows(a.quota)),
                  ),
                )
              : h("p", { class: "muted mt-s" }, "Reading accounts from the backend…"),
          ),
          h(
            "div",
            { class: "card" },
            h("h2", {}, "Connect an app"),
            h("p", { class: "small muted" }, "Use a project key with any Anthropic- or OpenAI-style client."),
            h("dl", { class: "kv" }, h("dt", {}, "Base URL"), h("dd", { class: "mono" }, baseUrl()), st.connection.httpUrl ? [h("dt", {}, "Plain http"), h("dd", { class: "mono" }, st.connection.httpUrl)] : null, h("dt", {}, "OpenAI-style"), h("dd", { class: "mono" }, baseUrl() + "/v1"), h("dt", {}, "Default model"), h("dd", { class: "mono" }, st.connection.defaultModel)),
            h("a", { class: "btn mt", href: "#projects" }, "Get a key"),
          ),
        ),
        usage && Object.keys(usage.byDayProject).length
          ? h(
              "div",
              { class: "card mt" },
              h("div", { class: "spread" }, h("h2", { style: "margin:0" }, "Tokens per day, last 14 days"), h("a", { class: "small", href: "#usage" }, "Usage")),
              (() => {
                const keys = [...new Set(Object.values(usage.byDayProject).flatMap(Object.keys))];
                const days = Object.keys(usage.byDayProject).sort();
                return barChart({ groups: days.map((d) => ({ label: d.slice(5), parts: usage.byDayProject[d] })), keys, title: "Tokens per day by project" });
              })(),
            )
          : null,
        h(
          "div",
          { class: "card mt" },
          h("div", { class: "spread" }, h("h2", { style: "margin:0" }, "Latest failed requests"), h("a", { class: "small", href: "#requests" }, "All requests")),
          h(
            "div",
            { class: "mt-s" },
            table(
              [
                { label: "When", value: (r) => ago(r.ts) },
                { label: "Project", value: (r) => r.project ?? "–" },
                { label: "Status", value: (r) => r.status },
                { label: "Error", value: (r) => r.error ?? "", cls: () => "err" },
              ],
              recent,
              { empty: h("p", { class: "muted" }, "No failed requests. 🎉"), onRow: showRequest },
            ),
          ),
        ),
      );
    };
    main.replaceChildren(
      pageHead("Overview", S.status ? `Up ${Math.round(S.status.uptimeSec / 3600)} h · time zone ${S.status.timeZone}` : ""),
      body,
    );
    await draw();
    return draw;
  },
};
function stat(label, value, hint) {
  return h("div", { class: "card stat" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), hint ? h("div", { class: "hint" }, hint) : null);
}

/* =========================================================================
   Projects
   ========================================================================= */
PAGES.projects = {
  every: 0,
  async render(main, [id, tab]) {
    if (id) return renderProject(main, Number(id), tab ?? "limits");
    const list = await projectsList();
    const create = async (btn) => {
      const v = await formDlg({ title: "New project", intro: "One project per app, so each has its own key, limits and usage.", fields: [{ name: "name", label: "Name", required: true, placeholder: "e.g. crm-staging" }, { name: "note", label: "Note (optional)" }], ok: "Create" });
      if (!v) return;
      const r = await act(btn, () => api("/admin/api/projects", { method: "POST", body: v }));
      if (r?.key) {
        showKey(v.name, r.key);
        location.hash = `#projects/${r.id}`;
      }
    };
    const newBtn = h("button", { class: "btn primary", type: "button", onclick: (e) => create(e.currentTarget) }, icon("plus"), "New project");
    const filter = h("input", { type: "search", placeholder: "Filter projects", "aria-label": "Filter projects", style: "max-width:260px" });
    const grid = h("div", { class: "grid mt" });
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      const rows = list.filter((p) => !q || p.name.toLowerCase().includes(q) || p.note.toLowerCase().includes(q));
      grid.replaceChildren(
        ...rows.map((p) => {
          const expired = p.expiresAt && new Date(p.expiresAt) < new Date();
          const u = p.usage ?? {};
          const caps = [
            ["Requests today", u.dayN, p.dailyRequestCap],
            ["Tokens today", u.tokToday, p.dailyTokenCap],
            ["Tokens this month", u.tokMonth, p.monthlyTokenCap],
          ].filter((c) => c[2]);
          return h(
            "a",
            { class: "card", href: `#projects/${p.id}`, style: "text-decoration:none;color:inherit;display:block" },
            h("div", { class: "row" }, h("strong", { class: "wrap-any" }, p.name), h("span", { class: "push" }, pill(!p.enabled ? "Off" : expired ? "Expired" : "On", p.enabled && !expired ? "ok" : "bad"))),
            h("div", { class: "muted small mt-s" }, `${p.keyPrefix}… · used ${ago(p.lastUsedAt)}`),
            h("div", { class: "row mt-s small" }, h("span", {}, h("strong", {}, fmt(u.today ?? 0)), " today"), h("span", {}, h("strong", {}, short(u.tok30 ?? 0)), " tokens / 30 d"), u.err30 ? h("span", { class: "bad-t" }, `${fmt(u.err30)} failed`) : null),
            caps.map(([label, used, cap]) => h("div", { class: "meter-row mt-s" }, h("span", { class: "muted" }, label.split(" ")[0]), meter(((used ?? 0) / cap) * 100), h("span", { class: "small" }, `${short(used ?? 0)}/${short(cap)}`))),
            p.note ? h("p", { class: "muted small mt-s" }, p.note) : null,
          );
        }),
      );
      if (!rows.length) grid.replaceChildren(q ? h("p", { class: "muted" }, "No project matches.") : empty("No projects yet", "Create one for each app that will call Claude through the gateway.", null));
    };
    filter.addEventListener("input", draw);
    main.replaceChildren(pageHead("Projects", "Each app gets its own key, limits, accounts and usage.", newBtn), list.length > 6 ? filter : null, grid);
    draw();
  },
};

async function renderProject(main, id, tab) {
  const [list, accts, models] = await Promise.all([projectsList(), api("/admin/api/accounts"), modelList()]);
  const p = list.find((x) => x.id === id);
  if (!p) {
    main.replaceChildren(empty("Project not found", "It may have been deleted.", h("a", { class: "btn", href: "#projects" }, "All projects")));
    return;
  }
  const expired = p.expiresAt && new Date(p.expiresAt) < new Date();
  const patch = (body, btn, msg = "Saved") => act(btn, () => api(`/admin/api/projects/${id}`, { method: "PATCH", body }), msg);
  const reload = () => route();
  const toggle = async (btn) => {
    if (p.enabled && !(await confirmDlg({ title: `Turn off ${p.name}?`, body: "Apps using this key get 403 errors until you turn it back on.", ok: "Turn off", danger: true }))) return;
    if (await patch({ enabled: !p.enabled }, btn, p.enabled ? "Turned off" : "Turned on")) {
      if (p.enabled) toast(`${p.name} turned off`, { action: { label: "Undo", fn: () => patch({ enabled: true }).then(reload) } });
      reload();
    }
  };
  const rotate = async (btn) => {
    if (!(await confirmDlg({ title: "Make a new key?", body: `The current key for ${p.name} stops working at once. Apps must switch to the new key.`, ok: "Make new key", danger: true }))) return;
    const r = await act(btn, () => api(`/admin/api/projects/${id}/rotate`, { method: "POST" }));
    if (r?.key) showKey(p.name, r.key);
  };
  const remove = async (btn) => {
    if (!(await confirmDlg({ title: `Delete ${p.name}?`, body: "The key stops working and the project is removed. Its past requests stay in the history without a name.", ok: "Delete", danger: true }))) return;
    if (await act(btn, () => api(`/admin/api/projects/${id}`, { method: "DELETE" }), "Deleted")) location.hash = "#projects";
  };
  const rename = async (btn) => {
    const v = await formDlg({ title: "Rename project", fields: [{ name: "name", label: "Name", value: p.name, required: true }, { name: "note", label: "Note", value: p.note }] });
    if (v && (await patch(v, btn, "Renamed"))) reload();
  };

  const TABS = [
    ["limits", "Limits"],
    ["accounts", "Accounts"],
    ["web", "Web access"],
    ["connect", "Connect"],
    ["activity", "Usage and requests"],
  ];
  const content = h("div");
  const tabs = h(
    "div",
    { class: "tabs", role: "tablist" },
    TABS.map(([k, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(k === tab), onclick: () => (location.hash = `#projects/${id}/${k}`) }, label)),
  );
  main.replaceChildren(
    h("p", { class: "small" }, h("a", { href: "#projects" }, "← Projects")),
    pageHead(
      p.name,
      h("span", {}, pill(!p.enabled ? "Off" : expired ? "Expired" : "On", p.enabled && !expired ? "ok" : "bad"), ` key ${p.keyPrefix}… · created ${when(p.createdAt)} · used ${ago(p.lastUsedAt)}`),
      h("button", { class: "btn", type: "button", onclick: (e) => rename(e.currentTarget) }, "Rename"),
      h("button", { class: "btn", type: "button", onclick: (e) => toggle(e.currentTarget) }, p.enabled ? "Turn off" : "Turn on"),
      h("button", { class: "btn", type: "button", onclick: (e) => rotate(e.currentTarget) }, "New key"),
      h("button", { class: "btn danger", type: "button", onclick: (e) => remove(e.currentTarget) }, "Delete"),
    ),
    tabs,
    content,
  );

  if (tab === "limits") {
    const inputs = {};
    const num = (k, label, help, extra = {}) => field(label, (inputs[k] = h("input", { type: "number", min: 0, value: p[k] ?? "", placeholder: "no limit", inputmode: "numeric", ...extra })), help);
    const u = p.usage ?? {};
    const modelNames = models.map((m) => m.id);
    inputs.expiresAt = h("input", { type: "date", value: p.expiresAt ? new Date(p.expiresAt).toLocaleDateString("en-CA") : "" });
    inputs.allowedModels = h("input", { type: "text", value: p.allowedModels, placeholder: "all models", list: "model-names" });
    const save = h("button", { class: "btn primary", type: "submit" }, "Save limits");
    content.append(
      h(
        "form",
        {
          class: "card",
          onsubmit: async (e) => {
            e.preventDefault();
            const body = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
            if (await patch(body, save, "Limits saved")) reload();
          },
        },
        h("h2", {}, "Limits"),
        h("p", { class: "muted small" }, `Today so far: ${fmt(u.dayN ?? 0)} requests, ${short(u.tokToday ?? 0)} tokens. This month: ${short(u.tokMonth ?? 0)} tokens. Days follow the gateway's time zone (${S.status?.timeZone ?? "–"}).`),
        h(
          "div",
          { class: "form mt" },
          num("rpmCap", "Requests per minute", "Leave empty for no limit."),
          num("dailyRequestCap", "Requests per day"),
          num("dailyTokenCap", "Tokens per day"),
          num("monthlyTokenCap", "Tokens per month"),
          num("maxTokensCap", "Max output tokens per reply", "Longer replies are cut at this length."),
          num("quotaCapPct", "Pause above 5-hour use (%)", "Stops this project when an account's 5-hour use reaches this, so other apps keep headroom.", { max: 100 }),
          field("Key expires on", inputs.expiresAt, "The key stops working at the end of this day."),
          field("Allowed models", inputs.allowedModels, "Comma-separated model ids or aliases. Empty = all."),
        ),
        h("datalist", { id: "model-names" }, modelNames.map((m) => h("option", { value: m }))),
        h("div", { class: "row mt" }, save),
      ),
    );
  }

  if (tab === "accounts") {
    const all = accts.accounts;
    let chosen = p.accounts ? p.accounts.split(",").filter(Boolean) : [];
    const listEl = h("div", { class: "mt" });
    const save = h("button", { class: "btn primary", type: "button" }, "Save accounts");
    const draw = () => {
      const pickable = all.filter((a) => !chosen.includes(a.id));
      listEl.replaceChildren(
        chosen.length
          ? h(
              "ol",
              { class: "steps" },
              chosen.map((aid, i) => {
                const a = all.find((x) => x.id === aid);
                return h(
                  "li",
                  { class: "row" },
                  h("span", { class: "tick" }, i + 1),
                  h("strong", {}, a?.label || aid),
                  a ? pill(a.enabled ? stateLabel[a.state] : "Off", a.enabled ? stateKind[a.state] : "") : pill("Missing", "bad"),
                  h(
                    "span",
                    { class: "push row" },
                    h("button", { class: "btn ghost icon-btn", type: "button", "aria-label": `Move ${aid} up`, disabled: i === 0, onclick: () => ((chosen = swap(chosen, i, i - 1)), draw()) }, icon("up")),
                    h("button", { class: "btn ghost icon-btn", type: "button", "aria-label": `Move ${aid} down`, disabled: i === chosen.length - 1, onclick: () => ((chosen = swap(chosen, i, i + 1)), draw()) }, icon("down")),
                    h("button", { class: "btn ghost icon-btn", type: "button", "aria-label": `Remove ${aid}`, onclick: () => ((chosen = chosen.filter((x) => x !== aid)), draw()) }, icon("x")),
                  ),
                );
              }),
            )
          : h("p", { class: "muted" }, "All accounts, in the order set on the Accounts page."),
        pickable.length
          ? h(
              "div",
              { class: "row mt" },
              h("span", { class: "muted small" }, "Add:"),
              pickable.map((a) => h("button", { class: "btn sm", type: "button", onclick: () => ((chosen = [...chosen, a.id]), draw()) }, icon("plus"), a.label || a.id)),
            )
          : null,
      );
    };
    save.addEventListener("click", async () => (await patch({ accounts: chosen.join(",") }, save, "Accounts saved")) && reload());
    draw();
    content.append(
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Which Claude accounts this project may use"),
        h("p", { class: "muted small" }, "The gateway tries them in this order. When one is rate limited or signed out, it moves to the next. Leave the list empty to use every account."),
        listEl,
        h("div", { class: "row mt" }, save, chosen.length ? h("button", { class: "btn ghost", type: "button", onclick: () => ((chosen = []), draw()) }, "Use all accounts") : null),
      ),
    );
  }

  if (tab === "web") {
    const input = h("textarea", { rows: 3, placeholder: "http://localhost:5173, https://app.example.com" });
    input.value = p.allowedOrigins;
    const save = h("button", { class: "btn primary", type: "button" }, "Save");
    save.addEventListener("click", async () => (await patch({ allowedOrigins: input.value }, save, "Saved")) && reload());
    content.append(
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Calls from web pages (browser)"),
        h("p", { class: "muted small" }, "Browsers block calls to another address unless it allows the page's origin. List the exact origins (scheme, host and port) that may call with this key. Use * for any origin, only for local experiments."),
        field("Allowed web origins", input, "Separate with commas or new lines. Empty = no browser access."),
        h("div", { class: "banner warning mt" }, h("div", { class: "body small" }, h("strong", {}, "Anyone who opens the page can read the key. "), "Keep tight limits on this project. For a public site, call the gateway from your site's server instead.")),
        h("div", { class: "row mt" }, save),
      ),
    );
  }

  if (tab === "connect") {
    const b = baseUrl();
    const KEY = "YOUR_PROJECT_KEY";
    const model = S.status?.connection?.defaultModel ?? "claude-haiku-5-5";
    const snippets = {
      curl: `curl ${b}/v1/messages \\\n  -H "x-api-key: ${KEY}" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"${model}","max_tokens":300,"messages":[{"role":"user","content":"Hello"}]}'`,
      ".env": `# Anthropic SDKs\nANTHROPIC_BASE_URL=${b}\nANTHROPIC_API_KEY=${KEY}\n\n# OpenAI-style clients\nOPENAI_BASE_URL=${b}/v1\nOPENAI_API_KEY=${KEY}`,
      PHP: `$ch = curl_init('${b}/v1/messages');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true, CURLOPT_TIMEOUT => 120,\n  CURLOPT_HTTPHEADER => ['content-type: application/json', 'x-api-key: ' . getenv('CLAUDE_GATEWAY_KEY'), 'anthropic-version: 2023-06-01'],\n  CURLOPT_POSTFIELDS => json_encode(['model' => '${model}', 'max_tokens' => 300,\n    'messages' => [['role' => 'user', 'content' => 'Hello']]]),\n]);\n$data = json_decode(curl_exec($ch), true);\necho end($data['content'])['text'];`,
      Node: `import Anthropic from "@anthropic-ai/sdk";\nconst client = new Anthropic({ baseURL: "${b}", apiKey: process.env.CLAUDE_GATEWAY_KEY });\nconst msg = await client.messages.create({ model: "${model}", max_tokens: 300,\n  messages: [{ role: "user", content: "Hello" }] });\nconsole.log(msg.content.at(-1).text);`,
      Python: `import anthropic, os\nclient = anthropic.Anthropic(base_url="${b}", api_key=os.environ["CLAUDE_GATEWAY_KEY"])\nmsg = client.messages.create(model="${model}", max_tokens=300,\n    messages=[{"role": "user", "content": "Hello"}])\nprint(msg.content[-1].text)`,
      "OpenAI-style": `from openai import OpenAI\nclient = OpenAI(base_url="${b}/v1", api_key=os.environ["CLAUDE_GATEWAY_KEY"])\nr = client.chat.completions.create(model="${model}",\n    messages=[{"role": "user", "content": "Hello"}])\nprint(r.choices[0].message.content)`,
    };
    let which = store.get("snippet", "curl");
    const box = h("div", { class: "mt-s" });
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Language" });
    const draw = () => {
      seg.replaceChildren(...Object.keys(snippets).map((k) => h("button", { type: "button", "aria-pressed": String(k === which), onclick: () => ((which = k), store.set("snippet", k), draw()) }, k)));
      box.replaceChildren(copyBlock(snippets[which] ?? snippets.curl));
    };
    draw();
    const testKey = h("input", { type: "password", placeholder: "Paste this project's key to test it", autocomplete: "off" });
    const testOut = h("div", { class: "small mt-s", role: "status" });
    const testBtn = h(
      "button",
      {
        class: "btn",
        type: "button",
        onclick: async () => {
          testBtn.setAttribute("aria-busy", "true");
          testOut.textContent = "Sending…";
          const t0 = performance.now();
          try {
            const r = await fetch("/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": testKey.value.trim(), "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: "user", content: "Reply with: ok" }] }) });
            const o = await r.json();
            testOut.replaceChildren(r.ok ? h("span", { class: "ok-t" }, `✓ Works (${ms(performance.now() - t0)}): "${o.content?.at(-1)?.text ?? ""}"`) : h("span", { class: "bad-t" }, `✗ ${r.status}: ${o.error?.message ?? "error"}`));
          } catch (e) {
            testOut.replaceChildren(h("span", { class: "bad-t" }, e.message));
          } finally {
            testBtn.removeAttribute("aria-busy");
          }
        },
      },
      "Test key",
    );
    content.append(
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Connection details"),
        h("dl", { class: "kv" }, h("dt", {}, "Base URL"), h("dd", { class: "mono" }, b), h("dt", {}, "OpenAI-style base"), h("dd", { class: "mono" }, b + "/v1"), h("dt", {}, "Key"), h("dd", {}, `Starts with ${p.keyPrefix}… (shown once when made; use New key to get another)`)),
        h("div", { class: "mt" }, seg, box),
        h("p", { class: "muted small mt-s" }, "Allow 60–120 s timeouts: each request runs through the Claude CLI on the gateway computer."),
      ),
      h("div", { class: "card" }, h("h2", {}, "Test the key"), h("div", { class: "row" }, h("div", { style: "flex:1;min-width:200px" }, testKey), testBtn), testOut),
    );
  }

  if (tab === "activity") {
    const usage = await api(`/admin/api/requests?project=${id}&limit=50`);
    content.append(h("div", { class: "row" }, h("a", { class: "btn", href: `#requests?project=${id}` }, "Open in Requests")), h("div", { class: "mt" }, requestsTable(usage)));
  }
}
const swap = (arr, i, j) => {
  const a = [...arr];
  [a[i], a[j]] = [a[j], a[i]];
  return a;
};

/* =========================================================================
   Accounts
   ========================================================================= */
PAGES.accounts = {
  every: 15,
  async render(main) {
    const body = h("div");
    const addBtn = h(
      "button",
      {
        class: "btn primary",
        type: "button",
        onclick: () =>
          dialog({
            title: "Add a Claude account",
            body: h(
              "div",
              {},
              h("p", {}, "Signing in needs a browser on the gateway computer, so accounts are added from its terminal. In the gateway folder, run:"),
              copyBlock("node proxy/cli.mjs account add work"),
              h("p", { class: "mt" }, "Replace ", h("code", {}, "work"), " with a short name. A browser opens; sign in with the Claude account to add. It appears here within a minute."),
              h("p", { class: "mt" }, "No browser on that computer? Make a token on any computer with ", h("code", {}, "claude setup-token"), ", then:"),
              copyBlock("node proxy/cli.mjs account add work --token"),
              h("div", { class: "banner warning mt" }, h("div", { class: "body small" }, h("strong", {}, "When you add the first named account, "), "the gateway stops using this computer's own sign-in. Add your main account too: ", h("code", {}, "node proxy/cli.mjs account add main"))),
              h("p", { class: "muted small mt" }, "Only add accounts that are yours. Using several accounts to get around usage limits may break Anthropic's terms."),
            ),
            actions: (close) => [h("button", { class: "btn primary", type: "button", onclick: close }, "Done")],
          }),
      },
      icon("plus"),
      "Add account",
    );
    const refreshBtn = h("button", { class: "btn", type: "button", onclick: async () => (await act(refreshBtn, () => api("/admin/api/accounts/refresh", { method: "POST" }), "Refreshed")) && draw() }, icon("refresh"), "Refresh");
    main.replaceChildren(pageHead("Claude accounts", "Requests go to the first ready account; when one hits its limit or signs out, the next one takes over.", refreshBtn, addBtn), body);

    const draw = async () => {
      const { accounts } = await api("/admin/api/accounts");
      const patch = (aid, b, btn, msg = "Saved") => act(btn, () => api(`/admin/api/accounts/${encodeURIComponent(aid)}`, { method: "PATCH", body: b }), msg);
      const move = async (i, j) => {
        const ids = swap(
          accounts.map((a) => a.id),
          i,
          j,
        );
        if (await act(null, () => api("/admin/api/accounts/order", { method: "POST", body: { ids } }), "Order saved")) draw();
      };
      if (!accounts.length) {
        body.replaceChildren(h("div", { class: "card" }, empty("Reading accounts…", "The gateway reads them from the backend once a minute.", null)));
        return;
      }
      body.replaceChildren(
        ...accounts.map((a, i) => {
          const t = a.today ?? {};
          return h(
            "div",
            { class: "card" },
            h(
              "div",
              { class: "row" },
              h("span", { class: "pill" }, `#${i + 1}`),
              h("strong", { class: "wrap-any" }, a.label || a.id),
              a.label && a.label !== a.id ? h("span", { class: "muted small mono" }, a.id) : null,
              pill(a.enabled ? stateLabel[a.state] : "Off", a.enabled ? stateKind[a.state] : ""),
              a.plan ? pill(a.plan, "info") : null,
              h(
                "span",
                { class: "push row" },
                h("button", { class: "btn ghost icon-btn", type: "button", "aria-label": "Move up", disabled: i === 0, onclick: () => move(i, i - 1) }, icon("up")),
                h("button", { class: "btn ghost icon-btn", type: "button", "aria-label": "Move down", disabled: i === accounts.length - 1, onclick: () => move(i, i + 1) }, icon("down")),
                sw(
                  a.enabled,
                  async (on, el) => {
                    if (!on && !(await confirmDlg({ title: `Turn off ${a.label || a.id}?`, body: "No requests go to this account until you turn it back on.", ok: "Turn off", danger: true }))) return (el.checked = true);
                    if (await patch(a.id, { enabled: on }, null, on ? "Turned on" : "Turned off")) draw();
                  },
                  "Use this account",
                ),
              ),
            ),
            a.state === "limited" ? h("div", { class: "banner warning mt-s" }, h("div", { class: "body small" }, h("strong", {}, `Paused until ${a.cooldownUntil ? new Date(a.cooldownUntil).toLocaleTimeString() : "its limit resets"}`), a.cooldownUntil ? ` (${until(a.cooldownUntil)})` : "", ". ", a.lastError ?? "")) : null,
            a.state === "signed_out" ? h("div", { class: "banner critical mt-s" }, h("div", { class: "body small" }, h("strong", {}, "Signed out. "), "Sign in again on the gateway computer: ", h("code", {}, a.id === "default" ? "claude login" : `node proxy/cli.mjs account login ${a.id}`))) : null,
            !a.enabled && a.lastError ? h("p", { class: "muted small mt-s" }, a.lastError) : null,
            h(
              "div",
              { class: "grid two mt" },
              h("div", {}, h("h3", {}, "Subscription use"), quotaRows(a.quota), a.daysUntilRenewal != null ? h("p", { class: "small mt-s " + (a.daysUntilRenewal <= 7 ? "warn-t" : "muted") }, `Sign-in renews in ${a.daysUntilRenewal} days`) : null),
              h("div", {}, h("h3", {}, "Today through the gateway"), h("p", { class: "small" }, `${fmt(t.n ?? 0)} requests · ${short(t.tok ?? 0)} tokens · ${money(t.cost ?? 0)}`, t.err ? h("span", { class: "bad-t" }, ` · ${t.err} failed`) : null), h("p", { class: "muted small" }, `Last used ${ago(a.lastUsedAt)}`), a.email ? h("p", { class: "muted small" }, a.email) : null),
            ),
            h(
              "div",
              { class: "row mt" },
              h(
                "button",
                {
                  class: "btn sm",
                  type: "button",
                  onclick: async (e) => {
                    const r = await act(e.currentTarget, () => api(`/admin/api/accounts/${encodeURIComponent(a.id)}/test`, { method: "POST" }));
                    if (r) r.ok ? toast(`✓ ${a.label || a.id} answered in ${ms(r.ms)}`) : toast(`${a.label || a.id}: ${r.error}`, { error: true });
                  },
                },
                "Test",
              ),
              a.state === "limited" || a.state === "signed_out"
                ? h("button", { class: "btn sm", type: "button", onclick: async (e) => (await act(e.currentTarget, () => api(`/admin/api/accounts/${encodeURIComponent(a.id)}/resume`, { method: "POST" }), "Resumed")) && draw() }, "Use again now")
                : null,
              h(
                "button",
                {
                  class: "btn sm",
                  type: "button",
                  onclick: async (e) => {
                    const v = await formDlg({
                      title: `Settings for ${a.label || a.id}`,
                      fields: [
                        { name: "label", label: "Display name", value: a.label ?? "" },
                        { name: "reservePct", label: "Stop using above 5-hour use (%)", type: "number", value: a.reservePct ?? "", help: "Keeps the rest for your own Claude use. Empty = use it fully." },
                        { name: "weeklyReservePct", label: "Stop using above 7-day use (%)", type: "number", value: a.weeklyReservePct ?? "" },
                      ],
                    });
                    if (v && (await patch(a.id, v, e.currentTarget))) draw();
                  },
                },
                "Settings",
              ),
              a.reservePct || a.weeklyReservePct ? h("span", { class: "muted small" }, `Reserve: ${a.reservePct ? `5-hour ${a.reservePct}%` : ""}${a.reservePct && a.weeklyReservePct ? ", " : ""}${a.weeklyReservePct ? `7-day ${a.weeklyReservePct}%` : ""}`) : null,
            ),
          );
        }),
        h("p", { class: "muted small mt" }, "Order matters: requests go to the first ready account. A project can choose its own accounts and order on its Accounts tab."),
      );
    };
    await draw();
    return draw;
  },
};

/* =========================================================================
   Models
   ========================================================================= */
PAGES.models = {
  every: 0,
  async render(main) {
    const models = await api("/admin/api/models");
    const refresh = h("button", { class: "btn", type: "button", onclick: route }, icon("refresh"), "Reload list");
    if (!models.length) {
      main.replaceChildren(pageHead("Models", "", refresh), h("div", { class: "card" }, empty("No models listed", "The backend didn't return a model list. Check that it's running and signed in.", null)));
      return;
    }
    const rows = models.map((m) => {
      const inputs = {
        maxTokensCap: h("input", { type: "number", min: 0, value: m.maxTokensCap ?? "", placeholder: "default", "aria-label": `Max output for ${m.id}`, style: "width:100px" }),
        aliases: h("input", { type: "text", value: m.aliases, placeholder: "e.g. haiku", "aria-label": `Aliases for ${m.id}`, style: "width:130px" }),
        priceIn: h("input", { type: "number", min: 0, step: "0.01", value: m.priceIn ?? "", placeholder: m.defaultPrice?.in ?? "", "aria-label": `Input price for ${m.id}`, style: "width:80px" }),
        priceOut: h("input", { type: "number", min: 0, step: "0.01", value: m.priceOut ?? "", placeholder: m.defaultPrice?.out ?? "", "aria-label": `Output price for ${m.id}`, style: "width:80px" }),
      };
      const save = h(
        "button",
        {
          class: "btn sm",
          type: "button",
          onclick: async () => {
            const body = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
            await act(save, () => api(`/admin/api/models/${encodeURIComponent(m.id)}`, { method: "PATCH", body }), "Saved");
          },
        },
        "Save",
      );
      return { m, inputs, save };
    });
    const u = (m) => m.usage ?? {};
    main.replaceChildren(
      pageHead("Models", "Turn models on or off, add short aliases, and set prices used for cost estimates.", refresh),
      table(
        [
          { label: "On", value: ({ m }) => sw(m.enabled, async (on, el) => {
              if (!on && !(await confirmDlg({ title: `Turn off ${m.id}?`, body: "Requests for this model get a 403 error.", ok: "Turn off", danger: true }))) return (el.checked = true);
              if (!(await act(null, () => api(`/admin/api/models/${encodeURIComponent(m.id)}`, { method: "PATCH", body: { enabled: on } }), on ? "Turned on" : "Turned off"))) el.checked = !on;
            }, `Use ${m.id}`) },
          { label: "Model", value: ({ m }) => h("div", {}, h("div", { class: "mono" }, m.id), h("div", { class: "muted small" }, m.name !== m.id ? m.name : "", m.contextWindow ? ` · ${short(m.contextWindow)} context` : "")) },
          { label: "Default", value: ({ m }) => (m.isDefault ? pill("Default", "ok") : h("button", { class: "btn ghost sm", type: "button", onclick: async (e) => (await confirmDlg({ title: `Make ${m.id} the default?`, body: "Requests that name no model, or an unknown alias, use the default.", ok: "Make default" })) && (await act(e.currentTarget, () => api(`/admin/api/models/${encodeURIComponent(m.id)}`, { method: "PATCH", body: { makeDefault: true } }), "Default changed")) && route() }, "Make default")) },
          { label: "Max output", value: ({ inputs }) => inputs.maxTokensCap },
          { label: "Aliases", value: ({ inputs }) => inputs.aliases },
          { label: "$ in / M", value: ({ inputs }) => inputs.priceIn },
          { label: "$ out / M", value: ({ inputs }) => inputs.priceOut },
          { label: "30 days", num: true, value: ({ m }) => h("span", { class: "small" }, `${fmt(u(m).n ?? 0)} req`, u(m).err ? h("span", { class: "bad-t" }, ` · ${u(m).err} failed`) : null) },
          { label: "", value: ({ save }) => save },
        ],
        rows,
      ),
      h("p", { class: "muted small mt" }, "Prices are estimates of what the same use would cost on the paid API (USD per million tokens). Empty uses the family price from Settings."),
    );
  },
};

/* =========================================================================
   Usage
   ========================================================================= */
PAGES.usage = {
  every: 30,
  async render(main) {
    let days = store.get("usageDays", 7);
    const body = h("div");
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Period" });
    const csv = h("a", { class: "btn", href: "/admin/api/requests.csv?days=30", download: true }, icon("download"), "CSV");
    main.replaceChildren(pageHead("Usage", "", seg, csv), body);
    const draw = async () => {
      seg.replaceChildren(...[[1, "Today"], [7, "7 days"], [30, "30 days"], [90, "90 days"]].map(([d, l]) => h("button", { type: "button", "aria-pressed": String(d === days), onclick: () => ((days = d), store.set("usageDays", d), draw()) }, l)));
      csv.setAttribute("href", `/admin/api/requests.csv?days=${days}`);
      const u = await api(`/admin/api/usage?days=${days}`);
      const t = u.total;
      if (!t) {
        body.replaceChildren(h("div", { class: "card" }, empty("No requests in this period", "Requests made with a project key show up here.", h("a", { class: "btn", href: "#projects" }, "Get a key"))));
        return;
      }
      const keys = [...new Set(Object.values(u.byDayProject).flatMap(Object.keys))];
      const dayKeys = Object.keys(u.byDayProject).sort();
      const chart = barChart({ groups: dayKeys.map((d) => ({ label: d.slice(5), parts: u.byDayProject[d] })), keys, title: "Tokens per day by project" });
      const dt = dataToggle(chart, () => table([{ label: "Day", value: (r) => r.key }, { label: "Requests", num: true, value: (r) => fmt(r.n) }, { label: "Failed", num: true, value: (r) => fmt(r.err) }, { label: "Tokens", num: true, value: (r) => fmt(r.in_tok + r.out_tok + r.cache) }, { label: "Cost", num: true, value: (r) => money(r.cost) }], u.byDay));
      const groupTable = (title, rows, label) =>
        h(
          "div",
          { class: "card" },
          h("h2", {}, title),
          table(
            [
              { label, value: (r) => r.key },
              { label: "Requests", num: true, value: (r) => fmt(r.n) },
              { label: "Failed", num: true, value: (r) => (r.err ? h("span", { class: "bad-t" }, fmt(r.err)) : "0") },
              { label: "Input", num: true, value: (r) => short(r.in_tok) },
              { label: "Output", num: true, value: (r) => short(r.out_tok) },
              { label: "Cache", num: true, value: (r) => short(r.cache) },
              { label: "Typical time", num: true, value: (r) => ms(r.p50) },
              { label: "Cost", num: true, value: (r) => money(r.cost) },
            ],
            rows,
          ),
        );
      body.replaceChildren(
        u.capped ? h("div", { class: "banner warning" }, h("div", { class: "body small" }, "Over 100,000 requests in this period: figures cover the latest 100,000.")) : null,
        h("div", { class: "grid stats" }, stat("Requests", fmt(t.n), t.err ? h("span", { class: "bad-t" }, `${fmt(t.err)} failed (${Math.round((t.err / t.n) * 100)}%)`) : "none failed"), stat("Input tokens", short(t.in_tok), `+ ${short(t.cache)} from cache`), stat("Output tokens", short(t.out_tok)), stat("API-equivalent cost", money(t.cost), "what the paid API would charge"), stat("Typical time", ms(t.p50), `95% under ${ms(t.p95)}`)),
        h("div", { class: "card mt" }, h("div", { class: "spread" }, h("h2", { style: "margin:0" }, "Tokens per day"), dt.btn), dt.wrap),
        h("div", { class: "grid two mt" }, groupTable("By project", u.byProject, "Project"), groupTable("By account", u.byAccount, "Account")),
        h("div", { class: "grid two mt" }, groupTable("By model", u.byModel, "Model"), groupTable("By address (top 20)", u.byIp, "Address")),
      );
    };
    await draw();
    return draw;
  },
};

/* =========================================================================
   Requests
   ========================================================================= */
function requestsTable(rows, opts = {}) {
  return table(
    [
      { label: "When", value: (r) => h("span", { title: when(r.ts) }, time(r.ts)) },
      { label: "Project", value: (r) => r.project ?? h("span", { class: "muted" }, "–") },
      { label: "Account", value: (r) => r.account ?? h("span", { class: "muted" }, "–") },
      { label: "Model", value: (r) => h("span", { class: "mono small" }, r.model ?? "–") },
      { label: "Status", value: (r) => pill(String(r.status), r.failed ? (r.status >= 500 || r.status === 200 ? "bad" : "warn") : "ok") },
      { label: "Time", num: true, value: (r) => ms(r.ms) },
      { label: "Tokens", num: true, value: (r) => short(r.in_tok + r.out_tok + r.cache_read + r.cache_write) },
      { label: "Tries", num: true, value: (r) => (r.attempts > 1 ? pill(String(r.attempts), "warn") : (r.attempts ?? "")) },
      { label: "Error", value: (r) => r.error ?? "", cls: () => "err" },
    ],
    rows,
    { onRow: showRequest, empty: opts.empty ?? h("p", { class: "muted" }, "No requests match."), caption: "Requests" },
  );
}
function showRequest(r) {
  const kv = (k, v) => (v == null || v === "" ? null : [h("dt", {}, k), h("dd", {}, v)]);
  drawer(
    `Request ${r.id}`,
    h(
      "div",
      {},
      r.error ? h("div", { class: "banner critical" }, h("div", { class: "body wrap-any" }, r.error)) : null,
      h(
        "dl",
        { class: "kv" },
        kv("When", when(r.ts)),
        kv("Project", r.project),
        kv("Account", r.account),
        kv("Status", `${r.status}${r.failed ? " (failed)" : ""}`),
        kv("Path", r.path),
        kv("Model", r.model),
        kv("Streamed", r.stream ? "yes" : "no"),
        kv("Attempts", r.attempts),
        kv("Stop reason", r.stop_reason),
        kv("Total time", ms(r.ms)),
        kv("Queue wait", ms(r.queue_ms)),
        kv("First byte", r.ttfb_ms != null ? ms(r.ttfb_ms) : null),
        kv("Input tokens", fmt(r.in_tok)),
        kv("Output tokens", fmt(r.out_tok)),
        kv("Cache read / write", `${fmt(r.cache_read)} / ${fmt(r.cache_write)}`),
        kv("Max tokens", r.max_tokens),
        kv("API-equivalent cost", money(r.cost)),
        kv("Address", r.ip),
        kv("Client", r.user_agent),
        kv("Request id", r.request_id ? h("span", { class: "mono small" }, r.request_id) : null),
      ),
      h("p", { class: "muted small mt" }, "The gateway never stores prompts or replies."),
    ),
  );
}
PAGES.requests = {
  every: 5,
  async render(main, _args, query) {
    const [projects, accts] = await Promise.all([projectsList(), api("/admin/api/accounts")]);
    const f = {
      q: h("input", { type: "search", placeholder: "Search errors, paths, models, request id, address", "aria-label": "Search", value: query?.get("q") ?? "" }),
      project: h("select", { "aria-label": "Project" }, h("option", { value: "" }, "All projects"), projects.map((p) => h("option", { value: p.id, selected: String(p.id) === query?.get("project") }, p.name))),
      account: h("select", { "aria-label": "Account" }, h("option", { value: "" }, "All accounts"), accts.accounts.map((a) => h("option", { value: a.id }, a.label || a.id))),
      errors: h("select", { "aria-label": "Status" }, h("option", { value: "" }, "All results"), h("option", { value: "1", selected: query?.get("errors") === "1" }, "Failed only")),
      from: h("input", { type: "date", "aria-label": "From" }),
      to: h("input", { type: "date", "aria-label": "To" }),
    };
    let rows = [];
    let more = true;
    let live = S.live;
    const list = h("div", { class: "mt" });
    const moreBtn = h("button", { class: "btn mt", type: "button" }, "Load older");
    const liveBtn = h("button", { class: "btn", type: "button", "aria-pressed": String(live) });
    const setLive = () => {
      liveBtn.replaceChildren(icon(live ? "pause" : "playground"), live ? "Pause live" : "Resume live");
      liveBtn.setAttribute("aria-pressed", String(live));
    };
    setLive();
    liveBtn.addEventListener("click", () => {
      live = S.live = !live;
      setLive();
    });
    const params = (extra = {}) => {
      const p = new URLSearchParams();
      if (f.q.value.trim()) p.set("q", f.q.value.trim());
      if (f.project.value) p.set("project", f.project.value);
      if (f.account.value) p.set("account", f.account.value);
      if (f.errors.value) p.set("errors", "1");
      if (f.from.value) p.set("from", new Date(f.from.value + "T00:00").toISOString());
      if (f.to.value) p.set("to", new Date(new Date(f.to.value + "T00:00").getTime() + 864e5).toISOString());
      for (const [k, v] of Object.entries(extra)) p.set(k, v);
      return p;
    };
    const draw = () => {
      list.replaceChildren(requestsTable(rows));
      moreBtn.classList.toggle("hidden", !more);
    };
    const load = async () => {
      rows = await api("/admin/api/requests?" + params({ limit: 100 }));
      more = rows.length === 100;
      draw();
    };
    moreBtn.addEventListener("click", async () => {
      const older = await act(moreBtn, () => api("/admin/api/requests?" + params({ limit: 100, before: rows.at(-1)?.id ?? 0 })));
      if (!older) return;
      rows = rows.concat(older);
      more = older.length === 100;
      draw();
    });
    const reload = debounce(() => load().catch(fail), 250);
    for (const el of Object.values(f)) el.addEventListener(el.type === "search" ? "input" : "change", reload);
    const clearErrs = h(
      "button",
      {
        class: "btn ghost",
        type: "button",
        onclick: async (e) => (await confirmDlg({ title: "Clear error messages?", body: "Failed requests stay in the list and the counts; only their error text is removed.", ok: "Clear", danger: true })) && (await act(e.currentTarget, () => api("/admin/api/errors", { method: "DELETE" }), "Cleared")) && load(),
      },
      "Clear error text",
    );
    main.replaceChildren(
      pageHead("Requests", "Every call through the gateway. Click a row for details.", liveBtn, h("a", { class: "btn", href: "/admin/api/requests.csv?days=30", download: true }, icon("download"), "CSV (30 days)"), clearErrs),
      h("div", { class: "card" }, h("div", { class: "form" }, h("div", { class: "field span" }, f.q), field("Project", f.project), field("Account", f.account), field("Result", f.errors), field("From", f.from), field("To", f.to))),
      list,
      moreBtn,
    );
    await load();
    // Live: fetch only rows newer than the top one, so "Load older" rows are kept.
    return async () => {
      if (!live) return;
      const top = rows[0]?.id ?? 0;
      const fresh = await api("/admin/api/requests?" + params({ limit: 100, after: top }));
      if (fresh.length) {
        rows = fresh.concat(rows);
        draw();
      }
    };
  },
};

/* =========================================================================
   Monitoring
   ========================================================================= */
PAGES.monitoring = {
  every: 60,
  async render(main) {
    let range = store.get("monRange", "24h");
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Range" });
    const body = h("div");
    main.replaceChildren(pageHead("Monitoring", "Recorded once a minute. Kept for the retention period in Settings.", seg), body);
    const draw = async () => {
      seg.replaceChildren(...["1h", "24h", "7d", "30d"].map((r) => h("button", { type: "button", "aria-pressed": String(r === range), onclick: () => ((range = r), store.set("monRange", r), draw()) }, r)));
      const m = await api(`/admin/api/monitoring?range=${range}`);
      if (!m.points.length) {
        body.replaceChildren(h("div", { class: "card" }, empty("No samples yet", "The first one is recorded within a minute of the gateway starting.", null)));
        return;
      }
      const lab = m.points.map((p) => {
        const d = new Date(p.ts);
        return range === "1h" || range === "24h" ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
      });
      const col = (k) => m.points.map((p) => p[k]);
      const ids = [...new Set(m.points.flatMap((p) => Object.keys(p.accounts)))];
      const upPct = Math.round((m.points.filter((p) => p.up === 1).length / m.points.length) * 1000) / 10;
      // Always 90 slots, oldest first; days without samples stay grey.
      const byDay = Object.fromEntries(m.uptime.map((d) => [d.day, d]));
      const days = Array.from({ length: 90 }, (_, i) => {
        const day = new Date(Date.now() - (89 - i) * 864e5).toLocaleDateString("en-CA");
        return byDay[day] ?? { day, pct: null };
      });
      body.replaceChildren(
        h(
          "div",
          { class: "card" },
          h("div", { class: "spread" }, h("h2", { style: "margin:0" }, "Backend uptime, last 90 days"), h("span", { class: "small" }, `${upPct}% in this range`)),
          h(
            "div",
            { class: "uptime mt-s", role: "img", "aria-label": `Daily uptime for ${days.length} days` },
            days.map((d) => h("i", { class: d.pct == null ? "" : d.pct >= 99.5 ? "ok" : d.pct >= 95 ? "warn" : "bad", title: d.pct == null ? `${d.day}: no data` : `${d.day}: ${d.pct}%` })),
          ),
          h("div", { class: "spread muted small mt-s" }, h("span", {}, days[0]?.day ?? ""), h("span", {}, "today")),
        ),
        h(
          "div",
          { class: "grid two mt" },
          h("div", { class: "card" }, h("h2", {}, "Requests and failures"), barChart({ half: true, groups: m.points.map((p, i) => ({ label: lab[i], parts: { OK: p.n - p.failed, Failed: p.failed } })), keys: ["OK", "Failed"], title: "Requests and failures" })),
          h("div", { class: "card" }, h("h2", {}, "Response time"), lineChart({ labels: lab, series: [{ label: "Typical (p50)", values: col("p50") }, { label: "Slowest 5% (p95)", values: col("p95") }], yFmt: (v) => ms(v), title: "Response time" })),
          h("div", { class: "card" }, h("h2", {}, "Account use (5-hour window)"), ids.length ? lineChart({ labels: lab, series: ids.map((id) => ({ label: id, values: m.points.map((p) => p.accounts[id]?.five ?? null) })), max: 100, yFmt: (v) => `${Math.round(v)}%`, title: "Account 5-hour use" }) : h("p", { class: "muted" }, "No data.")),
          h("div", { class: "card" }, h("h2", {}, "Account use (7-day window)"), ids.length ? lineChart({ labels: lab, series: ids.map((id) => ({ label: id, values: m.points.map((p) => p.accounts[id]?.week ?? null) })), max: 100, yFmt: (v) => `${Math.round(v)}%`, title: "Account 7-day use" }) : h("p", { class: "muted" }, "No data.")),
          h("div", { class: "card" }, h("h2", {}, "Running and waiting"), lineChart({ labels: lab, series: [{ label: "Running", values: col("active") }, { label: "Waiting", values: col("queued") }], title: "Running and waiting requests" })),
          h("div", { class: "card" }, h("h2", {}, "Memory"), lineChart({ labels: lab, series: [{ label: "Gateway", values: col("proxyMb") }, { label: "Backend", values: col("backendMb") }], yFmt: (v) => `${Math.round(v)} MB`, title: "Memory use" })),
        ),
        h("p", { class: "muted small mt" }, "For Grafana or Uptime Kuma, turn on the metrics endpoint in Settings → Backend."),
      );
    };
    await draw();
    return draw;
  },
};

/* =========================================================================
   Alerts
   ========================================================================= */
const RULE_FIELDS = {
  fiveHourPct: "5-hour use at or above (%)",
  weeklyPct: "7-day use at or above (%)",
  days: "Days before sign-in expires",
  minutes: "Minutes",
  restarts: "Restarts in 10 minutes",
  pct: "Percent",
  minRequests: "At least this many requests",
  seconds: "Seconds (slowest 5%)",
};
PAGES.alerts = {
  every: 20,
  async render(main, [tab = "open"]) {
    const TABS = [
      ["open", "Open"],
      ["history", "History"],
      ["rules", "Rules"],
      ["channels", "Where alerts go"],
    ];
    const content = h("div");
    const check = h("button", { class: "btn", type: "button", onclick: async () => (await act(check, () => api("/admin/api/monitor/run", { method: "POST" }), "Checked")) && draw() }, icon("refresh"), "Check now");
    main.replaceChildren(
      pageHead("Alerts", "The gateway checks every minute and tells you when something needs attention.", check),
      h("div", { class: "tabs", role: "tablist" }, TABS.map(([k, l]) => h("button", { type: "button", role: "tab", "aria-selected": String(k === tab), onclick: () => (location.hash = `#alerts/${k}`) }, l))),
      content,
    );
    const draw = async () => {
      const a = await api("/admin/api/alerts");
      if (tab === "open") {
        content.replaceChildren(
          a.open.length
            ? h(
                "div",
                {},
                a.open.map((x) =>
                  h(
                    "div",
                    { class: "banner " + (x.severity === "critical" ? "critical" : x.severity === "warning" ? "warning" : "info") },
                    h("div", { class: "body" }, h("strong", {}, x.title), x.subject ? h("span", { class: "muted" }, ` · ${x.subject}`) : null, h("div", { class: "small" }, x.message), h("div", { class: "muted small" }, `Since ${when(x.opened_at)} · ${x.notified_at ? "sent " + ago(x.notified_at) : "not sent to any channel"}`)),
                    h("button", { class: "btn sm", type: "button", onclick: async (e) => (await act(e.currentTarget, () => api(`/admin/api/alerts/${x.id}/dismiss`, { method: "POST" }), "Marked resolved")) && draw() }, "Resolve"),
                  ),
                ),
                h("p", { class: "muted small" }, "Alerts close by themselves when the problem goes away. Resolve one by hand if you've dealt with it; it opens again if the problem is still there at the next check."),
              )
            : h("div", { class: "card" }, empty("All clear", "No open alerts.", Object.values(a.channels).some((c) => c.enabled) ? null : h("a", { class: "btn", href: "#alerts/channels" }, "Set up where alerts go"))),
        );
      }
      if (tab === "history") {
        content.replaceChildren(
          table(
            [
              { label: "Opened", value: (x) => when(x.opened_at) },
              { label: "Alert", value: (x) => h("span", {}, pill(x.severity, x.severity), " ", x.title) },
              { label: "Subject", value: (x) => x.subject || "–" },
              { label: "Closed", value: (x) => (x.resolved_at ? when(x.resolved_at) : pill("Open", "bad")) },
              { label: "Message", value: (x) => h("span", { class: "small" }, x.message), cls: () => "wrap-any" },
            ],
            a.history,
            { empty: h("div", { class: "card" }, empty("No alerts yet", "Alerts the gateway raises are listed here.", null)) },
          ),
        );
      }
      if (tab === "rules") {
        const rules = structuredClone(a.rules);
        const repeat = h("input", { type: "number", min: 0, value: a.repeatMinutes });
        const qFrom = h("input", { type: "time", value: a.quietFrom });
        const qTo = h("input", { type: "time", value: a.quietTo });
        const save = h("button", { class: "btn primary", type: "button" }, "Save rules");
        save.addEventListener("click", () => act(save, () => api("/admin/api/alerts/settings", { method: "PATCH", body: { rules, repeatMinutes: repeat.value, quietFrom: qFrom.value, quietTo: qTo.value } }), "Rules saved"));
        content.replaceChildren(
          h(
            "div",
            { class: "card" },
            table(
              [
                { label: "On", value: ([k]) => sw(rules[k].enabled, (on) => (rules[k].enabled = on), a.ruleInfo[k]?.title ?? k) },
                { label: "Alert", value: ([k]) => h("div", {}, h("strong", {}, a.ruleInfo[k]?.title ?? k), " ", pill(a.ruleInfo[k]?.severity ?? "", a.ruleInfo[k]?.severity)) },
                {
                  label: "When",
                  value: ([k, r]) =>
                    h(
                      "div",
                      { class: "row" },
                      Object.keys(r)
                        .filter((f) => f !== "enabled")
                        .map((f) => h("label", { class: "row small" }, RULE_FIELDS[f] ?? f, h("input", { type: "number", min: 0, value: r[f], style: "width:80px", onchange: (e) => (rules[k][f] = Number(e.target.value)) }))),
                      Object.keys(r).length === 1 ? h("span", { class: "muted small" }, "When it happens") : null,
                    ),
                },
              ],
              Object.entries(rules),
            ),
          ),
          h(
            "div",
            { class: "card" },
            h("h2", {}, "Reminders and quiet hours"),
            h("div", { class: "form" }, field("Remind every (minutes)", repeat, "While an alert stays open. 0 = never."), field("Quiet from", qFrom, "Only critical alerts are sent during quiet hours."), field("Quiet until", qTo)),
            h("div", { class: "row mt" }, save),
          ),
        );
      }
      if (tab === "channels") {
        const c = a.channels;
        const sev = (v) => h("select", {}, ["info", "warning", "critical"].map((x) => h("option", { value: x, selected: x === v }, x === "info" ? "Everything" : x === "warning" ? "Warnings and critical" : "Critical only")));
        const secretInput = (st, ph) => h("input", { type: "password", autocomplete: "new-password", placeholder: st?.set ? "Saved. Type to replace." : ph });
        const forms = {
          webhook: { enabled: c.webhook.enabled, url: secretInput(c.webhook.url, "https://hooks.slack.com/services/…"), minSeverity: sev(c.webhook.minSeverity) },
          telegram: { enabled: c.telegram.enabled, token: secretInput(c.telegram.token, "123456:ABC-…"), chatId: h("input", { type: "text", value: c.telegram.chatId, placeholder: "e.g. 123456789" }), minSeverity: sev(c.telegram.minSeverity) },
          email: {
            enabled: c.email.enabled,
            host: h("input", { type: "text", value: c.email.host, placeholder: "smtp.example.com" }),
            port: h("input", { type: "number", value: c.email.port }),
            security: h("select", {}, [["starttls", "STARTTLS (587)"], ["tls", "TLS (465)"], ["none", "None (local only)"]].map(([v, l]) => h("option", { value: v, selected: v === c.email.security }, l))),
            user: h("input", { type: "text", value: c.email.user, autocomplete: "off" }),
            pass: secretInput(c.email.pass, "password"),
            from: h("input", { type: "email", value: c.email.from, placeholder: "gateway@example.com" }),
            to: h("input", { type: "text", value: c.email.to, placeholder: "you@example.com, team@example.com" }),
            minSeverity: sev(c.email.minSeverity),
          },
        };
        const collect = (name) => Object.fromEntries(Object.entries(forms[name]).map(([k, v]) => [k, v instanceof Node ? v.value : v]));
        const card = (name, title, intro, fieldsEl) => {
          const save = h("button", { class: "btn primary", type: "button" }, "Save");
          const test = h("button", { class: "btn", type: "button" }, "Send test");
          save.addEventListener("click", async () => (await act(save, () => api("/admin/api/alerts/settings", { method: "PATCH", body: { channels: { [name]: collect(name) } } }), "Saved")) && draw());
          test.addEventListener("click", async () => {
            const r = await act(test, async () => {
              await api("/admin/api/alerts/settings", { method: "PATCH", body: { channels: { [name]: collect(name) } } });
              return api(`/admin/api/alerts/test/${name}`, { method: "POST" });
            });
            if (r) r.ok ? toast(`Test sent to ${title}`) : toast(`${title}: ${r.error}`, { error: true });
          });
          return h(
            "div",
            { class: "card" },
            h("div", { class: "spread" }, h("h2", { style: "margin:0" }, title), sw(forms[name].enabled, (on) => (forms[name].enabled = on), `Send alerts by ${title}`)),
            h("p", { class: "muted small mt-s" }, intro),
            h("div", { class: "form mt" }, fieldsEl),
            h("div", { class: "row mt" }, save, test),
          );
        };
        const F = forms;
        content.replaceChildren(
          card("webhook", "Webhook", "Posts JSON with a text field. Works with Slack, Discord, Microsoft Teams and Google Chat incoming webhooks, or your own endpoint.", [h("div", { class: "field span" }, field("URL (https)", F.webhook.url)), field("Send", F.webhook.minSeverity)]),
          card("telegram", "Telegram", "Create a bot with @BotFather, send it a message, then find your chat id (for example with @userinfobot).", [field("Bot token", F.telegram.token), field("Chat id", F.telegram.chatId), field("Send", F.telegram.minSeverity)]),
          card("email", "Email", "Uses your mail server (SMTP). For Gmail, use an app password.", [field("Server", F.email.host), field("Port", F.email.port), field("Security", F.email.security), field("User name", F.email.user), field("Password", F.email.pass), field("From", F.email.from), h("div", { class: "field span" }, field("To", F.email.to, "Separate several with commas.")), field("Send", F.email.minSeverity)]),
          h("p", { class: "muted small" }, "At most 30 messages an hour per channel. The dashboard always shows every alert."),
        );
      }
    };
    await draw();
    return tab === "open" || tab === "history" ? draw : null;
  },
};

/* =========================================================================
   Activity
   ========================================================================= */
const EVENT_LABEL = {
  admin: "Dashboard change",
  login: "Signed in",
  login_failed: "Failed sign-in",
  account_state: "Account state",
  account_added: "Account found",
  fallback: "Switched account",
  backend_restart: "Backend restart",
  gateway_start: "Gateway started",
  alert_opened: "Alert opened",
  alert_resolved: "Alert closed",
  ip_blocked: "Address blocked",
  queue_full: "Queue full",
  queue_timeout: "Queue wait too long",
  notify_failed: "Alert not delivered",
  monitor_error: "Monitor error",
};
PAGES.activity = {
  every: 15,
  async render(main) {
    const kind = h("select", { "aria-label": "Kind" }, h("option", { value: "" }, "Everything"), Object.entries(EVENT_LABEL).map(([k, l]) => h("option", { value: k }, l)));
    let rows = [];
    const list = h("div", { class: "mt" });
    const more = h("button", { class: "btn mt", type: "button" }, "Load older");
    const draw = () =>
      list.replaceChildren(
        table(
          [
            { label: "When", value: (e) => h("span", { title: when(e.ts) }, ago(e.ts)) },
            { label: "What", value: (e) => pill(EVENT_LABEL[e.kind] ?? e.kind, /fail|blocked|error|restart|full|timeout/.test(e.kind) ? "warn" : e.kind === "alert_opened" ? "bad" : "") },
            { label: "Subject", value: (e) => e.subject ?? "" },
            { label: "Details", value: (e) => h("span", { class: "small" }, e.message ?? ""), cls: () => "wrap-any" },
            { label: "Address", value: (e) => e.ip ?? "" },
          ],
          rows,
          { empty: h("div", { class: "card" }, empty("Nothing yet", "Restarts, account changes, alerts and dashboard changes are listed here.", null)) },
        ),
      );
    const load = async () => {
      rows = await api(`/admin/api/events?limit=100${kind.value ? "&kind=" + kind.value : ""}`);
      more.classList.toggle("hidden", rows.length < 100);
      draw();
    };
    kind.addEventListener("change", () => load().catch(fail));
    more.addEventListener("click", async () => {
      const older = await act(more, () => api(`/admin/api/events?limit=100&before=${rows.at(-1)?.id ?? 0}${kind.value ? "&kind=" + kind.value : ""}`));
      if (older) {
        rows = rows.concat(older);
        more.classList.toggle("hidden", older.length < 100);
        draw();
      }
    });
    main.replaceChildren(pageHead("Activity", "What happened, and every change made in this dashboard.", kind), list, more);
    await load();
    return async () => {
      const fresh = await api(`/admin/api/events?limit=50${kind.value ? "&kind=" + kind.value : ""}`);
      const top = rows[0]?.id ?? 0;
      const add = fresh.filter((e) => e.id > top);
      if (add.length) {
        rows = add.concat(rows);
        draw();
      }
    };
  },
};

/* =========================================================================
   Playground
   ========================================================================= */
PAGES.playground = {
  every: 0,
  async render(main) {
    const [models, accts] = await Promise.all([modelList(), api("/admin/api/accounts")]);
    const saved = store.get("play", {});
    const model = h("select", { "aria-label": "Model" }, models.filter((m) => m.enabled).map((m) => h("option", { value: m.id, selected: m.id === (saved.model ?? S.status?.connection?.defaultModel) }, m.id)));
    const account = h("select", { "aria-label": "Account" }, h("option", { value: "" }, "First ready account"), accts.accounts.filter((a) => a.enabled).map((a) => h("option", { value: a.id }, a.label || a.id)));
    const maxTokens = h("input", { type: "number", min: 1, max: 32000, value: saved.maxTokens ?? 512 });
    const temperature = h("input", { type: "number", min: 0, max: 1, step: 0.1, value: saved.temperature ?? "", placeholder: "default" });
    const system = h("textarea", { rows: 2, placeholder: "Optional system prompt" });
    system.value = saved.system ?? "";
    const prompt = h("textarea", { rows: 5, placeholder: "Ask something… (Ctrl+Enter sends)" });
    prompt.value = saved.prompt ?? "";
    const out = h("div", { class: "playground-out", "aria-live": "polite" });
    const meta = h("div", { class: "muted small mt-s" });
    const send = h("button", { class: "btn primary", type: "button" }, icon("playground"), "Send");
    const stop = h("button", { class: "btn hidden", type: "button" }, "Stop");
    let ctrl = null;
    const run = async () => {
      const body = { model: model.value, account: account.value, maxTokens: maxTokens.value, temperature: temperature.value, system: system.value, prompt: prompt.value };
      store.set("play", { model: body.model, maxTokens: body.maxTokens, temperature: body.temperature, system: body.system, prompt: body.prompt });
      ctrl = new AbortController();
      send.setAttribute("aria-busy", "true");
      stop.classList.remove("hidden");
      out.textContent = "";
      meta.textContent = "Waiting for the first token…";
      const t0 = performance.now();
      let first = null;
      let usage = null;
      let stopReason = null;
      try {
        const r = await fetch("/admin/api/playground", { method: "POST", headers: { "content-type": "application/json", "x-cgw": "1" }, body: JSON.stringify(body), signal: ctrl.signal });
        if (!r.ok && !(r.headers.get("content-type") ?? "").includes("event-stream")) {
          const o = await r.json().catch(() => ({}));
          throw new Error(o.error?.message ?? o.error ?? `Status ${r.status}`);
        }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            try {
              const o = JSON.parse(line.slice(5));
              if (o.type === "content_block_delta" && o.delta?.text) {
                first ??= performance.now() - t0;
                out.append(o.delta.text);
              }
              if (o.type === "message_start") usage = { ...o.message.usage };
              if (o.type === "message_delta") {
                usage = { ...usage, ...o.usage };
                stopReason = o.delta?.stop_reason ?? stopReason;
              }
              if (o.type === "error") throw new Error(o.error?.message ?? "Error");
            } catch (e) {
              if (e.message && !(e instanceof SyntaxError)) throw e;
            }
          }
        }
        meta.textContent = `${ms(performance.now() - t0)} total · first token ${ms(first)} · ${fmt(usage?.input_tokens)} in / ${fmt(usage?.output_tokens)} out · stop: ${stopReason ?? "–"}`;
      } catch (e) {
        if (e.name === "AbortError") meta.textContent = "Stopped.";
        else {
          out.append(h("span", { class: "bad-t" }, e.message));
          meta.textContent = "";
        }
      } finally {
        send.removeAttribute("aria-busy");
        stop.classList.add("hidden");
      }
    };
    send.addEventListener("click", run);
    stop.addEventListener("click", () => ctrl?.abort());
    prompt.addEventListener("keydown", (e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && run());
    main.replaceChildren(
      pageHead("Playground", "Try a model through the gateway. These requests show in Requests as /playground."),
      h(
        "div",
        { class: "grid two" },
        h("div", { class: "card" }, h("div", { class: "form" }, field("Model", model), field("Account", account), field("Max output tokens", maxTokens), field("Temperature", temperature)), h("div", { class: "mt" }, field("System prompt", system)), h("div", { class: "mt" }, field("Message", prompt)), h("div", { class: "row mt" }, send, stop)),
        h("div", { class: "card" }, h("h2", {}, "Reply"), out, meta),
      ),
    );
  },
};

/* =========================================================================
   Settings
   ========================================================================= */
PAGES.settings = {
  every: 0,
  async render(main) {
    const [st, models] = await Promise.all([api("/admin/api/settings"), modelList()]);
    const zones = Intl.supportedValuesOf?.("timeZone") ?? [st.timeZone];
    const I = {
      maxConcurrent: h("input", { type: "number", min: 1, max: 8, value: st.maxConcurrent }),
      maxQueue: h("input", { type: "number", min: 0, max: 200, value: st.maxQueue }),
      queueTimeoutMs: h("input", { type: "number", min: 1, max: 600, value: Math.round(st.queueTimeoutMs / 1000) }),
      requestTimeoutMs: h("input", { type: "number", min: 10, max: 600, value: Math.round(st.requestTimeoutMs / 1000) }),
      maxBodyMb: h("input", { type: "number", min: 1, max: 50, value: st.maxBodyMb }),
      retentionDays: h("input", { type: "number", min: 1, max: 365, value: st.retentionDays }),
      badKeyLimit: h("input", { type: "number", min: 3, max: 1000, value: st.badKeyLimit }),
      defaultModel: h("select", {}, models.map((m) => h("option", { value: m.id, selected: m.id === st.defaultModel }, m.id))),
      publicHost: h("input", { type: "text", value: st.publicHost }),
      publicUrl: h("input", { type: "url", value: st.publicUrl, placeholder: "https://claude.example.com" }),
      timeZone: h("input", { type: "text", value: st.timeZone, list: "zones" }),
      trustedProxy: h("select", {}, [["none", "None: use the connection's address"], ["cloudflare", "Cloudflare tunnel"], ["forwarded", "Other proxy or tunnel (X-Forwarded-For)"]].map(([v, l]) => h("option", { value: v, selected: v === st.trustedProxy }, l))),
    };
    const flags = { enforceMaxTokens: st.enforceMaxTokens, metricsEnabled: st.metricsEnabled };
    const collect = () => ({
      ...Object.fromEntries(Object.entries(I).map(([k, el]) => [k, el.value])),
      queueTimeoutMs: Number(I.queueTimeoutMs.value) * 1000,
      requestTimeoutMs: Number(I.requestTimeoutMs.value) * 1000,
      ...flags,
    });
    const saveAll = async (btn) => {
      const r = await act(btn, () => api("/admin/api/settings", { method: "PATCH", body: collect() }), "Settings saved");
      if (r?.restartBackend && (await confirmDlg({ title: "Restart the backend now?", body: "This change takes effect when the backend restarts. Running requests are cut off.", ok: "Restart now" })))
        await act(null, () => api("/admin/api/restart-backend", { method: "POST" }), "Backend restarting");
    };
    const saveBtn = (label = "Save") => {
      const b = h("button", { class: "btn primary", type: "button" }, label);
      b.addEventListener("click", () => saveAll(b));
      return b;
    };
    const prices = Object.fromEntries(Object.entries(st.pricing).map(([fam, p]) => [fam, { in: h("input", { type: "number", min: 0, step: "0.01", value: p.in, "aria-label": `${fam} input price` }), out: h("input", { type: "number", min: 0, step: "0.01", value: p.out, "aria-label": `${fam} output price` }) }]));
    const pw = { current: h("input", { type: "password", autocomplete: "current-password" }), next: h("input", { type: "password", autocomplete: "new-password", minlength: 10 }), again: h("input", { type: "password", autocomplete: "new-password" }) };
    const blocked = S.status?.blockedIps ?? [];
    main.replaceChildren(
      pageHead("Settings", `Version ${st.version}`),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Gateway"),
        h(
          "div",
          { class: "form" },
          field("Requests at once", I.maxConcurrent, "More uses more memory: about 200 MB each."),
          field("Waiting requests (queue)", I.maxQueue),
          field("Longest wait in the queue (s)", I.queueTimeoutMs),
          field("Give up when the backend is silent for (s)", I.requestTimeoutMs),
          field("Largest request body (MB)", I.maxBodyMb),
          field("Keep history for (days)", I.retentionDays),
          field("Default model", I.defaultModel),
          field("Block an address after this many bad keys a minute", I.badKeyLimit),
        ),
        h("div", { class: "row mt" }, saveBtn()),
      ),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Network and time"),
        h(
          "div",
          { class: "form wide" },
          field("Address on this network", I.publicHost, "Shown in connection details."),
          field("Public URL (optional)", I.publicUrl, "When reached through a tunnel; shown to apps instead of the network address."),
          field("Behind a proxy or tunnel", I.trustedProxy, "Only then are forwarded addresses believed. A wrong choice lets callers fake their address."),
          field("Time zone", I.timeZone, "Daily and monthly limits reset at midnight here."),
        ),
        h("datalist", { id: "zones" }, zones.map((z) => h("option", { value: z }))),
        h("div", { class: "row mt" }, saveBtn()),
      ),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Backend"),
        h(
          "dl",
          { class: "kv" },
          h("dt", {}, "State"),
          h("dd", {}, S.status?.upstream?.ok ? pill("Healthy", "ok") : pill(S.status?.upstream?.status ?? "unknown", "bad")),
          h("dt", {}, "Version"),
          h("dd", {}, S.status?.upstream?.version ?? "–"),
          h("dt", {}, "Claude CLI"),
          h("dd", { class: "mono small" }, S.status?.upstream?.cli ?? "–"),
          h("dt", {}, "Memory"),
          h("dd", {}, S.status?.memory ? `${S.status.memory.meridianMb} MB (${S.status.memory.cliProcesses} CLI processes)` : "–"),
        ),
        h("div", { class: "row mt" }, h("label", { class: "check" }, sw(flags.enforceMaxTokens, (on) => (flags.enforceMaxTokens = on), "Enforce max output tokens"), "Enforce max output tokens (needed for the per-project limit)")),
        h("div", { class: "row mt-s" }, h("label", { class: "check" }, sw(flags.metricsEnabled, (on) => (flags.metricsEnabled = on), "Metrics endpoint"), "Metrics endpoint at /metrics (Prometheus format)")),
        st.metricsToken ? h("div", { class: "mt-s" }, h("p", { class: "small muted" }, "Scrape with this header:"), copyBlock(`Authorization: Bearer ${st.metricsToken}`)) : null,
        h(
          "div",
          { class: "row mt" },
          saveBtn(),
          h(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: async (e) => (await confirmDlg({ title: "Restart the backend?", body: "Running requests are cut off. It's back in a few seconds.", ok: "Restart", danger: true })) && act(e.currentTarget, () => api("/admin/api/restart-backend", { method: "POST" }), "Backend restarting"),
            },
            icon("refresh"),
            "Restart backend",
          ),
        ),
      ),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Prices for cost estimates"),
        h("p", { class: "muted small" }, "USD per million tokens, by model family. A price set on a model wins."),
        table(
          [
            { label: "Family", value: ([f]) => f },
            { label: "Input", value: ([, p]) => p.in },
            { label: "Output", value: ([, p]) => p.out },
          ],
          Object.entries(prices),
        ),
        h(
          "div",
          { class: "row mt" },
          (() => {
            const b = h("button", { class: "btn primary", type: "button" }, "Save prices");
            b.addEventListener("click", () => act(b, () => api("/admin/api/settings", { method: "PATCH", body: { pricing: Object.fromEntries(Object.entries(prices).map(([f, p]) => [f, { in: p.in.value, out: p.out.value }])) } }), "Prices saved"));
            return b;
          })(),
        ),
      ),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Security"),
        h(
          "form",
          {
            class: "form",
            onsubmit: async (e) => {
              e.preventDefault();
              if (pw.next.value !== pw.again.value) return toast("The new passwords don't match.", { error: true });
              if (await act(e.submitter, () => api("/admin/api/password", { method: "POST", body: { current: pw.current.value, next: pw.next.value } }), "Password changed. Other sessions were signed out.")) for (const el of Object.values(pw)) el.value = "";
            },
          },
          field("Current password", pw.current),
          field("New password", pw.next, "At least 10 characters."),
          field("New password again", pw.again),
          h("div", { class: "field", style: "justify-content:flex-end" }, h("button", { class: "btn primary", type: "submit" }, "Change password")),
        ),
        h(
          "div",
          { class: "row mt" },
          h("button", { class: "btn", type: "button", onclick: async (e) => (await confirmDlg({ title: "Sign out everywhere?", body: "Every dashboard session, including this one, is signed out.", ok: "Sign out everywhere", danger: true })) && (await act(e.currentTarget, () => api("/admin/api/logout-all", { method: "POST" }))) && showLogin("Signed out everywhere.") }, "Sign out everywhere"),
        ),
        h("h3", { class: "mt" }, "Blocked addresses"),
        blocked.length
          ? table(
              [
                { label: "Address", value: (b) => b.ip },
                { label: "Until", value: (b) => new Date(b.until).toLocaleTimeString() },
                { label: "", value: (b) => h("button", { class: "btn sm", type: "button", onclick: async (e) => (await act(e.currentTarget, () => api("/admin/api/unblock", { method: "POST", body: { ip: b.ip } }), "Unblocked")) && route() }, "Unblock") },
              ],
              blocked,
            )
          : h("p", { class: "muted small" }, "None. An address is blocked for 10 minutes after too many bad keys."),
      ),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Backup"),
        h("p", { class: "muted small" }, "Export settings, alert rules and model settings (no passwords, keys or tokens). Import them on another gateway."),
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: async (e) => {
                const data = await act(e.currentTarget, () => api("/admin/api/settings/export"));
                if (!data) return;
                const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })), download: `gateway-settings-${new Date().toISOString().slice(0, 10)}.json` });
                a.click();
                URL.revokeObjectURL(a.href);
              },
            },
            icon("download"),
            "Export",
          ),
          h(
            "label",
            { class: "btn" },
            "Import…",
            h("input", {
              type: "file",
              accept: "application/json",
              class: "sr-only",
              onchange: async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                let data;
                try {
                  data = JSON.parse(await file.text());
                } catch {
                  return toast("That file isn't valid JSON.", { error: true });
                }
                if (await confirmDlg({ title: "Import these settings?", body: `From ${data.exportedAt ? when(data.exportedAt) : "an unknown date"}. Current settings are replaced; projects, accounts and secrets are not touched.`, ok: "Import" }))
                  (await act(null, () => api("/admin/api/settings/import", { method: "POST", body: data }), "Imported")) && route();
              },
            }),
          ),
        ),
      ),
    );
  },
};

// The script is deferred, so the page is parsed by now; every page is defined above.
boot();
