import { MOCK_SNAPSHOT, MOCK_ZONES } from '@dispatch/contracts';
import { CommandCenter } from './CommandCenter';

export default function CommandCenterPage() {
  return <CommandCenter initialSnapshot={MOCK_SNAPSHOT} zones={MOCK_ZONES} />;
}
