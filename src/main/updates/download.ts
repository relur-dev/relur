import fs from 'node:fs';

/** Bytes so far, and the size when the server said it. */
export interface Progress {
  received: number;
  total: number | null;
}

export interface DownloadOptions {
  /** `<App>/<version>`, as for the check (spec §15.7). */
  userAgent: string;
  signal: AbortSignal;
  /** Plain http too: only the fake release endpoint of the tests. */
  allowHttp?: boolean;
}

function checkUrl(url: string, allowHttp: boolean): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error(`Not a download link: ${url}`);
  }
  if (protocol !== 'https:' && !(allowHttp && protocol === 'http:')) {
    throw new Error(`Not an https link: ${url}`);
  }
}

async function get(url: string, options: DownloadOptions): Promise<Response> {
  checkUrl(url, options.allowHttp ?? false);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': options.userAgent },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    const code = (error as { cause?: { code?: string } }).cause?.code;
    throw new Error(`The download couldn't start${code ? ` (${code})` : ''}`);
  }
  if (!response.ok)
    throw new Error(`The download failed: ${response.status} ${response.statusText}`);
  return response;
}

/** A small text file, such as `SHA256SUMS`. */
export async function downloadText(url: string, options: DownloadOptions): Promise<string> {
  return (await get(url, options)).text();
}

/**
 * Streams `url` to `file` (spec §15.7), through `<file>.part`, which is
 * removed when it fails or is cancelled; reports progress as it goes.
 */
export async function downloadFile(
  url: string,
  file: string,
  options: DownloadOptions & { onProgress: (progress: Progress) => void },
): Promise<void> {
  const response = await get(url, options);
  const length = Number(response.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? length : null;
  const part = `${file}.part`;
  const out = fs.createWriteStream(part);
  let received = 0;
  try {
    if (!response.body) throw new Error('The download was empty');
    const reader = response.body.getReader();
    options.onProgress({ received, total });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      options.onProgress({ received, total });
    }
    await new Promise<void>((resolve, reject) =>
      out.end((e?: Error | null) => (e ? reject(e) : resolve())),
    );
    if (total !== null && received !== total) throw new Error('The download was cut short');
    fs.renameSync(part, file);
  } catch (error) {
    // A piece may still be being written: the stream reports it as an error
    // once destroyed, which is expected here, and the part is removed only
    // after the file is closed.
    out.on('error', () => {});
    out.destroy();
    if (!out.closed) await new Promise<void>((r) => out.once('close', () => r()));
    fs.rmSync(part, { force: true });
    throw error;
  }
}
