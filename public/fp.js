// Berechnet einen Browser-Footprint und legt ihn per POST an den Server (pfp-Cookie). Der Server hasht ihn zusammen mit dem
// Tag zum Schlüssel für die URL-Tokens. Es werden nur Merkmale verwendet, die sich im Alltag nicht ändern
// (kein Fenster-/Zoom-Wert), damit Tokens im selben Browser gültig bleiben.
(function () {
  'use strict';

  function fnv(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  function canvasHash() {
    try {
      var c = document.createElement('canvas');
      c.width = 200;
      c.height = 40;
      var ctx = c.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '16px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(10, 5, 80, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('Veil <canvas> 1.0 äöü', 4, 8);
      return fnv(c.toDataURL());
    } catch (e) {
      return '';
    }
  }

  function gpu() {
    try {
      var gl = document.createElement('canvas').getContext('webgl');
      var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    } catch (e) {
      return '';
    }
  }

  function tz() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (e) {
      return '';
    }
  }

  var w = screen.width || 0;
  var h = screen.height || 0;
  var parts = [
    navigator.userAgent,
    (navigator.languages || [navigator.language]).join(','),
    navigator.platform,
    tz(),
    navigator.hardwareConcurrency || '',
    navigator.deviceMemory || '',
    screen.colorDepth || '',
    Math.min(w, h) + 'x' + Math.max(w, h),
    canvasHash(),
    gpu(),
  ];

  // Der Server setzt den Footprint als HttpOnly-Cookie, damit Skripte fremder Seiten ihn nicht auslesen können.
  // Synchron, damit das Cookie gesetzt ist, bevor das Formular abgeschickt werden kann.
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/__proxy/fp', false);
    xhr.setRequestHeader('content-type', 'text/plain');
    xhr.send(parts.join('|'));
  } catch (e) {
    /* ohne Footprint lassen sich keine Proxy-URLs erzeugen */
  }
})();
