import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { sanitizeStandaloneUpdates } from '../src/server.js';

test('the published standalone update registry is valid', async () => {
  const value = JSON.parse(await readFile(resolve(process.cwd(), 'data/standalone-updates.json'), 'utf8'));
  const result = sanitizeStandaloneUpdates(value);
  assert.equal(result.schema_version, 1);
  assert.equal(result.publications[0]?.id, 'new-ui-impulse');
  assert.ok(result.publications[0]?.versions.includes('1.3.0'));
});

test('standalone updates reject duplicate ids and unsafe images', () => {
  const publication = {
    id: 'news', title: 'News', subtitle: 'Details', versions: ['1.3.0'],
    published_at: '2026-08-30T00:00:00Z', hero_image_url: 'http://example.com/image.png',
    sections: [{ icon: 'sparkles', title: 'Title', body: 'Body' }],
  };
  assert.throws(() => sanitizeStandaloneUpdates({ schema_version: 1, publications: [publication] }), /HTTPS/u);
  publication.hero_image_url = null as unknown as string;
  assert.throws(() => sanitizeStandaloneUpdates({ schema_version: 1, publications: [publication, publication] }), /duplicate/u);
});
