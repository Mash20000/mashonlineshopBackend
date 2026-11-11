import { Router } from 'express';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Review from '../models/Review.js';
import { protect, adminOnly, optionalAuth } from '../middleware/auth.js';
import upload from '../middleware/upload.js';
import { uploadImageBuffer, deleteImage } from '../config/cloudinary.js';

const router = Router();

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const csv = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const SORTS = {
  newest: { createdAt: -1 },
  'price-asc': { price: 1 },
  'price-desc': { price: -1 },
  name: { name: 1 },
};

// Option groups such as Size, Color, RAM. Sent from the admin form as JSON.
const parseOptionGroups = (raw) => {
  let list = [];
  if (raw) {
    try {
      list = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('Product options are not valid'), { status: 400 });
    }
  }
  if (!Array.isArray(list)) throw Object.assign(new Error('Product options are not valid'), { status: 400 });

  const seen = new Set();
  const groups = [];
  for (const item of list.slice(0, 10)) {
    const name = String(item?.name || '').trim().slice(0, 30);
    const values = [...new Set((Array.isArray(item?.values) ? item.values : []).map((v) => String(v).trim().slice(0, 30)).filter(Boolean))].slice(0, 30);
    if (!name || !values.length || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    groups.push({ name, values });
  }
  return groups;
};

// Reads and validates the add / edit product form. Returns { error } or { data }.
const readProductBody = (body) => {
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  const category = String(body.category || '').trim();
  const price = Number(body.price);
  const stock = body.stock === undefined || body.stock === '' ? 1 : Number(body.stock);
  const onOffer = body.onOffer === true || ['true', 'on', '1'].includes(String(body.onOffer));

  if (!name || !description || !category) return { error: 'Name, category and description are required' };
  if (!Number.isFinite(price) || price <= 0) return { error: 'Enter a valid price' };
  if (!Number.isInteger(stock) || stock < 0) return { error: 'Stock must be a whole number' };

  let offerPrice = null;
  if (onOffer) {
    offerPrice = Number(body.offerPrice);
    if (!Number.isFinite(offerPrice) || offerPrice <= 0 || offerPrice >= price) {
      return { error: 'The offer price must be more than 0 and lower than the normal price' };
    }
  }

  let costPrice = null;
  if (body.costPrice !== undefined && String(body.costPrice).trim() !== '') {
    costPrice = Number(body.costPrice);
    if (!Number.isFinite(costPrice) || costPrice < 0) return { error: 'Enter a valid cost price (what you paid for the item)' };
  }

  let optionGroups;
  try {
    optionGroups = parseOptionGroups(body.options);
  } catch (err) {
    return { error: err.message };
  }

  return { data: { name, description, category, price, stock, costPrice, onOffer, offerPrice, optionGroups } };
};

// GET /api/products?q=&category=&sort=&page=&limit=&offer=true&ids=a,b
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const category = String(req.query.category || '').trim();
    const sort = SORTS[String(req.query.sort)] || SORTS.newest;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12));

    const filter = {};
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ name: rx }, { description: rx }, { category: rx }];
    }
    if (category) filter.category = new RegExp(escapeRegex(category), 'i');
    if (String(req.query.offer) === 'true') filter.onOffer = true;
    if (req.query.ids) filter._id = { $in: csv(req.query.ids).filter((id) => mongoose.isValidObjectId(id)) };

    const total = await Product.countDocuments(filter);
    const query = Product.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit);
    if (req.user?.role === 'admin') query.select('+costPrice'); // the buying price is for the admin only
    const products = await query;

    res.json({ products, page, pages: Math.max(1, Math.ceil(total / limit)), total });
  } catch (err) {
    next(err);
  }
});

router.get('/categories', async (req, res, next) => {
  try {
    const categories = await Product.distinct('category');
    res.json(categories.sort((a, b) => a.localeCompare(b)));
  } catch (err) {
    next(err);
  }
});

