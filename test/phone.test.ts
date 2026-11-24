import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, parseOwnerPhones } from '../src/core/phone';

test('normalizePhone: formatos con +, espacios, guiones y 00 -> solo dígitos', () => {
    assert.equal(normalizePhone('+54 9 11 2233-4455'), '5491122334455');
    assert.equal(normalizePhone('005491122334455'), '5491122334455');
});

test('normalizePhone: JID con device suffix', () => {
    assert.equal(normalizePhone('5491122334455:12@s.whatsapp.net'), '5491122334455');
});

test('normalizePhone: Argentina 54 + 10 dígitos se canoniza a 549 (igual que xBackend)', () => {
    assert.equal(normalizePhone('541122334455'), '5491122334455');
    assert.equal(normalizePhone('5491122334455'), '5491122334455');
});

test('normalizePhone: otros países sin cambios y vacío -> ""', () => {
    assert.equal(normalizePhone('+1 (415) 555-0100'), '14155550100');
    assert.equal(normalizePhone(''), '');
    assert.equal(normalizePhone(null), '');
    assert.equal(normalizePhone(undefined), '');
});

test('parseOwnerPhones: CSV normalizado, sin vacíos ni duplicados', () => {
    const set = parseOwnerPhones(' +54 11 2233-4455 , 5491122334455,, 14155550100 ');
    assert.deepEqual([...set].sort(), ['14155550100', '5491122334455']);
});
