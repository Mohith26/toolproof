'use strict';
// A small argument validator for tool calls. Not a JSON Schema
// implementation, just the subset an agent runtime actually needs: types,
// required fields, enums, numeric ranges, string length, and rejection of
// arguments nobody declared. Unknown-key rejection matters more here than
// in a web API: a planner that hallucinates an extra argument should hear
// about it on the spot, not have it silently dropped.

function validate(spec, args) {
  const errors = [];
  const input = args === undefined || args === null ? {} : args;
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['arguments must be an object'] };
  }
  for (const [key, rule] of Object.entries(spec || {})) {
    const has = Object.prototype.hasOwnProperty.call(input, key);
    if (!has) {
      if (rule.required) errors.push(`missing required argument "${key}"`);
      continue;
    }
    const val = input[key];
    switch (rule.type) {
      case 'string':
        if (typeof val !== 'string') { errors.push(`"${key}" must be a string`); break; }
        if (rule.maxLen !== undefined && val.length > rule.maxLen) errors.push(`"${key}" longer than ${rule.maxLen}`);
        if (rule.oneOf && !rule.oneOf.includes(val)) errors.push(`"${key}" must be one of ${rule.oneOf.join(', ')}`);
        break;
      case 'number':
        if (typeof val !== 'number' || Number.isNaN(val)) { errors.push(`"${key}" must be a number`); break; }
        if (rule.min !== undefined && val < rule.min) errors.push(`"${key}" below minimum ${rule.min}`);
        if (rule.max !== undefined && val > rule.max) errors.push(`"${key}" above maximum ${rule.max}`);
        if (rule.integer && !Number.isInteger(val)) errors.push(`"${key}" must be an integer`);
        break;
      case 'boolean':
        if (typeof val !== 'boolean') errors.push(`"${key}" must be a boolean`);
        break;
      case 'array':
        if (!Array.isArray(val)) errors.push(`"${key}" must be an array`);
        else if (rule.maxItems !== undefined && val.length > rule.maxItems) errors.push(`"${key}" has more than ${rule.maxItems} items`);
        break;
      default:
        errors.push(`"${key}" has an unknown rule type "${rule.type}"`);
    }
  }
  for (const key of Object.keys(input)) {
    if (!spec || !Object.prototype.hasOwnProperty.call(spec, key)) {
      errors.push(`unexpected argument "${key}"`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validate };

