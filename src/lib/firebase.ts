import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import { getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration: client is offline.');
    }
  }
}

testConnection();

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Compresses an image client-side so that if Firebase Storage is unavailable
 * (e.g. serverless deployment on Vercel without Storage rules), the fallback data URL
 * stays lightweight (< 180 KB) and fits safely inside Firestore string bounds.
 */
async function compressImageForInlineFallback(file: File, maxDataUrlLength = 190000): Promise<string> {
  const raw = await fileToDataUrl(file);
  if (raw.length <= maxDataUrlLength) {
    return raw;
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        let width = img.naturalWidth || img.width || 1200;
        let height = img.naturalHeight || img.height || 800;
        const maxSide = 1200;
        if (width > maxSide || height > maxSide) {
          const ratio = Math.min(maxSide / width, maxSide / height);
          width = Math.max(1, Math.round(width * ratio));
          height = Math.max(1, Math.round(height * ratio));
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(raw);
          return;
        }

        const mime = file.type === 'image/png' ? 'image/webp' : 'image/jpeg';
        let scale = 1;
        for (let attempt = 0; attempt < 5; attempt++) {
          const w = Math.max(120, Math.round(width * scale));
          const h = Math.max(120, Math.round(height * scale));
          canvas.width = w;
          canvas.height = h;
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);

          for (const q of [0.84, 0.72, 0.58]) {
            const candidate = canvas.toDataURL(mime, q);
            if (candidate.length <= maxDataUrlLength) {
              resolve(candidate);
              return;
            }
          }
          scale *= 0.75;
        }

        resolve(canvas.toDataURL('image/jpeg', 0.5));
      } catch {
        resolve(raw);
      }
    };
    img.onerror = () => resolve(raw);
    img.src = raw;
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Upload timed out')), ms);
    promise.then(
      (val) => {
        window.clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Uploads an image to Firebase Storage first; if Storage is unavailable/blocked
 * (including on Vercel serverless deployments), compresses and delegates to /api/upload-image
 * (disk locally, validated inline URL on Vercel) or returns the compact inline URL.
 */
export async function uploadMediaFile(file: File, folder = 'gallery'): Promise<string> {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `gurukul/${folder}/${Date.now()}_${safeName}`;
  try {
    const storageRef = ref(storage, storagePath);
    const snapshot = await withTimeout(
      uploadBytes(storageRef, file, { contentType: file.type }),
      6500
    );
    return await withTimeout(getDownloadURL(snapshot.ref), 5000);
  } catch {
    const compactDataUrl = await compressImageForInlineFallback(file, 190000);
    try {
      const res = await fetch('/api/upload-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataUrl: compactDataUrl,
          filename: safeName.replace(/\.[^.]+$/, ''),
        }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.url) {
        return json.url;
      }
    } catch {
      // Network fallback handled below
    }

    if (compactDataUrl.length <= 240000) {
      return compactDataUrl;
    }
    throw new Error('Image is too large after compression. Please choose a smaller PNG, JPG, or WEBP file.');
  }
}
