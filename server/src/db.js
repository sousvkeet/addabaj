import pg from 'pg';
import { config } from './config.js';

// Return bigint columns (message ids, counts) as JS numbers.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export function query(text, params) {
  return pool.query(text, params);
}

export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] ?? null;
}

export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
