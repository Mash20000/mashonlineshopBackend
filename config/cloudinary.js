import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/**
 * Upload an image buffer to Cloudinary and return its public HTTPS link.
 * The returned `url` is what gets saved in MongoDB with the product.
 */
export const uploadImageBuffer = (buffer, folder = process.env.CLOUDINARY_FOLDER || 'mash-online-shop') =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (error, result) => {
        if (error) return reject(error);
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(buffer);
  });

export const deleteImage = (publicId) => cloudinary.uploader.destroy(publicId);

export default cloudinary;
