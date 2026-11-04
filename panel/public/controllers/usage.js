(() => {
  const { Controller } = window.Stimulus;

  class UsageController extends Controller {
    static targets = ["seg", "val", "lab"];
    static values = { val: String, lab: String };

    focus(e) {
      const d = e.currentTarget.dataset;
      for (const s of this.segTargets) s.classList.toggle("dim", s.dataset.i !== d.i);
      this.valTarget.textContent = d.v;
      this.labTarget.textContent = `${d.n} · ${d.p} of the total`;
    }

    blur() {
      for (const s of this.segTargets) s.classList.remove("dim");
      this.valTarget.textContent = this.valValue;
      this.labTarget.textContent = this.labValue;
    }
  }

  document.addEventListener("DOMContentLoaded", () => window.Stimulus.register("usage", UsageController));
})();
