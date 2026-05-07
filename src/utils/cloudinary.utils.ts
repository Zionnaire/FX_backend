import cloudinary from '../config/claudinary';

export async function uploadToCloudinary(buffer: Buffer, folder: string) {
  return new Promise<any>((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream({ folder }, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
    uploadStream.end(buffer);
  });
}

export async function uploadDocumentToCloudinary(buffer: Buffer, folderPath: string, mimetype: string) {
  const resourceType = mimetype === 'application/pdf' ? 'raw' : 'auto';
  return new Promise<{ fileUrl: string; fileCldId: string }>((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: folderPath, resource_type: resourceType },
      (error, result) => {
        if (error) return reject(error);
        resolve({ fileUrl: result?.secure_url || '', fileCldId: result?.public_id || '' });
      }
    );
    uploadStream.end(buffer);
  });
}

export async function deleteFromCloudinary(publicId: string) {
  return cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
}
