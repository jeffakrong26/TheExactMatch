// StepForm — reusable one-topic-per-screen form wizard.
//
// First used by /review-my-deal; written so any future site form can drop
// it in instead of hand-rolling another next/back/progress script (the
// Find My Car and Sell My Car wizards each have their own inline copy).
// Styles: css/step-form.css. No dependencies.
//
// Markup contract (everything inside one root element):
//   <section class="sf-step" data-step="car" data-title="The car">…</section>
//     One screen per step. Inputs use dotted names (name="car.year") and
//     are collected into a nested object by data(). Entries are never
//     cleared on navigation, so Back always shows what was typed.
//   <div class="sf-choice" data-name="trade.has" [data-advance]>
//     <button type="button" value="yes">Yes</button>…</div>
//     Big tap-target button group backed by a hidden input; data-advance
//     moves to the next step on tap.
//   <div data-sf-repeat="fees"> + <template data-sf-template="fees">
//     Dynamic rows. Inputs inside a row use data-field="name". A button
//     with data-sf-add="fees" appends a row; [data-sf-remove] in a row
//     removes it. Collected as fees: [{ name, amount }, …].
//   [data-sf-show="trade.has=yes"] — shown only when that field has that
//     value (comma-separate several values: "payment.method=finance,lease").
//   Progress: [data-sf-progress] (bar inside: .sf-bar), [data-sf-label].
//   Nav: [data-sf-back], [data-sf-next], [data-sf-submit].
//
// JS:
//   const sf = new StepForm(root, {
//     flow: ['car', 'price', …],          // numbered steps, in order
//     skip: { payment: d => … },          // step is skipped when true
//     validate: { car: (d, el) => 'Message' | null },
//     finalStep: 'review',                // shows the submit button there
//     onShow: (key, sf) => {},            // e.g. render a summary
//     onSubmit: async (data, sf) => {},
//   });
//   sf.go('car', { returnTo: 'review' })   // edit-from-summary jump
//   sf.setFlow([...])                      // switch to a different path
//   sf.renderSummary(el, groups)           // tap-to-edit grouped summary

