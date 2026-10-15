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
