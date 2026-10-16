// reCAPTCHA prüft serverseitig, auf welcher Domain das Widget eingebettet ist (Parameter "co" der Anchor-URL).
// Im Proxy wäre das die Proxy-Origin; stattdessen die Origin der echten Seite eintragen.
(function () {
  var hooks = window.__proxyHooks;
  if (!hooks) return;
  var ANCHOR = /^(?:www\.)?(?:google\.com|recaptcha\.net)$/i;
  var PATH = /^\/recaptcha\/(?:api2|enterprise)\/anchor$/i;

  hooks.url.push(function (url, pageUrl) {
    if (!ANCHOR.test(url.hostname) || !PATH.test(url.pathname) || !url.searchParams.has('co')) return;
    var page = new URL(pageUrl);
    var port = page.port || (page.protocol === 'https:' ? '443' : '80');
    // reCAPTCHA-Variante von Base64: "=" als "." geschrieben
    url.searchParams.set('co', btoa(page.protocol + '//' + page.hostname + ':' + port).replace(/=/g, '.'));
  });
})();
