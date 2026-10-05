import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnlyOfficeJwtService } from './onlyoffice-jwt.service';

export interface CommandResponse {
  /** Error code of the Command Service; 0 = success. */
  error: number;
  users?: string[];
}

const REQUEST_TIMEOUT_MS = 5000;

/**
 * Calls the Command Service of the ONLYOFFICE document server. Throws when the server cannot be reached
 * or does not answer with JSON; error codes in a valid answer are returned for the caller to interpret.
 */
@Injectable()
export class OnlyOfficeCommandClient {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: OnlyOfficeJwtService,
  ) {}

  async send(command: 'info', key: string): Promise<CommandResponse> {
    const body = { c: command, key };
    const baseUrl = this.config.get<string>('ONLYOFFICE_INTERNAL_URL', 'http://localhost:8080').replace(/\/+$/, '');

    const response = await fetch(`${baseUrl}/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The server expects the request signed like every other message between the two systems
        Authorization: `Bearer ${await this.jwt.sign({ payload: body })}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Command service answered HTTP ${response.status}`);

    const answer = (await response.json()) as Partial<CommandResponse>;
    if (typeof answer.error !== 'number') throw new Error('Unexpected answer of the command service');
    return { error: answer.error, users: answer.users };
  }
}
