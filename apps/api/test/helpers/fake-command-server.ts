import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { JwtService } from '@nestjs/jwt';

/** What the fake document server answers to the `info` command, and how it misbehaves. */
export interface CommandState {
  info: Record<string, unknown>;
  httpStatus: number;
  down: boolean;
}

export const IDLE_COMMAND_STATE: CommandState = { info: { error: 1 }, httpStatus: 200, down: false };

export interface FakeCommandServer {
  origin: string;
  state: CommandState;
  requests: { command: string; key: string; tokenValid: boolean }[];
  reset(): void;
  close(): Promise<void>;
}

/**
 * A stand-in for the Command Service of ONLYOFFICE (PROJECT.md 7.4), so tests of operations that lock a revision
 * do not depend on the real document server. Start it and set ONLYOFFICE_INTERNAL_URL to `origin` before the
 * application is created.
 */
export async function startFakeCommandServer(secret: string): Promise<FakeCommandServer> {
  const jwt = new JwtService();
  const fake: FakeCommandServer = {
    origin: '',
    state: { ...IDLE_COMMAND_STATE },
    requests: [],
    reset() {
      fake.state = { ...IDLE_COMMAND_STATE };
      fake.requests = [];
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  const server = http.createServer((req, res) => {
    if (fake.state.down) return void req.socket.destroy();
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { c: string; key: string };
      let tokenValid = false;
      try {
        const decoded = jwt.verify((req.headers.authorization ?? '').replace('Bearer ', ''), { secret }) as { payload?: unknown };
        tokenValid = JSON.stringify(decoded.payload) === JSON.stringify(body);
      } catch {
        // an invalid token stays invalid
      }
      fake.requests.push({ command: body.c, key: body.key, tokenValid });
      const answer = tokenValid ? fake.state.info : { error: 6 };
      res.writeHead(fake.state.httpStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify({ key: body.key, ...answer }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
