(() => {
  const { Controller } = window.Stimulus;
  const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const GENERATED = 24;

  function pick(n) {
    const limit = 256 - (256 % n);
    const byte = new Uint8Array(1);
    for (;;) {
      crypto.getRandomValues(byte);
      if (byte[0] < limit) return byte[0] % n;
    }
  }

  const pageCsrf = () => document.querySelector('form[action="/logout"] input[name="_csrf"]')?.value ?? "";

  class CsrfFieldController extends Controller {
    connect() {
      this.fill();
    }

    fill() {
      const field = this.element.querySelector('input[name="_csrf"]');
      if (field) field.value = pageCsrf();
    }
  }

  class SecretController extends Controller {
    static targets = ["mask", "value", "show", "hide", "copy", "note"];
    static values = { url: String, seconds: { type: Number, default: 20 } };

    connect() {
      this.secret = null;
      this.timer = null;
      this.onLeave = () => this.clear();
      document.addEventListener("turbo:before-cache", this.onLeave);
      window.addEventListener("pagehide", this.onLeave);
    }

    disconnect() {
      this.clear();
      document.removeEventListener("turbo:before-cache", this.onLeave);
      window.removeEventListener("pagehide", this.onLeave);
    }

    async show() {
      this.showTarget.disabled = true;
      this.noteTarget.textContent = "";
      try {
        const res = await fetch(this.urlValue, {
          method: "POST",
          headers: { "x-csrf-token": pageCsrf(), accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 401 && body.reauth) {
          window.location.assign(body.reauth);
          return;
        }
        if (!res.ok || typeof body.value !== "string") {
          this.noteTarget.textContent = body.message || `Could not show it (HTTP ${res.status}).`;
          return;
        }
        this.secret = body.value;
        this.valueTarget.textContent = body.value;
        this.valueTarget.hidden = false;
        this.maskTarget.hidden = true;
        this.showTarget.hidden = true;
        this.hideTarget.hidden = false;
        this.copyTarget.hidden = false;
        this.element.setAttribute("data-refresh-hold", "");
        this.left = this.secondsValue;
        this.tickNote();
        this.timer = setInterval(() => {
          this.left -= 1;
          if (this.left <= 0) this.clear();
          else this.tickNote();
        }, 1000);
      } catch {
        this.noteTarget.textContent = "Could not reach the panel.";
      } finally {
        this.showTarget.disabled = false;
      }
    }

    tickNote() {
      this.noteTarget.textContent = `Hides in ${this.left} s`;
    }

    hide() {
      this.clear();
    }

    async copy() {
      if (this.secret === null) return;
      try {
        await navigator.clipboard.writeText(this.secret);
        this.noteTarget.textContent = `Copied. Hides in ${this.left} s`;
      } catch {
        this.noteTarget.textContent = "The browser blocked copying.";
      }
    }

    clear() {
      clearInterval(this.timer);
      this.timer = null;
      this.secret = null;
      this.valueTarget.textContent = "";
      this.valueTarget.hidden = true;
      this.maskTarget.hidden = false;
      this.showTarget.hidden = false;
      this.hideTarget.hidden = true;
      this.copyTarget.hidden = true;
      this.noteTarget.textContent = "";
      this.element.removeAttribute("data-refresh-hold");
    }
  }

  class SecretGenController extends Controller {
    static targets = ["input"];

    connect() {
      this.details = this.element.closest("details");
      this.onToggle = () => this.element.toggleAttribute("data-refresh-hold", this.details.open);
      this.details?.addEventListener("toggle", this.onToggle);
      this.onLeave = () => {
        if (this.hasInputTarget) this.inputTarget.value = "";
      };
      document.addEventListener("turbo:before-cache", this.onLeave);
    }

    disconnect() {
      this.details?.removeEventListener("toggle", this.onToggle);
      document.removeEventListener("turbo:before-cache", this.onLeave);
    }

    fill() {
      let out = "";
      for (let i = 0; i < GENERATED; i++) out += ALPHABET[pick(ALPHABET.length)];
      this.inputTarget.value = out;
      this.inputTarget.focus();
      this.inputTarget.select();
    }
  }

  class OnceController extends Controller {
    static targets = ["value", "note"];
    static values = { seconds: { type: Number, default: 60 } };

    connect() {
      this.left = this.secondsValue;
      this.timer = setInterval(() => {
        this.left -= 1;
        if (this.left <= 0) this.wipe();
        else this.noteTarget.textContent = `Hides in ${this.left} s`;
      }, 1000);
      this.onLeave = () => this.wipe();
      window.addEventListener("pagehide", this.onLeave);
    }

    disconnect() {
      this.wipe();
      window.removeEventListener("pagehide", this.onLeave);
    }

    async copy() {
      try {
        await navigator.clipboard.writeText(this.valueTarget.textContent);
        this.noteTarget.textContent = `Copied. Hides in ${this.left} s`;
      } catch {
        this.noteTarget.textContent = "The browser blocked copying.";
      }
    }

    wipe() {
      clearInterval(this.timer);
      this.valueTarget.textContent = "Hidden. It is not stored, so rotate again for a new one.";
      this.valueTarget.classList.remove("reveal");
      this.noteTarget.textContent = "";
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    window.Stimulus.register("csrf-field", CsrfFieldController);
    window.Stimulus.register("once", OnceController);
    window.Stimulus.register("secret", SecretController);
    window.Stimulus.register("secret-gen", SecretGenController);
  });
})();
