import { truncate } from '../core/text';
import { errorMessage } from '../core/logger';
import { assertPosition } from './ssh';

export interface IrdReading {
    url: string;
    ok: boolean;
    status: number | null;
    text: string;
}

export function irdUrl(position: string): string {
    return `http://100.64.${assertPosition(position)}.2:20135/`;
}

/** Lectura read-only de la página CGI del IRD; HTML a texto plano truncado a 4 000 chars. */
export async function readIrd(position: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<IrdReading> {
    const url = irdUrl(position);
    try {
        const res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
        const html = await res.text();
        const text = truncate(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
        return { url, ok: res.ok, status: res.status, text };
    } catch (err) {
        return { url, ok: false, status: null, text: errorMessage(err) };
    }
}
