'use strict';

const crypto = require('node:crypto');

const ROLES = ['owner', 'guest'];

/** Enrolled people ({id, name, role, createdAt}); there is at most one owner. */
function createPeople({ load, save }) {
  let list = (load() || []).filter((p) => p && p.id && p.name);

  const commit = () => save(list);
  const find = (id) => list.find((p) => p.id === id) || null;

  function claimOwner(id) {
    for (const p of list) if (p.id !== id && p.role === 'owner') p.role = 'guest';
  }

  function add({ name, role = 'guest' }) {
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) throw new Error('A name is required.');
    const person = {
      id: `p_${crypto.randomBytes(6).toString('hex')}`,
      name: clean,
      role: ROLES.includes(role) ? role : 'guest',
      createdAt: Date.now()
    };
    list.push(person);
    if (person.role === 'owner') claimOwner(person.id);
    commit();
    return person;
  }

  function update(id, { name, role } = {}) {
    const person = find(id);
    if (!person) return null;
    if (name !== undefined && String(name).trim()) person.name = String(name).trim().slice(0, 60);
    if (ROLES.includes(role)) {
      person.role = role;
      if (role === 'owner') claimOwner(id);
    }
    commit();
    return person;
  }

  function remove(id) {
    const before = list.length;
    list = list.filter((p) => p.id !== id);
    if (list.length !== before) commit();
    return list.length !== before;
  }

  return { list: () => list.map((p) => ({ ...p })), find, add, update, remove };
}

module.exports = { createPeople, ROLES };
