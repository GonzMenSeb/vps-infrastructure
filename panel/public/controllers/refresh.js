(() => {
  const { Controller } = window.Stimulus;
  const CHOICES = [0, 5, 15, 60, 180];
  const KEY = "vp-refresh";
  const FIELD = "input, select, textarea, [contenteditable]";

  const mmss = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s} s`);

  class RefreshController extends Controller {
    static targets = ["select", "label", "bar", "lamp"];
    static values = { frame: { type: String, default: "live" } };

    connect() {
      this.sec = 15;
      try {
        const v = localStorage.getItem(KEY);
        if (v !== null && CHOICES.includes(Number(v))) this.sec = Number(v);
      } catch {}
      this.selectTarget.value = String(this.sec);
      this.last = Date.now();
      this.busy = false;
      this.failed = false;
      this.onMorphAttr = (e) => {
        if (e.target instanceof HTMLDetailsElement && e.detail.attributeName === "open") e.preventDefault();
      };
      this.onLoad = (e) => {
        if (e.target.id !== this.frameValue) return;
        this.last = Date.now();
        this.failed = false;
      };
      this.onRender = (e) => {
        if (e.target.id !== this.frameValue) return;
        const rail = e.target.querySelector("[data-rail-state]");
        if (rail) for (const el of document.querySelectorAll(".rail [data-rail]")) el.textContent = rail.dataset[el.dataset.rail] ?? el.textContent;
        if (!this.open) return;
        for (const d of e.target.querySelectorAll("details[data-k]")) if (this.open.has(d.dataset.k)) d.open = true;
      };

      this.onError = (e) => {
        if (e.target.id === this.frameValue) this.failed = true;
      };
      this.onMissing = (e) => {
        if (e.target.id !== this.frameValue) return;
        e.preventDefault();
        e.detail.visit(e.detail.response);
      };
      this.onBeforeCache = () => {
        const frame = document.getElementById(this.frameValue);
        frame?.removeAttribute("src");
        frame?.removeAttribute("complete");
      };
      document.addEventListener("turbo:before-cache", this.onBeforeCache);
      document.addEventListener("turbo:before-morph-attribute", this.onMorphAttr);
      document.addEventListener("turbo:frame-load", this.onLoad);
      document.addEventListener("turbo:frame-render", this.onRender);
      document.addEventListener("turbo:fetch-request-error", this.onError);
      document.addEventListener("turbo:frame-missing", this.onMissing);
      this.prime();
      this.arm();
      this.timer = setInterval(() => this.step(), 250);
      this.step();
    }

    disconnect() {
      clearInterval(this.timer);
      document.removeEventListener("turbo:before-cache", this.onBeforeCache);

      document.removeEventListener("turbo:before-morph-attribute", this.onMorphAttr);
      document.removeEventListener("turbo:frame-load", this.onLoad);
      document.removeEventListener("turbo:frame-render", this.onRender);
      document.removeEventListener("turbo:fetch-request-error", this.onError);
      document.removeEventListener("turbo:frame-missing", this.onMissing);
    }

    prime() {
      const frame = document.getElementById(this.frameValue);
      if (!frame || frame.getAttribute("src")) return;
      frame.setAttribute("disabled", "");
      frame.src = location.pathname + location.search;
      frame.setAttribute("complete", "");
      frame.removeAttribute("disabled");
    }

    arm() {
      this.next = Date.now() + this.sec * 1000;
    }

    change() {
      this.sec = Number(this.selectTarget.value);
      try {
        localStorage.setItem(KEY, String(this.sec));
      } catch {}
      this.arm();
      this.step();
    }

    now() {
      this.fire();
    }

    held() {
      if (document.querySelector("dialog[open]")) return "a dialog is open";
      if (document.querySelector("[data-refresh-hold]")) return "an edit is in progress";
      const ae = document.activeElement;
      if (ae && ae !== this.selectTarget && ae.matches(FIELD) && !this.element.contains(ae)) return "a field is focused";
      return null;
    }

    fire() {
      this.arm();
      const frame = document.getElementById(this.frameValue);
      if (!frame || this.busy || this.held()) return;
      this.busy = true;
      this.open = new Set([...frame.querySelectorAll("details[open][data-k]")].map((d) => d.dataset.k));
      this.prime();
      Promise.resolve(frame.reload())
        .catch(() => {
          this.failed = true;
        })
        .finally(() => {
          this.busy = false;
          this.step();
        });
    }

    step() {
      const off = !this.sec;
      this.element.classList.toggle("off", off);
      this.element.classList.toggle("failed", this.failed);
      if (off) {
        this.labelTarget.textContent = "Auto-update off";
        this.barTarget.style.width = "0";
        return;
      }
      const left = this.next - Date.now();
      if (left <= 0) {
        if (document.hidden) return this.arm();
        return this.fire();
      }
      const ago = Math.round((Date.now() - this.last) / 1000);
      const hold = this.held();
      const head = this.failed ? "Update failed" : `Updated ${ago ? `${mmss(ago)} ago` : "just now"}`;
      this.labelTarget.textContent = hold ? `${head} · paused while ${hold}` : `${head} · next in ${mmss(Math.ceil(left / 1000))}`;
      this.barTarget.style.width = `${100 - (left / (this.sec * 1000)) * 100}%`;
    }
  }

  document.addEventListener("DOMContentLoaded", () => window.Stimulus.register("refresh", RefreshController));
})();
