import * as cheerio from 'cheerio';
import { encryptUrl, type UrlKey } from './urlcrypt.js';

const PREFIX = '/p/';
const SKIP = /^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i;

/** Macht aus einer (relativen) URL eine Proxy-URL: /p/<verschlüsselte absolute URL>#hash */
export function proxify(raw: string, base: string, key: UrlKey): string {
  const value = raw.trim();
  if (!value || SKIP.test(value)) return raw;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw;
    const hash = url.hash;
    url.hash = '';
    return PREFIX + encryptUrl(url.href, key) + hash;
  } catch {
    return raw;
  }
}

export function rewriteCss(css: string, base: string, key: UrlKey): string {
  return css
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_m, q: string, u: string) => `url(${q}${proxify(u, base, key)}${q})`)
    .replace(/@import\s+(['"])(.*?)\1/gi, (_m, q: string, u: string) => `@import ${q}${proxify(u, base, key)}${q}`);
}

/**
 * import("…") lässt sich im Browser nicht abfangen und würde relativ zur Proxy-URL aufgelöst
 * (SvelteKit: import("../_app/…") landet bei /_app/… statt beim Ziel). Daher in Inline-Skripten
 * die String-Literale von dynamischen und statischen Imports serverseitig umschreiben.
 */
export function rewriteInlineImports(js: string, base: string, key: UrlKey): string {
  // Bare Specifier ("lodash") bleiben unangetastet, nur relative und absolute URLs umschreiben
  const swap = (m: string, head: string, q: string, u: string) => (/^(?:\.{0,2}\/|https?:\/\/)/i.test(u) ? `${head}${q}${proxify(u, base, key)}${q}` : m);
  return js
    // new URL("./worker.js", import.meta.url) (Web-Worker, Assets)
    .replace(/(\bnew\s+URL\(\s*)(["'`])(\.{1,2}\/[^"'`$\\\n]+)\2(\s*,\s*import\.meta\.url\s*\))/g, (_m, head: string, q: string, u: string, tail: string) => `${head}${q}${proxify(u, base, key)}${q}${tail}`)
    // Vite-Preload-Liste (__vite__mapDeps): Pfade werden zur Laufzeit gegen import.meta.url aufgelöst
    .replace(/(\bm\.f=\[)([^\]]*)(\])/g, (_m, open: string, list: string, close: string) =>
      open + list.replace(/(["'`])(\.{1,2}\/[^"'`\\\n]+)\1/g, (_s, q: string, u: string) => `${q}${proxify(u, base, key)}${q}`) + close)
    .replace(/(\bimport\s*\(\s*)(['"`])([^'"`$\\\n]+)\2/g, swap)
    .replace(/(\bimport\s*)(['"])([^'"\\\n]+)\2/g, swap)
    .replace(/(\b(?:import|export)\b[^'"`;()]*?\bfrom\s*)(['"])([^'"\\\n]+)\2/g, swap);
}

function rewriteSrcset(value: string, base: string, key: UrlKey): string {
  return value.replace(/(^|,)(\s*)([^\s,]+)/g, (_m, sep: string, ws: string, u: string) => `${sep}${ws}${proxify(u, base, key)}`);
}

const URL_ATTRS: Array<[string, string]> = [
  ['a', 'href'],
  ['area', 'href'],
  ['link', 'href'],
  ['img', 'src'],
  ['script', 'src'],
  ['iframe', 'src'],
  ['frame', 'src'],
  ['embed', 'src'],
  ['source', 'src'],
  ['video', 'src'],
  ['video', 'poster'],
  ['audio', 'src'],
  ['track', 'src'],
  ['input', 'src'],
  ['form', 'action'],
  ['object', 'data'],
  ['button', 'formaction'],
  ['input', 'formaction'],
];

export function rewriteHtml(html: string, pageUrl: string, key: UrlKey): string {
  const $ = cheerio.load(html);

  // <base> bestimmt die Auflösungsbasis und wird entfernt.
  let base = pageUrl;
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).href;
    } catch {
      /* ungültiges <base> ignorieren */
    }
  }
  $('base').remove();

  for (const [tag, attr] of URL_ATTRS) {
    $(tag).each((_i, el) => {
      const v = $(el).attr(attr);
      if (v != null) $(el).attr(attr, proxify(v, base, key));
    });
  }

  $('img[srcset], source[srcset]').each((_i, el) => {
    $(el).attr('srcset', rewriteSrcset($(el).attr('srcset') ?? '', base, key));
  });

  $('style').each((_i, el) => {
    const css = $(el).html();
    if (css) $(el).html(rewriteCss(css, base, key));
  });
  $('[style]').each((_i, el) => {
    $(el).attr('style', rewriteCss($(el).attr('style') ?? '', base, key));
  });

  $('script:not([src])').each((_i, el) => {
    const type = ($(el).attr('type') ?? '').toLowerCase();
    if (type && type !== 'module' && !/javascript|ecmascript/.test(type)) return;
    const js = $(el).html();
    if (js && /\bimport\b|\bexport\b/.test(js)) $(el).html(rewriteInlineImports(js, base, key));
  });

  $('meta[http-equiv]').each((_i, el) => {
    const equiv = ($(el).attr('http-equiv') ?? '').toLowerCase();
    if (equiv === 'refresh') {
      const content = $(el).attr('content') ?? '';
      $(el).attr('content', content.replace(/(url\s*=\s*)(['"]?)([^'"]+)\2/i, (_m, p: string, q: string, u: string) => `${p}${q}${proxify(u, base, key)}${q}`));
    } else if (equiv.startsWith('content-security-policy')) {
      $(el).remove();
    }
  });

  // Integrity-Hashes passen nach dem Umschreiben nicht mehr.
  $('link[integrity], script[integrity]').removeAttr('integrity');

  const config = JSON.stringify(base).replace(/</g, '\\u003c');
  $('head').prepend(`<script>window.__PROXY_BASE=${config};</script><script src="/__proxy/client.js"></script>`);

  return $.html();
}
