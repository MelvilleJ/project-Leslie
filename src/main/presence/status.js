'use strict';

// Who the camera currently sees, shared with the tool policy and the agent's
// system prompt. Kept free of Electron so both can be tested.

const config = require('../config');

let current = { active: false, present: [], unknown: false };
let roster = [];

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/** Everyone enrolled, so the owner can be named even while the camera is off. */
function setRoster(people) {
  roster = people || [];
}

/**
 * First name to call the person at the desk: the owner if present, else the
 * guest in view. Unseen (or camera off) falls back to the owner; a stranger gets none.
 */
function addressName() {
  const owner = roster.find((p) => p.role === 'owner');
  if (!current.active) return firstName(owner?.name);
  const here = current.present.find((p) => p.role === 'owner') || current.present[0];
  if (here) return firstName(here.name);
  return current.unknown ? '' : firstName(owner?.name);
}

function set({ active, present = [], unknown = false }) {
  current = { active: Boolean(active), present, unknown: Boolean(unknown) };
}

function snapshot() {
  const ownerPresent = current.present.some((p) => p.role === 'owner');
  const others = current.present.filter((p) => p.role !== 'owner');
  return {
    ...current,
    ownerPresent,
    anyone: current.present.length > 0 || current.unknown,
    guests: others,
    restricted: restricted(),
    name: addressName()
  };
}

/** A non-owner is at the desk and the owner is not. An empty desk restricts nothing. */
function restricted() {
  if (!current.active || !config.cameraOwnerGating) return false;
  if (current.present.some((p) => p.role === 'owner')) return false;
  return current.unknown || current.present.length > 0;
}

function ownerPresent() {
  return current.active && current.present.some((p) => p.role === 'owner');
}

function listNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The camera section of the agent's system prompt; '' when the camera is off. */
function format() {
  if (!current.active) return '';
  const owner = current.present.find((p) => p.role === 'owner');
  const others = current.present.filter((p) => p.role !== 'owner').map((p) => `${p.name} (a guest)`);
  if (current.unknown) others.push('someone you do not recognise');

  if (!owner && !others.length) {
    return 'Camera: nobody is at the desk right now. The user may still be talking to you from across the room.';
  }
  if (owner) {
    const company = others.length ? ` with ${listNames(others)}. Others can see and hear your replies, so be discreet about private matters` : '';
    return `Camera: the owner, ${owner.name}, is at the desk${company}. Call them ${firstName(owner.name)}.`;
  }
  const lines = [
    `Camera: ${listNames(others)} ${others.length > 1 ? 'are' : 'is'} at the desk and the owner is not.`,
    'Address guests by their first name.',
    "Do not reveal the owner's private information: memories, email, messages, documents or files."
  ];
  if (restricted()) lines.push('Commands, file access and installs are disabled until the owner returns; say so if asked.');
  return lines.join(' ');
}

module.exports = { set, setRoster, snapshot, restricted, ownerPresent, addressName, format };
