'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchSiteText, htmlToText } = require('../src/siteText');
const { silentLogger } = require('../src/logger');

function htmlResponse(html, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => html };
}

test('htmlToText keeps the words and drops the markup', () => {
  const text = htmlToText(`
    <html><head><style>.x{color:red}</style><script>var a = 1;</script></head>
    <body><h1>Partnerships</h1><p>Email press&#64;brand.com or marketing [at] brand.com</p>
    <div>Creator&nbsp;program</div></body></html>`);

  assert.match(text, /Partnerships/);
  assert.match(text, /press@brand\.com/);
  assert.doesNotMatch(text, /var a = 1/, 'inline scripts are removed');
  assert.doesNotMatch(text, /<p>|<\/p>/);
  assert.doesNotMatch(text, /color:red/);
});

test('fetchSiteText walks the usual pages and skips failures', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.endsWith('/contact')) return htmlResponse('<p>Partnerships: press@brand.com</p>');
    if (url.endsWith('/about')) return htmlResponse('nope', 500);
    return htmlResponse('<h1>Brand</h1><p>We make things.</p>');
  };

  const page = await fetchSiteText({
    domain: 'brand.com',
    fetchImpl,
    timeoutMs: 2000,
    logger: silentLogger,
    paths: ['/', '/contact', '/about']
  });

  assert.equal(seen.length, 3);
  assert.match(page.text, /We make things\./);
  assert.match(page.text, /press@brand\.com/);
  assert.deepEqual(page.pages, ['https://brand.com/', 'https://brand.com/contact']);
});

test('fetchSiteText survives a site that never answers', async () => {
  const page = await fetchSiteText({
    domain: 'offline.test',
    timeoutMs: 500,
    logger: silentLogger,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    }
  });
  assert.equal(page.text, '');
  assert.deepEqual(page.pages, []);
});
