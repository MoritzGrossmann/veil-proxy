// Alle Frames liegen auf der Proxy-Origin. Widgets (z. B. reCAPTCHA) adressieren und prüfen aber die echten
// Origins per postMessage: targetOrigin der echten Seite würde nie zustellen, event.origin wäre immer die Proxy-Origin.
(function () {
  var origPost = window.postMessage;
  window.postMessage = function (message, target) {
    var args = Array.prototype.slice.call(arguments);
    if (typeof target === 'string' && target !== '/') args[1] = '*';
    else if (target && typeof target === 'object' && target.targetOrigin) args[1] = { targetOrigin: '*', transfer: target.transfer };
    return origPost.apply(this, args);
  };

  function realOrigin(e) {
    try {
      var src = e.source;
      if (src && src.__PROXY_BASE) return new URL(src.__PROXY_BASE).origin;
    } catch (err) {
      /* Quelle nicht lesbar */
    }
    return e.origin;
  }

  var wrapped = new WeakMap();
  var origAdd = EventTarget.prototype.addEventListener;
  var origRemove = EventTarget.prototype.removeEventListener;

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'message' && this === window && typeof listener === 'function') {
      var wrap = wrapped.get(listener);
      if (!wrap) {
        wrap = function (e) {
          var origin = realOrigin(e);
          var view = new Proxy(e, {
            get: function (t, k) {
              if (k === 'origin') return origin;
              var v = t[k];
              return typeof v === 'function' ? v.bind(t) : v;
            },
          });
          return listener.call(this, view);
        };
        wrapped.set(listener, wrap);
      }
      return origAdd.call(this, type, wrap, options);
    }
    return origAdd.call(this, type, listener, options);
  };

  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (type === 'message' && this === window && typeof listener === 'function' && wrapped.has(listener)) {
      return origRemove.call(this, type, wrapped.get(listener), options);
    }
    return origRemove.call(this, type, listener, options);
  };
})();
