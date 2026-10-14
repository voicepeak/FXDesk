import { StoreProvider, useStore } from './store';
import TopBar from './components/TopBar';
import TaskBar from './components/TaskBar';
import ToastHost from './components/ToastHost';
import JobsPage from './pages/JobsPage';
import EditorPage from './pages/EditorPage';
import ReviewPage from './pages/ReviewPage';
import LibraryPage from './pages/LibraryPage';
import SettingsPage from './pages/SettingsPage';

function Shell() {
  const { route } = useStore();
  return (
    <div className="app">
      <TopBar />
      <main className="main">
        {route.name === 'jobs' && <JobsPage />}
        {route.name === 'editor' && <EditorPage key={route.jobId} jobId={route.jobId} />}
        {route.name === 'review' && <ReviewPage key={route.jobId} jobId={route.jobId} />}
        {route.name === 'library' && <LibraryPage />}
        {route.name === 'settings' && <SettingsPage />}
      </main>
      <TaskBar />
      <ToastHost />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
