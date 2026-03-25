import { useState } from 'react';
import { getStudent, getPaymentInstructions } from '../services/api';

export default function PaymentForm() {
  const [studentId, setStudentId]       = useState('');
  const [student, setStudent]           = useState(null);
  const [instructions, setInstructions] = useState(null);
  const [error, setError]               = useState('');
  const [loading, setLoading]           = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const [stuRes, instrRes] = await Promise.all([
        getStudent(studentId),
        getPaymentInstructions(studentId),
      ]);
      setStudent(stuRes.data);
      setInstructions(instrRes.data);
    } catch {
      setError('Student not found. Please check the ID.');
    } finally {
      setLoading(false);
    }
  }

  const local    = instructions?.feeLocalEquivalent;
  const rateTime = local?.rateTimestamp
    ? new Date(local.rateTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div style={{ maxWidth: 480, margin: '2rem auto', fontFamily: 'sans-serif' }}>
      <h2>Pay School Fees</h2>

      <form onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Enter Student ID (e.g. STU1023)"
          value={studentId}
          onChange={e => setStudentId(e.target.value)}
          required
          style={{ width: '100%', padding: '0.5rem', marginBottom: '0.5rem' }}
        />
        <button type="submit" disabled={loading} style={{ padding: '0.5rem 1rem' }}>
          {loading ? 'Loading...' : 'Get Payment Instructions'}
        </button>
      </form>

      {error && <p style={{ color: 'red' }}>{error}</p>}

      {student && instructions && (
        <div style={{ marginTop: '1.5rem', background: '#f5f5f5', padding: '1rem', borderRadius: 8 }}>
          <p><strong>Student:</strong> {student.name} — Class {student.class}</p>

          {/* Fee amount with local currency equivalent */}
          <p style={{ margin: '0.4rem 0' }}>
            <strong>Required Fee:</strong>{' '}
            {instructions.feeAmount != null ? `${instructions.feeAmount} XLM` : `${student.feeAmount} XLM`}
            {local && (
              <span style={{ marginLeft: '0.5rem', color: '#2e7d32', fontWeight: 500 }}>
                ≈ {local.amount.toFixed(2)} {local.currency}
              </span>
            )}
          </p>

          {/* Rate freshness note */}
          {local && rateTime && (
            <p style={{ margin: '0 0 0.4rem', fontSize: '0.75rem', color: '#999' }}>
              Rate as of {rateTime} · 1 XLM = {local.rate.toFixed(4)} {local.currency}
            </p>
          )}
          {!local && instructions.feeAmount != null && (
            <p style={{ margin: '0 0 0.4rem', fontSize: '0.75rem', color: '#bbb' }}>
              Local currency rate unavailable
            </p>
          )}

          <p><strong>Status:</strong> {student.feePaid ? '✅ Paid' : '❌ Unpaid'}</p>
          <hr />

          <p><strong>Send payment to:</strong></p>
          <code style={{ wordBreak: 'break-all' }}>{instructions.walletAddress}</code>
          <p><strong>Memo (required):</strong> <code>{instructions.memo}</code></p>

          {instructions.acceptedAssets?.length > 0 && (
            <div style={{ marginTop: '0.75rem', padding: '0.5rem', background: '#e8f5e9', borderRadius: 4 }}>
              <strong>Accepted Assets:</strong>
              <ul style={{ margin: '0.25rem 0 0 1rem', padding: 0 }}>
                {instructions.acceptedAssets.map(a => (
                  <li key={a.code}>{a.displayName} ({a.code})</li>
                ))}
              </ul>
            </div>
          )}

          <p style={{ fontSize: '0.85rem', color: '#555', marginTop: '0.75rem' }}>
            {instructions.note}
          </p>
        </div>
      )}
    </div>
  );
}