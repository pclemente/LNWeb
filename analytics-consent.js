/* Analytics is opt-in. Lottery numbers, stakes and notes are never sent. */
(() => {
  const key = 'loteria_analytics_consent';
  const measurementId = window.LOTERIA_FIREBASE_CONFIG?.measurementId;
  let consent = null;
  let analytics = null;
  let logEvent = null;
  let setCollection = null;
  let loading = false;
  try { consent = localStorage.getItem(key); } catch { /* Browsing works without storage. */ }
  if (measurementId) window[`ga-disable-${measurementId}`] = consent !== 'accepted';
  window.loteriaTrack = (name, params = {}) => {
    if (consent !== 'accepted' || !analytics || !logEvent) return;
    // Only low-cardinality navigation events; never collect a user's portfolio.
    if (!['page_view', 'select_content'].includes(name)) return;
    const safe = {};
    if (['tab', 'lottery'].includes(params.content_type)) safe.content_type = params.content_type;
    if (['buscar', 'historico', 'resumen', 'info', 'navidad', 'nino'].includes(params.item_id)) safe.item_id = params.item_id;
    if (name === 'page_view') {
      safe.page_title = 'Mi Lotería';
      safe.page_location = `${location.origin}${location.pathname}`;
    }
    logEvent(analytics, name, safe);
  };
  async function enable() {
    if (loading || analytics || !window.LOTERIA_FIREBASE_CONFIG || consent !== 'accepted') return;
    loading = true;
    try {
      const [{ initializeApp }, api] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/12.16.0/firebase-analytics.js')
      ]);
      if (consent !== 'accepted' || !(await api.isSupported())) return;
      const app = initializeApp(window.LOTERIA_FIREBASE_CONFIG);
      analytics = api.initializeAnalytics(app, { config: { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false } });
      logEvent = api.logEvent;
      setCollection = api.setAnalyticsCollectionEnabled;
      setCollection(analytics, true);
      window.loteriaTrack('page_view');
      window.dispatchEvent(new Event('firebase-ready'));
    } catch { /* Optional analytics must never affect the application. */ }
    finally { loading = false; }
  }
  function choose(value) {
    consent = value;
    try { localStorage.setItem(key, value); } catch { /* This choice lasts for this session. */ }
    if (measurementId) window[`ga-disable-${measurementId}`] = consent !== 'accepted';
    if (analytics && setCollection) setCollection(analytics, consent === 'accepted');
    if (consent !== 'accepted') {
      document.cookie.split(';').forEach(part => {
        const name = part.trim().split('=')[0];
        if (!/^_ga(?:_|$)|^_gid$|^_gat/.test(name)) return;
        const domains = ['', location.hostname, '.' + location.hostname, '.pabloclementeperez.com'];
        domains.forEach(domain => { document.cookie = `${name}=; Max-Age=0; path=/${domain ? `; domain=${domain}` : ''}; SameSite=Lax`; });
      });
    }
    document.getElementById('consentBanner').hidden = true;
    if (consent === 'accepted') enable();
  }
  document.addEventListener('DOMContentLoaded', () => {
    const banner = document.getElementById('consentBanner');
    banner.hidden = consent === 'accepted' || consent === 'declined';
    document.getElementById('acceptAnalyticsBtn').addEventListener('click', () => choose('accepted'));
    document.getElementById('declineAnalyticsBtn').addEventListener('click', () => choose('declined'));
    document.getElementById('privacySettingsBtn').addEventListener('click', () => { banner.hidden = false; document.getElementById('declineAnalyticsBtn').focus(); });
    if (consent === 'accepted') enable();
  });
})();
