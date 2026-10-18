'use strict';

// The models setup offers, tested per LESLIE release (catalog.json). Each tier
// lists the context size and KV cache type that suit it; --fit handles the rest.

const { models } = require('./catalog.json');

const TIERS = ['cpu', 'small', 'medium', 'large'];

const totalBytes = (model) => model.files.reduce((n, f) => n + f.bytes, 0);

const find = (id) => models.find((m) => m.id === id) || null;

/** Models for a tier, the recommended one first. */
function forTier(tier) {
  return models
    .filter((m) => m.tiers[tier])
    .map((m) => ({ ...m, ...m.tiers[tier], bytes: totalBytes(m) }))
    .sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)));
}

const recommended = (tier) => (tier ? forTier(tier)[0] || null : null);

/** Profile settings for a model in a tier: ctx and cache type from the catalog. */
function profileFor(id, tier) {
  const model = find(id);
  if (!model) throw new Error(`${id} is not in the model catalog.`);
  const fit = model.tiers[tier] || model.tiers[TIERS.find((t) => model.tiers[t])];
  return { model: model.id, ctx: fit.ctx, cacheType: fit.cacheType || '' };
}

module.exports = { TIERS, models, find, forTier, recommended, profileFor, totalBytes };
