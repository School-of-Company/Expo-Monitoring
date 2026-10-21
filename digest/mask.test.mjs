import test from 'node:test';
import assert from 'node:assert/strict';
import { mask } from './mask.mjs';

test('phone numbers, hyphenated or not', () => {
  assert.equal(mask('call 01012345678 now'), 'call *** now');
  assert.equal(mask('call 010-1234-5678 now'), 'call *** now');
  assert.equal(mask('011-234-5678'), '***');
  assert.equal(mask('+82 10-1234-5678'), '***');
});
test('does not eat ordinary numbers', () => {
  assert.equal(mask('took 1234 ms, status 503'), 'took 1234 ms, status 503');
});
test('email, uuid, jwt, long tokens', () => {
  assert.equal(mask('user a.b+c@school.kr failed'), 'user *** failed');
  assert.equal(mask('id 123e4567-e89b-12d3-a456-426614174000.'), 'id ***.');
  assert.equal(mask('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123'), 'jwt ***');
  assert.equal(mask(`key ${'a1B2'.repeat(10)} end`), 'key *** end');
});
test('key=value secrets', () => {
  assert.equal(mask('password=hunter2 ok'), 'password=*** ok');
  assert.equal(mask('{"token":"abc"}'), '{"token":"***"}');
  assert.equal(mask('Authorization: Bearer abcdef'), 'Authorization: ***');
});
