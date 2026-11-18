// Mini JSON-Schema (no dependencies) for the data validator (docs/EXPANSION.md §4.4).
// Subset: type (incl. 'integer', arrays of types), required, enum, const, minimum, maximum, exclusiveMinimum,
// minLength, maxLength, pattern, items, minItems, maxItems, uniqueItems, properties, additionalProperties
// (boolean or schema), propertyNames, anyOf, oneOf, allOf, not, $ref (local "#/…" or "<file>.schema.json#/…" from
// the registry). Messages are pt-BR; paths are "campo.sub[2].x".

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function typeMatches(t, v) {
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeOf(v) === t;
}

const join = (path, key) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);

function pointer(doc, ptr) {
  if (!ptr || ptr === '#') return doc;
  let cur = doc;
  for (const raw of ptr.replace(/^#\/?/, '').split('/')) {
    if (raw === '') continue;
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    cur = cur?.[k];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * Validate `value` against `schema`.
 * @param {object} schema
 * @param {any} value
 * @param {{registry?: Record<string, object>, root?: object, path?: string}} [opts]
 *   registry: schema files by name ('common.schema.json' -> schema) for cross-file $ref
 * @returns {{path:string, message:string}[]}
 */
export function validate(schema, value, { registry = {}, root = schema, path = '' } = {}) {
  const errors = [];
  check(schema, value, path, root, registry, errors);
  return errors;
}

function resolveRef(ref, root, registry) {
  const [file, ptr] = ref.split('#');
  const doc = file ? registry[file] : root;
  if (!doc) return { error: `$ref para esquema desconhecido: ${ref}` };
  const s = pointer(doc, `#${ptr || ''}`);
  if (s === undefined) return { error: `$ref não resolve: ${ref}` };
  return { schema: s, root: doc };
}

function check(schema, v, path, root, registry, errors) {
  if (schema === true || schema == null) return;
  if (schema === false) { errors.push({ path, message: 'valor não permitido aqui' }); return; }
  const err = (message, p = path) => errors.push({ path: p, message });

  if (schema.$ref) {
    const r = resolveRef(schema.$ref, root, registry);
    if (r.error) { err(r.error); return; }
    check(r.schema, v, path, r.root, registry, errors);
    // siblings of $ref are also applied (draft 2019+ behaviour)
  }
  if (schema.allOf) for (const s of schema.allOf) check(s, v, path, root, registry, errors);
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validate(s, v, { registry, root, path }).length === 0);
    if (!ok) err(schema.anyOfMessage || 'não corresponde a nenhuma das formas aceitas');
  }
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => validate(s, v, { registry, root, path }).length === 0).length;
    if (n !== 1) err(n === 0 ? 'não corresponde a nenhuma das formas aceitas' : 'corresponde a mais de uma forma (oneOf)');
  }
  if (schema.not && validate(schema.not, v, { registry, root, path }).length === 0) err('valor proibido (not)');

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, v))) {
      err(`tipo errado: esperado ${types.join(' ou ')}, veio ${typeOf(v)}`);
      return; // the remaining keywords would only repeat the problem
    }
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(v)) err(`deve ser ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) {
    err(`valor ${JSON.stringify(v)} fora da lista: ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }

  if (typeof v === 'number') {
    if (schema.minimum != null && v < schema.minimum) err(`${v} abaixo do mínimo ${schema.minimum}`);
    if (schema.maximum != null && v > schema.maximum) err(`${v} acima do máximo ${schema.maximum}`);
    if (schema.exclusiveMinimum != null && v <= schema.exclusiveMinimum) err(`${v} deve ser maior que ${schema.exclusiveMinimum}`);
  }
  if (typeof v === 'string') {
    if (schema.minLength != null && v.length < schema.minLength) err(`texto curto demais (mín. ${schema.minLength})`);
    if (schema.maxLength != null && v.length > schema.maxLength) err(`texto longo demais (${v.length} > ${schema.maxLength})`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(v)) err(`"${v.slice(0, 40)}" não segue o padrão ${schema.pattern}`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems != null && v.length < schema.minItems) err(`lista com menos de ${schema.minItems} itens`);
    if (schema.maxItems != null && v.length > schema.maxItems) err(`lista com mais de ${schema.maxItems} itens`);
    if (schema.uniqueItems) {
      const seen = new Set();
      v.forEach((x, i) => {
        const k = JSON.stringify(x);
        if (seen.has(k)) err('item repetido', join(path, i));
        seen.add(k);
      });
    }
    if (schema.items) v.forEach((x, i) => check(schema.items, x, join(path, i), root, registry, errors));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of schema.required || []) if (!(k in v)) err(`campo obrigatório ausente: ${k}`);
    const props = schema.properties || {};
    for (const [k, x] of Object.entries(v)) {
      if (props[k]) check(props[k], x, join(path, k), root, registry, errors);
      else if (schema.additionalProperties === false) err(`campo desconhecido: ${k}`, join(path, k));
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        check(schema.additionalProperties, x, join(path, k), root, registry, errors);
      }
      if (schema.propertyNames) check(schema.propertyNames, k, join(path, k), root, registry, errors);
    }
  }
}
