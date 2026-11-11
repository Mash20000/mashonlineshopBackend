import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import connectDB from './config/db.js';
import './config/cloudinary.js';
import seedAdmin from './utils/seedAdmin.js';
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import orderRoutes from './routes/orders.js';
import messageRoutes from './routes/messages.js';
import paymentRoutes from './routes/payments.js';
import chatRoutes from './routes/chat.js';
import reviewRoutes from './routes/reviews.js';
import pushRoutes from './routes/push.js';
import analyticsRoutes from './routes/analytics.js';

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is missing. Add it to server/.env');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // behind ngrok / a hosting proxy: use the real visitor address

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'Mash Online Shop API' });
});

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/analytics', analyticsRoutes);

// Error handler (also catches multer / upload errors)
app.use((err, req, res, next) => {
  console.error(err.message);
  let status = err.status || 500;
  if (err.name === 'MulterError' || err.message === 'Only image files are allowed') status = 400;
  if (err.name === 'CastError' || err.name === 'ValidationError') status = 400;
  const message =
    err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 5 MB)' : status === 500 ? 'Server error' : err.message;
  res.status(status).json({ message });
});

const PORT = process.env.PORT || 5000;

connectDB().then(async () => {
  await seedAdmin();
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
