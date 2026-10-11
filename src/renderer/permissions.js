'use strict';

const list = document.getElementById('prompts');
const cards = new Map();

function applyAccent(color) {
  if (color) document.documentElement.style.setProperty('--accent', color);
}
window.permissions.getAccent().then(applyAccent);
window.permissions.onTheme(applyAccent);

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

function div(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  if (text) el.textContent = text;
  return el;
}

function render(prompt) {
  if (cards.has(prompt.id)) return;
  const card = div('prompt');
  const answer = (payload) => window.permissions.respond(prompt.id, payload);

  card.appendChild(div('source', prompt.source === 'pi' ? 'pi extension' : 'Leslie'));
  if (prompt.title) card.appendChild(div('title', prompt.title));
  const fallback = prompt.method === 'approve' ? 'Run this command?' : '';
  if (prompt.message || fallback) card.appendChild(div('message', prompt.message || fallback));

  const actions = div('actions');
  const cancel = button('Cancel', 'no', () => answer({ cancelled: true }));

  if (prompt.method === 'approve') {
    actions.append(button('Approve', 'yes', () => answer({ approved: true })), button('Deny', 'no', () => answer({ approved: false })));
  } else if (prompt.method === 'confirm') {
    actions.append(button('Yes', 'yes', () => answer({ confirmed: true })), button('No', 'no', () => answer({ confirmed: false })));
  } else if (prompt.method === 'select') {
    const options = div('options');
    for (const opt of prompt.options || []) options.appendChild(button(opt, '', () => answer({ value: opt })));
    card.appendChild(options);
    actions.appendChild(cancel);
  } else {
    const editor = prompt.method === 'editor';
    const field = document.createElement(editor ? 'textarea' : 'input');
    field.className = 'field';
    if (editor) {
      field.rows = 6;
      field.value = prompt.prefill || '';
    } else {
      field.placeholder = prompt.placeholder || '';
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          answer({ value: field.value });
        }
      });
    }
    card.appendChild(field);
    actions.append(button(editor ? 'Save' : 'OK', 'yes', () => answer({ value: field.value })), cancel);
    setTimeout(() => field.focus({ preventScroll: true }), 0);
  }

  card.appendChild(actions);
  list.appendChild(card);
  cards.set(prompt.id, card);
}

window.permissions.onAdd(render);
window.permissions.onRemove((id) => {
  const card = cards.get(id);
  if (card) card.remove();
  cards.delete(id);
});
window.permissions.list().then((prompts) => prompts.forEach(render));
