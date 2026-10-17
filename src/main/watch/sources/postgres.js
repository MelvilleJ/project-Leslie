'use strict';

const { Client, escapeIdentifier } = require('pg');

const MAX_ROWS = 50;
const CURSOR = '__leslie_cursor';

/** "schema.table:column" -> { table, column }; the column defaults to id. */
function parseTable(spec) {
  const [table, column = 'id'] = spec.split(':').map((s) => s.trim());
  return { table, column };
}

const quote = (name) => name.split('.').map(escapeIdentifier).join('.');

// The cursor travels as text so timestamps keep their microseconds; a JS Date
// would round them and re-announce rows that share a millisecond.
function newRowsQuery({ table, column }, after) {
  const col = escapeIdentifier(column);
  const where = after == null ? '' : `WHERE ${col} > $1`;
  return {
    text: `SELECT *, ${col}::text AS ${CURSOR} FROM ${quote(table)} ${where} ORDER BY ${col} LIMIT ${MAX_ROWS}`,
    values: after == null ? [] : [after]
  };
}

function latestQuery({ table, column }) {
  return { text: `SELECT max(${escapeIdentifier(column)})::text AS ${CURSOR} FROM ${quote(table)}` };
}

function toItem(table, row) {
  const { [CURSOR]: _cursor, ...fields } = row;
  return { title: `a new row in ${table}`, detail: JSON.stringify(fields) };
}

function createPostgresSource({ url, tables, intervalMs }) {
  const specs = tables.map(parseTable);

  async function poll(cursor) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
    await client.connect();
    try {
      const next = { ...cursor };
      const items = [];
      for (const spec of specs) {
        // A table missing from the cursor is new to the watch list: baseline it.
        if (!cursor || !(spec.table in cursor)) {
          next[spec.table] = (await client.query(latestQuery(spec))).rows[0][CURSOR];
          continue;
        }
        const { rows } = await client.query(newRowsQuery(spec, cursor[spec.table]));
        for (const row of rows) items.push(toItem(spec.table, row));
        if (rows.length) next[spec.table] = rows[rows.length - 1][CURSOR];
      }
      return { items, cursor: next };
    } finally {
      await client.end().catch(() => {});
    }
  }

  return { name: 'postgres', noun: 'database entry', intervalMs, poll };
}

module.exports = { createPostgresSource, parseTable, newRowsQuery };
