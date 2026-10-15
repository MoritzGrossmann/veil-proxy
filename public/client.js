// Wird in jede umgeschriebene HTML-Seite eingefügt und biegt dynamisch erzeugte URLs auf den Proxy um.
(function () {
  'use strict';
  var PREFIX = '/p/';
  var PROXIED = /^(?:https?:\/\/[^/]+)?\/(?:p\/v1\.|__proxy\/)/i;
  var SKIP = /^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i;
  var base = window.__PROXY_BASE || location.href;

  // Die Zieladresse steckt verschlüsselt in der Proxy-URL; Ver-/Entschlüsselung macht der Server.
  // Synchrones XHR, weil die Umschreibe-Hooks (setAttribute, fetch, ...) synchron antworten müssen.
  var origOpen = XMLHttpRequest.prototype.open;
  var rpcCache = { enc: {}, dec: {} };
  function rpc(kind, value) {
    var hit = rpcCache[kind][value];
    if (hit !== undefined) return hit;
    try {
      var xhr = new XMLHttpRequest();
      origOpen.call(xhr, 'POST', '/__proxy/' + kind, false);
      xhr.setRequestHeader('content-type', 'text/plain');
      xhr.send(value);
      if (xhr.status !== 200) return null;
      rpcCache[kind][value] = xhr.responseText;
      return xhr.responseText;
    } catch (e) {
      return null;
    }
  }

  function prox(u) {
    if (u == null) return u;
    var s = String(u).trim();
    if (!s || SKIP.test(s) || PROXIED.test(s)) return u;
    try {
      var x = new URL(s, base);
      if (x.protocol !== 'http:' && x.protocol !== 'https:') return u;
      var hash = x.hash;
      x.hash = '';
      var token = rpc('enc', x.href);
      return token == null ? u : PREFIX + token + hash;
    } catch (e) {
      return u;
    }
  }

  function unprox(u) {
    var m = /^(?:https?:\/\/[^/]+)?\/p\/(v1\.[A-Za-z0-9_-]+)/.exec(u || '');
    if (!m) return u;
    var plain = rpc('dec', m[1]);
    return plain == null ? u : plain;
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

  // Adressleiste wie im Browser (nur im obersten Fenster)
  if (window.top === window) {
    var BAR_HEIGHT = 44;
    var initBar = function () {
      if (document.getElementById('__proxy_bar')) return;
      var host = document.createElement('div');
      host.id = '__proxy_bar';
      host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;height:' + BAR_HEIGHT + 'px;z-index:2147483647;';
      var root = host.attachShadow({ mode: 'open' });
      root.innerHTML =
        '<style>' +
        'form{display:flex;gap:8px;align-items:center;box-sizing:border-box;height:' + BAR_HEIGHT + 'px;padding:6px 10px;background:#f1f3f4;border-bottom:1px solid #0003;font:14px system-ui,sans-serif}' +
        'input{flex:1;min-width:0;height:100%;box-sizing:border-box;padding:0 12px;font:inherit;border:1px solid #0003;border-radius:16px;background:#fff;color:#000}' +
        'button{height:100%;padding:0 14px;font:inherit;border:0;border-radius:16px;background:#2563eb;color:#fff;cursor:pointer}' +
        '@media (prefers-color-scheme:dark){form{background:#2b2b2b}input{background:#1a1a1a;color:#eee;border-color:#fff3}}' +
        '</style>' +
        '<form action="/go" method="get"><input name="url" type="text" spellcheck="false" autocomplete="off"><button type="submit">Öffnen</button></form>';
      var input = root.querySelector('input');
      var sync = function () {
        var cur = unprox(location.pathname + location.search);
        if (root.activeElement !== input) input.value = cur + location.hash;
      };
      sync();
      window.addEventListener('popstate', sync);
      window.addEventListener('hashchange', sync);
      setInterval(sync, 1000);
      document.documentElement.appendChild(host);
      document.documentElement.style.setProperty('padding-top', BAR_HEIGHT + 'px', 'important');
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBar);
    else initBar();
  }

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
