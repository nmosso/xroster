/**
 * Normaliza un teléfono o JID de WhatsApp a solo dígitos con código de país (mismo contrato que xBackend
 * `services/whatsapp/supportCaseRules.ts#normalizePhone`).
 * Argentina: "54" + 10 dígitos se canoniza con el 9 móvil ("541122334455" -> "5491122334455").
 */
export function normalizePhone(raw: string | null | undefined): string {
    if (!raw) return '';
    const user = String(raw).split('@')[0]!.split(':')[0]!;
    const digits = user.replace(/\D/g, '').replace(/^00/, '');
    return /^54[0-8]\d{9}$/.test(digits) ? `549${digits.slice(2)}` : digits;
}

/** CSV de OWNER_WHATSAPP_PHONES -> Set normalizado (sin vacíos ni duplicados). */
export function parseOwnerPhones(csv: string | null | undefined): Set<string> {
    return new Set(
        String(csv ?? '')
            .split(',')
            .map((p) => normalizePhone(p.trim()))
            .filter((p) => p.length > 0)
    );
}
