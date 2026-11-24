/** Contrato de forward xBackend -> xRooster (REQ-2026-012 §5.2). */
export interface WebhookPayload {
    message_id: string;
    group_id: string;
    sender_phone: string;
    sender_name?: string;
    from_me: boolean;
    text: string;
    timestamp?: number;
}

const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Validación estricta; null => 400 Bad Request. */
export function parseWebhookPayload(body: unknown): WebhookPayload | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>;
    const { message_id, group_id, sender_phone, sender_name, from_me, text, timestamp } = b;
    if (!isNonEmpty(message_id) || !isNonEmpty(group_id) || !isNonEmpty(sender_phone)) return null;
    if (typeof from_me !== 'boolean' || typeof text !== 'string') return null;
    if (sender_name !== undefined && typeof sender_name !== 'string') return null;
    if (timestamp !== undefined && typeof timestamp !== 'number') return null;
    return {
        message_id, group_id, sender_phone,
        ...(sender_name !== undefined ? { sender_name } : {}),
        from_me, text,
        ...(timestamp !== undefined ? { timestamp } : {})
    };
}
