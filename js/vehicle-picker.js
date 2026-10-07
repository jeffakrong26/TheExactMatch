// VehiclePicker — cascading Year -> Make -> Model -> Trim dropdowns.
//
// Each level's list comes from fetchOptions(), which /review-my-deal points
// at dealer-api's /api/public/vehicle-options (Marketcheck's own spellings
// of what's listed, so picks match the listings comparison exactly). Every
// list ends with "Not listed" (opens a text box), and if a list can't load, that level
// and the ones below fall back to plain text boxes, so no car is ever
// blocked. Works inside StepForm: each level writes a hidden input named
// "<name>.<level>" (e.g. car.make), which StepForm collects as usual.
//
//   const picker = new VehiclePicker(el, {
//     name: 'car', levels: ['year', 'make', 'model', 'trim'],
//     labels: { year: 'Year', ... },
//     fetchOptions: ({ year, make, model }) => Promise<string[]>,
//   });
//   await picker.setValues({ year: 2021, make: 'Toyota', ... }); // prefill
//
// Styles: .vp rules in css/step-form.css (the container uses display:contents
// so each level sits in the surrounding .sf-grid).

(function () {
  const OTHER = '__other';
  const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

  class VehiclePicker {
    constructor(root, opts) {
      this.root = root;
      this.opts = opts;
      this.levels = opts.levels;
      this.minYear = opts.minYear || 1981;
      this.maxYear = opts.maxYear || new Date().getFullYear() + 1;
      this.els = {};
      this.loadToken = 0;
      this.pending = {}; // values to auto-select once their list loads (prefer())
      root.classList.add('vp');
      for (const level of this.levels) this._build(level);
      this._fillYears();
      for (const level of this.levels.slice(1)) this._disable(level);
    }

    _build(level) {
      const label = document.createElement('label');
      label.className = 'sf-field vp-level';
      const title = (this.opts.labels && this.opts.labels[level]) || level[0].toUpperCase() + level.slice(1);
      label.innerHTML = `<span>${title}</span>`;
      const select = document.createElement('select');
      const other = document.createElement('input');
      other.type = 'text';
      other.className = 'vp-other';
      other.hidden = true;
      other.autocomplete = 'off';
      other.placeholder = `Type the ${level}`;
      if (level === 'year') { other.inputMode = 'numeric'; other.maxLength = 4; }
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = `${this.opts.name}.${level}`;
      label.append(select, other, hidden);
      this.root.appendChild(label);
      this.els[level] = { label, select, other, hidden };

      select.addEventListener('change', () => {
        if (select.value === OTHER) {
          this._showOther(level, '');
          other.focus();
        } else {
          hidden.value = select.value;
        }
        this._resetBelow(level);
        this._emit();
        if (select.value && select.value !== OTHER) this._loadNext(level);
      });
      other.addEventListener('input', () => {
        hidden.value = other.value.trim();
        this._emit();
      });
      // Typing a level means the ones below have no list to pick from.
      other.addEventListener('change', () => this._resetBelow(level, { typed: true }));
    }

    _emit() {
      this.root.dispatchEvent(new Event('change', { bubbles: true }));
    }

    _fillYears() {
      const years = [];
      for (let y = this.maxYear; y >= this.minYear; y--) years.push(String(y));
      this._setOptions('year', years);
    }

    _setOptions(level, values, { loading = false } = {}) {
      const { select, other } = this.els[level];
      select.hidden = false;
      other.hidden = true;
      const head = loading ? 'Loading…' : (values.length ? 'Choose…' : (level === 'year' ? 'Choose…' : 'None listed'));
      select.innerHTML = `<option value="">${head}</option>` +
        values.map((v) => `<option value="${v.replace(/"/g, '&quot;')}">${v.replace(/</g, '&lt;')}</option>`).join('') +
        (loading || level === 'year' ? '' : `<option value="${OTHER}">Not listed</option>`);
      select.disabled = loading;
    }

    _showOther(level, value) {
      const { select, other, hidden } = this.els[level];
      select.value = OTHER;
      other.hidden = false;
      other.value = value;
      hidden.value = value;
    }

    _disable(level) {
      const { select, other, hidden } = this.els[level];
      select.innerHTML = '<option value="">Choose…</option>'; // disabled until the level above is chosen
      select.disabled = true;
      select.hidden = false;
      other.hidden = true;
      other.value = '';
      hidden.value = this.pending[level] || ''; // a preferred value still submits
    }

    _resetBelow(level, { typed = false } = {}) {
      const i = this.levels.indexOf(level);
      this.loadToken++;
      for (const below of this.levels.slice(i + 1)) {
        if (typed) {
          // No list exists under a typed value: offer text boxes instead.
          const { select, other, hidden } = this.els[below];
          select.hidden = true;
          select.disabled = false;
          other.hidden = false;
          other.value = this.pending[below] || '';
          hidden.value = other.value;
        } else {
          this._disable(below);
        }
      }
    }

    _parents(level) {
      const p = {};
      for (const l of this.levels.slice(0, this.levels.indexOf(level))) p[l] = this.els[l].hidden.value;
      return p;
    }

    async _loadNext(level) {
      const next = this.levels[this.levels.indexOf(level) + 1];
      if (!next) return [];
      const token = this.loadToken;
      this._setOptions(next, [], { loading: true });
      let values;
      try {
        values = await this.opts.fetchOptions(this._parents(next));
      } catch (_) {
        values = null;
      }
      if (token !== this.loadToken) return null; // a newer choice superseded this load
      if (!values) {
        // List unavailable: this level and below become text boxes.
        this._resetBelow(level, { typed: true });
        return null;
      }
      this._setOptions(next, values);
      // A preferred value (e.g. ?make=Ferrari from a brand page) is picked
      // as soon as its list arrives; if it isn't listed it's kept as typed.
      const want = this.pending[next];
      if (want) {
        const { select, hidden } = this.els[next];
        const match = Array.from(select.options).find((o) => o.value && o.value !== OTHER && norm(o.value) === norm(want));
        if (match) {
          select.value = match.value;
          hidden.value = match.value;
          delete this.pending[next];
          this._emit();
          this._loadNext(next);
        } else {
          this._showOther(next, want);
        }
      }
      return values;
    }

    // Prefill a level whose list depends on choices above it (e.g. a make
    // before the year is chosen). The value is submitted as-is until then.
    prefer(values) {
      for (const [level, v] of Object.entries(values)) {
        if (!v || !this.els[level]) continue;
        this.pending[level] = String(v);
        this.els[level].hidden.value = String(v);
      }
    }

    // Prefill (e.g. from a photo of the buyer's order). Each value is matched
    // to the list ignoring case and punctuation; anything not listed is kept
    // as typed text so nothing the visitor gave us is lost.
    async setValues(values) {
      const wants = {};
      for (const level of this.levels) wants[level] = values[level] == null ? '' : String(values[level]).trim();
      this.loadToken++;
      let listed = true; // false once a level is typed: everything below is typed too
      for (let i = 0; i < this.levels.length; i++) {
        const level = this.levels[i];
        const { select, other, hidden } = this.els[level];
        if (listed && i > 0) {
          const opts = await this._loadNext(this.levels[i - 1]);
          if (opts === null) listed = false; // list unavailable
        }
        if (!listed) {
          select.hidden = true;
          other.hidden = false;
          other.value = wants[level];
          hidden.value = wants[level];
          continue;
        }
        if (!wants[level]) {
          select.value = '';
          hidden.value = '';
          for (const below of this.levels.slice(i + 1)) this._disable(below);
          break;
        }
        const match = Array.from(select.options).find((o) => o.value && o.value !== OTHER && norm(o.value) === norm(wants[level]));
        if (match) {
          select.value = match.value;
          hidden.value = match.value;
        } else {
          this._showOther(level, wants[level]);
          listed = false;
        }
      }
      this._emit();
    }
  }

  window.VehiclePicker = VehiclePicker;
})();
