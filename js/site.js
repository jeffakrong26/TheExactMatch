// Shared across every page — nav, FAQ accordion, scroll-reveal, the
// newsletter popup, and the generic form-submit helper used by the
// findmycar/sellmycar/contact page-specific scripts. Page-specific behavior
// (the multi-step wizards, their own submit functions) stays inline on its
// own page instead of living here.

// ── Mobile menu ──────────────────────────────────────────────
function toggleMenu() {
  document.getElementById('mobile-menu').classList.toggle('open');
}

// ── Desktop nav "More" dropdown ─────────────────────────────
function toggleNavMore() {
  document.getElementById('nav-more').classList.toggle('open');
  return false;
}
document.addEventListener('click', (e) => {
  const navMore = document.getElementById('nav-more');
  if (navMore && navMore.classList.contains('open') && !navMore.contains(e.target)) {
    navMore.classList.remove('open');
  }
});

// ── Scroll reveal ────────────────────────────────────────────
const io = new IntersectionObserver((entries) => {
  entries.forEach((e, i) => {
    if (e.isIntersecting) {
      setTimeout(() => e.target.classList.add('on'), i * 80);
      io.unobserve(e.target);
    }
  });
}, { threshold: 0.1 });
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
});

// ── FAQ ──────────────────────────────────────────────────────
function toggleFaq(el) {
  const isOpen = el.classList.contains('open');
  document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));
  if (!isOpen) el.classList.add('open');
}

// ── Dealer API endpoint ────────────────────────────────────────
const DEALER_API = 'https://theexactmatch-dealer-api.jeffakrong26.workers.dev/api';

