(() => {
  const localDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const offlineTest = new URLSearchParams(location.search).get('offline-test') === '1';
  if ('serviceWorker' in navigator && window.isSecureContext && (!localDevelopment || offlineTest)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' }).catch(() => {});
    });
  }
  let installPrompt;
  const installButton = document.getElementById('installBtn');
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    installButton.hidden = false;
  });
  installButton.addEventListener('click', async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    installPrompt = null;
    installButton.hidden = true;
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; installButton.hidden = true; });
})();
