import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../src/prisma/prisma.service';
import { EditSessionGate } from '../src/modules/editor/edit-session-gate.service';
import { OnlyOfficeCommandClient, type CommandResponse } from '../src/modules/editor/onlyoffice-command.client';
import { OnlyOfficeJwtService } from '../src/modules/editor/onlyoffice-jwt.service';

const SECRET = 'command-test-secret';

describe('EditSessionGate', () => {
  const MINUTE = 60_000;
  const ago = (ms: number) => new Date(Date.now() - ms);

  /** The gate with a fake database row and a fake document server answer for the `info` command. */
  function gateWith(options: { info: CommandResponse | Error; startedAt?: Date | null; missing?: boolean }) {
    const row = options.missing ? null : { editorKey: 'key', editSessionStartedAt: options.startedAt ?? null };
    const prisma = {
      revision: {
        findUnique: jest.fn(async () => row),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const commands = {
      send: jest.fn(async () => {
        if (options.info instanceof Error) throw options.info;
        return options.info;
      }),
    };
    const gate = new EditSessionGate(prisma as unknown as PrismaService, commands as unknown as OnlyOfficeCommandClient);
    return { gate, prisma, commands };
  }

  const active = { status: 409, response: { code: 'EDITOR_SESSION_ACTIVE' } };
  const unavailable = { status: 503, response: { code: 'EDITOR_SERVER_UNAVAILABLE' } };

  describe('lets the caller go on when no editing session was handed out', () => {
    it.each([
      ['the server has never heard of the document', { error: 1 }],
      ['nobody is connected', { error: 0, users: [] }],
      ['the server leaves out the user list', { error: 0 }],
    ])('and %s', async (_label, info) => {
      const { gate, prisma, commands } = gateWith({ info });

      await expect(gate.assertIdle('rev')).resolves.toBeUndefined();
      expect(commands.send).toHaveBeenCalledWith('info', 'key'); // asked about the key stored on the revision
      expect(prisma.revision.updateMany).not.toHaveBeenCalled();
    });

    it('when the revision does not exist (the caller reports that itself)', async () => {
      const { gate, commands } = gateWith({ info: { error: 1 }, missing: true });
      await expect(gate.assertIdle('rev')).resolves.toBeUndefined();
      expect(commands.send).not.toHaveBeenCalled();
    });
  });

  describe('refuses with EDITOR_SESSION_ACTIVE', () => {
    it.each([
      ['no mark', null],
      ['a fresh mark', ago(5_000)],
      ['an old mark', ago(10 * MINUTE)],
    ])('while somebody is connected (%s)', async (_label, startedAt) => {
      const { gate } = gateWith({ info: { error: 0, users: ['user-1'] }, startedAt });
      await expect(gate.assertIdle('rev')).rejects.toMatchObject(active);
    });

    it.each([
      ['a fresh mark', ago(5_000)],
      ['an old mark', ago(10 * MINUTE)],
    ])('when the last user has left but the closing callback is still to come (%s)', async (_label, startedAt) => {
      const { gate, prisma } = gateWith({ info: { error: 0, users: [] }, startedAt });

      await expect(gate.assertIdle('rev')).rejects.toMatchObject(active);
      expect(prisma.revision.updateMany).not.toHaveBeenCalled(); // the server still knows the session: keep the mark
    });

    it('when the session was just handed out and the server does not know the key yet', async () => {
      const { gate, prisma } = gateWith({ info: { error: 1 }, startedAt: ago(10_000) });

      await expect(gate.assertIdle('rev')).rejects.toMatchObject(active);
      expect(prisma.revision.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('releases a stale mark', () => {
    it('when the server has forgotten the session and the grace period is over', async () => {
      const startedAt = ago(5 * MINUTE);
      const { gate, prisma } = gateWith({ info: { error: 1 }, startedAt });

      await expect(gate.assertIdle('rev')).resolves.toBeUndefined();
      // Only the very mark that was read is cleared, so a session opened in the meantime is not released
      expect(prisma.revision.updateMany).toHaveBeenCalledWith({
        where: { id: 'rev', editorKey: 'key', editSessionStartedAt: startedAt },
        data: { editSessionStartedAt: null },
      });
    });
  });

  describe('refuses with EDITOR_SERVER_UNAVAILABLE, because the answer cannot be trusted', () => {
    it.each([
      ['the server cannot be reached', new Error('connect ECONNREFUSED')],
      ['the answer is an unexpected error code', { error: 6 }],
    ])('when %s', async (_label, info) => {
      for (const startedAt of [null, ago(10 * MINUTE)]) {
        const { gate, prisma } = gateWith({ info, startedAt });

        await expect(gate.assertIdle('rev')).rejects.toMatchObject(unavailable);
        expect(prisma.revision.updateMany).not.toHaveBeenCalled(); // never release a mark on a guess
      }
    });
  });
});

describe('OnlyOfficeCommandClient', () => {
  let server: http.Server;
  let origin: string;
  let requests: { method?: string; url?: string; authorization?: string; body: Record<string, unknown> }[];
  let reply: { status: number; body: string };
  let jwt: JwtService;

  function client(): OnlyOfficeCommandClient {
    const config = { get: (name: string, fallback?: string) => (name === 'ONLYOFFICE_INTERNAL_URL' ? origin : fallback) } as ConfigService;
    const secrets = { getOrThrow: () => SECRET } as unknown as ConfigService;
    return new OnlyOfficeCommandClient(config, new OnlyOfficeJwtService(jwt, secrets));
  }

  beforeAll(async () => {
    jwt = new JwtService();
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
        });
        res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`; // trailing slash on purpose
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    requests = [];
    reply = { status: 200, body: JSON.stringify({ key: 'k', error: 0, users: ['u1'] }) };
  });

  it('posts the command to /command, signed with the ONLYOFFICE secret', async () => {
    const answer = await client().send('info', 'document-key');

    expect(answer).toEqual({ error: 0, users: ['u1'] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/command', body: { c: 'info', key: 'document-key' } });
    const token = requests[0].authorization!.replace('Bearer ', '');
    expect(jwt.verify(token, { secret: SECRET })).toMatchObject({ payload: { c: 'info', key: 'document-key' } });
  });

  it('returns the error code of the command service', async () => {
    reply.body = JSON.stringify({ key: 'k', error: 1 });
    await expect(client().send('info', 'k')).resolves.toEqual({ error: 1, users: undefined });
  });

  it.each([
    ['an HTTP error', { status: 502, body: '<html>Bad Gateway</html>' }],
    ['something that is not JSON', { status: 200, body: 'ok' }],
    ['JSON without an error code', { status: 200, body: '{"key":"k"}' }],
  ])('throws on %s', async (_label, response) => {
    reply = response;
    await expect(client().send('info', 'k')).rejects.toThrow();
  });

  it('throws when the server cannot be reached', async () => {
    const unreachable = { get: () => 'http://127.0.0.1:1' } as unknown as ConfigService;
    const secrets = { getOrThrow: () => SECRET } as unknown as ConfigService;
    const broken = new OnlyOfficeCommandClient(unreachable, new OnlyOfficeJwtService(jwt, secrets));

    await expect(broken.send('info', 'k')).rejects.toThrow();
  });
});
