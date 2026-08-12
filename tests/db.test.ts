import { describe, expect, it } from 'vitest';
import { schemaStatements } from '../src/worker/db';

describe('schemaStatements', () => {
  it('splits on semicolons and drops comments', () => {
    const statements = schemaStatements(`
      -- a comment; with a semicolon
      CREATE TABLE IF NOT EXISTS a (id TEXT PRIMARY KEY);

      -- another comment
      CREATE INDEX IF NOT EXISTS idx_a ON a (id);
    `);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS a/);
    expect(statements[1]).toMatch(/^CREATE INDEX IF NOT EXISTS idx_a/);
  });

  it('returns no empty statements for trailing semicolons and whitespace', () => {
    expect(schemaStatements('SELECT 1; \n ; ;')).toEqual(['SELECT 1']);
  });
});
