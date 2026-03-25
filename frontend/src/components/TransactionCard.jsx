/**
 * TransactionCard — displays a single payment record.
 *
 * Shows both the XLM/USDC amount and the local currency equivalent when available.
 * If the price feed was unavailable at verification time, only the asset amount is shown.
 */
export default function TransactionCard({ payment }) {
  const {
    txHash,
    amount,
    assetCode = 'XLM',
    confirmedAt,
    studentId,
    localCurrency,
  } = payment;

  const formattedAmount = `${parseFloat(amount).toFixed(7)} ${assetCode}`;
  const formattedDate   = confirmedAt ? new Date(confirmedAt).toLocaleString() : '—';

  const hasLocal  = localCurrency?.available && localCurrency?.amount != null;
  const rateTime  = localCurrency?.rateTimestamp
    ? new Date(localCurrency.rateTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div
      style={{
        border: '1px solid #ddd',
        borderRadius: 8,
        padding: '0.75rem 1rem',
        marginBottom: '0.5rem',
        fontFamily: 'sans-serif',
      }}
    >
      {/* Amount row */}
      <p style={{ margin: 0 }}>
        <strong>Amount:</strong>{' '}
        {formattedAmount}
        {hasLocal && (
          <span style={{ marginLeft: '0.5rem', color: '#2e7d32', fontSize: '0.9rem' }}>
            ≈ {localCurrency.amount.toFixed(2)} {localCurrency.currency}
          </span>
        )}
        {!hasLocal && localCurrency && (
          <span style={{ marginLeft: '0.5rem', color: '#999', fontSize: '0.8rem' }}>
            (rate unavailable)
          </span>
        )}
      </p>

      {/* Rate freshness */}
      {hasLocal && rateTime && (
        <p style={{ margin: '0.1rem 0 0', fontSize: '0.75rem', color: '#aaa' }}>
          Rate as of {rateTime}
        </p>
      )}

      {/* Transaction hash */}
      <p style={{ margin: '0.25rem 0', fontSize: '0.85rem', color: '#555' }}>
        <strong>Tx:</strong>{' '}
        <code style={{ wordBreak: 'break-all', fontSize: '0.8rem' }}>{txHash}</code>
      </p>

      {/* Date + student */}
      <p style={{ margin: 0, fontSize: '0.85rem', color: '#888' }}>
        {formattedDate} — Student {studentId}
      </p>
    </div>
  );
}