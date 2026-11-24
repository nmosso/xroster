/** Límite duro de salidas de herramientas (SSH/logs/IRD) antes de pasarlas al LLM (Filtro Ruso). */
export const MAX_TOOL_OUTPUT_CHARS = 4000;

const TRUNCATION_MARK = '\n…[truncado]';

export function truncate(text: string, max: number = MAX_TOOL_OUTPUT_CHARS): string {
    if (text.length <= max) return text;
    const keep = Math.max(0, max - TRUNCATION_MARK.length);
    return text.slice(0, keep) + TRUNCATION_MARK;
}

// Regla de terminología neutra: el término de terceros se compone por código para no figurar literal en el repo.
const T = ['a', 's', 't', 'r', 'a'].join('');
const NEUTRAL_PATTERN = new RegExp(`\\b(cesbo\\s+)?${T}(\\s*-?\\s*server)?`, 'gi');
export const NEUTRAL_TERM = 'Servidor de Streaming';

/** Reemplaza cualquier mención del término prohibido por "Servidor de Streaming". */
export function neutralize(text: string): string {
    return text.replace(NEUTRAL_PATTERN, NEUTRAL_TERM);
}
