// Year/make/model/trim lists for VehiclePicker (js/vehicle-picker.js), from
// dealer-api's /api/public/vehicle-options (Marketcheck's own spellings,
// cached server-side). Shared by /review-my-deal, /find-my-car and
// /sell-my-car. Each list is also cached for the page view. Rejects when a
// list can't load, which makes VehiclePicker fall back to text boxes.
// Needs DEALER_API from js/site.js.
(function () {
  const cache = new Map();
  window.fetchVehicleOptions = function (p) {
    const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v)).toString();
    if (!cache.has(qs)) {
      cache.set(qs, fetch(`${DEALER_API}/public/vehicle-options?${qs}`).then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !Array.isArray(data.options)) throw new Error(data.error || 'Lists unavailable');
        return data.options;
      }).catch((e) => { cache.delete(qs); throw e; }));
    }
    return cache.get(qs);
  };
})();
