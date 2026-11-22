import crypto from 'crypto';

interface ApiRequest {
  method?: string;
  body?: unknown;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
}

function sanitizeText(input: unknown, maxLen: number): string {
  if (typeof input !== 'string') return '';
  return input.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maxLen);
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

const recentSubmissions = new Map<string, number>();
const DEDUP_WINDOW_MS = 1000 * 60 * 60 * 12;

function pruneDedupCache() {
  const now = Date.now();
  for (const [key, ts] of recentSubmissions.entries()) {
    if (now - ts > DEDUP_WINDOW_MS) {
      recentSubmissions.delete(key);
    }
  }
}

export default function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  pruneDedupCache();

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

  const kind = body.kind === 'admission' ? 'admission' : 'enquiry';

  const student_name = sanitizeText(body.student_name, 120);
  const parent_name = sanitizeText(body.parent_name, 120);
  const phone = sanitizeText(body.phone, 20);
  const email = sanitizeText(body.email, 120);
  const class_level = sanitizeText(body.class_level, 80);
  const course_name = sanitizeText(body.course_name, 160);
  const preferred_batch = sanitizeText(body.preferred_batch, 80);
  const school = sanitizeText(body.school, 160);
  const address = sanitizeText(body.address, 300);
  const message = sanitizeText(body.message, 2000);
  const source = sanitizeText(body.source, 60) || 'website';

  const errors: Record<string, string> = {};
  if (student_name.length < 2) {
    errors.student_name = "Please enter the student's full name.";
  }
  if (kind === 'admission' && parent_name.length < 2) {
    errors.parent_name = "Please enter the parent or guardian's name.";
  }
  const digits = normalizePhone(phone);
  if (digits.length < 10 || digits.length > 13 || !/^[+0-9\s()-]{10,20}$/.test(phone)) {
    errors.phone = 'Enter a valid mobile number (10–13 digits).';
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = 'Enter a valid email address.';
  }
  if (kind === 'admission' && !class_level) {
    errors.class_level = 'Please select the class.';
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ ok: false, errors });
  }

  const courseSlug =
    (course_name || 'general')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'general';
  const dateBucket = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dedupKey = `${kind}_${digits}_${courseSlug}_${dateBucket}`;

  if (recentSubmissions.has(dedupKey)) {
    return res.status(409).json({
      ok: false,
      duplicate: true,
      message:
        'We already received a submission with this mobile number and course today. Our admissions team will reach out shortly.',
    });
  }

  const hash = crypto.createHash('sha256').update(dedupKey).digest('hex').slice(0, 24);
  const docId = `${kind === 'admission' ? 'adm' : 'enq'}_${dateBucket}_${hash}`;

  return res.status(200).json({
    ok: true,
    docId,
    dedupKey,
    sanitized: {
      student_name,
      parent_name,
      phone,
      email,
      class_level,
      course_name,
      preferred_batch,
      school,
      address,
      message,
      source,
    },
  });
}
