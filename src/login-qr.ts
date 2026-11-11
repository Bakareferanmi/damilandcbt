import qrcode from 'qrcode-generator';

type Space = 'ss3' | 'digital';

const encoder = new TextEncoder();
const format = /^DC1\.(ss3|digital)\.(\d{1,15})\.(\d{1,15})\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/;
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

function signingKey(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode('damiland-login-qr-v1:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function loginQrToken(secret: string, space: Space, studentId: number, examId: number, version: number) {
  const payload = `DC1.${space}.${studentId}.${examId}.${version}`;
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload));
  return payload + '.' + base64url(new Uint8Array(signature));
}

export async function readLoginQr(secret: string, space: Space, token: unknown) {
  if (!secret || typeof token !== 'string' || token.length > 105) return null;
  const match = format.exec(token);
  if (!match || match[1] !== space) return null;
  const signature = Uint8Array.from(atob(match[5].replaceAll('-', '+').replaceAll('_', '/') + '='), ch => ch.charCodeAt(0));
  if (base64url(signature) !== match[5]) return null;
  const valid = await crypto.subtle.verify('HMAC', await signingKey(secret), signature, encoder.encode(token.slice(0, -44)));
  return valid ? { studentId: Number(match[2]), examId: Number(match[3]), version: Number(match[4]) } : null;
}

export async function loginQrImage(secret: string, space: Space, studentId: number, examId: number, version: number) {
  const qr = qrcode(0, 'M');
  qr.addData(await loginQrToken(secret, space, studentId, examId, version));
  qr.make();
  return qr.createDataURL(4, 16);
}

export const invalidLoginQr = 'This QR code is unavailable for this exam. Use your student code and password or ask your teacher for a new slip.';
