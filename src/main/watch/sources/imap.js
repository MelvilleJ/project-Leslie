'use strict';

const { ImapFlow } = require('imapflow');

const MAX_MESSAGES = 20;
const MAX_BODY_BYTES = 4000;

function findPart(node, type) {
  if (!node) return null;
  if (node.type === type && node.disposition !== 'attachment') return node.part || '1';
  for (const child of node.childNodes || []) {
    const part = findPart(child, type);
    if (part) return part;
  }
  return null;
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const stripHtml = (html) => html
  .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ');

async function bodyText(client, msg) {
  const plain = findPart(msg.bodyStructure, 'text/plain');
  const part = plain || findPart(msg.bodyStructure, 'text/html');
  if (!part) return '';
  const { content } = await client.download(String(msg.uid), part, { uid: true, maxBytes: MAX_BODY_BYTES });
  if (!content) return '';
  const text = await readStream(content);
  return (plain ? text : stripHtml(text)).replace(/\s+/g, ' ').trim();
}

function sender(envelope) {
  const from = envelope?.from?.[0];
  return from ? from.name || from.address : 'an unknown sender';
}

function createImapSource({ host, port, secure, user, password, mailbox, intervalMs }) {
  async function poll(cursor) {
    const client = new ImapFlow({ host, port, secure, auth: { user, pass: password }, logger: false });
    await client.connect();
    try {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const uidValidity = String(client.mailbox.uidValidity);
        const latest = client.mailbox.uidNext - 1;
        // A changed UIDVALIDITY means the server renumbered the mailbox, so old UIDs mean nothing.
        if (!cursor || cursor.uidValidity !== uidValidity) {
          return { items: [], cursor: { uidValidity, uid: latest } };
        }
        if (latest <= cursor.uid) return { items: [], cursor };

        const fetched = await client.fetchAll(
          `${cursor.uid + 1}:*`,
          { uid: true, flags: true, envelope: true, bodyStructure: true },
          { uid: true }
        );
        // "N:*" always returns the newest message, even when its UID is below N.
        const fresh = fetched.filter((m) => m.uid > cursor.uid);
        const unread = fresh.filter((m) => !m.flags?.has('\\Seen')).slice(-MAX_MESSAGES);

        const items = [];
        for (const msg of unread) {
          items.push({
            title: `from ${sender(msg.envelope)}: ${msg.envelope?.subject || '(no subject)'}`,
            detail: await bodyText(client, msg).catch(() => '')
          });
        }
        const uid = Math.max(cursor.uid, ...fresh.map((m) => m.uid));
        return { items, cursor: { uidValidity, uid } };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  return { name: 'email', noun: 'email', intervalMs, poll };
}

module.exports = { createImapSource, findPart };
