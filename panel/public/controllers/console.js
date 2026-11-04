(() => {
  const { Controller } = window.Stimulus;

  const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
  const NOTE = /\u001b\[8mha:[^\u001b]*\u001b\[0m/g;
  const MAX_CHARS = 400_000;
  const POLL_MS = 1500;
  const HIDDEN_MS = 5000;
  const BACKOFF = [2000, 5000, 10000];
  const BAD = /\b(error|fatal|failed|failure|exception)\b|Finished: (FAILURE|ABORTED|UNSTABLE)/i;
  const GOOD = /Finished: SUCCESS/;
  const DIM = /^\[Pipeline\]|^\s*\+ /;

  const clean = (s) => s.replace(NOTE, "").replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  class ConsoleController extends Controller {
    static targets = ["pane", "state", "follow"];
    static values = { src: String, running: Boolean };

    connect() {
      this.offset = 0;
      this.carry = "";
      this.follow = true;
      this.done = false;
      this.fails = 0;
      this.chars = 0;
      this.ctl = null;
      this.onScroll = () => {
        const p = this.paneTarget;
        const near = p.scrollHeight - p.scrollTop - p.clientHeight < 40;
        if (!near && this.follow) this.setFollow(false);
      };
      this.keep = (e) => {
        const t = e.target;
        if (this.element.contains(t) && t.closest("[data-console-target]")) e.preventDefault();
      };
      this.paneTarget.addEventListener("scroll", this.onScroll, { passive: true });
      document.addEventListener("turbo:before-morph-element", this.keep);
      this.setFollow(true);
      this.poll();
    }

    disconnect() {
      this.done = true;
      clearTimeout(this.timer);
      this.ctl?.abort();
      this.paneTarget.removeEventListener("scroll", this.onScroll);
      document.removeEventListener("turbo:before-morph-element", this.keep);
    }

    async poll() {
      if (this.done) return;
      if (document.hidden) {
        this.timer = setTimeout(() => this.poll(), HIDDEN_MS);
        return;
      }
      this.ctl = new AbortController();
      let wait = POLL_MS;
      try {
        const res = await fetch(`${this.srcValue}?start=${this.offset}`, { credentials: "same-origin", signal: this.ctl.signal, headers: { accept: "text/plain" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const size = Number(res.headers.get("X-Text-Size"));
        const text = await res.text();
        if (Number.isFinite(size) && size >= this.offset) this.offset = size;
        this.fails = 0;
        this.append(text);
        if (res.headers.get("X-More-Data") === "true") {
          this.setState("Streaming");
        } else {
          this.finish();
          return;
        }
      } catch (err) {
        if (this.done || err.name === "AbortError") return;
        wait = BACKOFF[Math.min(this.fails++, BACKOFF.length - 1)];
        this.setState(`Console unavailable (${err.message}), retrying`);
      }
      this.timer = setTimeout(() => this.poll(), wait);
    }

    finish() {
      this.done = true;
      if (this.carry) this.render(clean(this.carry));
      this.carry = "";
      this.setState("Finished");
    }

    append(text) {
      if (!text) return;
      const all = this.carry + text;
      const cut = all.lastIndexOf("\n");
      this.carry = cut < 0 ? all : all.slice(cut + 1);
      if (cut >= 0) this.render(clean(all.slice(0, cut + 1)));
    }

    render(block) {
      const pane = this.paneTarget;
      const frag = document.createDocumentFragment();
      for (const line of block.split("\n").slice(0, block.endsWith("\n") ? -1 : undefined)) {
        const span = document.createElement("span");
        if (GOOD.test(line)) span.className = "g";
        else if (BAD.test(line)) span.className = "e";
        else if (DIM.test(line)) span.className = "d";
        span.textContent = `${line}\n`;
        frag.append(span);
        this.chars += line.length + 1;
      }
      pane.append(frag);
      while (this.chars > MAX_CHARS && pane.firstElementChild) {
        this.chars -= pane.firstElementChild.textContent.length;
        pane.firstElementChild.remove();
        this.trimmed = true;
      }
      if (this.follow) pane.scrollTop = pane.scrollHeight;
    }

    toggle() {
      this.setFollow(!this.follow);
      if (this.follow) this.paneTarget.scrollTop = this.paneTarget.scrollHeight;
    }

    setFollow(on) {
      this.follow = on;
      this.followTarget.textContent = on ? "Stop following" : "Follow";
      this.followTarget.setAttribute("aria-pressed", String(on));
    }

    setState(text) {
      this.stateTarget.textContent = this.trimmed ? `${text} · earlier output trimmed` : text;
    }
  }

  class ConfirmController extends Controller {
    static values = { title: String, body: String, request: String, ok: String, danger: Boolean };

    ask(e) {
      if (this.approved) {
        this.approved = false;
        return;
      }
      e.preventDefault();
      const d = this.dialog();
      d.querySelector("h2").textContent = this.titleValue;
      d.querySelector(".body-text").textContent = this.bodyValue;
      d.querySelector("pre").textContent = this.requestValue;
      const ok = d.querySelector("button[value=ok]");
      ok.textContent = this.okValue;
      ok.className = `btn ${this.dangerValue ? "stop" : "go"}`;
      d.returnValue = "";
      d.onclose = () => {
        if (d.returnValue !== "ok") return;
        this.approved = true;
        this.element.requestSubmit();
      };
      d.showModal();
    }

    dialog() {
      let d = document.getElementById("confirm-dialog");
      if (d) return d;
      d = document.createElement("dialog");
      d.id = "confirm-dialog";
      d.className = "confirm";
      const form = document.createElement("form");
      form.method = "dialog";
      const h = document.createElement("h2");
      const body = document.createElement("div");
      body.className = "sec body-text";
      const req = document.createElement("div");
      const what = document.createElement("div");
      what.className = "what";
      what.textContent = "What will run";
      const pre = document.createElement("pre");
      pre.className = "code";
      req.append(what, pre);
      const btns = document.createElement("div");
      btns.className = "btns";
      const cancel = document.createElement("button");
      cancel.className = "btn";
      cancel.value = "cancel";
      cancel.textContent = "Cancel";
      const ok = document.createElement("button");
      ok.value = "ok";
      btns.append(cancel, ok);
      form.append(h, body, req, btns);
      d.append(form);
      document.body.append(d);
      return d;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    window.Stimulus.register("console", ConsoleController);
    window.Stimulus.register("confirm", ConfirmController);
  });
})();
