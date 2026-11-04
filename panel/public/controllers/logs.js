(() => {
  const { Controller } = window.Stimulus;

  const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
  const NOTE = /\u001b\[8mha:[^\u001b]*\u001b\[0m/g;
  const LEVELS = [
    ["e", /\b(error|err|fatal|panic|crit(ical)?|exception|failed|failure)\b/i],
    ["w", /\b(warn(ing)?)\b/i],
    ["d", /\b(debug|trace)\b/i],
  ];
  const BACKOFF = [1000, 2000, 5000, 10000, 15000];
  const COLORS = 8;

  const clean = (s) => s.replace(NOTE, "").replace(ANSI, "").replace(/\r/g, "");
  const level = (s) => LEVELS.find(([, re]) => re.test(s))?.[0] ?? "";
  const hue = (s) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS;

  class LogsController extends Controller {
    static targets = ["pane", "src", "pause", "state", "count", "dropped"];
    static values = { stream: String, cap: { type: Number, default: 1000 }, pauseCap: { type: Number, default: 5000 }, tz: { type: String, default: "UTC" } };

    connect() {
      this.paused = false;
      this.held = [];
      this.queue = [];
      this.dropped = 0;
      this.shown = 0;
      this.attempt = 0;
      this.lastId = null;
      this.stick = true;
      this.fmt = this.makeFormatter();
      this.onScroll = () => {
        const p = this.paneTarget;
        this.stick = p.scrollHeight - p.scrollTop - p.clientHeight < 40;
      };
      this.paneTarget.addEventListener("scroll", this.onScroll, { passive: true });
      this.open();
    }

    disconnect() {
      this.paneTarget.removeEventListener("scroll", this.onScroll);
      this.close();
      if (this.raf) cancelAnimationFrame(this.raf);
    }

    makeFormatter() {
      try {
        return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: this.tzValue });
      } catch {
        return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
      }
    }

    selection() {
      const v = this.srcTarget.value;
      if (v === "all") return {};
      const i = v.indexOf("/");
      return { host: v.slice(0, i), container: v.slice(i + 1) };
    }

    url() {
      const q = new URLSearchParams(this.selection());
      if (this.lastId) q.set("after", this.lastId);
      const s = q.toString();
      return s ? `${this.streamValue}?${s}` : this.streamValue;
    }

    open() {
      this.close();
      this.setState("Connecting", "");
      const es = new EventSource(this.url());
      this.es = es;
      es.onopen = () => {
        this.attempt = 0;
      };
      es.addEventListener("backlog", (e) => this.onLines(e));
      es.addEventListener("lines", (e) => this.onLines(e));
      es.addEventListener("dropped", (e) => this.onDropped(e));
      es.addEventListener("status", (e) => this.onStatus(e));
      es.addEventListener("fail", (e) => this.onFail(e));
      es.onerror = () => {
        if (this.es !== es) return;
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          this.es = null;
          const wait = BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)];
          this.setState(`Reconnecting in ${Math.round(wait / 1000)} s`, "warn");
          this.retry = setTimeout(() => this.open(), wait);
        } else {
          this.setState("Reconnecting", "warn");
        }
      };
    }

    close() {
      clearTimeout(this.retry);
      if (this.es) this.es.close();
      this.es = null;
    }

    parse(e) {
      try {
        return JSON.parse(e.data);
      } catch {
        return null;
      }
    }

    onLines(e) {
      if (/^\d{1,19}$/.test(e.lastEventId)) this.lastId = e.lastEventId;
      const list = this.parse(e);
      if (!Array.isArray(list)) return;
      const lines = list.filter((d) => d && typeof d.line === "string");
      if (this.paused) {
        this.held.push(...lines);
        if (this.held.length > this.pauseCapValue) {
          const over = this.held.length - this.pauseCapValue;
          this.held.splice(0, over);
          this.dropped += over;
          this.showDropped();
        }
        this.showCount();
        return;
      }
      this.queue.push(...lines);
      if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
    }

    onDropped(e) {
      const d = this.parse(e);
      const n = d && Number(d.count);
      if (!Number.isFinite(n) || n <= 0) return;
      this.dropped += n;
      this.showDropped();
    }

    onStatus(e) {
      const d = this.parse(e);
      if (!d) return;
      if (d.state === "live") this.setState(this.paused ? "Paused" : "Live", this.paused ? "warn" : "ok", !this.paused);
      else if (d.state === "reconnecting") this.setState(d.error ? "Loki unreachable, retrying" : "Reconnecting to Loki", "bad");
      else this.setState("Connecting", "");
    }

    onFail(e) {
      const d = this.parse(e);
      this.setState(d && d.message ? `Logs unavailable: ${d.message}` : "Logs unavailable", "bad");
    }

    flush() {
      this.raf = 0;
      const batch = this.queue.splice(0);
      if (!batch.length) return;
      const all = !this.selection().container;
      const frag = document.createDocumentFragment();
      for (const d of batch) frag.append(this.node(d, all));
      const pane = this.paneTarget;
      pane.append(frag);
      this.shown += batch.length;
      while (pane.childElementCount > this.capValue) {
        pane.firstElementChild.remove();
        this.shown -= 1;
      }
      this.showCount();
      if (this.stick) pane.scrollTop = pane.scrollHeight;
    }

    node(d, all) {
      const text = clean(d.line);
      const row = document.createElement("span");
      row.className = `ln ${level(text)}`.trim();
      const ts = document.createElement("span");
      ts.className = "ts";
      const ms = Number(String(d.ts ?? "").slice(0, -6));
      ts.textContent = Number.isFinite(ms) && ms > 0 ? this.fmt.format(new Date(ms)) : "";
      row.append(ts);
      if (all && d.container) {
        const c = document.createElement("span");
        c.className = `cn tc-${hue(d.container)}`;
        c.textContent = d.container;
        row.append(c);
      }
      const m = document.createElement("span");
      m.className = "m";
      m.textContent = text;
      row.append(m);
      return row;
    }

    toggle() {
      this.paused = !this.paused;
      this.pauseTarget.textContent = this.paused ? "Resume" : "Pause";
      this.pauseTarget.setAttribute("aria-pressed", String(this.paused));
      if (!this.paused) {
        this.queue.push(...this.held.splice(0));
        this.flush();
      }
      this.setState(this.paused ? "Paused" : this.es?.readyState === EventSource.OPEN ? "Live" : "Connecting", this.paused ? "warn" : "ok", !this.paused);
      this.showCount();
    }

    clear() {
      this.paneTarget.replaceChildren();
      this.queue = [];
      this.held = [];
      this.shown = 0;
      this.dropped = 0;
      this.showDropped();
      this.showCount();
    }

    change() {
      this.clear();
      this.lastId = null;
      try {
        const u = new URL(location.href);
        const sel = this.selection();
        u.searchParams.delete("host");
        u.searchParams.delete("container");
        for (const [k, v] of Object.entries(sel)) u.searchParams.set(k, v);
        history.replaceState(history.state, "", u);
      } catch {}
      this.open();
    }

    showCount() {
      const held = this.held.length;
      this.countTarget.textContent = `${this.shown} lines${held ? ` · ${held} held` : ""}`;
    }

    showDropped() {
      this.droppedTarget.hidden = this.dropped === 0;
      this.droppedTarget.textContent = this.dropped ? `${this.dropped} lines dropped` : "";
    }

    setState(label, tone, pulse = false) {
      const chip = document.createElement("span");
      chip.className = `chip ${tone}`.trim();
      const lamp = document.createElement("span");
      lamp.className = pulse ? "lamp pulse" : "lamp";
      chip.append(lamp, label);
      this.stateTarget.replaceChildren(chip);
    }
  }

  document.addEventListener("DOMContentLoaded", () => window.Stimulus.register("logs", LogsController));
})();
