import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { JwtService } from '@nestjs/jwt';

export type ConverterMode = 'ok' | 'error-code' | 'http-error' | 'foreign-url' | 'not-pdf' | 'unfinished' | 'down';

export const FAKE_PDF = Buffer.from('%PDF-1.4\n% fake converted document\n%%EOF\n', 'latin1');

export interface ConverterRequest {
  body: Record<string, unknown>;
  /** The Authorization header carried a token signed with the shared secret that wraps exactly this body */
  tokenValid: boolean;
}

export interface FakeConverterServer {
  origin: string;
  mode: ConverterMode;
  requests: ConverterRequest[];
  downloads: number;
  reset(): void;
  close(): Promise<void>;
}

/**
 * A stand-in for the Conversion API of ONLYOFFICE (PROJECT.md 6.12), so tests of the PDF copies do not depend on
 * the real document server. Start it and set ONLYOFFICE_INTERNAL_URL to `origin` before the application is created.
 */
export async function startFakeConverterServer(secret: string): Promise<FakeConverterServer> {
  const jwt = new JwtService();
  const fake: FakeConverterServer = {
    origin: '',
    mode: 'ok',
    requests: [],
    downloads: 0,
    reset() {
      fake.mode = 'ok';
      fake.requests = [];
      fake.downloads = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  const server = http.createServer((req, res) => {
    if (fake.mode === 'down') return void req.socket.destroy();

    if (req.method === 'GET' && req.url?.startsWith('/cache/')) {
      fake.downloads += 1;
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return void res.end(fake.mode === 'not-pdf' ? Buffer.from('<html>not a pdf</html>') : FAKE_PDF);
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
      let tokenValid = false;
      try {
        const decoded = jwt.verify((req.headers.authorization ?? '').replace('Bearer ', ''), { secret }) as { payload?: unknown };
        tokenValid = JSON.stringify(decoded.payload) === JSON.stringify(body);
      } catch {
        // stays false
      }
      // The command service of the same server: nobody is editing anything
      if (req.url === '/command') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({ error: 1 }));
      }
      fake.requests.push({ body, tokenValid });

      if (fake.mode === 'http-error') {
        res.writeHead(500);
        return void res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (fake.mode === 'error-code') return void res.end(JSON.stringify({ error: -4 }));
      if (fake.mode === 'unfinished') return void res.end(JSON.stringify({ endConvert: false, percent: 30 }));
      const origin = fake.mode === 'foreign-url' ? 'http://evil.example.org' : fake.origin;
      res.end(JSON.stringify({ endConvert: true, percent: 100, fileUrl: `${origin}/cache/${String(body.key)}/output.pdf`, fileType: 'pdf' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
