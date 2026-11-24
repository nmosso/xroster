export const MONITORING_KEY_PREFIX = 'monitoring:tenant:';

export interface TenantSnapshot {
    position: string;
    hash: Record<string, string>;
}

/** Fuente de salud por tenant (Redis de xBackend). Solo lectura. */
export interface MonitoringSource {
    listSnapshots(): Promise<TenantSnapshot[]>;
    getSnapshot(position: string): Promise<TenantSnapshot | null>;
}

/** Superficie mínima de ioredis usada (inyectable en tests). */
export interface RedisLike {
    scan(cursor: string, match: 'MATCH', pattern: string, count: 'COUNT', n: number): Promise<[string, string[]]>;
    hgetall(key: string): Promise<Record<string, string>>;
}

const isPosition = (s: string): boolean => /^\d+$/.test(s);

export class RedisMonitoringSource implements MonitoringSource {
    constructor(private readonly redis: RedisLike) {}

    async listSnapshots(): Promise<TenantSnapshot[]> {
        const keys = new Set<string>();
        let cursor = '0';
        do {
            const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${MONITORING_KEY_PREFIX}*`, 'COUNT', 200);
            batch.forEach((k) => keys.add(k));
            cursor = next;
        } while (cursor !== '0');

        const positions = [...keys]
            .map((k) => k.slice(MONITORING_KEY_PREFIX.length))
            .filter(isPosition)
            .sort((a, b) => Number(a) - Number(b));
        return Promise.all(positions.map(async (position) => ({ position, hash: await this.redis.hgetall(`${MONITORING_KEY_PREFIX}${position}`) })));
    }

    async getSnapshot(position: string): Promise<TenantSnapshot | null> {
        if (!isPosition(position)) return null;
        const hash = await this.redis.hgetall(`${MONITORING_KEY_PREFIX}${position}`);
        return Object.keys(hash).length > 0 ? { position, hash } : null;
    }
}
