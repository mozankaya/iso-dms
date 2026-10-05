import { ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OnlyOfficeCommandClient } from './onlyoffice-command.client';

/** Command Service error code for a document key the server does not know. */
const KEY_UNKNOWN = 1;

/**
 * An edit session that was handed out this recently may still be loading in the browser: the document
 * server does not know it yet although the user is about to connect.
 */
const SESSION_LOADING_GRACE_MS = 60_000;

export function editSessionActive(): ConflictException {
  return new ConflictException({
    code: 'EDITOR_SESSION_ACTIVE',
    message: 'The document is being edited or its last changes are still being saved',
  });
}

/**
 * Answers one question for the rest of the application: is anybody still working on this revision's
 * file, or is the last save still on its way? Other modules ask this before they lock a revision, so
 * they never need to know that ONLYOFFICE is behind it (PROJECT.md 4.2).
 *
 * The decision rests on our own record, `Revision.editSessionStartedAt`: it is set when an editing
 * session is handed out and cleared when the editor reports that the session is over and its content is
 * stored (callback status 2, or 4 when nothing changed). That mark is what covers the window in which the
 * last user has already left but the final save has not arrived yet. The document server is only a second
 * opinion, measured on the real server:
 *  - `info` lists the connected users (somebody is working);
 *  - `info` answers "unknown key" when the server has dropped the session, which also releases a mark whose
 *    closing callback will never come;
 *  - `forcesave` is deliberately not used: "no changes" does not mean the closing callback was delivered,
 *    and repeated commands delayed the final save.
 */
@Injectable()
export class EditSessionGate {
  private readonly logger = new Logger(EditSessionGate.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: OnlyOfficeCommandClient,
  ) {}

  /**
   * Resolves when no edit session of the revision is open and nothing is waiting to be saved.
   * Throws 409 EDITOR_SESSION_ACTIVE otherwise, and 503 EDITOR_SERVER_UNAVAILABLE when the answer cannot
   * be trusted (the safe choice: publishing without knowing could lose edits).
   */
  async assertIdle(revisionId: string): Promise<void> {
    const revision = await this.prisma.revision.findUnique({
      where: { id: revisionId },
      select: { editorKey: true, editSessionStartedAt: true },
    });
    if (!revision) return;

    try {
      const info = await this.commands.send('info', revision.editorKey);
      if (info.error !== 0 && info.error !== KEY_UNKNOWN) throw new Error(`info answered error ${info.error}`);

      const known = info.error === 0;
      if (known && (info.users?.length ?? 0) > 0) throw editSessionActive();

      const startedAt = revision.editSessionStartedAt;
      if (!startedAt) return; // nobody was given an editing session, or it ended and its content is stored

      // Marked, nobody connected: the closing callback is still to come, unless the server has forgotten it
      if (known) throw editSessionActive();
      if (Date.now() - startedAt.getTime() < SESSION_LOADING_GRACE_MS) throw editSessionActive();

      // The server dropped the session and no closing callback arrived: the mark is stale
      await this.prisma.revision.updateMany({
        where: { id: revisionId, editorKey: revision.editorKey, editSessionStartedAt: startedAt },
        data: { editSessionStartedAt: null },
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      this.logger.error(`The edit session of a revision could not be checked: ${(error as Error).message}`);
      throw new ServiceUnavailableException({
        code: 'EDITOR_SERVER_UNAVAILABLE',
        message: 'The editor server could not be reached',
      });
    }
  }
}
