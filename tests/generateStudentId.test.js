const { generateStudentId } = require('../backend/src/utils/generateStudentId');

const mockExists = jest.fn();
jest.mock('../backend/src/models/studentModel', () => ({
  exists: (...args) => mockExists(...args),
}));

beforeEach(() => mockExists.mockReset());

describe('generateStudentId', () => {
  test('returns an ID matching STU-XXXXXX format', async () => {
    mockExists.mockResolvedValue(false);
    const id = await generateStudentId();
    expect(id).toMatch(/^STU-[A-Z0-9]{6}$/);
  });

  test('retries when first candidate already exists', async () => {
    mockExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const id = await generateStudentId();
    expect(id).toMatch(/^STU-[A-Z0-9]{6}$/);
    expect(mockExists).toHaveBeenCalledTimes(2);
  });

  test('throws after exhausting all attempts', async () => {
    mockExists.mockResolvedValue(true);
    await expect(generateStudentId(3)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(mockExists).toHaveBeenCalledTimes(3);
  });

  test('generates unique IDs across multiple calls', async () => {
    mockExists.mockResolvedValue(false);
    const ids = await Promise.all(Array.from({ length: 20 }, () => generateStudentId()));
    const unique = new Set(ids);
    // All 20 should be unique (collision probability is negligible)
    expect(unique.size).toBe(20);
  });
});
