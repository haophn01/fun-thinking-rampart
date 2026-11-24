import { Link } from 'react-router';
import { usePageTitle } from './usePageTitle';

export function NotFound() {
  usePageTitle('Page not found');
  return (
    <section>
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to the Dashboard</Link>
      </p>
    </section>
  );
}
