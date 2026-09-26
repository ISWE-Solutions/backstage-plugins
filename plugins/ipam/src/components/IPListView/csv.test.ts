import { toCsv } from './csv';

describe('toCsv', () => {
  it('quotes only fields that need it', () => {
    expect(
      toCsv([
        ['ip', 'note'],
        ['10.20.30.1', 'plain'],
        ['10.20.30.2', 'has, comma'],
        ['10.20.30.3', 'says "hi"\nsecond line'],
      ]),
    ).toBe(
      'ip,note\r\n10.20.30.1,plain\r\n10.20.30.2,"has, comma"\r\n10.20.30.3,"says ""hi""\nsecond line"',
    );
  });
});
