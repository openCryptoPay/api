#!/usr/bin/env node
/**
 * Tests for the database-change notice check. No extra packages.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MARKER, evaluate, isMarkerVisible, visibleBody } from './db-change-notice.mjs';

const PLAIN_MARKER = MARKER.replaceAll('\uFE0F', '');

/**
 * Build a one-file pull-request list.
 * @param {string} filename
 * @param {string | undefined} patch Omit the patch when `patch` is `undefined`.
 * @returns {Array<{ filename: string, status: string, patch?: string }>}
 */
function files(filename, patch) {
  /** @type {{ filename: string, status: string, patch?: string }} */
  const entry = { filename, status: 'modified' };
  if (patch !== undefined) entry.patch = patch;
  return [entry];
}

/**
 * Unified diff whose only changed content line is `line`.
 * @param {string} line
 * @returns {string}
 */
function diffWith(line) {
  return `--- a/src/lib/map/place.ts\n+++ b/src/lib/map/place.ts\n${line}\n`;
}

describe('path triggers', () => {
  it('triggers for docs/schema, docs/database, integration, sqlite.ts, and store.ts', () => {
    const names = [
      'docs/schema/map-place.sql',
      'docs/database/README.md',
      'integration/db-schema-reference.test.ts',
      'src/lib/map/sqlite.ts',
      'src/lib/map/store.ts',
    ];
    for (const filename of names) {
      const result = evaluate({
        body: '',
        files: files(filename, diffWith('+export const n = 1;')),
      });
      assert.deepEqual(result.triggers, [filename]);
      assert.equal(result.required, true);
      assert.equal(result.ok, false);
    }
  });

  it('keeps the first filename order and drops duplicates', () => {
    const result = evaluate({
      body: MARKER,
      files: [
        ...files('docs/schema/map-place.sql', ''),
        ...files('README.md', diffWith('+db.query(1);')),
        ...files('docs/schema/map-place.sql', ''),
        ...files('integration/run.ts'),
      ],
    });
    assert.deepEqual(result.triggers, ['docs/schema/map-place.sql', 'integration/run.ts']);
    assert.equal(result.ok, true);
  });
});

describe('patch triggers under src', () => {
  /** @type {Array<[string, string]>} */
  const patterns = [
    ['_SCHEMA_SQL', '+const q = _SCHEMA_SQL;'],
    ['.exec(', "+db.exec('PRAGMA foreign_keys = ON');"],
    ['.query(', '+db.query(text);'],
    ['.prepare(', '+db.prepare(text);'],
    ['.run(', '+db.run(text);'],
    ['new Database(', '+const db = new Database(path);'],
    ['PRAGMA', '+const p = "PRAGMA table_info(map_place)";'],
    ['SELECT FROM', '+const q = "select id from map_place";'],
    ['INSERT INTO', '+const q = "INSERT INTO map_place values (1)";'],
    ['UPDATE SET', '+const q = "UPDATE map_place SET name = 1";'],
    ['DELETE FROM', '+const q = "delete from map_place";'],
    ['CREATE INDEX', '+const q = "CREATE INDEX map_place_idx ON map_place (id)";'],
    ['CREATE UNIQUE INDEX', '+const q = "create unique index map_place_idx on map_place (id)";'],
    ['CREATE TABLE', '+const q = "CREATE TABLE map_place (id int)";'],
    ['ALTER TABLE', '+const q = "alter table map_place add column n int";'],
    ['DROP TABLE', '+const q = "DROP TABLE map_place";'],
    ['DROP INDEX', '+const q = "drop index map_place_idx";'],
    ['ON CONFLICT', '+const q = "ON CONFLICT DO NOTHING";'],
    ['removed line', '-db.query(text);'],
  ];

  for (const [name, line] of patterns) {
    it(`triggers on ${name}`, () => {
      const result = evaluate({
        body: '',
        files: files('src/lib/map/place.ts', diffWith(line)),
      });
      assert.deepEqual(result.triggers, ['src/lib/map/place.ts']);
      assert.equal(result.required, true);
      assert.equal(result.ok, false);
    });
  }

  it('does not trigger on the removed patterns', () => {
    for (const line of [
      '+await migrateUserSchema();',
      '+const q = sql`select 1`;',
      '+await sql.unsafe(text);',
    ]) {
      const result = evaluate({
        body: '',
        files: files('src/lib/map/place.ts', diffWith(line)),
      });
      assert.deepEqual(result.triggers, []);
      assert.equal(result.ok, true);
    }
  });

  it('fail-closes when a src TypeScript patch is missing or empty', () => {
    for (const patch of [undefined, '']) {
      const result = evaluate({ body: '', files: files('src/lib/map/place.ts', patch) });
      assert.deepEqual(result.triggers, ['src/lib/map/place.ts']);
      assert.equal(result.ok, false);
    }
  });
});

