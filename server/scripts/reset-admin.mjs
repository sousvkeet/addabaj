// Locked out? Resets the host admin login to ADMIN_USERNAME / ADMIN_PASSWORD
// from server/.env (default admin / admin) and makes it a host admin again.
//   npm run admin:reset -w server
import bcrypt from 'bcryptjs';
import '../src/config.js';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { isWeakAdminPassword } from '../src/services/site.js';

const login = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || 'admin';
await migrate();
const hash = await bcrypt.hash(password, 10);
const { rowCount } = await pool.query(
  `UPDATE users SET password_hash = $2, site_role = 'admin', disabled_at = NULL, must_change_password = $3 WHERE lower(email) = $1`,
  [login, hash, isWeakAdminPassword(password)],
);
if (!rowCount) {
  await pool.query(
    `INSERT INTO users (email, name, password_hash, avatar_hue, site_role, must_change_password) VALUES ($1, 'Host Admin', $2, 268, 'admin', $3)`,
    [login, hash, isWeakAdminPassword(password)],
  );
}
console.log(`Host admin reset: log in as "${login}" with the password from ADMIN_PASSWORD (or "admin"). Restart the server if it's running.`);
await pool.end();
