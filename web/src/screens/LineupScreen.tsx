import { useNavigate, useParams } from 'react-router-dom';
import { LineupEditor } from '../lineup/LineupEditor.tsx';

export function LineupScreen() {
  const { fixtureId } = useParams<{ fixtureId: string }>();
  const navigate = useNavigate();
  if (!fixtureId) return null;
  return (
    <main>
      <h1>Lineup</h1>
      <LineupEditor fixtureId={fixtureId} half={1} onSubmitted={() => void navigate('/')} />
    </main>
  );
}
