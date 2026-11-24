import { usePageTitle } from './usePageTitle';

export function PlaceholderPage({ title }: { title: string }) {
  usePageTitle(title);
  return (
    <section>
      <h1>{title}</h1>
      <p>This section isn&apos;t built yet.</p>
    </section>
  );
}