describe('non-triggers', () => {
  it('ignores SQL under src/__tests__', () => {
    for (const filename of ['src/__tests__/place.test.ts', 'src/lib/map/__tests__/place.test.ts']) {
      const result = evaluate({
        body: '',
        files: files(filename, diffWith('+const q = "SELECT id FROM map_place";')),
      });
      assert.deepEqual(result.triggers, []);
      assert.equal(result.required, false);
      assert.equal(result.ok, true);
    }
  });

  it('ignores a TypeScript edit that does not touch the database', () => {
    const result = evaluate({
      body: '',
      files: files('src/lib/map/place.ts', diffWith('+export const n = 1;')),
    });
    assert.deepEqual(result, { required: false, ok: true, triggers: [] });
  });

  it('ignores a non-src file even when the patch contains SQL', () => {
    const result = evaluate({
      body: undefined,
      files: files('README.md', diffWith('+const q = "DELETE FROM map_place";')),
    });
    assert.equal(result.ok, true);
    assert.equal(result.required, false);
  });

  it('ignores +++ and --- header lines', () => {
    const patch = [
      '--- SELECT id FROM map_place a/src/lib/map/place.ts',
      '+++ INSERT INTO map_place b/src/lib/map/place.ts',
      ' context line .query(',
      '+export const n = 1;',
    ].join('\n');
    const result = evaluate({ body: '', files: files('src/lib/map/place.ts', patch) });
    assert.deepEqual(result.triggers, []);
  });

  it('stays ok with no files when the body is empty or omitted', () => {
    assert.deepEqual(evaluate({ body: '', files: [] }), {
      required: false,
      ok: true,
      triggers: [],
    });
    assert.deepEqual(evaluate({ body: undefined, files: [] }), {
      required: false,
      ok: true,
      triggers: [],
    });
    assert.deepEqual(evaluate({ files: [] }), { required: false, ok: true, triggers: [] });
  });
});

describe('marker visibility', () => {
  const hidden = [
    ['details', `<details>\n${MARKER}\n</details>`],
    [
      'nested details',
      `<details>\n<details open>\n${MARKER}\n</details>\nstill hidden\n</details>`,
    ],
    ['details any case', `<DETAILS>\n${MARKER}\n</DETAILS>`],
    ['backtick fence', `\`\`\`md\n${MARKER}\n\`\`\``],
    ['tilde fence', `~~~\n${MARKER}\n~~~`],
    ['html comment', `<!--\n${MARKER}\n-->`],
  ];

  for (const [name, body] of hidden) {
    it(`rejects a marker that is only inside ${name}`, () => {
      assert.equal(isMarkerVisible(body), false);
      assert.equal(visibleBody(body).includes(PLAIN_MARKER), false);
      const result = evaluate({ body, files: files('docs/schema/map-place.sql', '') });
      assert.equal(result.required, true);
      assert.equal(result.ok, false);
    });
  }

  it('accepts the marker on its own line, including without U+FE0F', () => {
    assert.notEqual(PLAIN_MARKER, MARKER);
    assert.equal(isMarkerVisible(`note\n${MARKER}\n`), true);
    assert.equal(isMarkerVisible(`\n  ${PLAIN_MARKER}  \n`), true);
    const result = evaluate({
      body: PLAIN_MARKER,
      files: files('src/lib/map/store.ts', '+export const n = 1;'),
    });
    assert.equal(result.required, true);
    assert.equal(result.ok, true);
  });

  it('rejects the marker when the same line has other text', () => {
    assert.equal(isMarkerVisible(`see ${MARKER}`), false);
    assert.equal(isMarkerVisible(`${MARKER} now`), false);
    const result = evaluate({
      body: `see ${MARKER}`,
      files: files('integration/job.ts'),
    });
    assert.equal(result.ok, false);
  });

  it('keeps a marker that sits outside a nested details block', () => {
    const body = `<details><details>\nhidden\n</details></details>\n${MARKER}\n`;
    assert.equal(isMarkerVisible(body), true);
    assert.equal(visibleBody(body).includes('hidden'), false);
  });
});

it('a </details> inside inline code does not reveal a hidden marker', () => {
  const body = '<details>\n`</details>`\n\n⚠️ 🗄️ Attention: database change\n\n</details>';
  assert.equal(isMarkerVisible(body), false);
});

it('a </details> inside indented code does not reveal a hidden marker', () => {
  const body = '<details>\n\n    </details>\n\n⚠️ 🗄️ Attention: database change\n\n</details>';
  assert.equal(isMarkerVisible(body), false);
});

it('a visible marker next to inline code stays visible', () => {
  assert.equal(isMarkerVisible('Uses `sql.query`.\n\n⚠️ 🗄️ Attention: database change'), true);
});
