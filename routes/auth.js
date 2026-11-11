import { Router } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';
import { formatPhone } from '../utils/daraja.js';
import rateLimit from '../utils/rateLimit.js';

const router = Router();

const authLimit = rateLimit({ max: 20, message: 'Too many attempts. Please wait a few minutes and try again.' });

const sign = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });

const publicUser = (u) => ({
  _id: u._id,
  name: u.name,
  username: u.username,
  email: u.email,
  phone: u.phone,
  role: u.role,
  mustChangePassword: Boolean(u.mustChangePassword),
  createdAt: u.createdAt,
});

router.post('/signup', authLimit, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const phoneRaw = String(req.body.phone || '').trim();

    if (!name) return res.status(400).json({ message: 'Please enter your name' });
    if (!/^[a-z0-9_.-]{3,30}$/.test(username))
      return res.status(400).json({ message: 'Username must be 3-30 letters, numbers, dots, dashes or underscores' });
    if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });

    let phone;
    if (phoneRaw) {
      phone = formatPhone(phoneRaw);
      if (!/^254[17]\d{8}$/.test(phone)) return res.status(400).json({ message: 'Enter a valid phone number e.g. 0712345678' });
    }

    if (await User.findOne({ username })) return res.status(409).json({ message: 'That username is already taken' });

    // Role is never taken from the request: signups are always customers.
    const user = await User.create({ name, username, password, phone, role: 'user' });
    res.status(201).json({ token: sign(user._id), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', authLimit, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = await User.findOne({ username }).select('+password');

    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ message: 'Incorrect username or password' });
    }
    res.json({ token: sign(user._id), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.get('/me', protect, (req, res) => {
  res.json(publicUser(req.user));
});

// Customer edits their own name / phone (Account page)
router.put('/me', protect, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const phoneRaw = String(req.body.phone || '').trim();
    if (!name) return res.status(400).json({ message: 'Please enter your name' });

    let phone = '';
    if (phoneRaw) {
      phone = formatPhone(phoneRaw);
      if (!/^254[17]\d{8}$/.test(phone)) return res.status(400).json({ message: 'Enter a valid phone number e.g. 0712345678' });
    }

    req.user.name = name;
    req.user.phone = phone;
    await req.user.save();
    res.json(publicUser(req.user));
  } catch (err) {
    next(err);
  }
});

// Change your own password (customers and admin)
router.put('/password', protect, authLimit, async (req, res, next) => {
  try {
    const current = String(req.body.currentPassword || '');
    const next_ = String(req.body.newPassword || '');
    if (next_.length < 6) return res.status(400).json({ message: 'The new password must be at least 6 characters' });
    if (next_ === current) return res.status(400).json({ message: 'Choose a password different from the current one' });

    const user = await User.findById(req.user._id).select('+password');
    if (!(await user.matchPassword(current))) return res.status(400).json({ message: 'The current password is not correct' });

    user.password = next_;
    user.mustChangePassword = false;
    await user.save();
    res.json({ message: 'Password changed', user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

export default router;
