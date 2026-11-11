import User from '../models/User.js';

const DEFAULT_PASSWORD = 'admin0000';

// Creates the admin account on first start (password is stored hashed).
// While the admin still uses the default password, the site asks to change it.
export default async function seedAdmin() {
  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const exists = await User.findOne({ username }).select('+password');

  if (exists) {
    if (exists.role === 'admin' && !exists.mustChangePassword && (await exists.matchPassword(DEFAULT_PASSWORD))) {
      exists.mustChangePassword = true;
      await exists.save();
    }
    return;
  }

  const password = process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD;
  await User.create({
    name: 'Administrator',
    username,
    password,
    role: 'admin',
    mustChangePassword: password === DEFAULT_PASSWORD,
  });
  console.log(`Admin account created (username: ${username})`);
}
