const { generateReferenceCode } = require('../backend/src/utils/generateReferenceCode');

const mockExists = jest.fn();
jest.mock('../backend/src/models/paymentModel', () => ({
  exists: (...args) => mockExists(...args),
}));

beforeEach(() => mockExists.mockReset());

describe('generateReferenceCode', () => {
  test('returns a code matching PAY-XXXXXXXXXX format', async () => {
    mockExists.mockResolvedValue(false);
    const code = await generateReferenceCode();
    expect(code).toMatch(/^PAY-[A-Z0-9]{10}$/);
  });

  test('retries when first candidate already exists', async () => {
    mockExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const code = await generateReferenceCode();
    expect(code).toMatch(/^PAY-[A-Z0-9]{10}$/);
    expect(mockExists).toHaveBeenCalledTimes(2);
  });

  test('throws INTERNAL_ERROR after exhausting all attempts', async () => {
    mockExists.mockResolvedValue(true);
    await expect(generateReferenceCode(3)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(mockExists).toHaveBeenCalledTimes(3);
  });

  test('generates unique codes across multiple calls', async () => {
    mockExists.mockResolvedValue(false);
    const codes = await Promise.all(Array.from({ length: 20 }, () => generateReferenceCode()));
    expect(new Set(codes).size).toBe(20);
  });
});
