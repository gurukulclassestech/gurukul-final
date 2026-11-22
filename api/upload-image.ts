interface ApiRequest {
  method?: string;
  body?: unknown;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
}

export default function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let body: Record<string, unknown> = {};
  if (typeof req.body === 'string') {
    try {
      body = JSON.parse(req.body) as Record<string, unknown>;
    } catch {
      body = {};
    }
  } else if (req.body && typeof req.body === 'object') {
    body = req.body as Record<string, unknown>;
  }

  const dataUrl = body.dataUrl;
  if (typeof dataUrl !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing image data.' });
  }

  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    return res.status(400).json({ ok: false, error: 'Only PNG, JPG, or WEBP images are supported.' });
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 4 * 1024 * 1024) {
    return res.status(413).json({ ok: false, error: 'Image must be smaller than 4 MB.' });
  }

  if (dataUrl.length > 250000) {
    return res.status(413).json({
      ok: false,
      error: 'Image exceeds inline limit after optimization. Please choose a smaller image or paste an image URL.',
    });
  }

  return res.status(200).json({ ok: true, url: dataUrl, storage: 'inline' });
}
