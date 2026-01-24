export type OkEnvelope<T> = { ok: true; data: T };
export type ErrEnvelope = {
  ok: false;
  error: { code: string; message: string; details?: unknown };
};
export type Envelope<T> = OkEnvelope<T> | ErrEnvelope;

export function ok<T>(data: T): OkEnvelope<T> {
  return { ok: true, data };
}

export function err(code: string, message: string, details?: unknown): ErrEnvelope {
  if (details === undefined) {
    return { ok: false, error: { code, message } };
  }
  return { ok: false, error: { code, message, details } };
}