(function () {
  function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]] = o[keys[i]] || {};
    o[keys[keys.length - 1]] = value;
  }
  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  class StepForm {
    constructor(root, opts = {}) {
      this.root = root;
      this.opts = opts;
      this.steps = Array.from(root.querySelectorAll('.sf-step'));
      this.byKey = Object.fromEntries(this.steps.map((el) => [el.dataset.step, el]));
      this.flow = opts.flow || this.steps.map((el) => el.dataset.step);
      this.history = [];
      this.current = null;
      this.returnTo = null;
      this.err = root.querySelector('[data-sf-error]');
      this.backBtn = root.querySelector('[data-sf-back]');
      this.nextBtn = root.querySelector('[data-sf-next]');
      this.submitBtn = root.querySelector('[data-sf-submit]');
      this.nextLabel = this.nextBtn ? this.nextBtn.textContent : 'Next';

      this._wireChoices();
      this._wireRepeats();
      root.addEventListener('input', () => this._refreshConditional());
      root.addEventListener('change', () => this._refreshConditional());
      // Enter in a text field means "next", not a native form submit.
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('input:not([type=checkbox]):not([type=radio])')) {
          e.preventDefault();
          if (this.current === this.opts.finalStep) this.submit(); else this.next();
        }
      });
      if (this.backBtn) this.backBtn.addEventListener('click', () => this.back());
      if (this.nextBtn) this.nextBtn.addEventListener('click', () => this.next());
      if (this.submitBtn) this.submitBtn.addEventListener('click', () => this.submit());
      this._refreshConditional();
    }

    // ── data ────────────────────────────────────────────────────────
    data() {
      const d = {};
      this.root.querySelectorAll('[name]').forEach((el) => {
        if (el.closest('[data-sf-repeat]') || el.closest('template')) return;
        if (el.type === 'checkbox') setPath(d, el.name, el.checked);
        else if (el.type === 'radio') { if (el.checked) setPath(d, el.name, el.value); }
        else setPath(d, el.name, el.value.trim());
      });
      this.root.querySelectorAll('[data-sf-repeat]').forEach((box) => {
        const rows = Array.from(box.children).map((row) => {
          const r = {};
          row.querySelectorAll('[data-field]').forEach((el) => { r[el.dataset.field] = el.value.trim(); });
          return r;
        });
        setPath(d, box.dataset.sfRepeat, rows);
      });
      return d;
    }

    // Fill fields from a nested object (e.g. values read off a photo).
    fill(values) {
      this.root.querySelectorAll('[name]').forEach((el) => {
        if (el.closest('[data-sf-repeat]') || el.closest('template')) return;
        const v = getPath(values, el.name);
        if (v === undefined) return;
        if (el.type === 'checkbox') el.checked = !!v;
        else el.value = v == null ? '' : String(v);
      });
      this.root.querySelectorAll('.sf-choice').forEach((g) => this._syncChoice(g));
      this.root.querySelectorAll('[data-sf-repeat]').forEach((box) => {
        const rows = getPath(values, box.dataset.sfRepeat);
        if (!Array.isArray(rows)) return;
        box.innerHTML = '';
        rows.forEach((r) => this.addRow(box.dataset.sfRepeat, r));
      });
      this._refreshConditional();
    }

    // ── choices ─────────────────────────────────────────────────────
    _wireChoices() {
      this.root.querySelectorAll('.sf-choice').forEach((group) => {
        let input = group.querySelector('input[type=hidden]');
        if (!input) {
          input = document.createElement('input');
          input.type = 'hidden';
          input.name = group.dataset.name;
          group.appendChild(input);
        }
        group.setAttribute('role', 'radiogroup');
        group.querySelectorAll('button').forEach((btn) => {
          btn.type = 'button';
          btn.setAttribute('role', 'radio');
          btn.addEventListener('click', () => {
            input.value = btn.value;
            this._syncChoice(group);
            this._refreshConditional();
            this._clearError();
            if (group.hasAttribute('data-advance')) setTimeout(() => this.next(), 160);
          });
        });
        this._syncChoice(group);
      });
    }
    _syncChoice(group) {
      const value = group.querySelector('input[type=hidden]').value;
      group.querySelectorAll('button').forEach((b) => {
        const on = b.value === value;
        b.classList.toggle('is-selected', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }

    // ── repeatable rows ─────────────────────────────────────────────
    _wireRepeats() {
      this.root.querySelectorAll('[data-sf-add]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const row = this.addRow(btn.dataset.sfAdd);
          row?.querySelector('input')?.focus();
        });
      });
      this.root.addEventListener('click', (e) => {
        const rm = e.target.closest('[data-sf-remove]');
        if (rm) rm.closest('[data-sf-repeat] > *')?.remove();
      });
    }
    addRow(key, values = {}) {
      const box = this.root.querySelector(`[data-sf-repeat="${key}"]`);
      const tpl = this.root.querySelector(`template[data-sf-template="${key}"]`);
      if (!box || !tpl) return null;
      const row = tpl.content.firstElementChild.cloneNode(true);
      row.querySelectorAll('[data-field]').forEach((el) => {
        const v = values[el.dataset.field];
        if (v != null) el.value = String(v);
      });
      box.appendChild(row);
      return row;
    }

    // ── conditional blocks ──────────────────────────────────────────
    _refreshConditional() {
      const d = this.data();
      this.root.querySelectorAll('[data-sf-show]').forEach((el) => {
        const [path, values] = el.dataset.sfShow.split('=');
        el.hidden = !values.split(',').includes(String(getPath(d, path) ?? ''));
      });
    }

    // ── navigation ──────────────────────────────────────────────────
    setFlow(flow) { this.flow = flow; }

    _isSkipped(key, d) {
      const fn = this.opts.skip && this.opts.skip[key];
      return !!(fn && fn(d));
    }
    _nextKey(from) {
      const d = this.data();
      let i = this.flow.indexOf(from);
      while (++i < this.flow.length) if (!this._isSkipped(this.flow[i], d)) return this.flow[i];
      return null;
    }

    go(key, { returnTo = null, push = true } = {}) {
      if (!this.byKey[key]) return;
      if (push && this.current && this.current !== key) this.history.push(this.current);
      this.returnTo = returnTo;
      this.current = key;
      this.steps.forEach((el) => {
        const on = el.dataset.step === key;
        el.classList.toggle('is-active', on);
        el.hidden = !on;
      });
      this._clearError();
      this._renderChrome();
      this.opts.onShow && this.opts.onShow(key, this);
      const el = this.byKey[key];
      const heading = el.querySelector('h2, h3, legend');
      if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
      const top = this.root.getBoundingClientRect().top + window.scrollY - 90;
      if (window.scrollY > top) window.scrollTo({ top, behavior: 'smooth' });
    }

    _validate(key) {
      const fn = this.opts.validate && this.opts.validate[key];
      const msg = fn ? fn(this.data(), this.byKey[key]) : null;
      if (msg) { this._showError(msg); return false; }
      return true;
    }

    next() {
      if (!this.current || !this._validate(this.current)) return;
      if (this.returnTo) {
        // Came here from a summary: drop that summary's history entry and
        // return to it, so Back from the summary still goes where it did.
        const target = this.returnTo;
        if (this.history[this.history.length - 1] === target) this.history.pop();
        this.go(target, { push: false });
        return;
      }
      const key = this._nextKey(this.current);
      if (key) this.go(key);
    }

    back() {
      const prev = this.history.pop();
      if (prev) this.go(prev, { push: false });
      else this.opts.onExit && this.opts.onExit(this);
    }

    async submit() {
      if (!this.current || !this._validate(this.current)) return;
      if (!this.submitBtn || this.submitBtn.disabled) return;
      const label = this.submitBtn.textContent;
      this.submitBtn.disabled = true;
      this.submitBtn.textContent = 'Sending…';
      try {
        await this.opts.onSubmit(this.data(), this);
      } catch (e) {
        this._showError(e.message || 'Something went wrong. Please try again.');
      } finally {
        this.submitBtn.disabled = false;
        this.submitBtn.textContent = label;
      }
    }

    _renderChrome() {
      const pos = this.flow.indexOf(this.current);
      const numbered = pos !== -1;
      const label = this.root.querySelector('[data-sf-label]');
      const bar = this.root.querySelector('[data-sf-progress] .sf-bar');
      const progress = this.root.querySelector('[data-sf-progress]');
      if (label) {
        const title = this.byKey[this.current].dataset.title || '';
        label.innerHTML = numbered
          ? `Step <strong>${pos + 1}</strong> of ${this.flow.length}`
          : esc(this.returnTo && title ? `Editing: ${title}` : title);
      }
      if (bar) bar.style.width = numbered ? `${((pos + 1) / this.flow.length) * 100}%` : bar.style.width;
      if (progress) {
        progress.setAttribute('role', 'progressbar');
        progress.setAttribute('aria-valuemin', '1');
        progress.setAttribute('aria-valuemax', String(this.flow.length));
        if (numbered) progress.setAttribute('aria-valuenow', String(pos + 1));
      }
      const isFinal = this.current === this.opts.finalStep;
      const stepEl = this.byKey[this.current];
      const hideNext = isFinal || stepEl.hasAttribute('data-sf-no-next');
      if (this.nextBtn) {
        this.nextBtn.hidden = hideNext;
        this.nextBtn.textContent = this.returnTo ? 'Save and go back' : this.nextLabel;
      }
      if (this.submitBtn) this.submitBtn.hidden = !isFinal;
      if (this.backBtn) this.backBtn.hidden = stepEl.hasAttribute('data-sf-no-back');
    }

    _showError(msg) {
      if (!this.err) { alert(msg); return; }
      this.err.textContent = msg;
      this.err.hidden = false;
    }
    _clearError() { if (this.err) this.err.hidden = true; }

    // groups: [{ step, title, rows: [[label, value], …] }]. Rows with an
    // empty value render as "Not entered" so nothing silently disappears.
    // Each row is a button that jumps to its step and returns here.
    renderSummary(container, groups) {
      const here = this.current;
      container.innerHTML = groups.map((g) => `
        <div class="sf-summary-group">
          <div class="sf-summary-title">${esc(g.title)}</div>
          ${g.rows.map(([label, value]) => `
            <button type="button" class="sf-summary-row" data-sf-edit="${esc(g.step)}">
              <span class="sf-summary-label">${esc(label)}</span>
              <span class="sf-summary-value${value ? '' : ' is-empty'}">${esc(value || 'Not entered')}</span>
              <span class="sf-summary-edit" aria-hidden="true">Edit</span>
            </button>`).join('')}
        </div>`).join('');
      container.querySelectorAll('[data-sf-edit]').forEach((btn) => {
        btn.addEventListener('click', () => this.go(btn.dataset.sfEdit, { returnTo: here }));
      });
    }
  }

  window.StepForm = StepForm;
})();
