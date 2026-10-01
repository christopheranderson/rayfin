import { Finley } from './Finley';
import { Welcome } from './Welcome';

export function EmptyStatePreview() {
  return <Welcome companion={Finley} companionName="Finley" />;
}