// Suggestions for the cart page: same categories as the items in the cart first, then other products.
// GET /api/products/related?categories=Electronics,Fashion&exclude=id1,id2&limit=24
router.get('/related', async (req, res, next) => {
  try {
    const categories = csv(req.query.categories);
    const exclude = csv(req.query.exclude).filter((id) => mongoose.isValidObjectId(id));
    const limit = Math.min(48, Math.max(1, parseInt(req.query.limit, 10) || 24));

    let list = [];
    if (categories.length) {
      list = await Product.find({
        stock: { $gt: 0 },
        _id: { $nin: exclude },
        category: { $in: categories.map((c) => new RegExp(`^${escapeRegex(c)}$`, 'i')) },
      })
        .sort({ createdAt: -1 })
        .limit(limit);
    }

    if (list.length < limit) {
      const skip = [...exclude, ...list.map((p) => p._id)];
      const more = await Product.find({ stock: { $gt: 0 }, _id: { $nin: skip } })
        .sort({ createdAt: -1 })
        .limit(limit - list.length);
      list = list.concat(more);
    }

    res.json(list);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Product not found' });
    const query = Product.findById(req.params.id);
    if (req.user?.role === 'admin') query.select('+costPrice');
    const product = await query;
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (err) {
    next(err);
  }
});

// Admin: add a product. The image is uploaded to Cloudinary and its link is saved in MongoDB.
router.post('/', protect, adminOnly, upload.single('image'), async (req, res, next) => {
  try {
    const { error, data } = readProductBody(req.body);
    if (error) return res.status(400).json({ message: error });
    if (!req.file) return res.status(400).json({ message: 'Please choose a product image' });

    const { url, publicId } = await uploadImageBuffer(req.file.buffer);
    const product = await Product.create({ ...data, image: url, imagePublicId: publicId });
    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
});

// Admin: edit a product (name, price, stock, offer, options...). A new image is optional.
router.put('/:id', protect, adminOnly, upload.single('image'), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Product not found' });
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const { error, data } = readProductBody(req.body);
    if (error) return res.status(400).json({ message: error });

    let oldImageId = null;
    if (req.file) {
      const { url, publicId } = await uploadImageBuffer(req.file.buffer);
      oldImageId = product.imagePublicId;
      product.image = url;
      product.imagePublicId = publicId;
    }

    product.name = data.name;
    product.description = data.description;
    product.category = data.category;
    product.price = data.price;
    product.stock = data.stock;
    product.costPrice = data.costPrice;
    product.onOffer = data.onOffer;
    product.offerPrice = data.offerPrice;
    product.optionGroups = data.optionGroups;
    await product.save();

    if (oldImageId) deleteImage(oldImageId).catch(() => {});
    res.json(product);
  } catch (err) {
    next(err);
  }
});

// Admin: change a few fields in one click from the Store page (price, stock, offer, cost price).
// body can hold: price, stock, addStock, costPrice, onOffer, offerPrice
router.patch('/:id/quick', protect, adminOnly, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Product not found' });
    const product = await Product.findById(req.params.id).select('+costPrice');
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const b = req.body || {};
    const has = (k) => b[k] !== undefined && b[k] !== null && b[k] !== '';
    const bad = (message) => res.status(400).json({ message });

    if (has('price')) {
      const v = Number(b.price);
      if (!Number.isFinite(v) || v <= 0) return bad('Enter a valid price');
      product.price = v;
    }
    if (has('stock')) {
      const v = Number(b.stock);
      if (!Number.isInteger(v) || v < 0) return bad('Stock must be a whole number');
      product.stock = v;
    }
    if (has('addStock')) {
      const v = Number(b.addStock);
      if (!Number.isInteger(v) || v <= 0 || v > 100000) return bad('Enter how many items to add');
      product.stock += v;
    }
    if (b.costPrice === null || b.costPrice === '') {
      product.costPrice = null;
    } else if (b.costPrice !== undefined) {
      const v = Number(b.costPrice);
      if (!Number.isFinite(v) || v < 0) return bad('Enter a valid cost price');
      product.costPrice = v;
    }
    if (b.onOffer !== undefined) {
      product.onOffer = b.onOffer === true || b.onOffer === 'true';
      if (!product.onOffer) product.offerPrice = null;
    }
    if (product.onOffer) {
      if (has('offerPrice')) product.offerPrice = Number(b.offerPrice);
      const o = Number(product.offerPrice);
      if (!Number.isFinite(o) || o <= 0 || o >= product.price) return bad('The offer price must be more than 0 and lower than the normal price');
    }

    await product.save();
    res.json(product);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', protect, adminOnly, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Product not found' });
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (product.imagePublicId) deleteImage(product.imagePublicId).catch(() => {});
    Review.deleteMany({ product: product._id }).catch(() => {});
    res.json({ message: 'Product deleted' });
  } catch (err) {
    next(err);
  }
});

export default router;
