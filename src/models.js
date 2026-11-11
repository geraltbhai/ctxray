'use strict';
/**
 * Model pricing table.
 *
 * Prices are USD per 1,000,000 tokens and were checked on 2026-11-11. Vendors
 * change these often — `ctxray --models` prints the table, and you can override
 * it entirely with a `models` key in .ctxrayrc.json or a --pricing <file> flag.
 *
 * `context` is the usable input window in tokens.
 * `cachedInput`, where present, is the price for a prompt-cache read.
 */

const MODELS = [
  {
    id: 'opus-5.5', label: 'Claude Opus 5.5', vendor: 'Anthropic',
    input: 4.0, output: 20.0, cachedInput: 0.2, context: 1000000, default: true,
  },
  {
    id: 'sonnet-5.5', label: 'Claude Sonnet 5.5', vendor: 'Anthropic',
    input: 2.0, output: 10.0, cachedInput: 0.1, context: 1000000, default: true,
  },
  {
    id: 'haiku-5.5', label: 'Claude Haiku 5.5', vendor: 'Anthropic',
    input: 0.1, output: 0.5, cachedInput: 0.01, context: 1000000, default: true,
    note: '$0.50 input once a prompt passes 100k tokens',
  },
  {
    id: 'gpt-5-class', label: 'GPT-5 class', vendor: 'OpenAI',
    input: 5.0, output: 30.0, cachedInput: 0.5, context: 400000, default: true,
  },
  {
    id: 'gemini-3-pro', label: 'Gemini 3.x Pro', vendor: 'Google',
    input: 2.0, output: 12.0, context: 1000000, default: true,
    note: '$4.00 input above 200k context',
  },
  {
    id: 'gemini-flash', label: 'Gemini Flash-Lite', vendor: 'Google',
    input: 0.3, output: 2.5, context: 1000000,
  },
  // Previous generation, kept so `--model opus-5` and old configs keep working.
  {
    id: 'opus-5', label: 'Claude Opus 5', vendor: 'Anthropic',
    input: 5.0, output: 25.0, cachedInput: 0.5, context: 200000,
  },
  {
    id: 'sonnet-5', label: 'Claude Sonnet 5', vendor: 'Anthropic',
    input: 2.0, output: 10.0, cachedInput: 0.2, context: 200000,
  },
  {
    id: 'haiku-4.5', label: 'Claude Haiku 4.5', vendor: 'Anthropic',
    input: 1.0, output: 5.0, cachedInput: 0.1, context: 200000,
  },
];

// Anthropic rows rechecked 2026-11-11. OpenAI and Google rows were spot-checked
// the same day against public price trackers, not the vendors' own pages.
const PRICES_CHECKED = '2026-11-11';

function byId(id) {
  return MODELS.find((m) => m.id === id) || null;
}

function defaults() {
  return MODELS.filter((m) => m.default);
}

/** Cost in USD of sending `tokens` input tokens once. */
function inputCost(model, tokens) {
  return (tokens / 1e6) * model.input;
}

module.exports = { MODELS, PRICES_CHECKED, byId, defaults, inputCost };
