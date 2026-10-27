import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LOG_MAX_ENTRIES, LOG_STRING_MAX } from '../constants';

/** What every call resolves to: the status and the parsed body, `ok` for 2xx. Never throws on an HTTP error. */
export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  body: T;
}

/** A refused request: { error }. */
export interface ApiError {
  error: string;
}

/** One line of the activity log. */
export interface LogEntry {
  time: string;
  method: 'GET' | 'POST';
  path: string;
  status: number;
  body: unknown;
}

/**
 * The activity log (wallet spec 8.2, Log), and the one place every HTTP
 * call of the wallet goes through so it can be logged: the newest 40 calls,
 * path, status and answer, polls excepted (they pass `quiet`). Every path is
 * on the wallet's own origin: /api/masterpod/..., /api/anos/<n>/...,
 * /api/keyholder/<n>/..., /api/sign.
 */
@Injectable({ providedIn: 'root' })
export class LogService {
  private readonly http = inject(HttpClient);

  /** The newest calls first, at most LOG_MAX_ENTRIES. */
  readonly entries = signal<LogEntry[]>([]);

  /** The log as text, for the Log page. */
  readonly text = computed(() =>
    this.entries()
      .map((e) => `${e.time}  ${e.method} ${e.path}  ->  ${e.status}\n${JSON.stringify(e.body, shorten, 2)}`)
      .join('\n\n'),
  );

  clear(): void {
    this.entries.set([]);
  }

  /** POST `body` as JSON to `path` on this origin. */
  async post<T>(path: string, body: unknown, quiet = false): Promise<ApiResponse<T>> {
    const result = await this.request<T>(() => this.http.post<T>(path, body, { observe: 'response' }));
    if (!quiet) this.record('POST', path, result);
    return result;
  }

  /** GET `path` on this origin. */
  async get<T>(path: string, quiet = false): Promise<ApiResponse<T>> {
    const result = await this.request<T>(() => this.http.get<T>(path, { observe: 'response' }));
    if (!quiet) this.record('GET', path, result);
    return result;
  }

  private async request<T>(call: () => import('rxjs').Observable<import('@angular/common/http').HttpResponse<T>>): Promise<ApiResponse<T>> {
    try {
      const res = await firstValueFrom(call());
      return { ok: true, status: res.status, body: res.body as T };
    } catch (err) {
      if (!(err instanceof HttpErrorResponse)) throw err;
      const reason = err.status === 0 ? { error: 'could not reach the wallet proxy (network error)' } : err.error;
      return { ok: false, status: err.status, body: reason as T };
    }
  }

  private record(method: LogEntry['method'], path: string, result: ApiResponse<unknown>): void {
    const entry: LogEntry = { time: new Date().toLocaleTimeString(), method, path, status: result.status, body: result.body };
    this.entries.update((entries) => [entry, ...entries].slice(0, LOG_MAX_ENTRIES));
  }
}

/** The one-line reason of a refused answer. */
export function reasonOf(res: ApiResponse<unknown>): string {
  const body = res.body as Partial<ApiError> | null;
  return `HTTP ${res.status}${body && typeof body.error === 'string' ? ': ' + body.error : ''}`;
}

/** JSON.stringify replacer that cuts long strings (images, keys) in the log. */
function shorten(_key: string, value: unknown): unknown {
  return typeof value === 'string' && value.length > LOG_STRING_MAX ? `${value.slice(0, LOG_STRING_MAX)}… (${value.length} chars)` : value;
}
