'use strict';

function normalizeUrl(u) {
  let url = String(u).trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

module.exports = {
  name: 'open_url',
  readOnly: true,
  description:
    "Open a web page in LESLIE's window so the user can see it. Use when the user " +
    'asks to open, show, visit, or go to a specific URL or website.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL or domain to open, e.g. "example.com" or "https://example.com/page".'
      }
    },
    required: ['url']
  },
  async run({ url }, ctx) {
    if (!url || !String(url).trim()) throw new Error('url is required');
    const target = normalizeUrl(url);
    if (ctx && ctx.openUrl) ctx.openUrl(target);
    return { opened: target };
  }
};
