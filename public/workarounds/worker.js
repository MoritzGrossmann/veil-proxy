// new Worker("https://ziel/…") scheitert an der Same-Origin-Pflicht; die URL muss über den Proxy laufen
// (z. B. reCAPTCHA lädt api2/webworker.js so).
(function () {
  var hooks = window.__proxyHooks;
  if (!hooks) return;
  ['Worker', 'SharedWorker'].forEach(function (name) {
    var Orig = window[name];
    if (!Orig) return;
    window[name] = function (url, options) {
      // URL-Objekte können aus einem anderen Frame stammen (instanceof greift dann nicht), daher immer in String wandeln
      var u = hooks.prox(String(url));
      return options === undefined ? new Orig(u) : new Orig(u, options);
    };
    window[name].prototype = Orig.prototype;
  });
})();
