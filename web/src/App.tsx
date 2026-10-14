import { lazy, Suspense, useState } from 'react';
import { StoreProvider, useStore } from './store';
import TopBar from './components/TopBar';
import TaskBar from './components/TaskBar';
import ToastHost from './components/ToastHost';
import JobsPage from './pages/JobsPage';
import LibraryPage from './pages/LibraryPage';
import SettingsPage from './pages/SettingsPage';
import NewJobModal from './components/NewJobModal';

const EditorPage = lazy(() => import('./pages/EditorPage'));
const ReviewPage = lazy(() => import('./pages/ReviewPage'));

function Shell() {
  const { route } = useStore();
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1200);
  const [showNew, setShowNew] = useState(false);
  const closeMobileSidebar = () => { if (window.innerWidth <= 1000) setSidebarOpen(false); };
  const newJob = () => { setShowNew(true); closeMobileSidebar(); };
  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <TaskBar onNewJob={newJob} onNavigate={closeMobileSidebar} />
      <div className="workspace">
        <TopBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((open) => !open)} />
        <main className="main">
          <Suspense fallback={<div className="loading-page">加载工作台…</div>}>
            {route.name === 'jobs' && <JobsPage onNewJob={newJob} />}
            {route.name === 'editor' && <EditorPage key={route.jobId} jobId={route.jobId} />}
            {route.name === 'review' && <ReviewPage key={route.jobId} jobId={route.jobId} />}
            {route.name === 'library' && <LibraryPage />}
            {route.name === 'settings' && <SettingsPage />}
          </Suspense>
        </main>
      </div>
      {sidebarOpen && <button className="sidebar-backdrop" aria-label="关闭任务侧栏" onClick={() => setSidebarOpen(false)} />}
      {showNew && <NewJobModal onClose={() => setShowNew(false)} />}
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