// ── Core submit helper ────────────────────────────────────────
// onSuccess (optional): called with the parsed response body after the
// success UI is already showing — for follow-up work (e.g. uploading
// optional photos using the id this endpoint just returned) that shouldn't
// delay or risk the submission itself. Errors inside it are the caller's
// concern to handle quietly; a failure there must never look like the
// submission failed.
async function submitToApi(btn, endpoint, wrapId, successId, errorId, payload, onSuccess) {
  // Prevent duplicate submissions
  if (btn.dataset.submitting === 'true') return;
  btn.dataset.submitting = 'true';

  // Loading state
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const res = await fetch(`${DEALER_API}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      // Success
      document.getElementById(wrapId).style.display = 'none';
      document.getElementById(successId).style.display = 'block';
      if (errorId) {
        const err = document.getElementById(errorId);
        if (err) err.style.display = 'none';
      }
      if (onSuccess) onSuccess(data);
    } else {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Submission failed. Please try again.');
    }
  } catch (e) {
    // Restore button so user can retry
    btn.disabled = false;
    btn.textContent = originalText;
    btn.dataset.submitting = 'false';

    // Show inline error
    const errEl = errorId ? document.getElementById(errorId) : null;
    if (errEl) {
      errEl.textContent = e.message || 'Something went wrong. Please try again or text us at (512) 650-9328.';
      errEl.style.display = 'block';
    } else {
      alert(e.message || 'Something went wrong. Please try again or text us at (512) 650-9328.');
    }
  }
}

// ── Newsletter popup ──────────────────────────────────────────
(function(){
  const STORAGE_CLOSED   = 'tem_nl_closed';
  const STORAGE_SUBBED   = 'tem_nl_subscribed';
  const HIDE_DAYS        = 30;
  const DELAY_MS         = 3000;
  const WORKER_ENDPOINT  = 'https://newsletter-signup.jeffakrong26.workers.dev';

  function shouldShow(){
    if(localStorage.getItem(STORAGE_SUBBED)) return false;
    const closed = localStorage.getItem(STORAGE_CLOSED);
    if(!closed) return true;
    return (Date.now() - parseInt(closed,10)) > HIDE_DAYS * 864e5;
  }

  function open(){
    document.getElementById('nl-overlay').classList.add('nl-visible');
    document.getElementById('nl-email').focus();
  }

  function close(){
    document.getElementById('nl-overlay').classList.remove('nl-visible');
    localStorage.setItem(STORAGE_CLOSED, Date.now().toString());
  }

  function showMsg(text, type){
    const el = document.getElementById('nl-msg');
    el.textContent = text;
    el.className = type === 'ok' ? 'nl-ok' : 'nl-err';
    el.style.display = 'block';
  }

  async function submit(){
    const emailEl  = document.getElementById('nl-email');
    const btn      = document.getElementById('nl-submit');
    const email    = emailEl.value.trim();
    const re       = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if(!email || !re.test(email)){
      showMsg('Please enter a valid email address.','err');
      emailEl.focus();
      return;
    }

    btn.disabled    = true;
    btn.textContent = 'Sending…';

    try{
      const res  = await fetch(WORKER_ENDPOINT,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({email})
      });
      const data = await res.json().catch(()=>({}));

      if(res.ok){
        showMsg("You're in. Watch your inbox for Jeff's Recent Finds.",'ok');
        localStorage.setItem(STORAGE_SUBBED,'1');
        emailEl.style.display = 'none';
        btn.style.display     = 'none';
        document.querySelector('.nl-micro').style.display = 'none';
      } else {
        showMsg(data.error || 'Something went wrong. Please try again.','err');
        btn.disabled    = false;
        btn.textContent = 'Get Recent Finds';
      }
    } catch(e){
      showMsg('Something went wrong. Please try again.','err');
      btn.disabled    = false;
      btn.textContent = 'Get Recent Finds';
    }
  }

  // Find My Car / Sell My Car: interrupting someone mid-form is worse than
  // not showing the popup at all, so these two get no exit-intent/scroll
  // trigger — instead we wait for their own success screen (#find-success /
  // #sell-success) to actually appear. A MutationObserver on that element
  // rather than a hook into submitFindForm/submitSellForm: this stays
  // decoupled from the two page-specific submit flows entirely, and doesn't
  // care how the success screen ended up visible.
  const FORM_PAGE_SUCCESS_ID = {
    '/find-my-car': 'find-success',
    '/sell-my-car': 'sell-success',
  }[location.pathname];

  // Same breakpoint the nav already treats as "mobile" (.nav-links hides,
  // hamburger takes over) — reused here so "mobile" means the same thing
  // everywhere on the site rather than a second, possibly-drifting number.
  const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

  document.addEventListener('DOMContentLoaded',function(){
    if(!shouldShow()) return;

    if (FORM_PAGE_SUCCESS_ID) {
      const successEl = document.getElementById(FORM_PAGE_SUCCESS_ID);
      if (successEl) {
        const observer = new MutationObserver(() => {
          if (successEl.style.display === 'block') {
            observer.disconnect();
            open();
          }
        });
        observer.observe(successEl, { attributes: true, attributeFilter: ['style'] });
      }
    } else if (isMobile()) {
      // 60% scroll depth.
      function onScroll(){
        const scrolled = window.scrollY + window.innerHeight;
        const total = document.documentElement.scrollHeight;
        if (total > 0 && scrolled / total >= 0.6) {
          window.removeEventListener('scroll', onScroll);
          open();
        }
      }
      window.addEventListener('scroll', onScroll, { passive: true });
    } else {
      // Exit-intent.
      function exitIntent(e){
        if(e.clientY > 0 || e.relatedTarget) return;
        document.removeEventListener('mouseout', exitIntent);
        open();
      }
      document.addEventListener('mouseout', exitIntent);
    }

    document.getElementById('nl-close').addEventListener('click', close);
    document.getElementById('nl-overlay').addEventListener('click',function(e){
      if(e.target === this) close();
    });
    document.addEventListener('keydown',function(e){
      if(e.key==='Escape') close();
    });
    document.getElementById('nl-submit').addEventListener('click', submit);
    document.getElementById('nl-email').addEventListener('keydown',function(e){
      if(e.key==='Enter') submit();
    });
  });
})();
