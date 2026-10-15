// Wird in jede umgeschriebene HTML-Seite eingefügt und biegt dynamisch erzeugte URLs auf den Proxy um.
(function () {
  'use strict';
  var PREFIX = '/p/';
  var PROXIED = /^(?:https?:\/\/[^/]+)?\/p\/https?%3A/i;
  var SKIP = /^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i;
  var base = window.__PROXY_BASE || location.href;

  function prox(u) {
    if (u == null) return u;
    var s = String(u).trim();
    if (!s || SKIP.test(s) || PROXIED.test(s)) return u;
    try {
      var x = new URL(s, base);
      if (x.protocol !== 'http:' && x.protocol !== 'https:') return u;
      var hash = x.hash;
      x.hash = '';
      return PREFIX + encodeURIComponent(x.href) + hash;
    } catch (e) {
      return u;
    }
  }

  function unprox(u) {
    var m = /^(?:https?:\/\/[^/]+)?\/p\/(https?%3A[^#]*)/i.exec(u || '');
    return m ? decodeURIComponent(m[1]) : u;
  }

  // fetch
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string' || input instanceof URL) {
      input = prox(String(input));
    } else if (input && input.url) {
      input = new Request(prox(input.url), input);
    }
    return origFetch.call(this, input, init);
  };

  // XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = prox(url);
    return origOpen.apply(this, args);
  };

  if (navigator.sendBeacon) {
    var origBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function (url, data) {
      return origBeacon.call(this, prox(url), data);
    };
  }

  var origWindowOpen = window.open;
  window.open = function (url) {
    var args = Array.prototype.slice.call(arguments);
    if (url) args[0] = prox(url);
    return origWindowOpen.apply(this, args);
  };

  // setAttribute für URL-Attribute
  var URL_ATTRS = { src: 1, href: 1, action: 1, poster: 1, data: 1, formaction: 1 };
  var origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (URL_ATTRS[String(name).toLowerCase()]) value = prox(value);
    return origSetAttribute.call(this, name, value);
  };

  // Property-Setter (el.src = ..., a.href = ...)
  [
    [HTMLAnchorElement, 'href'],
    [HTMLAreaElement, 'href'],
    [HTMLLinkElement, 'href'],
    [HTMLImageElement, 'src'],
    [HTMLScriptElement, 'src'],
    [HTMLIFrameElement, 'src'],
    [HTMLSourceElement, 'src'],
    [HTMLMediaElement, 'src'],
    [HTMLFormElement, 'action'],
  ].forEach(function (pair) {
    var desc = Object.getOwnPropertyDescriptor(pair[0].prototype, pair[1]);
    if (!desc || !desc.set) return;
    Object.defineProperty(pair[0].prototype, pair[1], {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: function (v) {
        desc.set.call(this, prox(v));
      },
    });
  });

  // History-API: Basis nachführen, damit relative URLs weiter stimmen
  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn];
    history[fn] = function (state, title, url) {
      if (url != null) {
        try {
          var full = new URL(unprox(String(url)), base);
          base = full.href;
          url = prox(full.href);
        } catch (e) {
          /* unverändert lassen */
        }
      }
      return orig.call(this, state, title, url);
    };
  });

  // GET-Formulare: Browser würde die Query der Proxy-URL ersetzen, daher selbst zusammenbauen
  document.addEventListener(
    'submit',
    function (e) {
      var form = e.target;
      if (!form || form.tagName !== 'FORM') return;
      var method = ((e.submitter && e.submitter.formMethod) || form.method || 'get').toLowerCase();
      if (method !== 'get') return;
      e.preventDefault();
      var target = new URL(unprox(form.getAttribute('action')) || base, base);
      var params = new URLSearchParams();
      new FormData(form).forEach(function (v, k) {
        if (typeof v === 'string') params.append(k, v);
      });
      target.search = params.toString();
      location.href = prox(target.href);
    },
    true
  );
})();
