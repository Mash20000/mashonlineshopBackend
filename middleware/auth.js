import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Please log in to continue' });

  try {
    const { id } = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(id);
    if (!user) return res.status(401).json({ message: 'Account not found, please log in again' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: 'Session expired, please log in again' });
  }
};

// Identifies the user when a valid token is sent, but lets everybody through (used by public routes that show more to the admin).
export const optionalAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const { id } = jwt.verify(token, process.env.JWT_SECRET);
      req.user = (await User.findById(id)) || undefined;
    } catch {
      /* invalid token: treat as a visitor */
    }
  }
  next();
};

export const adminOnly = (req, res, next) => {
  if (req.user?.role === 'admin') return next();
  res.status(403).json({ message: 'Admin access only' });
};
