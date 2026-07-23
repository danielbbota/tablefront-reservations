/** Route-level skeleton shown while dashboard pages fetch data. */
export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <div className="tf-skeleton h-9 w-64" />
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="tf-skeleton h-24 rounded-2xl" />
        ))}
      </div>
      <div className="tf-skeleton mt-6 h-72 rounded-2xl" />
    </div>
  );
}
